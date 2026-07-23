// LLM tweak path for firmware generation.
//
// One Anthropic Messages API call per tweak, with the traced pin map as a
// hard constraint, then post-validation via assertPinsMatch. Callers handle
// fallback to the deterministic template on any failure.
//
// API shapes verified against the sources in docs/references-codegen.md.

import Anthropic from "@anthropic-ai/sdk";
import type { Netlist } from "@/lib/types";
import { assertPinsMatch, extractPinMap, type CircuitHint } from "./template";

export interface LlmTweakArgs {
  netlist: Netlist;
  hint: CircuitHint;
  intent: string;
  apiKey: string;
  /** Validated template sketch the model edits; keeps pin constants anchored. */
  baseCode: string;
}

function stripFences(text: string): string {
  const m = /^```[a-zA-Z0-9+._-]*\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  return m ? m[1] : text.trim();
}

/**
 * Returns the tweaked sketch, or throws. Every thrown error means the caller
 * must fall back to the template path.
 */
export async function generateWithLlm(args: LlmTweakArgs): Promise<string> {
  const { netlist, hint, intent, apiKey, baseCode } = args;
  const map = extractPinMap(netlist);
  const client = new Anthropic({ apiKey });

  const digital = map.digitalPins.map((p) => `D${p}`).join(", ") || "none";
  const system = [
    "You modify Arduino UNO C++ firmware for Forge, a guided hardware assembly assistant.",
    "Hard constraints:",
    `- The physical circuit uses exactly these Arduino UNO pins: ${map.unoRefs.join(", ")}.`,
    `- Wired digital pins: ${digital}. Reference them only through the existing *_PIN constants; keep those constants and their values byte-identical.`,
    "- Never introduce any other digital pin number, in code or comments.",
    "- Keep the sketch complete and compilable for an Arduino UNO.",
    "- Output only the full modified sketch. No markdown fences, no commentary.",
  ].join("\n");

  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 16000,
    system,
    messages: [
      {
        role: "user",
        content: `Circuit: ${hint}. Current sketch:\n\n${baseCode}\nRequested change: ${intent}`,
      },
    ],
  });

  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  const code = stripFences(text);
  if (code.length === 0) {
    throw new Error("model returned no code");
  }

  assertPinsMatch(netlist, code);
  return code.endsWith("\n") ? code : `${code}\n`;
}
