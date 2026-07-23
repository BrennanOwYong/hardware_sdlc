// Segment Anything Model (SAM 2) adapter over the Replicate HTTP API.
// Endpoint shapes, auth header, Prefer: wait sync mode, poll pattern, and the
// meta/sam-2 input/output schema were verified against the vendor docs on
// 2026-07-24; deep links in docs/references-practice-sam.md.
//
// The module keeps project imports type-free so tests/sam.test.mjs can load
// it directly through Node's type stripping (only node_modules resolve at
// runtime: zod, pngjs).
import { z } from "zod";
import { PNG } from "pngjs";

/** Pinned meta/sam-2 version id (docs/references-practice-sam.md). */
export const SAM_MODEL_VERSION =
  "cbd95fb76192174268b6b303aeeb7a736e8dab0cbc38177f09db79b2299da30b";

const REPLICATE_API = "https://api.replicate.com/v1";
/** Largest number of individual mask PNGs downloaded per frame. */
const MAX_MASK_DOWNLOADS = 32;
/** Regions kept after ranking (the 12 largest survivors). */
export const MAX_REGIONS = 12;
/** Area floor: regions under 0.5% of the image are noise. */
export const MIN_REGION_AREA = 0.005;
/** Two boxes with IoU above this are duplicates; the larger one wins. */
export const MAX_REGION_IOU = 0.5;

export interface SamBox {
  /** Normalized [x, y, width, height], top-left origin, all in 0..1. */
  bbox: [number, number, number, number];
  /** Mask pixel count over total pixels (0..1) — tighter than bbox area. */
  area: number;
}

export interface SamSegmentation {
  boxes: SamBox[];
  note: string;
}

export type IdentifyMode = "sam+vlm" | "vlm" | "mock";

/**
 * Degradation ladder. Both keys: SAM proposes regions, the VLM labels them.
 * Anthropic only: vision-only identification. Anything else (including a
 * Replicate token with no Anthropic key — SAM has no labeler without the
 * VLM): deterministic mock.
 */
export function chooseIdentifyMode(env: {
  hasAnthropicKey: boolean;
  hasReplicateToken: boolean;
}): IdentifyMode {
  if (!env.hasAnthropicKey) return "mock";
  return env.hasReplicateToken ? "sam+vlm" : "vlm";
}

/**
 * Tight bounding box over the "on" pixels of an RGBA mask buffer
 * (pngjs inflates every PNG to RGBA). A pixel is on when any color channel
 * exceeds 127 — SAM masks are white-on-black. Returns null for empty masks.
 * A mask holding two separate blobs yields the union box over both.
 */
