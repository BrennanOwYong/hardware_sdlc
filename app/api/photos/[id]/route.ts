// PATCH  /api/photos/<id> -> cache an identify result on a stored photo
// DELETE /api/photos/<id> -> remove the photo (index entry + jpg)
// Next 15: context.params is a Promise (docs/references-p3.md).

import { NextResponse } from "next/server";
import { photoPatchRequestSchema } from "@/lib/photos/contract";
import { getPhotoStore, PhotoError } from "@/lib/photos/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EVICTED_NOTE =
  "That photo is no longer in the library; it may have been evicted to keep the newest 50. Take a fresh photo.";

function photoErrorResponse(err: PhotoError) {
  return NextResponse.json(
    err.status === 404
      ? { error: err.message, note: EVICTED_NOTE }
      : { error: err.message },
    { status: err.status },
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = photoPatchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const store = getPhotoStore();
    const photo = parsed.data.coach
      ? await store.setCoach(id, parsed.data.coach)
      : await store.setInventory(id, parsed.data.inventory!);
    return NextResponse.json({ photo });
  } catch (err) {
    if (err instanceof PhotoError) return photoErrorResponse(err);
    throw err;
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await getPhotoStore().remove(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PhotoError) return photoErrorResponse(err);
    throw err;
  }
}
