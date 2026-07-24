// POST /api/journal -> append one pending build-journal entry (coach step or
//                      flash event); saves the frame image when frameDataUrl
//                      is present.
// GET  /api/journal -> { entries } still pending (not yet drained into a
//                      commit by POST /api/commits).
// Store + lifecycle: lib/journal/store.ts.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getJournalStore, JournalError } from "@/lib/journal/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const appendSchema = z.object({
  kind: z.enum(["coach", "flash"]),
  summary: z.string().min(1),
  detail: z.string().optional(),
  goal: z.string().optional(),
  attempt: z.string().optional(),
  verdict: z.string().optional(),
  firmwareHash: z.string().optional(),
  frameDataUrl: z.string().optional(),
});

export async function GET() {
  const entries = await getJournalStore().listPending();
  return NextResponse.json({ entries });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = appendSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const entry = await getJournalStore().appendPending(parsed.data);
    return NextResponse.json({ entry }, { status: 201 });
  } catch (err) {
    if (err instanceof JournalError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
