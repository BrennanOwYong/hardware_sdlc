// ar-find builder verification: marker geometry + query matching.
// lib/inventory/markers.ts only has type-only project imports, so Node 24
// type stripping runs it directly.
import test from "node:test";
import assert from "node:assert/strict";

const {
  markerFromBbox,
  haloGeometry,
  matchesQuery,
  markersForQuery,
  FALLBACK_MARKER_SIZE,
  MIN_MARKER_SIZE,
} = await import("../lib/inventory/markers.ts");

const approx = (actual, expected, msg) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${msg ?? "approx"}: ${actual} !== ${expected}`,
  );

test("markerFromBbox centers the marker on the bbox", () => {
  const m = markerFromBbox([0.2, 0.4, 0.2, 0.1], "LED (red)", "find");
  approx(m.x, 0.3, "center x = bx + bw/2");
  approx(m.y, 0.45, "center y = by + bh/2");
  approx(m.w, 0.2, "w passes through");
  approx(m.h, 0.1, "h passes through");
  assert.equal(m.label, "LED (red)");
  assert.equal(m.kind, "find");
});

test("markerFromBbox clamps a center that falls outside 0..1", () => {
  const m = markerFromBbox([0.9, 0.95, 0.4, 0.4], "edge part", "find");
  assert.equal(m.x, 1);
  assert.equal(m.y, 1);
});

test("haloGeometry converts normalized coords to percentages", () => {
  const g = haloGeometry({ x: 0.3, y: 0.45, w: 0.2, h: 0.1 });
  approx(g.leftPct, 20, "left = (x - w/2) * 100");
  approx(g.topPct, 40, "top = (y - h/2) * 100");
  approx(g.widthPct, 20, "width");
  approx(g.heightPct, 10, "height");
});

test("haloGeometry falls back to the fixed size when w/h are missing", () => {
  const g = haloGeometry({ x: 0.5, y: 0.5 });
  approx(g.widthPct, FALLBACK_MARKER_SIZE * 100, "fallback width");
  approx(g.heightPct, FALLBACK_MARKER_SIZE * 100, "fallback height");
  approx(g.leftPct, (0.5 - FALLBACK_MARKER_SIZE / 2) * 100, "still centered");
  approx(g.topPct, (0.5 - FALLBACK_MARKER_SIZE / 2) * 100, "still centered");
});

test("haloGeometry falls back when the bbox is degenerate", () => {
  const g = haloGeometry({ x: 0.5, y: 0.5, w: MIN_MARKER_SIZE / 2, h: 0 });
  approx(g.widthPct, FALLBACK_MARKER_SIZE * 100, "tiny w gets fallback");
  approx(g.heightPct, FALLBACK_MARKER_SIZE * 100, "zero h gets fallback");
});

test("haloGeometry keeps a usable explicit size", () => {
  const g = haloGeometry({ x: 0.5, y: 0.5, w: 0.5, h: 0.25 });
  approx(g.widthPct, 50, "explicit w kept");
  approx(g.heightPct, 25, "explicit h kept");
});

test("matchesQuery is case-insensitive over label and partType", () => {
  const led = { label: "LED (red)", partType: "led" };
  assert.equal(matchesQuery(led, "RED"), true);
  assert.equal(matchesQuery(led, "led"), true);
  assert.equal(matchesQuery(led, "  Led "), true, "query is trimmed");
  assert.equal(matchesQuery(led, "resistor"), false);
});

test("matchesQuery: blank query matches nothing", () => {
  const led = { label: "LED (red)", partType: "led" };
  assert.equal(matchesQuery(led, ""), false);
  assert.equal(matchesQuery(led, "   "), false);
});

test("markersForQuery filters by query and converts to find markers", () => {
  const parts = [
    { label: "LED (red)", partType: "led", bbox: [0.1, 0.1, 0.2, 0.2] },
    { label: "Jumper wire (red)", partType: "jumper-wire", bbox: [0.5, 0.5, 0.2, 0.1] },
    { label: "220Ω resistor", partType: "resistor", bbox: [0.7, 0.7, 0.2, 0.05] },
  ];
  const markers = markersForQuery(parts, "red");
  assert.equal(markers.length, 2);
  assert.deepEqual(
    markers.map((m) => m.label),
    ["LED (red)", "Jumper wire (red)"],
  );
  for (const m of markers) assert.equal(m.kind, "find");
  approx(markers[1].x, 0.6, "second marker centered");
  approx(markers[1].y, 0.55, "second marker centered");
});

test("markersForQuery with a blank query returns no markers", () => {
  const parts = [
    { label: "LED (red)", partType: "led", bbox: [0.1, 0.1, 0.2, 0.2] },
  ];
  assert.deepEqual(markersForQuery(parts, "  "), []);
});
