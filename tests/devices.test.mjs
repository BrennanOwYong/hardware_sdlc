// The wireframe is only worth drawing if it follows the model. These tests
// hold the two claims the UI makes: a hole exists where the spec says it
// exists, and a hole the spec does not have cannot be resolved into a
// confident-looking coordinate.
import test from "node:test";
import assert from "node:assert/strict";
import { CATALOG, specById } from "../lib/devices/catalog.ts";
import {
  PITCH_MM,
  autoPlace,
  columnLetters,
  describeRef,
  geometryFor,
  layoutProject,
  nearestHole,
  pinLabel,
  resolveRef,
  sameNode,
  specSummary,
} from "../lib/devices/layout.ts";
import { detectDevices, detectDevicesOrDefault } from "../lib/devices/detect.ts";

const lookup = (id) => specById(id);

const project = (specIds) => layoutProject(autoPlace(specIds, lookup), lookup);

test("every catalog entry has a unique id and a model name", () => {
  const ids = CATALOG.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(CATALOG.every((s) => s.model.length > 0));
});

test("column letters follow columnsPerHalf, not a fixed a-j", () => {
  assert.deepEqual(columnLetters(specById("bb-400")), [
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
  ]);
  // Three receptacles per half means six columns exist and j does not.
  assert.deepEqual(columnLetters(specById("bb-3col")), ["a", "b", "c", "d", "e", "f"]);
});

test("a 3-column board has no column e-j holes at all", () => {
  const layout = project(["bb-3col"]);
  assert.ok(resolveRef(layout, "BB:12:c"), "column c exists");
  assert.equal(resolveRef(layout, "BB:12:j"), null, "column j does not exist");
  // Refusing to place it is the point: a drawn hole would be a lie you could
  // push a wire into.
});

test("row count comes from the model", () => {
  const mini = project(["bb-170"]);
  assert.ok(resolveRef(mini, "BB:17:a"), "17 rows on a 170-point board");
  assert.equal(resolveRef(mini, "BB:18:a"), null);

  const full = project(["bb-830"]);
  assert.ok(resolveRef(full, "BB:63:a"), "63 rows on an 830-point board");
  assert.equal(resolveRef(full, "BB:64:a"), null);
});

test("a board with no rails cannot resolve a rail ref", () => {
  const mini = project(["bb-170"]);
  assert.equal(
    resolveRef(mini, "BB:RAIL:GND"),
    null,
    "the SYB-170 has no rails, so a ground-rail instruction is unbuildable here",
  );
  const half = project(["bb-400"]);
  assert.ok(resolveRef(half, "BB:RAIL:GND"));
  assert.ok(resolveRef(half, "BB:RAIL:PWR"));
});

test("holes sit one pitch apart in real millimetres", () => {
  const geo = geometryFor(specById("bb-400"), "BB");
  const a1 = geo.holes.find((h) => h.localRef === "1:a");
  const a2 = geo.holes.find((h) => h.localRef === "2:a");
  const b1 = geo.holes.find((h) => h.localRef === "1:b");
  assert.ok(Math.abs(a2.x - a1.x - PITCH_MM) < 1e-9);
  assert.ok(Math.abs(b1.y - a1.y - PITCH_MM) < 1e-9);
});

test("the centre channel is a real 0.3 inch gap between e and f", () => {
  const geo = geometryFor(specById("bb-400"), "BB");
  const e = geo.holes.find((h) => h.localRef === "1:e");
  const f = geo.holes.find((h) => h.localRef === "1:f");
  assert.ok(Math.abs(f.y - e.y - 7.62) < 1e-9);
});

test("rail holes come in groups of five with a gap, not evenly spaced", () => {
  const geo = geometryFor(specById("bb-400"), "BB");
  const rail = geo.holes
    .filter((h) => h.group === "rail" && h.ref.includes("RAIL:T+"))
    .sort((a, b) => a.x - b.x);
  const gaps = rail.slice(1).map((h, i) => Math.round((h.x - rail[i].x) * 100) / 100);
  assert.ok(gaps.includes(2.54), "holes inside a group are one pitch apart");
  assert.ok(gaps.includes(5.08), "a double gap separates groups");
});

test("legacy refs from existing netlists still resolve", () => {
  const layout = project(["bb-400", "uno-r3"]);
  for (const ref of ["BB:5:f", "BB:17:a", "BB:RAIL:GND", "UNO:D13", "UNO:GND", "UNO:5V", "UNO:A0"]) {
    assert.ok(resolveRef(layout, ref), `${ref} must still resolve`);
  }
});

test("holes in the same half-row share a node; across the channel they do not", () => {
  const layout = project(["bb-400"]);
  assert.ok(sameNode(layout, "BB:5:a", "BB:5:e"), "a-e are one strip");
  assert.ok(!sameNode(layout, "BB:5:e", "BB:5:f"), "the channel splits the row");
  assert.ok(!sameNode(layout, "BB:5:a", "BB:6:a"), "different rows are separate");
});

test("a 5V board and a 3.3V board are distinguishable from the spec alone", () => {
  assert.equal(specById("uno-r3").logicV, 5);
  assert.equal(specById("esp32-devkit-v1").logicV, 3.3);
  assert.match(specSummary(specById("uno-r3")), /ATmega328P/);
  assert.match(specSummary(specById("bb-170")), /170 tie points/);
});

