// live-ux builder verification: snap-on-submit state machine, recorder mime
// chain, clip policy, mask tint/scale math, and results-PNG layout.
// lib/inventory/liveflow.ts only has type-only project imports, so Node 24
// type stripping runs it directly (same pattern as markers.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";

const {
  nextLivePhase,
  pickRecorderMime,
  RECORDER_MIME_CHAIN,
  CLIP_MAX_BYTES,
  shouldDropClip,
  clipContainerMime,
  maskPngToDataUrl,
  stripDataUrlPrefix,
  tintMaskPixels,
  MASK_TINT_RGB,
  MASK_TINT_MAX_ALPHA,
  maskDestRect,
  partitionByMask,
  scanSummary,
  resultsPngLayout,
  RESULTS_PNG_MIN_WIDTH,
  RESULTS_PNG_MAX_WIDTH,
  RESULTS_PNG_HEADER_H,
  RESULTS_PNG_ROW_H,
  RESULTS_PNG_PAD,
} = await import("../lib/inventory/liveflow.ts");

// ---- state machine ----------------------------------------------------------

test("happy path: idle -> aim -> captured -> analyzing -> done -> aim", () => {
  let p = "idle";
  p = nextLivePhase(p, "start");
  assert.equal(p, "aim");
  p = nextLivePhase(p, "submit");
  assert.equal(p, "captured");
  p = nextLivePhase(p, "flashed");
  assert.equal(p, "analyzing");
  p = nextLivePhase(p, "resolved");
  assert.equal(p, "done");
  p = nextLivePhase(p, "resume");
  assert.equal(p, "aim");
});

test("identify beating the flash timer: captured -> done directly", () => {
  assert.equal(nextLivePhase("captured", "resolved"), "done");
  // The late flash timer then fires "flashed" against done: no-op.
  assert.equal(nextLivePhase("done", "flashed"), "done");
});

test("stop tears down from every active phase", () => {
  for (const phase of ["aim", "captured", "analyzing", "done"]) {
    assert.equal(nextLivePhase(phase, "stop"), "idle");
  }
});

test("illegal events keep the current phase", () => {
  assert.equal(nextLivePhase("idle", "submit"), "idle");
  assert.equal(nextLivePhase("idle", "resolved"), "idle");
  assert.equal(nextLivePhase("aim", "flashed"), "aim");
  assert.equal(nextLivePhase("aim", "resolved"), "aim");
  assert.equal(nextLivePhase("analyzing", "submit"), "analyzing");
  assert.equal(nextLivePhase("done", "submit"), "done");
});

test("restarting the source while aiming or done stays/returns to aim", () => {
  assert.equal(nextLivePhase("aim", "start"), "aim");
  assert.equal(nextLivePhase("done", "start"), "aim");
});

// ---- recorder mime chain ----------------------------------------------------

test("mime chain prefers vp9 webm, then webm, then mp4", () => {
  assert.deepEqual(
    [...RECORDER_MIME_CHAIN],
    ["video/webm;codecs=vp9", "video/webm", "video/mp4"],
  );
  assert.equal(pickRecorderMime(() => true), "video/webm;codecs=vp9");
  assert.equal(
    pickRecorderMime((t) => t === "video/webm"),
    "video/webm",
  );
  assert.equal(
    pickRecorderMime((t) => t === "video/mp4"),
    "video/mp4",
  );
});

test("no supported mime -> null (constructor then picks its own)", () => {
  assert.equal(pickRecorderMime(() => false), null);
});

// ---- clip policy --------------------------------------------------------------

test("clip cap is 30 MB inclusive", () => {
  assert.equal(CLIP_MAX_BYTES, 30 * 1024 * 1024);
  assert.equal(shouldDropClip(CLIP_MAX_BYTES), false);
  assert.equal(shouldDropClip(CLIP_MAX_BYTES + 1), true);
  assert.equal(shouldDropClip(0), false);
});

test("clipContainerMime strips codec parameters to the bare container", () => {
  assert.equal(clipContainerMime("video/webm;codecs=vp9"), "video/webm");
  assert.equal(clipContainerMime("video/webm"), "video/webm");
  assert.equal(clipContainerMime("video/mp4;codecs=avc1"), "video/mp4");
  assert.equal(clipContainerMime("VIDEO/MP4"), "video/mp4");
  assert.equal(clipContainerMime("video/ogg"), null);
  assert.equal(clipContainerMime(""), null);
  assert.equal(clipContainerMime(null), null);
  assert.equal(clipContainerMime(undefined), null);
});

// ---- data-URL plumbing ---------------------------------------------------------

test("maskPngToDataUrl prefixes bare base64 and passes data URLs through", () => {
  assert.equal(maskPngToDataUrl("AAAA"), "data:image/png;base64,AAAA");
  assert.equal(
    maskPngToDataUrl("data:image/png;base64,BBBB"),
    "data:image/png;base64,BBBB",
  );
});

test("stripDataUrlPrefix returns the payload after the first comma", () => {
  assert.equal(stripDataUrlPrefix("data:video/webm;base64,QUJD"), "QUJD");
  assert.equal(stripDataUrlPrefix("no-comma-here"), "no-comma-here");
});

