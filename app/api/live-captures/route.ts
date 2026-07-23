// POST /api/live-captures -> save one live-view capture (optional clip,
//                            frame jpg, results png, metadata json) under
//                            data/images/live-view/, 201 { id, files }
// GET  /api/live-captures -> { captures } newest first
// Store + zod contract live in lib/photos/liveCaptures.ts so node --test
// covers them outside the Next runtime. Docs: docs/references-storage.md.

import { NextResponse } from "next/server";
import {
  getLiveCaptureStore,
  LiveCaptureError,
  liveCaptureRequestSchema,
} from "@/lib/photos/liveCaptures";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const captures = await getLiveCaptureStore().list();
    return NextResponse.json({ captures });
  } catch {
    return NextResponse.json({
      captures: [],
      note: "Stored live captures could not be listed; data/images/live-view is unreadable right now.",
    });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = liveCaptureRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const meta = await getLiveCaptureStore().save(parsed.data);
    return NextResponse.json({ id: meta.id, files: meta.files }, { status: 201 });
  } catch (err) {
    if (err instanceof LiveCaptureError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // Disk trouble degrades to a plain note, never a 500.
    return NextResponse.json(
      {
        error: "the capture could not be saved",
        note: "Writing under data/images/live-view failed; the capture was not stored. Check disk space and permissions, then retry.",
      },
      { status: 503 },
    );
  }
}