test("the Uno header keeps its physical jog between D7 and D8", () => {
  const geo = geometryFor(specById("uno-r3"), "UNO");
  const d8 = geo.holes.find((h) => h.localRef === "D8");
  const d7 = geo.holes.find((h) => h.localRef === "D7");
  assert.ok(d7.x - d8.x > PITCH_MM * 1.5, "the gap is wider than one pitch");
});

test("a second GND pin keeps a distinct ref but prints as GND", () => {
  const geo = geometryFor(specById("uno-r3"), "UNO");
  assert.ok(geo.holes.some((h) => h.localRef === "GND"));
  assert.ok(geo.holes.some((h) => h.localRef === "GND2"));
  assert.equal(pinLabel("GND2"), "GND");
  assert.equal(pinLabel("D13"), "D13");
});

test("two breadboards get distinct instance prefixes", () => {
  const placements = autoPlace(["bb-400", "bb-400", "uno-r3"], lookup);
  assert.deepEqual(
    placements.map((p) => p.instanceId),
    ["BB", "BB2", "UNO"],
  );
});

test("descriptions name the model, so an instruction is checkable", () => {
  const layout = project(["bb-170", "uno-r3"]);
  assert.match(describeRef(layout, "BB:5:c"), /row 5, hole c on the SYB-170/);
  assert.match(describeRef(layout, "UNO:D13"), /D13 pin on the Arduino UNO Rev3/);
});

test("snapping picks a hole only within the snap radius", () => {
  const layout = project(["bb-400"]);
  const target = layout.holes.find((h) => h.localRef === "10:c");
  assert.equal(nearestHole(layout, target.x + 0.3, target.y + 0.3)?.ref, target.ref);
  assert.equal(nearestHole(layout, target.x + 40, target.y + 40), null);
});

test("no two holes share a ref: a target ring lands on exactly one hole", () => {
  const layout = project(["bb-830", "uno-r3", "esp32-devkit-v1"]);
  const refs = layout.holes.map((h) => h.ref);
  assert.equal(new Set(refs).size, refs.length);
  // The Uno carries three grounds; only the one beside D13 answers to UNO:GND.
  assert.equal(layout.holes.filter((h) => h.ref === "UNO:GND").length, 1);
});

test("a loose rail ref lands mid-line, not at the seam between two rails", () => {
  const layout = project(["bb-400"]);
  const xy = resolveRef(layout, "BB:RAIL:GND");
  const chosen = layout.holes.find((h) => h.x === xy.x && h.y === xy.y);
  const line = layout.holes.filter((h) =>
    h.ref.startsWith(chosen.ref.split(":").slice(0, 3).join(":") + ":"),
  );
  const xs = line.map((h) => h.x);
  const span = Math.max(...xs) - Math.min(...xs);
  const offCentre = Math.abs(xy.x - (Math.min(...xs) + span / 2));
  assert.ok(offCentre < span * 0.1, "the landing hole sits near the middle of its own rail");
  assert.equal(new Set(line.map((h) => h.y)).size, 1, "one rail line, not two");
});

test("a tie-point count in the label picks the exact model", () => {
  const { matches } = detectDevices(["830 tie-point solderless breadboard"], CATALOG);
  assert.equal(matches[0].specId, "bb-830");
  assert.equal(matches[0].basis, "model-name");
});

test("a vague breadboard label defaults but says it defaulted", () => {
  const { matches } = detectDevices(["a breadboard"], CATALOG);
  assert.equal(matches[0].specId, "bb-400");
  assert.equal(matches[0].basis, "class-default");
  assert.match(matches[0].why, /not which one/);
});

test("board labels match on model name and beat vaguer aliases", () => {
  const { matches } = detectDevices(["Arduino Uno R3 microcontroller board"], CATALOG);
  assert.equal(matches[0].specId, "uno-r3");
  const esp = detectDevices(["ESP32 dev board"], CATALOG);
  assert.equal(esp.matches[0].specId, "esp32-devkit-v1");
});

test("parts that are not devices fall through to unmatched", () => {
  const { matches, unmatched } = detectDevices(
    ["red LED", "220 ohm resistor", "jumper wires"],
    CATALOG,
  );
  assert.equal(matches.length, 0);
  assert.equal(unmatched.length, 3);
});

test("an empty inventory still yields something to draw, flagged as assumed", () => {
  const { matches } = detectDevicesOrDefault([], CATALOG, {
    breadboardId: "bb-400",
    boardId: "uno-r3",
  });
  assert.equal(matches.length, 2);
  assert.ok(matches.every((m) => m.basis === "assumed"));
  assert.ok(matches.every((m) => m.confidence <= 0.2));
});

test("one Uno seen twice does not become a two-board build", () => {
  const { matches } = detectDevices(
    ["Arduino Uno", "Arduino Uno board, angled view"],
    CATALOG,
  );
  assert.equal(matches.length, 1);
});

test("the bench lays out wider than it is tall, so a wide screen can fill", () => {
  const layout = project(["bb-400", "uno-r3"]);
  assert.ok(
    layout.widthMm > layout.heightMm,
    "stacking devices vertically leaves a wide column mostly empty",
  );
  const [bb, uno] = layout.devices;
  assert.ok(uno.placement.xMm > bb.placement.xMm + bb.geometry.widthMm,
    "the board sits clear to the right of the breadboard, not overlapping it");
});

test("devices are squared up against each other vertically", () => {
  const layout = project(["bb-400", "uno-r3"]);
  const centre = (d) => d.placement.yMm + d.geometry.heightMm / 2;
  const [a, b] = layout.devices;
  assert.ok(Math.abs(centre(a) - centre(b)) < 0.01, "centred on one line");
});
