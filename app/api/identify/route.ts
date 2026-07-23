// POST /api/identify — photo -> named part inventory.
// Vision request shape verified against the Anthropic vision docs;
// deep links in docs/references-p1.md. SAM region proposals ride the
// Replicate HTTP API; deep links in docs/references-practice-sam.md.
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Inventory, PartDetection } from "@/lib/types";
import { buildMockInventory } from "@/lib/inventory/mock";
import {
  chooseIdentifyMode,
  segmentImage,
  type SamBox,
} from "@/lib/perception/sam";
import {
  identifyRequestSchema,
  MEDIA_TYPES,
  type IdentifyError,
  type IdentifyResponse,
  type MediaType,
} from "@/lib/inventory/contract";
// Prompt text lives in lib/inventory/prompts.ts so node --test can import the
// builders directly (Next.js route files reject extra exports at build time).
import { buildRegionPrompt, buildVisionPrompt } from "@/lib/inventory/prompts";

const MODEL = "claude-sonnet-5";

const RETRY_PROMPT =
  "Your previous reply was not a valid JSON array matching the required schema. Reply again with ONLY the JSON array — no prose, no markdown, no code fences.";

const regionLabelSchema = z.object({
  region: z.number().int().min(1),
  partType: z.string().min(1),
  label: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
const regionLabelsSchema = z.array(regionLabelSchema).min(1);
type RegionLabel = z.infer<typeof regionLabelSchema>;

const rawDetectionSchema = z.object({
  partType: z.string().min(1),
  label: z.string().min(1),
  confidence: z.number().min(0).max(1),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});
const rawDetectionsSchema = z.array(rawDetectionSchema).min(1);
type RawDetection = z.infer<typeof rawDetectionSchema>;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function parseDetections(text: string): RawDetection[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = rawDetectionsSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Normalize a bbox the model may have emitted in pixels despite instructions. */
function normalizeBbox(
  bbox: [number, number, number, number],
  imageWidth?: number,
  imageHeight?: number,
): [number, number, number, number] {
  const looksLikePixels = bbox.some((v) => v > 1.5);
  if (looksLikePixels && imageWidth && imageHeight) {
    return [
      clamp01(bbox[0] / imageWidth),
      clamp01(bbox[1] / imageHeight),
      clamp01(bbox[2] / imageWidth),
      clamp01(bbox[3] / imageHeight),
    ];
  }
  return [clamp01(bbox[0]), clamp01(bbox[1]), clamp01(bbox[2]), clamp01(bbox[3])];
}

interface ParsedImage {
  mediaType: MediaType;
  data: string;
}

function parseImagePayload(
  imageBase64: string,
  fallbackMediaType: MediaType | undefined,
): ParsedImage | { error: string } {
  if (imageBase64.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(imageBase64);
    if (!match) return { error: "imageBase64 is a malformed data URL" };
    const candidate = match[1];
    const supported = MEDIA_TYPES.find((m) => m === candidate);
    if (!supported) {
      return {
        error: `unsupported media type "${candidate}" — the vision API accepts ${MEDIA_TYPES.join(
          ", ",
        )}. Rasterize SVGs to a canvas and send PNG/JPEG.`,
      };
    }
    return { mediaType: supported, data: match[2] };
  }
  return { mediaType: fallbackMediaType ?? "image/jpeg", data: imageBase64 };
}

async function detectWithRetry(
  client: Anthropic,
  image: ParsedImage,
  prompt: string,
): Promise<RawDetection[]> {
  const imageBlock: Anthropic.ImageBlockParam = {
    type: "image",
    source: {
      type: "base64",
      media_type: image.mediaType,
      data: image.data,
    },
  };
  const firstTurn: Anthropic.MessageParam = {
    role: "user",
    // Image before text — per the vision docs' image-then-text guidance.
    content: [imageBlock, { type: "text", text: prompt }],
  };

  const first = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "disabled" },
    messages: [firstTurn],
  });
  const firstText = textOf(first);
  const firstParse = parseDetections(firstText);
  if (firstParse) return firstParse;

  // One retry with the invalid reply echoed back.
  const second = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "disabled" },
    messages: [
      firstTurn,
      { role: "assistant", content: firstText || "(empty reply)" },
      { role: "user", content: RETRY_PROMPT },
    ],
  });
  const secondParse = parseDetections(textOf(second));
  if (secondParse) return secondParse;

  throw new Error("model returned invalid JSON twice");
}

