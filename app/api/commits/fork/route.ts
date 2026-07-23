// POST /api/commits/fork { fromId, branch } -> new commit on the new branch,
// parent = fromId, board state copied from the source commit.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore, VcsError } from "@/lib/vcs/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const forkSchema = z.object({
  fromId: z.string().min(1),
  branch: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "letters, digits, dot, dash, underscore"),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = forkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const commit = await getStore().fork(parsed.data.fromId, parsed.data.branch);
    return NextResponse.json({ commit }, { status: 201 });
  } catch (err) {
    if (err instanceof VcsError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
