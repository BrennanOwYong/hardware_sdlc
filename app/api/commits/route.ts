// GET  /api/commits  -> { commits } in creation order (oldest first)
// POST /api/commits  -> create a commit; parent defaults to head of "main".
//                       Pending build-journal entries (coach steps, flash
//                       events) are drained into the new commit's `journal`
//                       field, so the timeline shows the steps DONE between
//                       commits, not only end states (FEEDBACK 13).
// Route handler conventions verified against docs/references-p3.md.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore, VcsError } from "@/lib/vcs/store";
import { getJournalStore } from "@/lib/journal/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const edgeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["wire", "component"]),
  part: z.string().optional(),
  value: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
});

const createSchema = z.object({
  message: z.string().min(1),
  netlist: z.object({ edges: z.array(edgeSchema) }),
  firmware: z.object({ code: z.string(), hash: z.string().min(1) }),
  photoDataUrl: z.string().optional(),
  parent: z.string().optional(),
});

export async function GET() {
  const commits = await getStore().list();
  return NextResponse.json({ commits });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  // Drain pending journal entries into this commit. On a failed create the
  // drained entries go back to the pending list so they attach to the next
  // successful commit instead of vanishing.
  const journalStore = getJournalStore();
  const journal = await journalStore.drainPending();
  try {
    const commit = await getStore().create({ ...parsed.data, journal });
    return NextResponse.json({ commit }, { status: 201 });
  } catch (err) {
    await journalStore.restorePending(journal);
    if (err instanceof VcsError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
