# Perception builder — references

Deep links verified via WebFetch on 2026-07-23. Re-verify against these exact
URLs before changing lib/perception/perceive.ts, lib/perception/index.ts, or
hooks/usePerception.ts.

## Anthropic Messages API — vision (base64 image content block)

- https://docs.anthropic.com/en/docs/build-with-claude/vision
  (301 → https://platform.claude.com/docs/en/build-with-claude/vision.md — the
  redirect target is the page actually fetched and relied on)

Facts relied on:

- Image content block shape: `{ "type": "image", "source": { "type": "base64",
  "media_type": "image/jpeg", "data": "<base64>" } }` inside a `user` message's
  `content` array.
- Supported media types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
- Claude works best when the image block comes **before** the text block —
  perceive.ts orders `[image, text]`.
- Max 10 MB per base64 image on the Claude API; our capture path sends ~640px
  wide JPEG at quality 0.6, far under the limit and cheap in visual tokens
  (tokens = ceil(w/28) x ceil(h/28)).
- Used with model `claude-sonnet-5`, `max_tokens: 300`,
  `thinking: { type: "disabled" }` (Sonnet 5 defaults to adaptive thinking when
  the field is omitted; disabling keeps the small token budget on the JSON
  verdict and keeps per-frame latency down).

## MDN — getUserMedia (camera)

- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia

Facts relied on:

- Signature `navigator.mediaDevices.getUserMedia(constraints)` →
  `Promise<MediaStream>`.
- Back camera selection: `{ video: { facingMode: "environment" } }`.
- **Secure context required**: on plain HTTP, `navigator.mediaDevices` is
  `undefined`. Phones therefore need HTTPS (or localhost) for camera access —
  usePerception surfaces this as a readable error instead of crashing.
- Failure modes handled: `NotAllowedError` (permission denied),
  `NotFoundError` (no camera) — both land in the hook's `error` state.

## MDN — getDisplayMedia (screen capture)

- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia

Facts relied on:

- Signature `navigator.mediaDevices.getDisplayMedia(options)` →
  `Promise<MediaStream>`; `{ video: true }` is the minimal valid options object
  (`video: false` rejects with TypeError).
- Requires a secure context **and** transient user activation — start() must be
  called from a button click, which the assemble page does.
- Effectively **desktop-only** (not Baseline; unavailable on mainstream mobile
  browsers). That matches the test plan: the user screen-captures MS Paint /
  Google Slides on a desktop while dragging JPEG part cutouts; phone usage goes
  through the camera path instead.

## Replicate — Segment Anything 2 (documented future adapter, NOT implemented)

- https://replicate.com/meta/sam-2

Facts recorded:

- Model id `meta/sam-2` — prompt-based image segmentation (image input +
  point/box prompts → masks), ~$0.0091/run, ~10s on an Nvidia L40S; the
  Replicate deployment is image-only today (no video).
- Future adapter sketch: a second server-side backend behind the same
  `/api/perceive` contract could call `meta/sam-2` to get part/target masks,
  then derive `tip-at` / `seated` geometrically instead of asking the VLM for a
  verdict. Zero custom-trained models either way. Nothing in the current code
  depends on Replicate.

## Operational notes

- Camera on phones: HTTPS is mandatory (see getUserMedia above). `next dev`
  over the LAN is HTTP, so on-phone camera demos need a TLS tunnel (e.g.
  ngrok/cloudflared) or localhost port-forwarding via USB debugging.
- getDisplayMedia being desktop-only is a feature for this project: the
  simulated-workspace demo runs on the laptop, the phone-facing story uses the
  camera path.
- /api/perceive degrades without `ANTHROPIC_API_KEY`: it answers
  `200 { events: [], note: "no ANTHROPIC_API_KEY: use mock or manual mode" }`
  so the live loop stays alive and the UI can show the note.
