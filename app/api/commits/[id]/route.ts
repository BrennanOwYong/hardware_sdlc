// GET /api/commits/<id> -> { commit } or 404.
// Next 15: context.params is a Promise (see docs/references-p3.md).

import { NextResponse } from "next/server";
import { getStore } from "@/lib/vcs/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const commit = await getStore().get(id);
  if (!commit) {
    return NextResponse.json({ error: `commit ${id} not found` }, { status: 404 });
  }
  return NextResponse.json({ commit });
}