function parseRegionLabels(text: string): RegionLabel[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = regionLabelsSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** One vision call labeling SAM's numbered regions; one retry on bad JSON. */
async function labelRegionsWithRetry(
  client: Anthropic,
  image: ParsedImage,
  prompt: string,
): Promise<RegionLabel[]> {
  const imageBlock: Anthropic.ImageBlockParam = {
    type: "image",
    source: {
      type: "base64",
      media_type: image.mediaType,
      data: image.data,
    },
  };
  const firstTurn: Anthropic.MessageParam = {
    role: "user",
    content: [imageBlock, { type: "text", text: prompt }],
  };

  const first = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "disabled" },
    messages: [firstTurn],
  });
  const firstText = textOf(first);
  const firstParse = parseRegionLabels(firstText);
  if (firstParse) return firstParse;

  const second = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "disabled" },
    messages: [
      firstTurn,
      { role: "assistant", content: firstText || "(empty reply)" },
      { role: "user", content: RETRY_PROMPT },
    ],
  });
  const secondParse = parseRegionLabels(textOf(second));
  if (secondParse) return secondParse;

  throw new Error("model returned invalid JSON twice");
}

/**
 * Join labels to SAM boxes: drop "ignore" and out-of-range region numbers,
 * keep the first label per region, use SAM's tight bbox for every part.
 */
function partsFromRegionLabels(
  labels: RegionLabel[],
  boxes: SamBox[],
): PartDetection[] {
  const seen = new Set<number>();
  const parts: PartDetection[] = [];
  for (const label of labels) {
    if (label.partType === "ignore") continue;
    if (label.region < 1 || label.region > boxes.length) continue;
    if (seen.has(label.region)) continue;
    seen.add(label.region);
    parts.push({
      id: `p${parts.length + 1}`,
      partType: label.partType,
      label: label.label,
      confidence: clamp01(label.confidence),
      bbox: boxes[label.region - 1].bbox,
    });
  }
  return parts;
}

export async function POST(
  req: Request,
): Promise<NextResponse<IdentifyResponse | IdentifyError>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body is not valid JSON" }, {
      status: 400,
    });
  }

  const parsed = identifyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}` },
      { status: 400 },
    );
  }
  const { imageBase64, mediaType, useSample, imageWidth, imageHeight } =
    parsed.data;
  const query = parsed.data.query?.trim() || undefined;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    if (query) {
      return NextResponse.json({
        inventory: buildMockInventory(),
        note: "ANTHROPIC_API_KEY is not set - live identify is off; photo mode with the sample image still works.",
      });
    }
    return NextResponse.json({
      inventory: buildMockInventory(),
      note: useSample
        ? "ANTHROPIC_API_KEY is not set — returned the deterministic mock inventory matched to the sample parts sheet."
        : "ANTHROPIC_API_KEY is not set — returned the deterministic mock inventory (it matches the sample parts sheet, not your photo). Set the key in .env.local for live vision.",
    });
  }

  if (!imageBase64) {
    return NextResponse.json({
      inventory: buildMockInventory(),
      note: "No image was supplied — returned the deterministic mock inventory.",
    });
  }

  const image = parseImagePayload(imageBase64, mediaType);
  if ("error" in image) {
    return NextResponse.json({ error: image.error }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });
  const mode = chooseIdentifyMode({
    hasAnthropicKey: true,
    hasReplicateToken: Boolean(process.env.REPLICATE_API_TOKEN),
  });

  // sam+vlm: SAM proposes tight regions, one vision call names them.
  // Any SAM-side failure degrades to the vision-only path below — never a 500.
  let samNote: string | undefined;
  if (mode === "sam+vlm") {
    try {
      const seg = await segmentImage(image.data, {
        mediaType: image.mediaType,
      });
      if (seg.boxes.length === 0) {
        samNote =
          "sam found no usable regions in this frame — used vision-only identification.";
      } else {
        const labels = await labelRegionsWithRetry(
          client,
          image,
          buildRegionPrompt(seg.boxes, query),
        );
        const parts = partsFromRegionLabels(labels, seg.boxes);
        if (parts.length > 0) {
          const inventory: Inventory = {
            parts,
            capturedAt: new Date().toISOString(),
            source: "vlm",
          };
          return NextResponse.json({
            inventory,
            note: `sam+vlm: ${seg.boxes.length} regions, ${parts.length} labeled`,
          });
        }
        samNote =
          "sam+vlm labeled every region as ignore — used vision-only identification.";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      samNote = `sam segmentation failed (${message}) — used vision-only identification.`;
    }
  }

  try {
    const detections = await detectWithRetry(
      client,
      image,
      buildVisionPrompt(query),
    );
    const parts: PartDetection[] = detections.map((d, i) => ({
      id: `p${i + 1}`,
      partType: d.partType,
      label: d.label,
      confidence: clamp01(d.confidence),
      bbox: normalizeBbox(d.bbox, imageWidth, imageHeight),
    }));
    const inventory: Inventory = {
      parts,
      capturedAt: new Date().toISOString(),
      source: "vlm",
    };
    return NextResponse.json(
      samNote ? { inventory, note: samNote } : { inventory },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `vision identification failed: ${message}` },
      { status: 502 },
    );
  }
}
