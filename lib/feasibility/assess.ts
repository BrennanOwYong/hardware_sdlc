// POST /api/assess — given a goal and the parts the camera found, judge whether
// the build is possible and name what is missing. Logic lives here so the route
// file stays a handler-only re-export (the lib/coach/coach.ts pattern).
import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import {
  assessRequestSchema,
  assessResponseSchema,
  type AssessResponse,
} from "@/lib/feasibility/contract";
import { buildAssessPrompt, extractJson, fallbackAssessment } from "@/lib/feasibility/pure";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1200;

function messageText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const parsed = assessRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      { status: 400 },
    );
  }

  const { goal, parts } = parsed.data;
  const partLines = parts.map((p) => `${p.label} (${p.partType})`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(fallbackAssessment(goal, partLines));
  }

  const client = new Anthropic({ apiKey });
  const prompt = buildAssessPrompt(goal, partLines);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      });
      const candidate = assessResponseSchema.safeParse(
        extractJson(messageText(message)),
      );
      if (candidate.success) {
        const result: AssessResponse = candidate.data;
        return NextResponse.json(result);
      }
    } catch (err) {
      const degraded = fallbackAssessment(goal, partLines);
      degraded.note =
        err instanceof Anthropic.APIError
          ? `assessment unreachable (${err.status}): showing the standard starter list`
          : "assessment unreachable: showing the standard starter list";
      return NextResponse.json(degraded);
    }
  }

  const degraded = fallbackAssessment(goal, partLines);
  degraded.note =
    "the assessment replied in an unexpected shape twice: showing the standard starter list";
  return NextResponse.json(degraded);
}
