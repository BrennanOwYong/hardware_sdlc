// Physical-move coach (FEEDBACK item 12, test T19): POST handler logic.
// app/api/coach/route.ts re-exports POST from here so node --test can
// exercise the keyless and validation paths directly (the perceive.ts
// pattern). One claude-sonnet-5 vision call per photo, strict-JSON verdict,
// one corrective retry on malformed output. Keyless and API-error paths
// return 200 with a plain note - this endpoint never 500s by design.
//
// References (verified via WebFetch, see docs/references-coach.md):
// - Vision / base64 image blocks, image-before-text ordering:
//   https://platform.claude.com/docs/en/build-with-claude/vision.md
import Anthropic from "@anthropic-ai/sdk";
import { preciseGuide } from "@/lib/coach/geometry";

import {
  buildCoachPrompt,
  clampCoachGeometry,
  coachRequestSchema,
  coachVerdictSchema,
  degradedCoachResponse,
  extractCoachJson,
  formatRequestIssues,
  KEYLESS_NOTE,
  MALFORMED_NOTE,
  normalizeCoachImage,
  truncateHistory,
  type CoachRequest,
  type CoachResponse,
} from "./contract";

export const COACH_MODEL = "claude-sonnet-5";

/** The verdict JSON carries an objects array, so it needs more room than a
 * boolean verdict; thinking stays disabled so the budget is all JSON. */
const MAX_TOKENS = 700;

function json(body: CoachResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Degrade shape built in contract.ts (pure, covered by tests/coach.test.mjs). */
function degraded(instruction: string, note: string, status = 200): Response {
  return json(degradedCoachResponse(instruction, note), status);
}

function messageText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function askCoach(
  client: Anthropic,
  req: CoachRequest,
  extraInstruction?: string,
): Promise<string> {
  const { data, mediaType } = normalizeCoachImage(req.imageBase64);
  const prompt = buildCoachPrompt({
    goal: req.goal,
    attempt: req.attempt,
    history: truncateHistory(req.history),
  });
  const text = extraInstruction ? `${prompt}\n\n${extraInstruction}` : prompt;
  // Image before text per the vision docs; thinking disabled keeps the
  // small budget on the JSON verdict (adaptive is Sonnet 5's default).
  const message = await client.messages.create({
    model: COACH_MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "disabled" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data } },
          { type: "text", text },
        ],
      },
    ],
  });
  return messageText(message);
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return degraded(
      "Send the photo again - the request body was not readable JSON.",
      "invalid request: body is not JSON",
      400,
    );
  }

  const parsed = coachRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return degraded(
      "Send the photo again - the request was missing something.",
      formatRequestIssues(parsed.error.issues),
      400,
    );
  }
  const req = parsed.data;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return degraded(
      "Coaching needs the server's vision key. Ask whoever runs Forge to set ANTHROPIC_API_KEY, then retake the photo.",
      KEYLESS_NOTE,
    );
  }

  const client = new Anthropic({ apiKey });
  try {
    let text = await askCoach(client, req);
    let candidate = extractCoachJson(text);
    let verdict = coachVerdictSchema.safeParse(candidate);
    if (!verdict.success) {
      // One retry with a corrective nudge, per the malformed-output contract.
      text = await askCoach(
        client,
        req,
        "Your previous reply was not the required JSON object. Reply again with ONLY the JSON object described above.",
      );
      candidate = extractCoachJson(text);
      verdict = coachVerdictSchema.safeParse(candidate);
    }
    if (!verdict.success) {
      return degraded(
        "The coach could not read that photo this time - take it again from the same spot.",
        MALFORMED_NOTE,
      );
    }
    const clamped = clampCoachGeometry(verdict.data);

    // Re-anchor the guidance on segmented pixels. The model says WHAT to do;
    // segmentation says exactly WHERE. Any failure inside returns an estimate
    // rather than nothing, so this never costs us a coaching turn.
    let guide = null;
    try {
      guide = await preciseGuide(req.imageBase64, clamped);
    } catch {
      guide = null;
    }

    return json({
      ...clamped,
      guide,
      note:
        `vlm confidence ${clamped.confidence.toFixed(2)} on attempt ${req.attempt}` +
        (guide ? ` · ${guide.note}` : ""),
    });
  } catch (err) {
    const detail =
      err instanceof Anthropic.APIError
        ? `anthropic api error ${err.status ?? "?"}: ${err.message}`
        : `anthropic call failed: ${err instanceof Error ? err.message : String(err)}`;
    // 200 keeps the try-again loop alive through hiccups; the page shows the note.
    return degraded(
      "The coach hit a temporary problem - try the same photo again in a moment.",
      detail,
    );
  }
}
