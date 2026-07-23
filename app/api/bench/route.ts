// GET /api/bench -> BenchStatus. Fresh board scan on every call (the nav chip
// polls ~5s, the bench page ~3s). Degrades to cliAvailable:false with a
// beginner note when arduino-cli is missing. Doc links:
// docs/references-delta-bench.md.

import { NextResponse } from "next/server";
import type { BenchStatus } from "@/lib/types";
import { refreshBench } from "@/lib/bench/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<BenchStatus>> {
  const status = await refreshBench();
  return NextResponse.json(status);
}
