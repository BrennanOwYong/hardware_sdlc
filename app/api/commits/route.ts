// GET  /api/commits  -> { commits } in creation order (oldest first)
// POST /api/commits  -> create a commit; parent defaults to head of "main"
// Route handler conventions verified against docs/references-p3.md.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore, VcsError } from "@/lib/vcs/store";

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
  try {
    const commit = await getStore().create(parsed.data);
    return NextResponse.json({ commit }, { status: 201 });
  } catch (err) {
    if (err instanceof VcsError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
