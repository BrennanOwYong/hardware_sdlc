# References — P1 inventory builder ("Ctrl-F for real life")

Official documentation verified via WebFetch on 2026-07-23 before implementing
`app/api/identify/route.ts` and `app/inventory/page.tsx`.

## Anthropic vision (Messages API with images)

- https://platform.claude.com/docs/en/build-with-claude/vision.md
  - Base64 image content block shape used in the route:
    `{"type": "image", "source": {"type": "base64", "media_type": "...", "data": "..."}}`,
    placed in a `user` message's `content` array. The docs recommend
    image-before-text ordering; the route sends `[imageBlock, textBlock]`.
  - Supported media types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
    SVG is NOT supported, so the client rasterizes `public/sample-parts.svg` to a
    canvas and exports JPEG before POSTing.
  - Limits: 10 MB per base64 image on the Claude API, 8000x8000 px max
    dimensions, 32 MB request body.
  - Resolution guidance: standard-tier models downscale past 1568 px on the long
    edge; the client caps exports at 1568 px (`MAX_EDGE` in
    `app/inventory/page.tsx`) to keep payloads small and token cost flat.
  - Coordinates caveat: the model natively reports pixel coordinates relative to
    the resized image (see the vision-coordinates page linked from the doc). The
    prompt demands 0..1-normalized bboxes, and `normalizeBbox()` in the route
    divides by the client-reported image dimensions as a fallback when the model
    answers in pixels anyway.

## Model

- `claude-sonnet-5` per the project brief (rule 6). Request shape (adaptive
  thinking default, `thinking: {type: "disabled"}` accepted, no sampling
  params) cross-checked against the bundled claude-api skill reference (cached
  2026-06-24) and the models overview:
  https://platform.claude.com/docs/en/about-claude/models/overview.md

## SDK

- `@anthropic-ai/sdk` 0.113.0 (already installed by the scaffold). Types used:
  `Anthropic.ImageBlockParam`, `Anthropic.MessageParam`, `Anthropic.Message`,
  `Anthropic.TextBlock` — no custom redeclarations, no casts.
