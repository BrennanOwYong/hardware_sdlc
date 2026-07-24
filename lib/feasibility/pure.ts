// Pure feasibility helpers: no SDK, no next/server, so `node --test` can load
// this directly (the lib/plan/pure.ts split).
import type { AssessResponse } from "@/lib/feasibility/contract";

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

export function buildAssessPrompt(goal: string, partLines: string[]): string {
  return [
    "A beginner photographed their desk and wants to know whether they can build something with what is there.",
    "",
    `What they want to build: ${goal}`,
    "",
    partLines.length > 0
      ? `What the camera found on the desk:\n${partLines.map((p) => `- ${p}`).join("\n")}`
      : "The camera found nothing usable on the desk.",
    "",
    "Judge honestly. Everyday objects (phone stands, power banks, pens, tweezers, boxes) are NOT electronic components; say so plainly instead of stretching them into roles they cannot fill. A power bank can sometimes serve as a 5V USB power source, and tweezers can help handle small parts, so credit genuinely useful items, but never pretend a pen is a resistor.",
    "",
    "Reply with ONE JSON object and nothing else:",
    '{"required": [{"kind": "uno|breadboard|jumpers|led|resistor|button|dht11|usb-cable|sensor|battery|other", "name": "<part>", "qty": <how many this build needs>, "why": "<what it is for>", "critical": true}], "verdict": "ready|partial|not-possible", "summary": "<one plain sentence a beginner understands>", "usable": [{"name": "<what you saw>", "role": "<the job it can do in THIS build>"}], "unusable": [{"name": "<what you saw>", "why": "<why it does not help here>"}], "missing": [{"name": "<part to get>", "partKey": "uno|breadboard|jumpers|led|resistor|button|dht11|usb-cable or null", "qty": 1, "why": "<what it is for>", "critical": true}], "nextStep": "<the single next thing they should do>"}',
    "",
    "`required` is the FULL bill of materials for this build with exact quantities, listing every part whether or not the desk already has it. Count carefully: a circuit connecting a sensor and an LED to a board typically needs four to six jumper wires, not one. Quantities drive a have-versus-need comparison, so a vague number produces bad advice.",
    'Use "ready" only when nothing is missing. Use "not-possible" when none of the electronics exist yet. Keep every string under 140 characters, no jargon.',
  ].join("\n");
}

/** Deterministic assessment when no key is available. */
export function fallbackAssessment(
  goal: string,
  partLines: string[],
): AssessResponse {
  return {
    required: [
      { kind: "uno", name: "Arduino Uno", qty: 1, why: "runs your code", critical: true },
      { kind: "breadboard", name: "Half-size breadboard", qty: 1, why: "holds the circuit", critical: true },
      { kind: "jumpers", name: "Jumper wires", qty: 6, why: "connects everything", critical: true },
      { kind: "led", name: "LED", qty: 1, why: "something you can see", critical: false },
      { kind: "resistor", name: "220 ohm resistor", qty: 1, why: "protects the LED", critical: false },
    ],
    verdict: "not-possible",
    summary:
      "Offline mode cannot judge your photo, so here is the usual starter kit for a first electronics build.",
    usable: [],
    unusable: partLines.slice(0, 6).map((name) => ({
      name,
      why: "Offline mode cannot tell whether this helps.",
    })),
    missing: [
      { name: "Arduino Uno", partKey: "uno", qty: 1, why: "runs your code", critical: true },
      {
        name: "Half-size breadboard",
        partKey: "breadboard",
        qty: 1,
        why: "holds the circuit without soldering",
        critical: true,
      },
      {
        name: "Jumper wires",
        partKey: "jumpers",
        qty: 1,
        why: "connects the board to the parts",
        critical: true,
      },
      { name: "LED", partKey: "led", qty: 1, why: "something you can see switch on", critical: false },
      {
        name: "220 ohm resistor",
        partKey: "resistor",
        qty: 1,
        why: "protects the LED",
        critical: false,
      },
    ],
    nextStep: `Set ANTHROPIC_API_KEY, then retake the photo to get a real judgement for "${goal.slice(0, 60)}".`,
    note: "ANTHROPIC_API_KEY is not set: this is a canned starter list, not a reading of your photo.",
  };
}

/** Everyday-object heuristic used to caption the parts strip. */
export function looksElectronic(partType: string, label: string): boolean {
  const t = `${partType} ${label}`.toLowerCase();
  return /microcontroller|arduino|esp32|breadboard|resistor|led|sensor|jumper|wire|capacitor|button|switch|module|chip|diode|transistor|battery|power/.test(
    t,
  );
}
