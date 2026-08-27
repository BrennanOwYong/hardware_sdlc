// Snapping labels onto masks. The bug this replaces put a correct mask under
// the wrong name, so the tests care most about pairings being right and about
// refusing a pairing rather than guessing one.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_FIT,
  containment,
  fitScore,
  iou,
  snapDetectionsToRegions,
  snapNote,
} from "../lib/perception/snap.ts";

const region = (bbox, maskPng = "MASK", area = 0.02) => ({ bbox, area, maskPng });
const det = (label, bbox, partType = "part", confidence = 0.9) => ({
  label,
  partType,
  confidence,
  bbox,
});

test("iou is zero for disjoint boxes and one for identical ones", () => {
  assert.equal(iou([0, 0, 0.1, 0.1], [0.5, 0.5, 0.1, 0.1]), 0);
  assert.equal(iou([0.2, 0.2, 0.3, 0.3], [0.2, 0.2, 0.3, 0.3]), 1);
});

test("containment sees a small region sitting inside a big detection box", () => {
  // A thin wire mask inside a generous model box: IoU is poor, containment is total.
  const wire = [0.30, 0.40, 0.02, 0.20];
  const box = [0.25, 0.35, 0.20, 0.30];
  assert.ok(iou(wire, box) < 0.15, "IoU alone would reject this correct pairing");
  // Float arithmetic on the intersection lands a hair off exactly 1.
  assert.ok(
    Math.abs(containment(wire, box) - 1) < 1e-9,
    "the wire is entirely inside the box",
  );
  assert.ok(fitScore({ bbox: wire, area: 0.004 }, det("wire", box)) >= MIN_FIT);
});

test("each detection takes the region it actually overlaps", () => {
  const regions = [
    region([0.05, 0.05, 0.15, 0.15], "MASK_LEFT"),
    region([0.70, 0.60, 0.20, 0.20], "MASK_RIGHT"),
  ];
  const detections = [
    det("Arduino Uno", [0.68, 0.58, 0.24, 0.24], "microcontroller"),
    det("Resistor", [0.04, 0.04, 0.18, 0.18], "resistor"),
  ];
  const { parts } = snapDetectionsToRegions(detections, regions);
  const uno = parts.find((p) => p.label === "Arduino Uno");
  const res = parts.find((p) => p.label === "Resistor");
  assert.equal(uno.maskPng, "MASK_RIGHT", "the board takes the right-hand mask");
  assert.equal(res.maskPng, "MASK_LEFT", "the resistor takes the left-hand mask");
  // And the position comes from segmentation, not from the model's estimate.
  assert.deepEqual(uno.bbox, [0.70, 0.60, 0.20, 0.20]);
});

test("a region is claimed once: the stronger pairing wins it", () => {
  const regions = [region([0.40, 0.40, 0.10, 0.10], "ONLY")];
  const detections = [
    det("exact match", [0.40, 0.40, 0.10, 0.10]),
    det("loose overlap", [0.35, 0.35, 0.30, 0.30]),
  ];
  const { parts, unmatchedDetections } = snapDetectionsToRegions(detections, regions);
  assert.equal(parts.find((p) => p.label === "exact match").maskPng, "ONLY");
  assert.equal(parts.find((p) => p.label === "loose overlap").maskPng, undefined);
  assert.equal(unmatchedDetections, 1);
});

test("a detection over nothing keeps its own box and gets no mask", () => {
  const regions = [region([0.80, 0.80, 0.10, 0.10])];
  const detections = [det("Pen", [0.05, 0.05, 0.08, 0.08], "stationery")];
  const { parts, unmatchedDetections, unclaimedRegions } = snapDetectionsToRegions(
    detections,
    regions,
  );
  assert.equal(parts[0].maskPng, undefined, "no mask beats a wrong mask");
  assert.deepEqual(parts[0].bbox, [0.05, 0.05, 0.08, 0.08]);
  assert.equal(unmatchedDetections, 1);
  assert.equal(unclaimedRegions, 1);
});

test("every detection survives even with no regions at all", () => {
  const detections = [det("Tweezers", [0.1, 0.1, 0.1, 0.1]), det("Pen", [0.3, 0.3, 0.1, 0.1])];
  const { parts } = snapDetectionsToRegions(detections, []);
  assert.equal(parts.length, 2, "segmentation failing must not lose the labels");
  assert.ok(parts.every((p) => p.maskPng === undefined));
});

test("ids are sequential and labels are preserved verbatim", () => {
  const { parts } = snapDetectionsToRegions(
    [det("Resistors, assorted, on card", [0.1, 0.1, 0.1, 0.1], "resistor", 0.85)],
    [region([0.1, 0.1, 0.1, 0.1])],
  );
  assert.equal(parts[0].id, "p1");
  assert.equal(parts[0].label, "Resistors, assorted, on card");
  assert.equal(parts[0].partType, "resistor");
  assert.equal(parts[0].confidence, 0.85);
});

test("the note reports what actually happened, masks included", () => {
  const result = snapDetectionsToRegions(
    [det("a", [0.1, 0.1, 0.1, 0.1]), det("b", [0.8, 0.8, 0.05, 0.05])],
    [region([0.1, 0.1, 0.1, 0.1])],
  );
  assert.equal(snapNote(1, result), "sam+vlm: 1 regions, 2 labelled, masks on 1 parts");
});

test("a SAM fragment inside a whole-object box pairs, and so does the reverse", () => {
  // SAM returned only the power bank's red body; the model boxed the whole
  // thing including its cables.
  const fragment = { bbox: [0.06, 0.62, 0.18, 0.20], area: 0.036, maskPng: "FRAG" };
  const whole = det("USB power bank", [0.02, 0.58, 0.35, 0.32], "battery");
  assert.ok(fitScore(fragment, whole) >= MIN_FIT, "fragment inside box must pair");

  // And the other way: SAM merged the stand with its shadow, the model boxed
  // only the stand.
  const merged = { bbox: [0.20, 0.05, 0.46, 0.46], area: 0.21, maskPng: "MERGED" };
  const tight = det("Phone stand", [0.24, 0.08, 0.38, 0.38], "accessory");
  assert.ok(fitScore(merged, tight) >= MIN_FIT, "box inside region must pair too");
});

test("genuinely separate objects still refuse to pair", () => {
  const far = { bbox: [0.80, 0.05, 0.10, 0.10], area: 0.01, maskPng: "FAR" };
  const near = det("Pen", [0.05, 0.85, 0.08, 0.12], "stationery");
  assert.ok(fitScore(far, near) < MIN_FIT, "no overlap must stay unpaired");
});
