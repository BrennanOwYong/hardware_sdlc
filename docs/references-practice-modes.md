# References — practice modes (practice photos + practice video)

Deep links consulted on 2026-07-24 while building the practice-media
features: the /inventory "Practice photos" strip, the /assemble
"Practice video" mode (live source `"file"` in `LiveSourceOptions`), and
`lib/practice/manifest.ts`.

## Video playback (practice video mode, hooks/usePerception.ts)

- `HTMLMediaElement.play()` — returns a Promise; rejects with
  `NotAllowedError` (autoplay policy) or `NotSupportedError` (bad/missing
  media). The hook awaits it inside `start()` so a rejection surfaces as
  the hook's `error` string.
  https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play
- Autoplay guide — muted `<video>` is classified inaudible and exempt from
  autoplay blocking; playback started from a user gesture is always
  allowed. Practice video sets `muted` AND starts from the "Play practice
  video" click, so both conditions hold.
  https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay
- `HTMLMediaElement.src` / `load()` — detaching a clip on stop(): pause,
  `removeAttribute("src")`, then `load()` so the element releases the
  resource (assigning `src = ""` would instead point at the page URL).
  https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/src
  https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/load

## Canvas frame capture (shared with camera/screen modes)

- `CanvasRenderingContext2D.drawImage()` — accepts an `HTMLVideoElement`
  and draws its current frame; only valid when `readyState > 1`, and the
  intrinsic size comes from `videoWidth`/`videoHeight`. The hook's
  `captureFrame()` guards on `readyState < 2 || videoWidth === 0` and
  scales from `videoWidth`/`videoHeight`, unchanged for file playback.
  https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage
- `HTMLCanvasElement.toDataURL()` — JPEG export used for the ~1024px
  frames posted to /api/perceive.
  https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL
- `HTMLMediaElement.readyState` — value 2 (`HAVE_CURRENT_DATA`) is the
  minimum for a drawable frame.
  https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/readyState

## Camera / screen capture (pre-existing, unchanged)

- `getUserMedia`: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- `getDisplayMedia`: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia

## Practice media on disk

- `public/practice/manifest.json` — curated list (8 photos, 2 videos);
  validated at runtime by `practiceManifestSchema` in
  `lib/practice/manifest.ts` and by `tests/practice.test.mjs`.
- `public/practice/ATTRIBUTION.md` — per-file licenses and source links
  (Wikimedia Commons CC BY / CC BY-SA, Pexels License).
