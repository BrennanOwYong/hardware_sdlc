# Storage unification: one images root

Date: 2026-07-24. Builder: storage-unification.

## Layout

```
data/images/
  user/       photo library (index.json + <id>.jpg), was data/photos/
  practice/   curated media + manifest.json + ATTRIBUTION.md, was public/practice/
  live-view/  capture artifacts: <id>.webm|mp4, <id>-frame.jpg,
              <id>-results.png, <id>.json
```

Everything under the root streams through `GET /api/images/[...path]`
(`app/api/images/[...path]/route.ts`); the testable pieces (path safety,
content-type whitelist, cache policy, Range negotiation) live in
`lib/photos/storage.ts`. Rationale: `public/` is snapshotted into
production builds, so runtime files must live in `data/` and stream via API
routes (same finding as the photo library, `docs/references-photolib.md`).

## Behavior

- Served extensions only: jpg/jpeg, png, mp4, webm, json, md. Anything else
  404s with a note, as do traversal attempts and missing files.
- Traversal protection: per-segment allowlist (`^[A-Za-z0-9][A-Za-z0-9._-]*$`,
  so `..`, dot-leading names, separators, and NUL never pass) plus a
  resolve-and-prefix check against the root.
- Cache: media is `public, max-age=31536000, immutable` (user/live-view names
  carry UUIDs, practice is a fixed curated set); json/md are `no-store` so
  manifest edits show up.
- Range: single `bytes=` ranges answer 206 + `Content-Range` (Safari refuses
  `<video>` playback without it); malformed or multi-range headers fall back
  to a full 200 (allowed by the spec); an out-of-bounds start answers 416
  with `Content-Range: bytes */<size>`.

## Photo library migration

`lib/photos/store.ts` takes an optional legacy directory; `getPhotoStore()`
passes `data/photos/`. On first use the store moves every legacy file
(index.json + jpgs) into `data/images/user/` and removes the legacy
directory. Idempotent: destination files win, so a stale legacy dir can
never clobber live data; once the legacy dir is gone the check is a single
ENOENT. Photo API behavior is otherwise unchanged (50-photo cap, cached
inventory). `setInventory` now strips only `photoDataUrl` via rest-spread,
so added fields (per-part `maskPng` etc.) survive the cache.

## Practice media

`public/practice/*` moved to `data/images/practice/` (README pointer left
behind; originals in the baseline git commit). `lib/practice/manifest.ts`
now builds URLs from `PRACTICE_BASE_PATH = "/api/images/practice"`; the
manifest keeps plain basenames in `file`. Nothing references `/practice/*`
anymore (grep-verified over app/, lib/, components/, hooks/, tests/,
public/). Note: `data/` is gitignored, so the practice set lives on disk
only; the baseline commit holds the originals under `public/practice/`.

## Live captures

`POST /api/live-captures` (zod contract + store in
`lib/photos/liveCaptures.ts`): optional bare-base64 clip (webm/mp4, 30 MB
decoded cap, `clipBase64`+`clipMime` together or not at all), required
`frameDataUrl` (image/jpeg data URL) and `resultsPngDataUrl` (image/png data
URL), 8 MB each, `query`, `capturedAt` (parseable date string). Saves the
files listed under Layout, metadata json last so list() never sees a
half-written capture; answers `201 { id, files }` where `files` maps
clip?/frame/results/meta to `/api/images/live-view/...` URLs.
`GET /api/live-captures` -> `{ captures }` newest-first (capturedAt desc);
unreadable metadata is skipped, disk trouble degrades to a note, never a 500.

## References

- HTTP Range semantics (forms, inclusive ends, 416, full-200 fallback,
  multi-range may be ignored):
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Range
  (checked 2026-07-24)
- 416 + `Content-Range: bytes */<size>`:
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/416
- Next.js route handlers (binary Response, dynamic APIs), already cited in
  docs/references-photolib.md and docs/references-p3.md.
