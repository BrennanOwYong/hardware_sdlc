// Codegen orchestrator: canned transforms first, LLM second, deterministic
// template as the floor. Every path returns a CodegenResult; the optional
// note explains any degradation (mock path, LLM fallback).

import type { CodegenRequest, CodegenResult } from "@/lib/types";
import {
  generateTemplate,
  inferCircuitHint,
  parseIntent,
  sha256,
  type CircuitHint,
} from "./template";
import { generateWithLlm } from "./llm";

export { CodegenError } from "./template";

export interface CodegenOutcome {
  result: CodegenResult;
  note?: string;
}

function finish(code: string, pinsUsed: string[], via: CodegenResult["via"]): CodegenResult {
  return { code, hash: sha256(code), pinsUsed, via };
}

export async function runCodegen(request: CodegenRequest): Promise<CodegenOutcome> {
  const hint: CircuitHint = request.circuitHint ?? inferCircuitHint(request.netlist);
  const intent = request.intent?.trim();
  const base = generateTemplate(request.netlist, hint);

  if (!intent) {
    return { result: finish(base.code, base.pinsUsed, "template") };
  }

  const canned = parseIntent(intent, hint);
  if (canned !== null) {
    const tweaked = generateTemplate(request.netlist, hint, canned);
    return {
      result: finish(tweaked.code, tweaked.pinsUsed, "template"),
      note: `Canned transform applied for intent "${intent}".`,
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      result: finish(base.code, base.pinsUsed, "template"),
      note:
        `Mock path: ANTHROPIC_API_KEY is not set and intent "${intent}" ` +
        "matches no canned transform. Returned the deterministic template unchanged.",
    };
  }

  try {
    const code = await generateWithLlm({
      netlist: request.netlist,
      hint,
      intent,
      apiKey,
      baseCode: base.code,
    });
    return { result: finish(code, base.pinsUsed, "llm") };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      result: finish(base.code, base.pinsUsed, "template"),
      note: `LLM tweak rejected (${reason}); fell back to the validated template.`,
    };
  }
}
