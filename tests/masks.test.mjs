// Compact-mask verification: downscale geometry (max-pooling, no upscale),
// PNG round-trip through pngjs (white/transparent, pixels match), payload
// cap ordering (largest regions keep masks first), and the useSample
// fast-path selection logic. lib/perception/sam.ts has no project value
// imports, so Node 24 type stripping runs it directly (zod and pngjs
// resolve from node_modules).
import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";

const {
  rgbaToBinaryMask,
  binaryMaskToBox,
  downscaleBinaryMask,
  encodeMaskPng,
  decodeMaskRegion,
  capMaskPayload,
  isSampleFastPath,
  SAMPLE_FAST_PATH_NOTE,
  MAX_MASK_EDGE,
} = await import("../lib/perception/sam.ts");

const approx = (actual, expected, msg) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${msg ?? "approx"}: ${actual} !== ${expected}`,
  );

/** Binary mask with all pixels off. */
const blankBinary = (width, height) => ({
  width,
  height,
  on: new Uint8Array(width * height),
});

/** Fill an on-rectangle [x0..x1] x [y0..y1] inclusive on a binary mask. */
const fillBinaryRect = (mask, x0, y0, x1, y1) => {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) mask.on[y * mask.width + x] = 1;
};

// --- downscale geometry ------------------------------------------------------

test("downscale geometry: landscape long edge lands exactly on the cap", () => {
  const out = downscaleBinaryMask(blankBinary(1280, 720), 640);
  assert.equal(out.width, 640);
  assert.equal(out.height, 360, "short edge scales by the same factor");
  assert.equal(out.on.length, 640 * 360);
});

test("downscale geometry: portrait long edge lands exactly on the cap", () => {
  const out = downscaleBinaryMask(blankBinary(720, 1280), 640);
  assert.equal(out.width, 360);
  assert.equal(out.height, 640);
});

test("downscale geometry: square mask becomes cap x cap", () => {
  const out = downscaleBinaryMask(blankBinary(1000, 1000), 640);
  assert.equal(out.width, 640);
  assert.equal(out.height, 640);
});

test("downscale geometry: never upscales — within-bound masks come back as-is", () => {
  const small = blankBinary(640, 480);
  fillBinaryRect(small, 10, 10, 20, 20);
  const out = downscaleBinaryMask(small, 640);
  assert.equal(out.width, 640);
  assert.equal(out.height, 480);
  assert.deepEqual(out.on, small.on, "pixels untouched when no scaling runs");
  const tiny = downscaleBinaryMask(blankBinary(100, 50), 640);
  assert.equal(tiny.width, 100);
  assert.equal(tiny.height, 50);
});

test("downscale geometry: extreme aspect floors the short edge at 1", () => {
  const out = downscaleBinaryMask(blankBinary(5000, 2), 640);
  assert.equal(out.width, 640);
  assert.equal(out.height, 1, "round(2 * 640 / 5000) = 0 floors to 1");
});

test("downscale geometry: default cap is MAX_MASK_EDGE", () => {
  const out = downscaleBinaryMask(blankBinary(MAX_MASK_EDGE * 2, MAX_MASK_EDGE));
  assert.equal(out.width, MAX_MASK_EDGE);
  assert.equal(out.height, MAX_MASK_EDGE / 2);
});

test("downscale max-pooling: a 1-px wire survives, empty stays empty", () => {
  const wire = blankBinary(1280, 720);
  fillBinaryRect(wire, 0, 400, 1279, 400); // 1-px horizontal line
  const out = downscaleBinaryMask(wire, 640);
  const y = Math.floor((400 * out.height) / 720);
  let onInRow = 0;
  for (let x = 0; x < out.width; x++) onInRow += out.on[y * out.width + x];
  assert.equal(onInRow, out.width, "every destination pixel over the wire is on");
  const empty = downscaleBinaryMask(blankBinary(1280, 720), 640);
  assert.equal(
    empty.on.reduce((a, b) => a + b, 0),
    0,
    "no pixels invented from an empty mask",
  );
  const full = blankBinary(1280, 720);
  full.on.fill(1);
  const fullOut = downscaleBinaryMask(full, 640);
  assert.equal(
    fullOut.on.reduce((a, b) => a + b, 0),
    fullOut.on.length,
    "a fully-on mask stays fully on",
  );
});

// --- PNG round-trip ----------------------------------------------------------

test("encodeMaskPng round-trip: white opaque on, transparent off, pixels match", () => {
  const mask = blankBinary(16, 12);
  fillBinaryRect(mask, 4, 2, 11, 9);
  mask.on[0] = 1; // lone corner pixel
  const b64 = encodeMaskPng(mask);
  assert.ok(!b64.startsWith("data:"), "bare base64, no data: prefix");
  const png = PNG.sync.read(Buffer.from(b64, "base64"));
  assert.equal(png.width, 16);
  assert.equal(png.height, 12);
  for (let p = 0; p < mask.on.length; p++) {
    const i = p * 4;
    if (mask.on[p]) {
      assert.deepEqual(
        [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]],
        [255, 255, 255, 255],
        `pixel ${p} is white opaque`,
      );
    } else {
      assert.equal(png.data[i + 3], 0, `pixel ${p} is transparent`);
    }
  }
});

test("decodeMaskRegion: box from full resolution, mask round-trips the shape", () => {
  // White-on-black source mask, like SAM emits.
  const w = 20;
  const h = 10;
  const src = new PNG({ width: w, height: h });
  for (let y = 3; y <= 7; y++) {
    for (let x = 5; x <= 14; x++) {
      const i = (y * w + x) * 4;
      src.data[i] = 255;
      src.data[i + 1] = 255;
      src.data[i + 2] = 255;
      src.data[i + 3] = 255;
    }
  }
  const region = decodeMaskRegion(new Uint8Array(PNG.sync.write(src)));
  assert.ok(region, "non-empty mask yields a region");
  approx(region.box.bbox[0], 5 / 20);
  approx(region.box.bbox[1], 3 / 10);
  approx(region.box.bbox[2], 10 / 20);
  approx(region.box.bbox[3], 5 / 10);
  approx(region.box.area, 50 / 200);
  // Small mask: no downscale, so the binary mask mirrors the source exactly.
  assert.equal(region.mask.width, w);
  assert.equal(region.mask.height, h);
  const rebuilt = binaryMaskToBox(region.mask);
  assert.deepEqual(rebuilt.bbox, region.box.bbox, "mask and box agree");
});

test("decodeMaskRegion: empty mask returns null; oversized mask is downscaled", () => {
  const empty = new PNG({ width: 8, height: 8 });
  assert.equal(decodeMaskRegion(new Uint8Array(PNG.sync.write(empty))), null);
  const big = new PNG({ width: 1000, height: 500 });
  const i = (250 * 1000 + 500) * 4;
  big.data[i] = 255;
  big.data[i + 1] = 255;
  big.data[i + 2] = 255;
  big.data[i + 3] = 255;
  const region = decodeMaskRegion(new Uint8Array(PNG.sync.write(big)), 100);
  assert.ok(region);
  assert.equal(region.mask.width, 100, "long edge downscaled to the cap");
  assert.equal(region.mask.height, 50);
  approx(region.box.area, 1 / 500000, "area still measured at full resolution");
});

test("rgbaToBinaryMask: threshold matches maskToBox (127 off, 128 on)", () => {
  const data = new Uint8Array(4 * 4 * 4);
  data[(1 * 4 + 1) * 4] = 127;
  data[(2 * 4 + 2) * 4] = 128;
  const mask = rgbaToBinaryMask(data, 4, 4);
  assert.equal(mask.on[1 * 4 + 1], 0, "127 stays off");
  assert.equal(mask.on[2 * 4 + 2], 1, "128 turns on");
  assert.throws(
    () => rgbaToBinaryMask(new Uint8Array(3), 4, 4),
    /mask buffer too small/,
  );
});

// --- payload cap ordering ----------------------------------------------------

test("capMaskPayload: largest regions keep masks first, boxes stay", () => {
  // Input deliberately NOT area-sorted; each mask is 100 chars.
  const boxes = [
    { bbox: [0, 0, 0.1, 0.1], area: 0.01, maskPng: "a".repeat(100) },
    { bbox: [0.2, 0, 0.3, 0.3], area: 0.09, maskPng: "b".repeat(100) },
    { bbox: [0.6, 0, 0.2, 0.2], area: 0.04, maskPng: "c".repeat(100) },
  ];
  const { boxes: capped, masksDropped } = capMaskPayload(boxes, 200);
  assert.equal(masksDropped, 1);
  assert.equal(capped.length, 3, "no box is ever dropped");
  assert.equal(capped[0].maskPng, undefined, "smallest region loses its mask");
  assert.equal(capped[1].maskPng, "b".repeat(100), "largest keeps its mask");
  assert.equal(capped[2].maskPng, "c".repeat(100), "second largest keeps its mask");
  assert.deepEqual(
    capped.map((b) => b.area),
    [0.01, 0.09, 0.04],
    "input order preserved",
  );
  assert.equal(boxes[0].maskPng, "a".repeat(100), "input array not mutated");
});

test("capMaskPayload: under-budget input passes through unchanged", () => {
  const boxes = [
    { bbox: [0, 0, 0.1, 0.1], area: 0.01, maskPng: "a".repeat(50) },
    { bbox: [0.5, 0.5, 0.1, 0.1], area: 0.02 }, // no mask — never counted
  ];
  const { boxes: capped, masksDropped } = capMaskPayload(boxes, 50);
  assert.equal(masksDropped, 0);
  assert.equal(capped, boxes, "zero-drop path returns the same array");
});

test("capMaskPayload: a single over-budget mask is dropped, later small ones fit", () => {
  const boxes = [
    { bbox: [0, 0, 0.5, 0.5], area: 0.25, maskPng: "x".repeat(300) },
    { bbox: [0.6, 0.6, 0.1, 0.1], area: 0.01, maskPng: "y".repeat(80) },
  ];
  const { boxes: capped, masksDropped } = capMaskPayload(boxes, 100);
  assert.equal(masksDropped, 1);
  assert.equal(capped[0].maskPng, undefined, "over-budget mask dropped");
  assert.deepEqual(capped[0].bbox, [0, 0, 0.5, 0.5], "its box survives");
  assert.equal(capped[1].maskPng, "y".repeat(80), "budget flows to the next mask");
});

// --- sample fast-path selection ----------------------------------------------

test("sample fast-path: useSample:true selects it, keyed or not, image or not", () => {
  assert.equal(isSampleFastPath({ useSample: true }), true);
  assert.equal(
    isSampleFastPath({ useSample: true, imageBase64: "abc" }),
    true,
    "sample wins even when an image rides along",
  );
  assert.equal(isSampleFastPath({ useSample: false }), false);
  assert.equal(isSampleFastPath({}), false, "real photos never fast-path");
});

test("sample fast-path note names the sample sheet and points at live vision", () => {
  assert.equal(
    SAMPLE_FAST_PATH_NOTE,
    "sample sheet uses its known inventory - photograph something real for live vision",
  );
});
