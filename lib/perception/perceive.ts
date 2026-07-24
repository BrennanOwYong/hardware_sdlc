/**
 * Server-side perception: zod-validated request handling, the single
 * Anthropic vision call, strict-JSON verdict parsing, and the mapping from
 * verdict to PerceptionEvents. app/api/perceive/route.ts re-exports POST from
 * here; keeping the logic in lib/ lets node --test exercise it directly.
 *
 * References (see docs/references-perception.md and
 * docs/references-delta-accuracy.md for the full list):
 * - Vision / base64 image blocks: https://platform.claude.com/docs/en/build-with-claude/vision.md
 *   (docs.anthropic.com/en/docs/build-with-claude/vision 301-redirects there)
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import type { PerceptionEvent } from "@/lib/types";

export const PERCEIVE_MODEL = "claude-sonnet-5";

/** Fast tier for the live-lab streaming experiment (dated full ID per the
 * models overview - see docs/references-livelab.md). */
export const PERCEIVE_FAST_MODEL = "claude-haiku-4-5-20251001";

export const perceiveRequestSchema = z.object({
  /** Raw base64 image bytes; a data: URL prefix is tolerated and stripped. */
  frameBase64: z.string().min(1),
  instruction: z.string().min(1),
  expectedTargets: z.array(z.string().min(1)).min(1),
  phase: z.enum(["awaiting-tip", "awaiting-seat"]),
  edgeId: z.string().min(1),
  /** Which vision model judges this frame. Optional on the wire; defaults to
   * Sonnet 5 so every existing caller keeps its behavior. The live-lab page
   * sends the Haiku full ID to measure the fast tier. */
  model: z
    .enum(["claude-sonnet-5", "claude-haiku-4-5-20251001"])
    .default(PERCEIVE_MODEL),
});

export type PerceiveRequest = z.infer<typeof perceiveRequestSchema>;

export const visionVerdictSchema = z.object({
  tipOnTarget: z.boolean(),
  seated: z.boolean(),
  wrongPlacement: z.string().nullable(),
  /**
   * The specific pin/hole label the model reads the tip nearest to, in the
   * ref grammar ("UNO:D2", "BB:15:a"), or null when unsure. Defaults to null
   * so an old-format reply (without the field) still validates.
   */
  observedRef: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
});

export type VisionVerdict = z.infer<typeof visionVerdictSchema>;

/** Verdicts below this confidence are discarded server-side: the frame maps to
 * zero events, which the client-side StreakGate counts as a streak miss. */
export const MIN_CONFIDENCE = 0.5;

