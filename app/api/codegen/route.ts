// POST /api/codegen: zod-validated CodegenRequest -> CodegenResult.
// Response may carry an extra `note` string explaining degraded paths
// (mock path without ANTHROPIC_API_KEY, LLM fallback to template).

import { NextResponse } from "next/server";
import { z } from "zod";
import type { CodegenRequest } from "@/lib/types";
import { CodegenError, runCodegen } from "@/lib/codegen";

export const runtime = "nodejs";

const netlistEdgeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["wire", "component"]),
  part: z.string().optional(),
  value: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
});

const codegenRequestSchema = z.object({
  netlist: z.object({
    edges: z.array(netlistEdgeSchema).min(1),
  }),
  circuitHint: z.enum(["button-led", "dht11"]).optional(),
  intent: z.string().max(500).optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be JSON" }, { status: 400 });
  }

  const parsed = codegenRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid CodegenRequest", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const request: CodegenRequest = parsed.data;
  try {
    const { result, note } = await runCodegen(request);
    return NextResponse.json(note !== undefined ? { ...result, note } : result);
  } catch (err) {
    if (err instanceof CodegenError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json({ error: "codegen failed" }, { status: 500 });
  }
}
