# References — live-UX build (exact-pixel masks + snap-on-submit + live-view save)

Official docs consulted (fetched 2026-07-24) before implementing
components/MaskOverlay.tsx, lib/inventory/liveflow.ts, and the live mode in
app/inventory/page.tsx. FEEDBACK.md items 2, 9, 10.

## MediaRecorder (rolling clip, FEEDBACK.md item 10)

- MediaRecorder API overview:
  https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
  - `start(timeslice)` fires `dataavailable` every `timeslice` ms; without a
    timeslice a single Blob arrives only on stop. The build uses
    `start(1000)` so chunks accumulate while aiming.
  - Event order on `stop()`: the FINAL `dataavailable` fires before the
    `stop` event, so assembling `new Blob(chunks)` inside the `stop` handler
    sees complete data (lib code: `stopRecorder` in app/inventory/page.tsx).
  - Constructor with an unsupported mimeType selects a supported type on its
    own; the actual choice is readable from `recorder.mimeType`. The build
    therefore constructs WITHOUT options when the whole fallback chain fails,
    instead of skipping the clip.
- `MediaRecorder.isTypeSupported()` (static):
  https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static
  - Returns a boolean per full mime string including codec parameters
    ("video/webm;codecs=vp9"). Gate every candidate before constructing.
  - Fallback chain implemented in `pickRecorderMime`
    (lib/inventory/liveflow.ts): video/webm;codecs=vp9 -> video/webm ->
    video/mp4. Safari records mp4, not webm; feature detection rather than
    UA sniffing is the documented pattern.
  - `typeof MediaRecorder === "undefined"` skips the clip entirely and keeps
    the rest of the snap flow (frame + results PNG still save).

## Canvas (frozen frame, mask tint, results PNG)

- `HTMLCanvasElement.toDataURL()`:
  https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL
  - `toDataURL(type, quality)`; default type image/png, JPEG accepts a 0..1
    quality. Returns `data:<type>;base64,<payload>`; a zero-sized canvas
    returns "data:,". Frozen frame exports as JPEG 0.85, results sheet as
    PNG.
- `CanvasRenderingContext2D.getImageData()`:
  https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/getImageData
  - `ImageData.data` is a Uint8ClampedArray in RGBA order, row by row;
    `putImageData` writes it back. `tintMaskPixels`
    (lib/inventory/liveflow.ts) walks that layout: RGB := accent, alpha :=
    luminance x source-alpha x ~55%, which handles both white-on-black and
    white-on-transparent masks (the masks builder ships the latter, per
    lib/types.ts).
  - Cross-origin pixels taint the canvas and make getImageData throw
    SecurityError; masks arrive as same-document data URLs, so the overlay
    never taints.

## Sibling contracts consumed (same repo)

- `PartDetection.maskPng?: string` — masks builder, lib/types.ts +
  lib/perception/sam.ts (base64 PNG, no data: prefix, white = object).
- `POST /api/live-captures` — storage builder,
  lib/photos/liveCaptures.ts (`liveCaptureRequestSchema`): clipMime must be
  the BARE container ("video/webm" | "video/mp4") and must travel together
  with clipBase64; `clipContainerMime` in lib/inventory/liveflow.ts strips
  codec parameters off the recorder's reported mime before posting.
