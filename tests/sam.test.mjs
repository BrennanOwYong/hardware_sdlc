// SAM adapter verification: mask->bbox math on synthetic RGBA fixtures,
// region ranking (area floor, overlap suppression, cap), pngjs roundtrip,
// and the identify degradation ladder. lib/perception/sam.ts has no project
// value imports, so Node 24 type stripping runs it directly (zod and pngjs
// resolve from node_modules).
import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";

const {
  maskToBox,
  decodeMaskToBox,
  boxIou,
  selectRegions,
  chooseIdentifyMode,
  MAX_REGIONS,
  MIN_REGION_AREA,
} = await import("../lib/perception/sam.ts");

const approx = (actual, expected, msg) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${msg ?? "approx"}: ${actual} !== ${expected}`,
  );

/** Blank RGBA mask buffer (all channels 0 = every pixel off). */
const blankMask = (w, h) => new Uint8Array(w * h * 4);

/** Turn one pixel on (white, opaque). */
const setOn = (data, w, x, y) => {
  const i = (y * w + x) * 4;
  data[i] = 255;
  data[i + 1] = 255;
  data[i + 2] = 255;
  data[i + 3] = 255;
};

/** Fill an on-rectangle [x0..x1] x [y0..y1] inclusive. */
const fillRect = (data, w, x0, y0, x1, y1) => {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) setOn(data, w, x, y);
};

test("maskToBox: single blob yields a tight normalized box and pixel area", () => {
  const data = blankMask(10, 10);
  fillRect(data, 10, 2, 3, 4, 6); // 3 wide, 4 tall = 12 px
  const box = maskToBox(data, 10, 10);
  assert.ok(box, "non-empty mask returns a box");
  approx(box.bbox[0], 0.2, "x = minX/width");
  approx(box.bbox[1], 0.3, "y = minY/height");
  approx(box.bbox[2], 0.3, "w = (maxX-minX+1)/width");
  approx(box.bbox[3], 0.4, "h = (maxY-minY+1)/height");
  approx(box.area, 0.12, "area = onPixels/totalPixels");
});

test("maskToBox: two separated blobs in one mask yield the union box", () => {
  const data = blankMask(10, 10);
  setOn(data, 10, 0, 0);
  setOn(data, 10, 9, 9);
  const box = maskToBox(data, 10, 10);
  assert.ok(box);
  approx(box.bbox[0], 0, "union starts at first blob");
  approx(box.bbox[1], 0, "union starts at first blob");
  approx(box.bbox[2], 1, "union spans to second blob");
  approx(box.bbox[3], 1, "union spans to second blob");
  approx(box.area, 0.02, "area counts only on pixels, not the box");
});

test("maskToBox: empty mask returns null", () => {
  assert.equal(maskToBox(blankMask(8, 8), 8, 8), null);
});

test("maskToBox: pixels at exactly 127 stay off, 128 turns on", () => {
  const data = blankMask(4, 4);
  const i = (1 * 4 + 1) * 4;
  data[i] = 127;
  assert.equal(maskToBox(data, 4, 4), null, "127 is below the on threshold");
  data[i] = 128;
  const box = maskToBox(data, 4, 4);
  assert.ok(box, "128 crosses the on threshold");
  approx(box.area, 1 / 16);
});

test("decodeMaskToBox: pngjs write/read roundtrip matches raw-buffer math", () => {
  const w = 16;
  const h = 12;
  const data = blankMask(w, h);
  fillRect(data, w, 4, 2, 11, 9);
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(data);
  const bytes = PNG.sync.write(png);
  const decoded = decodeMaskToBox(new Uint8Array(bytes));
  const direct = maskToBox(data, w, h);
  assert.ok(decoded && direct);
  assert.deepEqual(decoded.bbox, direct.bbox);
  approx(decoded.area, direct.area);
});

test("boxIou: identical boxes 1, disjoint boxes 0", () => {
  approx(boxIou([0.1, 0.1, 0.3, 0.3], [0.1, 0.1, 0.3, 0.3]), 1);
  approx(boxIou([0, 0, 0.2, 0.2], [0.5, 0.5, 0.2, 0.2]), 0);
});

test("selectRegions: area floor drops regions under 0.5% of the image", () => {
  const tiny = { bbox: [0, 0, 0.05, 0.05], area: 0.004 };
  const kept = { bbox: [0.5, 0.5, 0.1, 0.1], area: 0.006 };
  const result = selectRegions([tiny, kept]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], kept);
  assert.equal(
    selectRegions([{ bbox: [0, 0, 0.1, 0.1], area: MIN_REGION_AREA }]).length,
    1,
    "exactly-at-floor region survives",
  );
});

test("selectRegions: overlap suppression keeps the larger of two duplicates", () => {
  const big = { bbox: [0.1, 0.1, 0.4, 0.4], area: 0.16 };
  const dupe = { bbox: [0.12, 0.12, 0.4, 0.4], area: 0.15 }; // IoU ~0.82 with big
  const separate = { bbox: [0.6, 0.6, 0.2, 0.2], area: 0.04 };
  const result = selectRegions([dupe, separate, big]);
  assert.equal(result.length, 2, "duplicate suppressed");
  assert.deepEqual(result[0], big, "largest area ranks first");
  assert.deepEqual(result[1], separate, "disjoint region survives");
});

test("selectRegions: caps at the 12 largest survivors", () => {
  // 15 disjoint boxes on a grid, strictly descending area.
  const boxes = [];
  for (let i = 0; i < 15; i++) {
    const col = i % 5;
    const row = Math.floor(i / 5);
    boxes.push({
      bbox: [col * 0.2, row * 0.2, 0.18, 0.18],
      area: 0.03 - i * 0.001,
    });
  }
  const result = selectRegions(boxes);
  assert.equal(result.length, MAX_REGIONS);
  approx(result[0].area, 0.03, "largest kept first");
  approx(result[11].area, 0.03 - 11 * 0.001, "12th largest is the cutoff");
});

test("degradation ladder: both keys -> sam+vlm, anthropic only -> vlm, else mock", () => {
  assert.equal(
    chooseIdentifyMode({ hasAnthropicKey: true, hasReplicateToken: true }),
    "sam+vlm",
  );
  assert.equal(
    chooseIdentifyMode({ hasAnthropicKey: true, hasReplicateToken: false }),
    "vlm",
  );
  assert.equal(
    chooseIdentifyMode({ hasAnthropicKey: false, hasReplicateToken: true }),
    "mock",
    "a Replicate token without a labeler still means mock",
  );
  assert.equal(
    chooseIdentifyMode({ hasAnthropicKey: false, hasReplicateToken: false }),
    "mock",
  );
});
