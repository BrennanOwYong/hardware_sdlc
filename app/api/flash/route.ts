// POST /api/flash: zod-validated FlashRequest -> FlashResult.
// Compiles whenever the CLI + AVR core exist; uploads only when a board is
// awake. Compile-only success is still ok:true (stage "compile") with a note
// telling the beginner to plug the board in. Doc links:
// docs/references-delta-bench.md.

import { NextResponse } from "next/server";
import { z } from "zod";
import type { FlashResult } from "@/lib/types";
import { firmwareHash } from "@/lib/vcs/store";
import { GUIDANCE, pickGuidance } from "@/lib/bench/guidance";
import { cleanupSketch, compileSketch, uploadSketch } from "@/lib/bench/cli";
import { pickTarget, refreshBench } from "@/lib/bench/registry";
import { compileOnlyResult } from "@/lib/bench/parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const flashRequestSchema = z.object({
  code: z.string().min(1, "code must not be empty"),
  deviceId: z.string().optional(),
});

function fail(stage: FlashResult["stage"], output: string, guidance: string): FlashResult {
  return { ok: false, stage, output, guidance };
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be JSON" }, { status: 400 });
  }
  const parsed = flashRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid FlashRequest", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { code, deviceId } = parsed.data;

  const status = await refreshBench();
  if (!status.cliAvailable) {
    return NextResponse.json(fail("compile", "", GUIDANCE["no-cli"]));
  }
  if (!status.coreInstalled) {
    return NextResponse.json(fail("compile", "", GUIDANCE["core-missing"]));
  }

  const target = pickTarget(status, deviceId);
  const fqbn = target?.fqbn ?? "arduino:avr:uno";
  const compiled = await compileSketch(code, fqbn);
  try {
    if (!compiled.ok) {
      return NextResponse.json(
        fail("compile", `[compile]\n${compiled.output}`, GUIDANCE["compile-failed"]),
      );
    }
    const hash = firmwareHash(code);

    if (!target || target.port === null) {
      return NextResponse.json(compileOnlyResult(`[compile]\n${compiled.output}`, hash));
    }

    const uploaded = await uploadSketch(compiled, target.port, fqbn);
    const log = `[compile]\n${compiled.output}\n\n[upload]\n${uploaded.output}`;
    if (!uploaded.ok) {
      return NextResponse.json(
        fail("upload", log, pickGuidance({ stage: "upload", output: uploaded.output })),
      );
    }

    return NextResponse.json({
      ok: true,
      stage: "done",
      output: log,
      firmwareHash: hash,
    } satisfies FlashResult);
  } finally {
    await cleanupSketch(compiled);
  }
}
