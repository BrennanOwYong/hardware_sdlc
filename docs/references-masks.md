# References — compact region masks (pngjs re-encode, payload cap)

Research date: 2026-07-24. Shapes verified against the vendor pages below
before the mask pipeline in lib/perception/sam.ts was extended.

## pngjs (existing dependency, no new packages)

Source: https://github.com/pngjs/pngjs (README, v7)

- `PNG.sync.read(buffer)` inflates every PNG to RGBA: "Buffer of image pixel
  data. Every pixel consists 4 bytes: R, G, B, A (opacity)." The binary-mask
  threshold in `rgbaToBinaryMask` reads those 4-byte pixels.
- `new PNG({ width, height })` pre-allocates `png.data` zero-filled
  (transparent black), so `encodeMaskPng` only writes the on pixels.
- `PNG.sync.write(png, { colorType })` colorType values: 0 = grayscale,
  2 = color no alpha, 4 = grayscale & alpha, 6 = color & alpha. The mask
  encoder passes `colorType: 6` so the transparent background survives
  (white opaque = object, alpha 0 = everything else).

## Replicate meta/sam-2 mask output

Source (versioned API page, pinned version):
https://replicate.com/meta/sam-2/versions/cbd95fb76192174268b6b303aeeb7a736e8dab0cbc38177f09db79b2299da30b/api

- `individual_masks`: array of URIs, one white-on-black binary mask PNG per
  detected object, at the input image's resolution. Full endpoint/auth/poll
  shapes live in docs/references-practice-sam.md.

## Payload budget rationale

- Masks are downscaled to at most 640 px on the long edge (max-pooling so
  1-px structures like jumper wires survive) and re-encoded as white +
  transparent PNGs — deflate compresses the flat regions well, so a typical
  region mask lands in the tens of kilobytes of base64.
- `MAX_TOTAL_MASK_BYTES` caps the summed base64 characters per image at
  2 MiB (base64 length ≈ response bytes). `capMaskPayload` assigns masks to
  regions in area-descending order until the budget runs out; regions past
  the budget keep their bounding boxes and lose only the mask, and the
  segmentation note records how many were dropped.
