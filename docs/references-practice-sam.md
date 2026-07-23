# References — SAM adapter (Replicate meta/sam-2)

Research date: 2026-07-24. All shapes below were read from the vendor pages on
that date before any code was written.

## Replicate HTTP API

Source: https://replicate.com/docs/reference/http

- Create prediction (works for every model, community or official):
  `POST https://api.replicate.com/v1/predictions`
  Body: `{ "version": "<64-char version id>", "input": { ... } }`.
  A model-scoped form `POST https://api.replicate.com/v1/models/{owner}/{name}/predictions`
  exists for official models; this repo pins the version id and uses the
  standard endpoint so the call works regardless of official-model status.
- Auth header: `Authorization: Bearer <REPLICATE_API_TOKEN>` (token, prefixed
  by `Bearer` and a space).
- Sync mode: header `Prefer: wait=n` with n in 1..60 seconds. The request
  stays open until the model finishes. On timeout the prediction returns in
  `starting` state and must be fetched via the get endpoint.
- Poll: `GET https://api.replicate.com/v1/predictions/{prediction_id}`.
  Status values: `starting`, `processing`, `succeeded`, `failed`, `canceled`.
- Prediction object fields used here: `id`, `status`, `output`, `error`,
  `urls` (contains `get` and `cancel` convenience URLs).

## meta/sam-2 model schema

Source (versioned API page, pinned version):
https://replicate.com/meta/sam-2/versions/cbd95fb76192174268b6b303aeeb7a736e8dab0cbc38177f09db79b2299da30b/api

Pinned version id (the `version` field in the create-prediction body):
`cbd95fb76192174268b6b303aeeb7a736e8dab0cbc38177f09db79b2299da30b`

Input properties:

| Property | Type | Default | Description |
|---|---|---|---|
| `image` | string (URI) | required | Input image |
| `points_per_side` | integer | 32 | Points per side for mask generation |
| `pred_iou_thresh` | number | 0.88 | Predicted IOU threshold |
| `stability_score_thresh` | number | 0.95 | Stability score threshold |
| `use_m2m` | boolean | true | Use M2M refinement |

Output schema:

- `combined_mask`: string (URI) — one unified mask over all objects.
- `individual_masks`: array of string (URI) — one binary mask PNG per
  detected object. The adapter downloads these, decodes them with pngjs,
  and computes tight bounding boxes.

## File inputs

Source: https://replicate.com/docs/topics/predictions/input-files

- Three ways to pass files: hosted HTTP URL, client-library upload (up to
  100MB), or a base64 data URI. Replicate recommends the data URI form only
  for files under 1MB. Forge sends webcam/screen frames as JPEG data URIs;
  typical frames stay under that bound, and larger ones still work (the 1MB
  figure is a recommendation, not a hard limit).
