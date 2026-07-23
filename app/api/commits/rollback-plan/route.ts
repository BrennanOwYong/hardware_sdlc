// GET /api/commits/rollback-plan?from=<id>&to=<id>
// -> ordered physical ops turning the `from` board state into the `to` state
//    (removals first), plus the firmware hash to re-flash.

import { NextResponse, type NextRequest } from "next/server";
import { rollbackPlan } from "@/lib/vcs/diff";
import { getStore } from "@/lib/vcs/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const from = request.nextUrl.searchParams.get("from");
  const to = request.nextUrl.searchParams.get("to");
  if (!from || !to) {
    return NextResponse.json(
      { error: "query params `from` and `to` (commit ids) are required" },
      { status: 400 },
    );
  }
  const store = getStore();
  const [fromCommit, toCommit] = await Promise.all([store.get(from), store.get(to)]);
  if (!fromCommit) {
    return NextResponse.json({ error: `commit ${from} not found` }, { status: 404 });
  }
  if (!toCommit) {
    return NextResponse.json({ error: `commit ${to} not found` }, { status: 404 });
  }
  const ops = rollbackPlan(fromCommit.netlist, toCommit.netlist);
  return NextResponse.json({
    from: fromCommit.id,
    to: toCommit.id,
    ops,
    targetFirmwareHash: toCommit.firmware.hash,
  });
}
