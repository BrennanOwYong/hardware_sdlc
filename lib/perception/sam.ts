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
/** Compact masks are downscaled so their long edge is at most this. */
export const MAX_MASK_EDGE = 640;
/** Base64 mask payload budget per image (~2 MB of response characters). */
export const MAX_TOTAL_MASK_BYTES = 2 * 1024 * 1024;

export interface SamBox {
  /** Normalized [x, y, width, height], top-left origin, all in 0..1. */
  bbox: [number, number, number, number];
  /** Mask pixel count over total pixels (0..1) — tighter than bbox area. */
  area: number;
  /**
   * Compact binary mask of the region as a base64 PNG (no data: prefix):
   * white opaque where the object is, transparent elsewhere, long edge
   * capped at MAX_MASK_EDGE. Absent when the payload cap dropped it.
   */
  maskPng?: string;
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

/** One-byte-per-pixel binary mask: on[y * width + x] is 1 on the object. */
export interface BinaryMask {
  width: number;
  height: number;
  on: Uint8Array;
}

/**
 * Threshold an RGBA mask buffer (pngjs inflates every PNG to RGBA) into a
 * binary mask. A pixel is on when any color channel exceeds 127 — SAM masks
 * are white-on-black.
 */
export function rgbaToBinaryMask(
  data: Uint8Array,
  width: number,
  height: number,
): BinaryMask {
  if (data.length < width * height * 4) {
    throw new Error(
      `mask buffer too small: ${data.length} bytes for ${width}x${height} RGBA`,
    );
  }
  const on = new Uint8Array(width * height);
  for (let p = 0; p < on.length; p++) {
    const i = p * 4;
    if (data[i] > 127 || data[i + 1] > 127 || data[i + 2] > 127) on[p] = 1;
  }
  return { width, height, on };
}

/**
 * Tight bounding box over the on pixels of a binary mask. Returns null for
 * empty masks. A mask holding two separate blobs yields the union box.
 */
export function binaryMaskToBox(mask: BinaryMask): SamBox | null {
  const { width, height, on } = mask;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let onCount = 0;
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      if (on[rowStart + x]) {
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

/**
 * Tight bounding box over the "on" pixels of an RGBA mask buffer. A pixel is
 * on when any color channel exceeds 127. Returns null for empty masks.
 */
export function maskToBox(
  data: Uint8Array,
  width: number,
  height: number,
): SamBox | null {
  return binaryMaskToBox(rgbaToBinaryMask(data, width, height));
}

/** Decode a mask PNG (Buffer/Uint8Array of the file bytes) to its box. */
export function decodeMaskToBox(pngBytes: Uint8Array): SamBox | null {
  const png = PNG.sync.read(Buffer.from(pngBytes));
  return maskToBox(png.data, png.width, png.height);
}

/**
 * Downscale a binary mask so its long edge is at most maxEdge, preserving
 * aspect (short edge rounds, floor 1). Never upscales — a mask already
 * within the bound comes back unchanged. Each destination pixel max-pools
 * its source cell (on if ANY covered source pixel is on) so 1-px structures
 * like jumper wires survive the shrink.
 */
export function downscaleBinaryMask(
  mask: BinaryMask,
  maxEdge: number = MAX_MASK_EDGE,
): BinaryMask {
  const { width, height, on } = mask;
  if (Math.max(width, height) <= maxEdge) return mask;
  const outW =
    width >= height ? maxEdge : Math.max(1, Math.round((width * maxEdge) / height));
  const outH =
    height > width ? maxEdge : Math.max(1, Math.round((height * maxEdge) / width));
  const out = new Uint8Array(outW * outH);
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor((oy * height) / outH);
    const y1 = Math.min(height - 1, Math.ceil(((oy + 1) * height) / outH) - 1);
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor((ox * width) / outW);
      const x1 = Math.min(width - 1, Math.ceil(((ox + 1) * width) / outW) - 1);
      let hit = 0;
      scan: for (let y = y0; y <= y1; y++) {
        const rowStart = y * width;
        for (let x = x0; x <= x1; x++) {
          if (on[rowStart + x]) {
            hit = 1;
            break scan;
          }
        }
      }
      out[oy * outW + ox] = hit;
    }
  }
  return { width: outW, height: outH, on: out };
}

/**
 * Encode a binary mask as a base64 PNG (no data: prefix): white opaque
 * where on, fully transparent elsewhere. colorType 6 keeps the alpha
 * channel (pngjs README; docs/references-masks.md).
 */
export function encodeMaskPng(mask: BinaryMask): string {
  const png = new PNG({ width: mask.width, height: mask.height });
  // pngjs pre-allocates png.data zero-filled (transparent black).
  for (let p = 0; p < mask.on.length; p++) {
    if (mask.on[p]) {
      const i = p * 4;
      png.data[i] = 255;
      png.data[i + 1] = 255;
      png.data[i + 2] = 255;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png, { colorType: 6 }).toString("base64");
}

export interface MaskRegion {
  /** Box computed at full mask resolution (tightest bbox). */
  box: SamBox;
  /** Binary mask already downscaled to at most maxEdge on the long edge. */
  mask: BinaryMask;
}

/**
 * Decode a mask PNG to its full-resolution box plus a compact binary mask
 * for later re-encoding. Returns null for empty masks.
 */
export function decodeMaskRegion(
  pngBytes: Uint8Array,
  maxEdge: number = MAX_MASK_EDGE,
): MaskRegion | null {
  const png = PNG.sync.read(Buffer.from(pngBytes));
  const full = rgbaToBinaryMask(png.data, png.width, png.height);
  const box = binaryMaskToBox(full);
  if (!box) return null;
  return { box, mask: downscaleBinaryMask(full, maxEdge) };
}

export interface CapMaskResult {
  /** Same boxes in the same order; some may have lost their maskPng. */
  boxes: SamBox[];
  /** How many regions had their mask dropped by the payload budget. */
  masksDropped: number;
}

/**
 * Enforce the per-image mask payload budget. Regions keep their masks in
 * area-descending order (biggest objects matter most for highlighting)
 * until the base64 budget runs out; later masks are dropped while their
 * boxes stay. Non-mutating; box order is preserved.
 */
export function capMaskPayload(
  boxes: SamBox[],
  maxTotalBytes: number = MAX_TOTAL_MASK_BYTES,
): CapMaskResult {
  const entries: Array<{ index: number; area: number; bytes: number }> = [];
  boxes.forEach((box, index) => {
    if (box.maskPng !== undefined) {
      entries.push({ index, area: box.area, bytes: box.maskPng.length });
    }
  });
  entries.sort((a, b) => b.area - a.area);
  const drop = new Set<number>();
  let total = 0;
  for (const entry of entries) {
    if (total + entry.bytes <= maxTotalBytes) total += entry.bytes;
    else drop.add(entry.index);
  }
  if (drop.size === 0) return { boxes, masksDropped: 0 };
  return {
    boxes: boxes.map((box, i) =>
      drop.has(i) ? { bbox: box.bbox, area: box.area } : box,
    ),
    masksDropped: drop.size,
  };
}

/** Note text for the useSample fast path (served keyed or keyless). */
export const SAMPLE_FAST_PATH_NOTE =
  "sample sheet uses its known inventory - photograph something real for live vision";

/**
 * The bundled sample parts sheet has a known inventory — useSample:true
 * short-circuits /api/identify before any key check, SAM call, or VLM call.
 * Real photos (useSample absent or false) never take this path.
 */
export function isSampleFastPath(req: { useSample?: boolean }): boolean {
  return req.useSample === true;
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
      return decodeMaskRegion(new Uint8Array(await res.arrayBuffer()));
    }),
  );
  const candidates: SamBox[] = [];
  const maskByBox = new Map<SamBox, BinaryMask>();
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) {
      candidates.push(result.value.box);
      maskByBox.set(result.value.box, result.value.mask);
    }
  }
  // Rank on boxes alone, then encode compact mask PNGs only for survivors.
  const kept = selectRegions(candidates).map((box) => {
    const mask = maskByBox.get(box);
    return mask ? { ...box, maskPng: encodeMaskPng(mask) } : box;
  });
  const { boxes, masksDropped } = capMaskPayload(kept);
  const baseNote = `${boxes.length} regions from ${output.data.individual_masks.length} masks`;
  return {
    boxes,
    note:
      masksDropped > 0
        ? `${baseNote}; payload cap dropped masks on ${masksDropped} regions`
        : baseNote,
  };
}
