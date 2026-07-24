// Physical-move coach (FEEDBACK item 12, test T19): pure contract pieces.
// Zod schemas for POST /api/coach, the vision prompt builder, history
// truncation, JSON extraction, and geometry clamping. This file keeps project
// imports type-only and node_modules imports to zod alone, so both the client
// page and tests/coach.test.mjs (node --test with Node 24 type stripping) can
// load it directly. The Anthropic call lives in lib/coach/coach.ts.
//
// References: docs/references-coach.md (Anthropic vision doc re-verified for
// this build).
import { z } from "zod";

/** At most this many prior instructions travel with a request. */
export const HISTORY_MAX = 5;

/** POST /api/coach request body. */
export const coachRequestSchema = z.object({
  /** What the user is trying to do, e.g. "plug the USB cable into the Arduino's USB socket". */
  goal: z.string().min(1).max(200),
  /** The attempt photo: data URL (data:image/...;base64,...) or bare base64 (JPEG assumed). */
  imageBase64: z.string().min(1),
  /** 1-based attempt counter; bumps on every "Try again with a new photo". */
  attempt: z.number().int().min(1),
  /** Prior coach instructions, oldest first, capped at HISTORY_MAX. */
  history: z.array(z.string().min(1)).max(HISTORY_MAX).optional(),
});
export type CoachRequest = z.infer<typeof coachRequestSchema>;

const point01 = z.object({ x: z.number(), y: z.number() });

/** Strict JSON the vision model must return (defaults tolerate omitted nulls). */
export const coachVerdictSchema = z.object({
  verdict: z.enum(["adjust", "done", "cannot-see"]),
  /** One plain beginner sentence: how to move, confirmation, or what to reshoot. */
  instruction: z.string().min(1),
  /** Every object involved in the goal, bbox [x, y, w, h] normalized 0..1. */
  objects: z
    .array(
      z.object({
        label: z.string().min(1),
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      }),
    )
    .default([]),
  /** The exact destination (socket, port, hole) center, or null when unseen. */
  target: point01.extend({ label: z.string().min(1) }).nullable().default(null),
  /** Movement arrow: from the part's current spot to where it must go. */
  arrow: z.object({ from: point01, to: point01 }).nullable().default(null),
  confidence: z.number().min(0).max(1),
});
export type CoachVerdict = z.infer<typeof coachVerdictSchema>;

/** POST /api/coach response: the (clamped) verdict plus an optional plain note. */
export const coachResponseSchema = coachVerdictSchema.extend({
  note: z.string().optional(),
});
export type CoachResponse = z.infer<typeof coachResponseSchema>;

