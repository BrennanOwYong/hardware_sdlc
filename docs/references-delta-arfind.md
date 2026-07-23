# References - delta build 2, ar-find builder

Official documentation re-verified via WebFetch on 2026-07-23 before
implementing the live Ctrl-F loop in `app/inventory/page.tsx`, the
`ArMarkerLayer` component, and the `query` field in
`app/api/identify/route.ts`.

## MDN media capture

- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
  - `getUserMedia(constraints)` returns `Promise<MediaStream>`. Rear camera via
    `{ video: { facingMode: "environment" } }`. The soft form (no `exact`) is
    deliberate: `{ exact: "environment" }` hard-fails with
    `OverconstrainedError` on laptops that only have a front camera.
  - Secure context only: `navigator.mediaDevices` is `undefined` off
    HTTPS/localhost, so the page checks for it before calling and explains the
    HTTPS requirement in plain words.
  - Rejection names (per MDN): `NotAllowedError`, `NotFoundError`,
    `NotReadableError`, `OverconstrainedError`, `AbortError`, `SecurityError`,
    `TypeError`, `InvalidStateError`. `friendlyMediaError()` maps the four
    common ones (NotAllowed / NotFound / NotReadable / InvalidState) to
    beginner-readable messages; the rest surface their own message.
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
  - `getDisplayMedia(options)` returns `Promise<MediaStream>`; `video` must be
    `true` or omitted (`false` throws `TypeError`). The page calls
    `getDisplayMedia({ video: true })`.
  - Requires transient activation (a user gesture) plus a focused page;
    calling outside one rejects with `InvalidStateError`. Both live-mode
    starts run only from button clicks.
  - Desktop-oriented: mobile support is inconsistent, so the page probes
    `typeof navigator.mediaDevices.getDisplayMedia !== "function"` and shows
    "Screen sharing works in a computer browser, not on a phone."
  - The user can end sharing from the browser's own stop UI; the page listens
    for the video track's `ended` event and releases everything.

## Anthropic vision (Messages API with images)

- https://platform.claude.com/docs/en/build-with-claude/vision.md
  - Base64 image content block shape (unchanged from delta 1, re-verified):
    `{"type": "image", "source": {"type": "base64", "media_type": "...", "data": "..."}}`
    inside a `user` message's `content` array, image before text (the docs
    recommend image-then-text ordering; the route keeps `[imageBlock, textBlock]`).
  - Supported media types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
  - Limits: 10 MB per base64 image on the Claude API, 8000x8000 px max
    dimensions, 32 MB request body.
  - Resolution: `claude-sonnet-5` sits in the high-resolution tier (max long
    edge 2576 px, 4784 visual tokens; token cost is
    `ceil(width/28) * ceil(height/28)`). Live frames are captured at ~1024 px
    wide JPEG q0.7, so they are never downscaled and a 16:9 frame costs about
    780 visual tokens per poll.
  - The `query` field only appends a "SEARCH FOCUS" instruction to the same
    prompt; the request shape is unchanged, so no new API surface was needed.
