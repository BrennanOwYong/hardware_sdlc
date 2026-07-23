// GET /api/images/<...path> -> bytes of any file under data/images/
// (user/ photo library, practice/ curated media, live-view/ captures).
// Runtime files must stream from data/ because public/ is snapshotted at
// build time in production. Path safety, content-type whitelist, cache
// policy, and Range negotiation live in lib/photos/storage.ts (unit-tested
// in tests/livecaptures.test.mjs). Docs: docs/references-storage.md.

import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import {
  cacheControlFor,
  contentTypeFor,
  imagesRoot,
  resolveImagePath,
  resolveRange,
} from "@/lib/photos/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND_NOTE =
  "No stored image matches that path. User photos live under user/, curated practice media under practice/, live-view captures under live-view/.";

function notFound(pathText: string) {
  return NextResponse.json(
    { error: `no image at ${pathText}`, note: NOT_FOUND_NOTE },
    { status: 404 },
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  const pathText = (segments ?? []).join("/");
  const fullPath = resolveImagePath(imagesRoot(), segments ?? []);
  const contentType = fullPath ? contentTypeFor(fullPath) : undefined;
  if (!fullPath || !contentType) return notFound(pathText);

  let buffer: Buffer;
  try {
    buffer = await readFile(fullPath);
  } catch {
    // Missing file or a directory path: both read as "nothing to serve".
    return notFound(pathText);
  }

  const range = resolveRange(request.headers.get("range"), buffer.byteLength);
  if (range.kind === "unsatisfiable") {
    return NextResponse.json(
      { error: `requested range not satisfiable for ${pathText}` },
      {
        status: 416,
        headers: { "Content-Range": `bytes */${buffer.byteLength}` },
      },
    );
  }

  const slice =
    range.kind === "range"
      ? buffer.subarray(range.start, range.end + 1)
      : buffer;
  // Copy into a fresh ArrayBuffer-backed view so the body satisfies BodyInit
  // under strict TS (Buffer is Uint8Array<ArrayBufferLike>).
  const body = new Uint8Array(slice.byteLength);
  body.set(slice);

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(body.byteLength),
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControlFor(contentType),
  };
  if (range.kind === "range") {
    headers["Content-Range"] =
      `bytes ${range.start}-${range.end}/${buffer.byteLength}`;
  }
  return new NextResponse(body, {
    status: range.kind === "range" ? 206 : 200,
    headers,
  });
}
