# Accuracy builder (delta 2) — references and accuracy ladder

Deep links re-verified via WebFetch on 2026-07-23. Re-verify against these
exact URLs before changing lib/perception/perceive.ts, lib/perception/index.ts,
or hooks/usePerception.ts.

## Anthropic Messages API — vision

- https://platform.claude.com/docs/en/build-with-claude/vision.md
  (https://docs.anthropic.com/en/docs/build-with-claude/vision 301-redirects
  there; the platform.claude.com page is the one fetched and relied on)

Facts relied on for this delta:

- Image content block shape unchanged: `{ "type": "image", "source":
  { "type": "base64", "media_type": "image/jpeg", "data": "<base64>" } }`
  inside a `user` message's `content` array, image block BEFORE the text block
  (the docs recommend image-then-text ordering).
- Supported media types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
- Visual token cost: `ceil(width/28) x ceil(height/28)` tokens per image.
  - old capture: 640x360 -> 23x13 = 299 tokens/frame
  - new capture: 1024x576 -> 37x21 = 777 tokens/frame (~2.6x, still cheap at
    one frame per second-ish poll)
- **High-resolution tier**: `claude-sonnet-5` is listed in the high-resolution
  tier — max long edge **2576 px**, max **4784** visual tokens. A 1024-px-wide
  frame is therefore processed **unresized**; nothing is lost to server-side
  downscaling.
- Image-quality guidance (the reason for 640 -> 1024 and q0.6 -> q0.7):
  - "If the image contains important text, make sure it's legible and not too
    small" — silkscreen pin labels (D2, GND, 5V) and breadboard row numbers
    are exactly this kind of small text; 640 px frames blur them.
  - "Heavy JPEG compression can make text difficult to read" — hence quality
    0.7 instead of 0.6.
  - Accuracy limitations: "Claude might hallucinate or make mistakes when
    interpreting low-quality, rotated, or very small images under 200 pixels"
    and counting is "approximate" — this is why single-frame verdicts are not
    trusted (see the StreakGate below) and why confidence < 0.5 discards the
    frame.
- Max 10 MB per base64 image on the Claude API; a 1024-px q0.7 JPEG is tens of
  kilobytes, far under the limit.
- Model/config unchanged from the P2 build: `claude-sonnet-5`,
  `max_tokens: 300`, `thinking: { type: "disabled" }` (valid on Sonnet 5;
  keeps the small budget on the JSON verdict). See docs/references-perception.md.

## What this delta shipped (accuracy rung 1)

1. **Sharper frames** — hooks/usePerception.ts captures 1024-px-wide JPEG at
   quality 0.7 (was 640 @ 0.6). Sonnet 5's high-res tier processes it 1:1.
2. **Model-read location (`observedRef`)** — the verdict schema is now
   `{ tipOnTarget, seated, wrongPlacement, observedRef, confidence }`. The
   prompt instructs the model to NAME the specific pin/hole the tip is nearest
   (silkscreen labels for UNO headers, row/column counting for breadboard
   holes, cutouts included), in the ref grammar, `null` only when unsure.
   Server-side mapping (lib/perception/perceive.ts `mapVerdictToEvents`):
   - `observedRef` present but matching no expected target -> `misplaced`
     event with `observed = observedRef` ("wrong hole: expected D2, saw D4").
   - `observedRef` matching an expected target (case-insensitive) -> tip
     confirmation even when `tipOnTarget` was hedged false.
   - confidence < `MIN_CONFIDENCE` (0.5) -> the whole frame verdict is
     discarded (zero events), which the client counts as a streak miss.
3. **Temporal consistency (`StreakGate` in lib/perception/index.ts)** —
   `tip-at` fires only after `consecutiveN` (default 2) consecutive frames
   agree on the SAME ref; `seated` needs 2 consecutive seated verdicts;
   `misplaced` fires immediately (safety beats latency); any frame without
   the event (including discarded low-confidence frames) resets the streak;
   streaks reset on step/phase change. The knob is `consecutiveN` on
   `LiveTuningOptions` (local to lib/perception — lib/types.ts is a read-only
   shared contract).
4. **Surfaced notes** — /api/perceive's `note` (vlm confidence, "tip read at
   UNO:D2", low-confidence skip, no-key notice) flows LiveBackend `onNote` ->
   `usePerception().note` -> one muted line under the video on /assemble.

## The accuracy ladder (upgrade path, honest assessment)

Rung 1 — **verdict-level with observedRef (SHIPPED, this delta).** The model
names the pin from one full-workspace frame. Good enough to catch off-by-one
row errors when labels are legible, but the whole workspace shares ~777
tokens of visual budget and counting is approximate per the vision docs.
Expect failures on dense breadboard regions and oblique camera angles.

Rung 2 — **zoomed crops (NEXT).** Before asking for a verdict, crop the frame
client-side to a region around the expected targets (or around the last
`observedRef`) and send the crop as a second image (or instead of the full
frame). Same API contract, same verdict schema; only hooks/usePerception.ts's
capture path and the prompt change ("Image 1: full workspace, Image 2: zoom
of the target area" per the multiple-images pattern in the vision doc). This
multiplies pixels-per-hole ~4-10x without touching lib/types.ts.

Rung 3 — **printed fiducial homography (mvp.md section 6, Tier 1).** Print a
life-size breadboard mat with an ArUco marker; the marker corners give a
screen-pixel <-> board-coordinate homography, so the tip location becomes
geometry instead of a language-model judgment, testable to +/- 1 hole with a
pen tip on paper (zero hardware). The VLM then only verifies "is it seated",
while WHERE comes from math. mvp.md also sketches the SAM 2 / MediaPipe
tracking that slots in above this. This is the rung that makes "the firmware
pin came from the hole you actually used" a measured claim rather than a
model opinion.

## Verification run (2026-07-23)

- `npx tsc --noEmit` — result recorded in the task report.
- `node --test tests/perception.test.mjs` — covers the observedRef mapping
  (mismatch -> misplaced, hedged-match -> tip-at, case-insensitive), the
  MIN_CONFIDENCE discard, StreakGate behavior (2-in-a-row fires, alternating
  never fires, empty-frame miss resets, misplaced immediate, seated streak,
  context reset, configurable N), the onNote relay, and all pre-existing
  perception tests.