// ---- mask tint math -------------------------------------------------------------

test("tintMaskPixels: white opaque -> accent at max alpha; black/transparent vanish", () => {
  // Four RGBA pixels: white opaque, black opaque, mid-gray opaque,
  // white-but-transparent (encoder kept RGB under alpha 0).
  const px = new Uint8ClampedArray([
    255, 255, 255, 255,
    0, 0, 0, 255,
    128, 128, 128, 255,
    255, 255, 255, 0,
  ]);
  tintMaskPixels(px);
  // Pixel 0: full tint.
  assert.deepEqual([...px.slice(0, 4)], [...MASK_TINT_RGB, MASK_TINT_MAX_ALPHA]);
  // Pixel 1: black background -> alpha 0.
  assert.equal(px[7], 0);
  // Pixel 2: mid-gray -> proportional alpha (128/255 of max, rounded).
  assert.equal(px[11], Math.round((128 / 255) * MASK_TINT_MAX_ALPHA));
  // Pixel 3: transparent background -> alpha 0 even though RGB is white.
  assert.equal(px[15], 0);
  // Every pixel's RGB is the accent tint.
  for (let i = 0; i < px.length; i += 4) {
    assert.deepEqual([...px.slice(i, i + 3)], [...MASK_TINT_RGB]);
  }
});

test("tintMaskPixels ignores a trailing partial pixel", () => {
  const px = new Uint8ClampedArray([255, 255, 255, 255, 9, 9]);
  tintMaskPixels(px);
  assert.deepEqual([...px.slice(4)], [9, 9]);
});

// ---- mask destination rect ------------------------------------------------------

test("maskDestRect: matching aspect stretches exactly full frame", () => {
  const r = maskDestRect(1024, 768, 1024, 768);
  assert.deepEqual(r, { dx: 0, dy: 0, dw: 1024, dh: 768 });
  const scaled = maskDestRect(512, 384, 1024, 768);
  assert.deepEqual(scaled, { dx: 0, dy: 0, dw: 1024, dh: 768 });
});

test("maskDestRect: mismatched aspect letterboxes centered", () => {
  const r = maskDestRect(100, 100, 200, 100);
  assert.deepEqual(r, { dx: 50, dy: 0, dw: 100, dh: 100 });
});

test("maskDestRect: degenerate sizes draw nothing", () => {
  assert.deepEqual(maskDestRect(0, 100, 200, 100), { dx: 0, dy: 0, dw: 0, dh: 0 });
  assert.deepEqual(maskDestRect(100, 100, 0, 100), { dx: 0, dy: 0, dw: 0, dh: 0 });
});

// ---- partition -------------------------------------------------------------------

test("partitionByMask splits on a non-empty maskPng", () => {
  const withMask = { id: "p1", partType: "wire", label: "jumper", confidence: 0.9, bbox: [0, 0, 0.1, 0.1], maskPng: "AAAA" };
  const noMask = { id: "p2", partType: "led", label: "LED", confidence: 0.8, bbox: [0.2, 0.2, 0.1, 0.1] };
  const emptyMask = { id: "p3", partType: "ic", label: "chip", confidence: 0.7, bbox: [0.4, 0.4, 0.1, 0.1], maskPng: "" };
  const { masked, plain } = partitionByMask([withMask, noMask, emptyMask]);
  assert.deepEqual(masked.map((p) => p.id), ["p1"]);
  assert.deepEqual(plain.map((p) => p.id), ["p2", "p3"]);
});

// ---- copy ------------------------------------------------------------------------

test("scanSummary pluralizes", () => {
  assert.equal(scanSummary(0), "Scan complete: 0 items found");
  assert.equal(scanSummary(1), "Scan complete: 1 item found");
  assert.equal(scanSummary(7), "Scan complete: 7 items found");
});

// ---- results PNG layout ------------------------------------------------------------

test("resultsPngLayout scales the frame to the clamped width", () => {
  const l = resultsPngLayout(2048, 1024, 3);
  assert.equal(l.width, RESULTS_PNG_MAX_WIDTH);
  assert.equal(l.frameW, 1024);
  assert.equal(l.frameH, 512); // aspect preserved through the 2x downscale
  assert.equal(l.frameY, RESULTS_PNG_HEADER_H);
  assert.equal(l.tableY, RESULTS_PNG_HEADER_H + 512 + RESULTS_PNG_PAD);
  // header row + 3 data rows + bottom pad
  assert.equal(l.height, l.tableY + RESULTS_PNG_ROW_H * 4 + RESULTS_PNG_PAD);
});

test("resultsPngLayout clamps width into [480, 1024]", () => {
  assert.equal(resultsPngLayout(320, 240, 1).width, RESULTS_PNG_MIN_WIDTH);
  assert.equal(resultsPngLayout(4000, 3000, 1).width, RESULTS_PNG_MAX_WIDTH);
});

test("resultsPngLayout reserves at least one data row", () => {
  const l0 = resultsPngLayout(1024, 768, 0);
  const l1 = resultsPngLayout(1024, 768, 1);
  assert.equal(l0.height, l1.height);
});
