// Pure planning helpers: no SDK, no next/server, so `node --test` can load
// this directly under Node's type stripping (the same split that keeps
// lib/perception/perceive.ts testable).
import type { WirePlanResponse } from "@/lib/plan/contract";

/** Models sometimes fence their JSON; take the outermost object either way. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function buildPlanPrompt(idea: string, history: string[]): string {
  return [
    "You help a total beginner turn a hardware idea into a concrete parts list.",
    "The user owns no parts yet and has never wired a breadboard.",
    "",
    history.length > 0 ? "Conversation so far:\n" + history.join("\n") + "\n" : "",
    `The user's idea: ${idea}`,
    "",
    "Reply with ONE JSON object and nothing else:",
    '{"reply": "<two sentences, plain words, no jargon>", "parts": [{"name": "...", "partKey": "uno|breadboard|jumpers|led|resistor|button|dht11|usb-cable or null", "qty": 1, "why": "<why this part, one short clause>"}]}',
    "",
    "Include `parts` as soon as you can name a workable starter build; ask at most one clarifying question before committing to a list.",
    "Prefer the beginner staples that map to a partKey. Keep the list under 8 entries.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildWirePrompt(goal: string, partNames: string[]): string {
  return [
    "You are planning the wiring for a beginner's breadboard build.",
    `Goal: ${goal}`,
    `Parts on the bench: ${partNames.join(", ")}`,
    "",
    "Reply with ONE JSON object and nothing else:",
    '{"steps": [{"index": 1, "fromPart": "<exact part name>", "toPart": "<exact part name>", "instruction": "<one plain sentence a beginner can follow>", "checkDetail": "<what the user should see or feel when it is right>"}], "endStateSummary": "<two sentences describing the finished circuit>", "checks": ["<thing to verify before powering on>"]}',
    "",
    "Use only the part names given. Six steps or fewer. Name specific pins (D13, GND, 5V) where it helps.",
  ].join("\n");
}

/** Deterministic wiring so the assemble beat never dead-ends without a key. */
export function fallbackWirePlan(partNames: string[]): WirePlanResponse {
  const board = partNames.find((n) => /uno|arduino/i.test(n)) ?? partNames[0];
  const bb = partNames.find((n) => /breadboard/i.test(n)) ?? partNames[1] ?? board;
  const led = partNames.find((n) => /led/i.test(n)) ?? partNames[2] ?? bb;
  const res = partNames.find((n) => /resistor/i.test(n)) ?? led;
  return {
    steps: [
      {
        index: 1,
        fromPart: board,
        toPart: bb,
        instruction: `Run a jumper from the ${board} GND pin to the blue rail on the ${bb}.`,
        checkDetail: "The wire sits flat in the hole and does not wobble.",
      },
      {
        index: 2,
        fromPart: led,
        toPart: bb,
        instruction: `Push the ${led} into two different rows of the ${bb}, long leg on the upper row.`,
        checkDetail: "Both legs are in separate rows, never the same row.",
      },
      {
        index: 3,
        fromPart: res,
        toPart: bb,
        instruction: `Bridge the ${led} short leg row to the blue rail with the ${res}.`,
        checkDetail: "The resistor spans from the LED row to the ground rail.",
      },
      {
        index: 4,
        fromPart: board,
        toPart: led,
        instruction: `Run a jumper from ${board} pin D13 to the ${led} long-leg row.`,
        checkDetail: "D13 connects to the row holding the long leg only.",
      },
    ],
    endStateSummary: `The ${board} drives the ${led} through a current-limiting ${res}, with ground returning to the board. Powering the board over USB should light the LED under program control.`,
    checks: [
      "No wire bridges 5V straight to GND.",
      "The LED long leg goes to the signal pin, short leg to ground.",
      "Every jumper is fully seated, not resting on top of a hole.",
    ],
    note: "deterministic fallback wiring plan",
  };
}
