// Mask geometry: the arrow must land on real pixels of real objects.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ALPHA_THRESHOLD,
  bboxCenter,
  farthestEdgePoint,
  guideBetween,
  maskBounds,
  maskCentroid,
  maskIsEmpty,
  matchObject,
  nearestEdgePoint,
} from "../lib/masks/anchors.ts";

/** Build a mask from an ASCII picture: '#' is covered, '.' is background. */
function maskFrom(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const alpha = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      alpha[y * width + x] = ch === "#" ? 255 : 0;
    });
  });
  return { width, height, alpha };
}

const SQUARE = maskFrom([
  "..........",
  "..####....",
  "..####....",
  "..####....",
  "..........",
]);

test("an empty mask is reported as empty, not as a point at the origin", () => {
  const empty = maskFrom(["....", "....", "...."]);
  assert.equal(maskIsEmpty(empty), true);
  assert.equal(maskCentroid(empty), null);
  assert.equal(maskBounds(empty), null);
  assert.equal(maskIsEmpty(SQUARE), false);
});

test("centroid sits at the centre of mass", () => {
  const c = maskCentroid(SQUARE);
  assert.ok(Math.abs(c.x - 0.35) < 0.02, `x was ${c.x}`);
  // Rows 1..3 of 5 -> mean row 2 -> 2/5 = 0.4. Verified by hand, not guessed.
  assert.ok(Math.abs(c.y - 0.4) < 0.02, `y was ${c.y}`);
});

test("centroid follows the pixels, not the bounding box, for an L shape", () => {
  // An L's bbox centre falls in the empty corner; its centroid must not.
  const L = maskFrom([
    "##........",
    "##........",
    "##........",
    "########..",
    "########..",
  ]);
  const c = maskCentroid(L);
  const b = maskBounds(L);
  const bboxCentre = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  assert.ok(
    c.x < bboxCentre.x,
    `centroid ${c.x} should sit left of the bbox centre ${bboxCentre.x}`,
  );
});

test("nearestEdgePoint faces the traveller, farthest faces away", () => {
  const near = nearestEdgePoint(SQUARE, { x: 1, y: 0.5 }); // approach from the right
  const far = farthestEdgePoint(SQUARE, { x: 1, y: 0.5 });
  assert.ok(near.x > far.x, "the near edge must be closer to the approach side");
  // And both must actually be inside the object.
  const b = maskBounds(SQUARE);
  for (const p of [near, far]) {
    assert.ok(p.x >= b.x - 0.01 && p.x <= b.x + b.w + 0.01, "point inside bounds");
  }
});

test("approaching from the other side flips the near edge", () => {
  const fromRight = nearestEdgePoint(SQUARE, { x: 1, y: 0.5 });
  const fromLeft = nearestEdgePoint(SQUARE, { x: 0, y: 0.5 });
  assert.ok(fromLeft.x < fromRight.x, "the near edge tracks the approach direction");
});

test("guideBetween anchors both ends on masks and says so", () => {
  const mover = maskFrom(["##........", "##........", "..........", "..........", ".........."]);
  const dest = maskFrom(["........##", "........##", "..........", "..........", ".........."]);
  const g = guideBetween(
    { mask: mover, fallback: { x: 0, y: 0 } },
    { mask: dest, fallback: { x: 1, y: 1 } },
  );
  assert.equal(g.source, "mask");
  assert.ok(g.from.x < g.to.x, "the arrow runs from the mover toward the destination");
  // The endpoints must sit on the objects, not at the guessed fallbacks.
  assert.notDeepEqual(g.from, { x: 0, y: 0 });
  assert.notDeepEqual(g.to, { x: 1, y: 1 });
});

test("a missing mask degrades to the estimate and is labelled model", () => {
  const g = guideBetween(
    { mask: null, fallback: { x: 0.2, y: 0.2 } },
    { mask: null, fallback: { x: 0.8, y: 0.8 } },
  );
  assert.equal(g.source, "model");
  assert.deepEqual(g.from, { x: 0.2, y: 0.2 });
  assert.deepEqual(g.to, { x: 0.8, y: 0.8 });
});

test("one mask present is still reported as model, never as mask", () => {
  const g = guideBetween(
    { mask: SQUARE, fallback: { x: 0.2, y: 0.2 } },
    { mask: null, fallback: { x: 0.9, y: 0.5 } },
  );
  assert.equal(g.source, "model", "a half-guessed arrow is a guessed arrow");
});

test("an empty mask counts as absent rather than as an object at 0,0", () => {
  const empty = maskFrom(["....", "....", "...."]);
  const g = guideBetween(
    { mask: empty, fallback: { x: 0.3, y: 0.3 } },
    { mask: empty, fallback: { x: 0.7, y: 0.7 } },
  );
  assert.equal(g.source, "model");
});

test("bboxCenter is the documented fallback", () => {
  assert.deepEqual(bboxCenter([0.2, 0.4, 0.2, 0.2]), { x: 0.30000000000000004, y: 0.5 });
});

test("matchObject prefers shared words and uses overlap to break ties", () => {
  const candidates = [
    { label: "USB-C cable end", bbox: [0.1, 0.1, 0.2, 0.2] },
    { label: "laptop USB port", bbox: [0.6, 0.5, 0.15, 0.1] },
    { label: "ceramic mug", bbox: [0.8, 0.8, 0.1, 0.1] },
  ];
  const port = matchObject({ label: "the USB port on the laptop", bbox: [0.6, 0.5, 0.15, 0.1] }, candidates);
  assert.equal(port.label, "laptop USB port");
  const cable = matchObject({ label: "USB cable", bbox: [0.1, 0.1, 0.2, 0.2] }, candidates);
  assert.equal(cable.label, "USB-C cable end");
});

test("matchObject returns null rather than pointing at the wrong object", () => {
  const candidates = [{ label: "ceramic mug", bbox: [0.8, 0.8, 0.1, 0.1] }];
  assert.equal(matchObject({ label: "USB port", bbox: [0.1, 0.1, 0.1, 0.1] }, candidates), null);
});

test("alpha below the threshold is treated as background", () => {
  const soft = { width: 2, height: 1, alpha: new Uint8Array([ALPHA_THRESHOLD - 1, 255]) };
  // Only pixel x=1 counts, so the centroid is 1/2 = 0.5.
  assert.equal(maskCentroid(soft).x, 0.5);
  // With both pixels solid it would sit halfway between them, at 0.25.
  const both = { width: 2, height: 1, alpha: new Uint8Array([255, 255]) };
  assert.equal(maskCentroid(both).x, 0.25);
});
