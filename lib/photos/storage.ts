// Unified image storage: every runtime media file lives under data/images/
// (user/ photo library, practice/ curated media, live-view/ capture
// artifacts) and is served by GET /api/images/[...path]. public/ is
// snapshotted into production builds, so runtime files must stream from
// data/ via API routes. This module holds the testable pieces (path
// resolution with traversal protection, content-type mapping, Range
// parsing); the route file only wires them to the request.
//
// Runtime imports stay limited to node builtins so tests/livecaptures.test.mjs
// can run this file directly under node --test via type stripping.
// Docs: docs/references-storage.md.

import { resolve, sep } from "node:path";

/** Subdirectories of the storage root; created on demand by their writers. */
export const IMAGE_SUBDIRS = ["user", "practice", "live-view"] as const;

/** Absolute storage root: <cwd>/data/images. */
export function imagesRoot(): string {
  return resolve(process.cwd(), "data", "images");
}

/** Extension (lowercase, no dot) -> served content type. Whitelist: paths
 * with any other extension 404 rather than guessing. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  mp4: "video/mp4",
  webm: "video/webm",
  json: "application/json",
  md: "text/markdown",
};

/** Content type for a file name, or undefined when not servable. */
export function contentTypeFor(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return undefined;
  return CONTENT_TYPES[fileName.slice(dot + 1).toLowerCase()];
}

/**
 * Cache policy per content type. Media bytes under data/images/ never change
 * once written (user/live-view names carry UUIDs; practice files are a
 * curated fixed set), so browsers may cache hard. json/md (manifest,
 * attribution) may be edited in place and are revalidated every time.
 */
export function cacheControlFor(contentType: string): string {
  return contentType === "application/json" || contentType === "text/markdown"
    ? "no-store"
    : "public, max-age=31536000, immutable";
}

const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolves catch-all URL segments against a storage root. Returns the
 * absolute file path, or undefined for anything unsafe: empty segment
 * lists, segments failing the allowlist (dot-leading names, "..", path
 * separators, NUL, anything outside [A-Za-z0-9._-]), and — defense in
 * depth — any resolved path that escapes the root (resolve + prefix check).
 */
export function resolveImagePath(
  root: string,
  segments: readonly string[],
): string | undefined {
  if (segments.length === 0) return undefined;
  for (const s of segments) {
    if (!SAFE_SEGMENT_RE.test(s)) return undefined;
    if (s === "." || s === ".." || s.includes("/") || s.includes("\\")) {
      return undefined;
    }
  }
  const rootAbs = resolve(root);
  const full = resolve(rootAbs, ...segments);
  if (full === rootAbs || !full.startsWith(rootAbs + sep)) return undefined;
  return full;
}

/** Outcome of Range-header negotiation over a file of known size. */
export type RangeResult =
  | { kind: "full" }
  | { kind: "range"; start: number; end: number } // inclusive byte offsets
  | { kind: "unsatisfiable" };

/**
 * Single-range "bytes=start-end" negotiation (RFC 9110 §14). Safari and
 * mobile browsers refuse <video> playback without 206 support, so the
 * images route honors one range. Malformed or multi-range headers fall
 * back to a full 200 (the RFC lets a server ignore Range); a start at or
 * past the file size is unsatisfiable (416).
 */
export function resolveRange(
  header: string | null | undefined,
  size: number,
): RangeResult {
  if (!header) return { kind: "full" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "full" };
  if (size === 0) return { kind: "unsatisfiable" };
  if (m[1] === "") {
    // Suffix form "bytes=-N": the final N bytes.
    const suffix = Number(m[2]);
    if (suffix === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return { kind: "unsatisfiable" };
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return { kind: "full" };
  return { kind: "range", start, end };
}
