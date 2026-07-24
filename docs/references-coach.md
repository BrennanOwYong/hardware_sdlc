# Coach builder — references

Deep links verified via WebFetch on 2026-07-24. Re-verify against these exact
URLs before changing lib/coach/coach.ts, lib/coach/contract.ts, or
app/coach/page.tsx.

## Anthropic Messages API — vision (base64 image content block)

- https://docs.anthropic.com/en/docs/build-with-claude/vision
  (301 → https://platform.claude.com/docs/en/build-with-claude/vision.md — the
  redirect target is the page actually fetched and relied on for this build)

Facts relied on:

- Image content block shape: `{ "type": "image", "source": { "type": "base64",
  "media_type": "image/jpeg", "data": "<base64>" } }` inside a `user` message's
  `content` array.
- Supported media types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
  (lib/coach/contract.ts `normalizeCoachImage` accepts exactly these).
- Claude works best when the image block comes **before** the text block —
  coach.ts orders `[image, text]`.
- Max 10 MB per base64 image on the Claude API. The page rasterizes attempt
  photos to a <= 1568 px long-edge JPEG at quality 0.85 (the inventory
  pipeline), far under the limit.
- Visual token cost is `ceil(width / 28) x ceil(height / 28)`. `claude-sonnet-5`
  is on the high-resolution tier (max long edge 2576 px / 4784 visual tokens),
  so a 1568 px photo is sent unresized; 1568 px keeps token cost and latency
  bounded while leaving connector-level detail legible.
- Used with model `claude-sonnet-5`, `max_tokens: 700`,
  `thinking: { type: "disabled" }` (Sonnet 5 defaults to adaptive thinking;
  disabling keeps the budget on the strict-JSON verdict). 700 rather than the
  perceive endpoint's 300 because the coach verdict carries an objects array,
  a target, and an arrow.
- Model coordinate outputs are approximate per the doc's Limitations section —
  `clampCoachGeometry` clips every returned coordinate into 0..1 so markers
  always land on the photo.

## Internal contracts consumed

- `POST /api/journal` (journal builder): fire-and-forget per exchange with
  `{ kind: "coach", goal, attempt, verdict, instruction, frameDataUrl }`.
  The route was not present in source at coach build time; the page swallows
  failures by design, so coaching works with or without it.
- `components/ArMarkerLayer` + `lib/inventory/markers` (`markerFromBbox`):
  normalized-bbox pins for the named objects.
- Raster pipeline constants (<= 1568 px, JPEG 0.85) mirror
  app/inventory/page.tsx so every vision feature sends comparable frames.
