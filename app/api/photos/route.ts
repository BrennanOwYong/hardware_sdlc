// GET  /api/photos -> { photos } newest first, meta only unless ?full=1
// POST /api/photos -> store the client's rasterized JPEG, 201 { photo }
// Route handler conventions: docs/references-p3.md, docs/references-photolib.md.

import { NextResponse, type NextRequest } from "next/server";
import { photoCreateRequestSchema } from "@/lib/photos/contract";
import { getPhotoStore, PhotoError, type PhotoEntry } from "@/lib/photos/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toMeta(entry: PhotoEntry): Omit<PhotoEntry, "inventory"> {
  return {
    id: entry.id,
    capturedAt: entry.capturedAt,
    bytes: entry.bytes,
    width: entry.width,
    height: entry.height,
    label: entry.label,
    mediaType: entry.mediaType,
  };
}

export async function GET(request: NextRequest) {
  const full = request.nextUrl.searchParams.get("full") === "1";
  const photos = await getPhotoStore().list();
  return NextResponse.json({ photos: full ? photos : photos.map(toMeta) });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = photoCreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const photo = await getPhotoStore().add(parsed.data);
    return NextResponse.json({ photo }, { status: 201 });
  } catch (err) {
    if (err instanceof PhotoError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