/** Keeps the most recent HISTORY_MAX instructions (oldest dropped first). */
export function truncateHistory(history: readonly string[] | undefined): string[] {
  if (!history || history.length === 0) return [];
  return history.slice(-HISTORY_MAX);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Clips every coordinate into 0..1 so a slightly out-of-range model reply
 * still renders inside the photo instead of failing validation or drawing
 * markers off-frame. bbox w/h are clamped so x+w and y+h stay inside too.
 */
export function clampCoachGeometry(verdict: CoachVerdict): CoachVerdict {
  return {
    ...verdict,
    objects: verdict.objects.map((o) => {
      const x = clamp01(o.bbox[0]);
      const y = clamp01(o.bbox[1]);
      return {
        label: o.label,
        bbox: [x, y, Math.min(clamp01(o.bbox[2]), 1 - x), Math.min(clamp01(o.bbox[3]), 1 - y)],
      };
    }),
    target: verdict.target
      ? { x: clamp01(verdict.target.x), y: clamp01(verdict.target.y), label: verdict.target.label }
      : null,
    arrow: verdict.arrow
      ? {
          from: { x: clamp01(verdict.arrow.from.x), y: clamp01(verdict.arrow.from.y) },
          to: { x: clamp01(verdict.arrow.to.x), y: clamp01(verdict.arrow.to.y) },
        }
      : null,
  };
}

/** Note for the keyless degrade (200, never 500). */
export const KEYLESS_NOTE = "no ANTHROPIC_API_KEY: the photo was not analyzed";

/** Note when the model output stays malformed after the one retry. */
export const MALFORMED_NOTE =
  "vision output malformed after one retry; nothing was judged";

/**
 * A response the page can always render: cannot-see verdict, zero markers,
 * plain-language note. Every degrade path (keyless, malformed, API error,
 * invalid request) returns this shape so the client never special-cases.
 */
export function degradedCoachResponse(
  instruction: string,
  note: string,
): CoachResponse {
  return {
    verdict: "cannot-see",
    instruction,
    objects: [],
    target: null,
    arrow: null,
    confidence: 0,
    note,
  };
}

/** zod issues -> the "invalid request: ..." note (the perceive.ts format). */
export function formatRequestIssues(issues: readonly z.ZodIssue[]): string {
  return `invalid request: ${issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ")}`;
}

/** Pulls the first {...} span out of model text and parses it. Null on failure. */
export function extractCoachJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export interface CoachPromptInput {
  goal: string;
  attempt: number;
  history: readonly string[];
}

/**
 * The coaching prompt: name the involved objects, locate the exact
 * destination, judge the CURRENT photo against the goal and the prior
 * instructions, and when wrong say how to move in beginner physical terms.
 */
export function buildCoachPrompt(input: CoachPromptInput): string {
  const history = truncateHistory(input.history);
  const historyBlock =
    history.length === 0
      ? "This is the first photo for this goal; there are no prior instructions."
      : [
          "Instructions you already gave on earlier photos (oldest first):",
          ...history.map((h, i) => `${i + 1}. ${h}`),
          "Judge whether the user followed them. If an earlier instruction was",
          "ignored or overdone, say so in plain words and give the corrected move.",
        ].join("\n");
  return [
    "You are a hands-on assembly coach for a complete beginner working on an",
    "electronics workbench. The user told you their goal, tried a physical move,",
    "and photographed the result. Coach their NEXT move.",
    "",
    "IMPORTANT: the photo may be a SIMULATED workspace - the user may be dragging",
    "image cutouts or illustrations of parts (USB cables, Arduino boards,",
    "breadboards, wires, plugs) around a slide, paint canvas, or screen share.",
    "Treat cutouts and illustrations exactly as if they were real physical parts.",
    "Never dismiss the scene as fake.",
    "",
    `Goal: ${input.goal}`,
    `This is attempt number ${input.attempt}.`,
    historyBlock,
    "",
    "Do all of this, in order:",
    "1. Name every object involved in the goal that you can see (the thing being",
    "   moved AND its destination). Put each in objects with a short label and a",
    "   tight bbox [x, y, width, height], all normalized 0..1 from the top-left.",
    "2. Locate the EXACT destination - the specific socket, port, or hole the",
    "   goal names (e.g. the Arduino's USB-B socket, not the whole board). Set",
    "   target to its center {x, y} with a short label. Null only if unseen.",
    "3. Judge the CURRENT state in this photo against the goal and the prior",
    "   instructions. Decide the verdict:",
    '   - "done": the goal is achieved (e.g. the plug is fully seated in the',
    "     socket). instruction = one short congratulating confirmation sentence.",
    '   - "adjust": not there yet or something is wrong. instruction = ONE plain',
    "     sentence a beginner can follow, in physical terms: direction, distance,",
    '     rotation, flipping. Examples: "Rotate the plug so its flat side faces',
    '     up." / "Move the cable about two centimeters left, toward the silver',
    '     socket." / "Flip the connector over and push it straight in." Name',
    "     things by look (color, shape, position), never by jargon.",
    '   - "cannot-see": the moved part or the destination is not visible enough',
    "     to judge. instruction = one sentence saying exactly what to reshoot",
    "     (get closer, change angle, add light, include the socket in frame).",
    "4. arrow: when the part must move, set from = the part's current center and",
    "   to = where it should go (usually the target). Null when no move is",
    "   needed or you cannot see enough.",
    "5. confidence: 0..1, how sure you are of this verdict.",
    "",
    "Respond with ONLY this JSON object - no markdown fences, no prose:",
    '{"verdict": "adjust" | "done" | "cannot-see", "instruction": string, "objects": [{"label": string, "bbox": [x, y, w, h]}], "target": {"x": number, "y": number, "label": string} | null, "arrow": {"from": {"x": number, "y": number}, "to": {"x": number, "y": number}} | null, "confidence": number between 0 and 1}',
  ].join("\n");
}

export type CoachMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** Splits an optional data: URL prefix off and returns clean base64 + media type. */
export function normalizeCoachImage(imageBase64: string): {
  data: string;
  mediaType: CoachMediaType;
} {
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,/.exec(imageBase64);
  if (match) {
    return {
      data: imageBase64.slice(match[0].length),
      mediaType: match[1] as CoachMediaType,
    };
  }
  return { data: imageBase64, mediaType: "image/jpeg" };
}
