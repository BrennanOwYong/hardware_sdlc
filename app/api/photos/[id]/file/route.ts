// GET /api/photos/<id>/file -> the stored image bytes.
// Streams from data/photos/ at request time. public/ is snapshotted at build
// time in production, so runtime-stored user content must never live there.
// Binary Response shape per the Next.js route.js docs (docs/references-photolib.md).

import { NextResponse } from "next/server";
import { getPhotoStore } from "@/lib/photos/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const image = await getPhotoStore().readImage(id);
  if (!image) {
    return NextResponse.json(
      {
        error: `photo ${id} not found`,
        note: "That photo is no longer in the library; it may have been evicted to keep the newest 50.",
      },
      { status: 404 },
    );
  }
  // Copy into a fresh ArrayBuffer-backed view so the body satisfies BodyInit
  // under strict TS (Buffer is Uint8Array<ArrayBufferLike>).
  const body = new Uint8Array(image.buffer.byteLength);
  body.set(image.buffer);
  // Ids are UUIDs and stored bytes never change, so the browser may cache hard.
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": image.mediaType,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
