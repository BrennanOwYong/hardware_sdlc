// Idea-to-parts planning conversation, and the wiring plan for the parts the
// user ends up holding. Logic lives here (not in the route file) so the route
// stays a handler-only re-export, matching lib/coach/coach.ts.
import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import {
  planRequestSchema,
  plannedPartSchema,
  wirePlanRequestSchema,
  wireStepSchema,
  type PlanResponse,
  type WirePlanResponse,
} from "@/lib/plan/contract";
import { z } from "zod";
import {
  buildPlanPrompt,
  buildWirePrompt,
  extractJson,
  fallbackWirePlan,
} from "@/lib/plan/pure";

export { buildPlanPrompt, buildWirePrompt, extractJson, fallbackWirePlan };

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 900;

const KEYLESS_NOTE =
  "ANTHROPIC_API_KEY is not set, so planning is offline. The parts list below is a canned starter build.";

/** Canned plan so the wizard demos end to end with no key. */
const FALLBACK_PARTS = [
  { name: "Arduino Uno", partKey: "uno" as const, qty: 1, why: "runs the code" },
  {
    name: "Half-size breadboard",
    partKey: "breadboard" as const,
    qty: 1,
    why: "holds the circuit without soldering",
  },
  {
    name: "Jumper wires",
    partKey: "jumpers" as const,
    qty: 1,
    why: "connects the board to the parts",
  },
  { name: "LED", partKey: "led" as const, qty: 1, why: "the output you can see" },
  {
    name: "220 ohm resistor",
    partKey: "resistor" as const,
    qty: 1,
    why: "protects the LED from too much current",
  },
];

const planJsonSchema = z.object({
  reply: z.string().min(1),
  parts: z.array(plannedPartSchema).optional(),
});

const wirePlanJsonSchema = z.object({
  steps: z.array(wireStepSchema).min(1),
  endStateSummary: z.string().min(1),
  checks: z.array(z.string()).min(1),
});

function messageText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function callModel(prompt: string, client: Anthropic): Promise<string> {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  });
  return messageText(message);
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const parsed = planRequestSchema.safeParse(body);
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const degraded: PlanResponse = {
      reply:
        "Planning needs an API key, so here is a starter build you can walk through anyway.",
      parts: FALLBACK_PARTS,
      note: KEYLESS_NOTE,
    };
    return NextResponse.json(degraded);
  }

  const history = (parsed.data.history ?? []).map(
    (t) => `${t.role === "user" ? "User" : "You"}: ${t.text}`,
  );
  const prompt = buildPlanPrompt(parsed.data.idea, history);
  const client = new Anthropic({ apiKey });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const text = await callModel(prompt, client);
      const candidate = planJsonSchema.safeParse(extractJson(text));
      if (candidate.success) {
        const result: PlanResponse = {
          reply: candidate.data.reply,
          ...(candidate.data.parts ? { parts: candidate.data.parts } : {}),
        };
        return NextResponse.json(result);
      }
    } catch (err) {
      const degraded: PlanResponse = {
        reply: "The planner is unreachable right now; here is a starter build.",
        parts: FALLBACK_PARTS,
        note:
          err instanceof Anthropic.APIError
            ? `planner error (${err.status}): showing a canned starter build`
            : "planner error: showing a canned starter build",
      };
      return NextResponse.json(degraded);
    }
  }

  const degraded: PlanResponse = {
    reply: "The planner replied in an unexpected shape; here is a starter build.",
    parts: FALLBACK_PARTS,
    note: "planner returned malformed JSON twice: showing a canned starter build",
  };
  return NextResponse.json(degraded);
}

export async function POST_WIREPLAN(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = wirePlanRequestSchema.safeParse(body);
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

  const names = parsed.data.parts.map((p) => p.name);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      ...fallbackWirePlan(names),
      note: "ANTHROPIC_API_KEY is not set: showing a deterministic wiring plan.",
    });
  }

  const client = new Anthropic({ apiKey });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const text = await callModel(buildWirePrompt(parsed.data.goal, names), client);
      const candidate = wirePlanJsonSchema.safeParse(extractJson(text));
      if (candidate.success) return NextResponse.json(candidate.data);
    } catch {
      return NextResponse.json({
        ...fallbackWirePlan(names),
        note: "wiring planner unreachable: showing a deterministic plan.",
      });
    }
  }
  return NextResponse.json({
    ...fallbackWirePlan(names),
    note: "wiring planner returned malformed JSON twice: showing a deterministic plan.",
  });
}