export function maskToBox(
  data: Uint8Array,
  width: number,
  height: number,
): SamBox | null {
  if (data.length < width * height * 4) {
    throw new Error(
      `mask buffer too small: ${data.length} bytes for ${width}x${height} RGBA`,
    );
  }
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let onCount = 0;
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * 4;
      if (data[i] > 127 || data[i + 1] > 127 || data[i + 2] > 127) {
        onCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (onCount === 0) return null;
  return {
    bbox: [
      minX / width,
      minY / height,
      (maxX - minX + 1) / width,
      (maxY - minY + 1) / height,
    ],
    area: onCount / (width * height),
  };
}

/** Decode a mask PNG (Buffer/Uint8Array of the file bytes) to its box. */
export function decodeMaskToBox(pngBytes: Uint8Array): SamBox | null {
  const png = PNG.sync.read(Buffer.from(pngBytes));
  return maskToBox(png.data, png.width, png.height);
}

/** Intersection-over-union of two normalized [x, y, w, h] boxes. */
export function boxIou(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

export interface SelectRegionOptions {
  maxRegions?: number;
  minArea?: number;
  maxIou?: number;
}

/**
 * Rank candidate regions: drop those under the area floor, sort by mask area
 * descending, greedily suppress boxes overlapping an already-kept box past
 * the IoU cutoff, cap at the N largest survivors.
 */
export function selectRegions(
  boxes: SamBox[],
  opts: SelectRegionOptions = {},
): SamBox[] {
  const maxRegions = opts.maxRegions ?? MAX_REGIONS;
  const minArea = opts.minArea ?? MIN_REGION_AREA;
  const maxIou = opts.maxIou ?? MAX_REGION_IOU;
  const ranked = boxes
    .filter((b) => b.area >= minArea)
    .slice()
    .sort((x, y) => y.area - x.area);
  const kept: SamBox[] = [];
  for (const candidate of ranked) {
    if (kept.length >= maxRegions) break;
    if (kept.every((k) => boxIou(k.bbox, candidate.bbox) <= maxIou)) {
      kept.push(candidate);
    }
  }
  return kept;
}

// --- Replicate prediction lifecycle -----------------------------------------

const predictionSchema = z.object({
  id: z.string(),
  status: z.enum(["starting", "processing", "succeeded", "failed", "canceled"]),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
  urls: z.object({ get: z.string() }).partial().optional(),
});
type Prediction = z.infer<typeof predictionSchema>;

/** meta/sam-2 output: URIs to a combined mask PNG and per-object mask PNGs. */
const samOutputSchema = z.object({
  combined_mask: z.string(),
  individual_masks: z.array(z.string()),
});

export interface SegmentImageOptions {
  /** Defaults to process.env.REPLICATE_API_TOKEN. */
  token?: string;
  /** Media type when imageBase64 is bare base64 (data URLs carry their own). */
  mediaType?: string;
  /** Overall deadline for create + poll, milliseconds. Default 60000. */
  timeoutMs?: number;
  /** Test hook; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const POLL_INTERVAL_MS = 1500;
const MASK_DOWNLOAD_TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return "(no body)";
  }
}

function terminalOrThrow(p: Prediction): Prediction | null {
  if (p.status === "succeeded") return p;
  if (p.status === "failed" || p.status === "canceled") {
    const detail =
      typeof p.error === "string" ? p.error : JSON.stringify(p.error ?? "");
    throw new Error(`replicate prediction ${p.status}: ${detail.slice(0, 300)}`);
  }
  return null;
}

/**
 * Run meta/sam-2 on one image and return ranked bounding-box proposals.
 * Uses the sync `Prefer: wait` mode first, then falls back to polling
 * GET /v1/predictions/{id} until the deadline.
 */
export async function segmentImage(
  imageBase64: string,
  opts: SegmentImageOptions = {},
): Promise<SamSegmentation> {
  const token = opts.token ?? process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("REPLICATE_API_TOKEN is not set");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;

  const image = imageBase64.startsWith("data:")
    ? imageBase64
    : `data:${opts.mediaType ?? "image/jpeg"};base64,${imageBase64}`;

  const createRes = await doFetch(`${REPLICATE_API}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // Sync mode: hold the request open up to n seconds (1..60 per docs).
      Prefer: `wait=${Math.min(60, Math.max(1, Math.floor(timeoutMs / 1000)))}`,
    },
    body: JSON.stringify({
      version: SAM_MODEL_VERSION,
      input: { image },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!createRes.ok) {
    throw new Error(
      `replicate create failed (HTTP ${createRes.status}): ${await readErrorDetail(createRes)}`,
    );
  }
  let prediction = predictionSchema.parse(await createRes.json());

  // Poll if the sync window elapsed before the model finished.
  while (!terminalOrThrow(prediction)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `replicate prediction timed out after ${Math.round(timeoutMs / 1000)}s (status ${prediction.status})`,
      );
    }
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    const pollUrl =
      prediction.urls?.get ?? `${REPLICATE_API}/predictions/${prediction.id}`;
    const pollRes = await doFetch(pollUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
    });
    if (!pollRes.ok) {
      throw new Error(
        `replicate poll failed (HTTP ${pollRes.status}): ${await readErrorDetail(pollRes)}`,
      );
    }
    prediction = predictionSchema.parse(await pollRes.json());
  }

  const output = samOutputSchema.safeParse(prediction.output);
  if (!output.success) {
    throw new Error("replicate returned an unexpected sam-2 output shape");
  }

  const maskUrls = output.data.individual_masks.slice(0, MAX_MASK_DOWNLOADS);
  const settled = await Promise.allSettled(
    maskUrls.map(async (url) => {
      const res = await doFetch(url, {
        signal: AbortSignal.timeout(MASK_DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`mask download HTTP ${res.status}`);
      return decodeMaskToBox(new Uint8Array(await res.arrayBuffer()));
    }),
  );
  const candidates: SamBox[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) {
      candidates.push(result.value);
    }
  }
  const boxes = selectRegions(candidates);
  return {
    boxes,
    note: `${boxes.length} regions from ${output.data.individual_masks.length} masks`,
  };
}