export interface PerceiveResponse {
  events: PerceptionEvent[];
  note?: string;
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** Splits an optional data: URL prefix off and returns clean base64 + media type. */
export function normalizeFrame(frameBase64: string): {
  data: string;
  mediaType: ImageMediaType;
} {
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,/.exec(frameBase64);
  if (match) {
    return {
      data: frameBase64.slice(match[0].length),
      mediaType: match[1] as ImageMediaType,
    };
  }
  return { data: frameBase64, mediaType: "image/jpeg" };
}

export function buildVisionPrompt(req: PerceiveRequest): string {
  return [
    "You are the perception system for a guided electronics-assembly assistant.",
    "IMPORTANT: the frame may be a SIMULATED workspace - the user may be dragging",
    "image cutouts of parts (wires, LEDs, resistors, buttons, Arduino boards,",
    "breadboards) around a slide, paint canvas, or screen share. Treat cutouts",
    "exactly as if they were real physical parts. Never dismiss the scene as fake.",
    "The workspace is general: breadboard holes (e.g. BB:12:e, BB:RAIL:GND) and",
    "Arduino header ports (e.g. UNO:D2, UNO:GND, UNO:5V) are equally valid targets.",
    "",
    `Current step instruction: ${req.instruction}`,
    `Expected target refs for this step: ${req.expectedTargets.join(", ")}`,
    `Step edge id: ${req.edgeId}`,
    `Phase: ${req.phase}`,
    "",
    "Phase meaning:",
    "- awaiting-tip: decide whether the free tip of the wire or component lead is",
    "  touching or hovering directly over one of the expected targets.",
    "- awaiting-seat: decide whether the wire/component end is fully inserted or",
    "  seated at the expected targets (visually flush, overlapping the hole/port).",
    "",
    "If the part is clearly placed at a target that is NOT in the expected list,",
    "report it in wrongPlacement using the same ref grammar when possible",
    '(e.g. "UNO:D3" or "BB:14:c"), otherwise a short description. Use null when',
    "nothing is misplaced.",
    "",
    "observedRef: name the SPECIFIC pin or hole the free tip is nearest to,",
    "even when it matches an expected target. Read the silkscreen labels printed",
    "on the Arduino (D0-D13, A0-A5, GND, 5V, 3V3) for header ports, and count",
    "breadboard holes by row number and column letter for breadboard targets.",
    "Do this for image cutouts exactly as for real parts - the labels and hole",
    "grid in the picture are authoritative. Use the ref grammar shown above",
    '("UNO:D2", "BB:15:a", "BB:RAIL:GND"). Set observedRef to null ONLY when',
    "you cannot confidently name a specific pin or hole.",
    "",
    "Respond with ONLY this JSON object - no markdown fences, no prose:",
    '{"tipOnTarget": boolean, "seated": boolean, "wrongPlacement": string | null, "observedRef": string | null, "confidence": number between 0 and 1}',
  ].join("\n");
}

/** Pulls the first {...} span out of model text and parses it. Returns null on failure. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/** Case-insensitive ref comparison: "bb:15:A" and "BB:15:a" name the same hole. */
function refsEqual(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

export function mapVerdictToEvents(
  verdict: VisionVerdict,
  req: PerceiveRequest,
  atMs: number,
): PerceptionEvent[] {
  const events: PerceptionEvent[] = [];
  // Low confidence discards the whole frame verdict (including misplaced):
  // zero events reach the client, and its StreakGate counts the frame as a miss.
  if (verdict.confidence < MIN_CONFIDENCE) return events;
  if (verdict.wrongPlacement !== null && verdict.wrongPlacement.trim() !== "") {
    events.push({
      type: "misplaced",
      atMs,
      edgeId: req.edgeId,
      expected: req.expectedTargets,
      observed: verdict.wrongPlacement.trim(),
    });
    return events;
  }
  // observedRef is the model-read pin/hole. Tolerate its absence (old-format
  // reply) and blank strings.
  const observedRaw = verdict.observedRef ?? null;
  const observed =
    observedRaw !== null && observedRaw.trim() !== "" ? observedRaw.trim() : null;
  const matched =
    observed !== null
      ? req.expectedTargets.find((t) => refsEqual(t, observed))
      : undefined;
  if (observed !== null && matched === undefined) {
    // The model read a SPECIFIC pin that is not an expected target - this is
    // what powers "wrong hole: expected D2 row, saw D4".
    events.push({
      type: "misplaced",
      atMs,
      edgeId: req.edgeId,
      expected: req.expectedTargets,
      observed,
    });
    return events;
  }
  // A matched observedRef confirms the tip even when tipOnTarget was hedged.
  if (verdict.tipOnTarget || matched !== undefined) {
    events.push({ type: "tip-at", atMs, ref: matched ?? req.expectedTargets[0] });
  }
  if (req.phase === "awaiting-seat" && verdict.seated) {
    events.push({ type: "seated", atMs, edgeId: req.edgeId });
  }
  return events;
}

function json(body: PerceiveResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function messageText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function askVision(
  client: Anthropic,
  req: PerceiveRequest,
  extraInstruction?: string,
): Promise<string> {
  const { data, mediaType } = normalizeFrame(req.frameBase64);
  const prompt = extraInstruction
    ? `${buildVisionPrompt(req)}\n\n${extraInstruction}`
    : buildVisionPrompt(req);
  // Image before text per the vision docs. Thinking handling is per-model:
  // Sonnet 5 runs adaptive thinking by default, so it gets an explicit
  // disable to keep the ~300-token budget on the JSON verdict; Haiku 4.5
  // has no adaptive mode and runs without thinking when the field is
  // omitted (models overview - docs/references-livelab.md), so the param
  // is left off rather than sending a config the model may reject.
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: req.model,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  };
  if (req.model === PERCEIVE_MODEL) {
    params.thinking = { type: "disabled" };
  }
  const message = await client.messages.create(params);
  return messageText(message);
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ events: [], note: "invalid request: body is not JSON" }, 400);
  }

  const parsed = perceiveRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      { events: [], note: `invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` },
      400,
    );
  }
  const req = parsed.data;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ events: [], note: "no ANTHROPIC_API_KEY: use mock or manual mode" });
  }

  const client = new Anthropic({ apiKey });
  try {
    let text = await askVision(client, req);
    let candidate = extractJson(text);
    let verdict = visionVerdictSchema.safeParse(candidate);
    if (!verdict.success) {
      // One retry with a corrective nudge, per the malformed-output contract.
      text = await askVision(
        client,
        req,
        "Your previous reply was not the required JSON object. Reply again with ONLY the JSON object described above.",
      );
      candidate = extractJson(text);
      verdict = visionVerdictSchema.safeParse(candidate);
    }
    if (!verdict.success) {
      return json({ events: [], note: "vision output malformed after one retry; skipping frame" });
    }
    const events = mapVerdictToEvents(verdict.data, req, Date.now());
    const conf = verdict.data.confidence.toFixed(2);
    const note =
      verdict.data.confidence < MIN_CONFIDENCE
        ? `vlm confidence ${conf} is below ${MIN_CONFIDENCE.toFixed(2)} - this look was ignored`
        : verdict.data.observedRef
          ? `vlm confidence ${conf} - tip read at ${verdict.data.observedRef}`
          : `vlm confidence ${conf}`;
    return json({ events, note });
  } catch (err) {
    const detail =
      err instanceof Anthropic.APIError
        ? `anthropic api error ${err.status ?? "?"}: ${err.message}`
        : `anthropic call failed: ${err instanceof Error ? err.message : String(err)}`;
    // 200 with empty events keeps the live polling loop alive through hiccups.
    return json({ events: [], note: detail });
  }
}
