// The guided build: dependencies must reflect physical reality, and the
// before/after states must match what a person would actually see.
import test from "node:test";
import assert from "node:assert/strict";
import {
  GUIDED_STEPS,
  LEGEND,
  computeWaves,
  legendFor,
  netlistAfter,
  netlistBefore,
  orderingNote,
  siblingsInWave,
  waveIndexById,
} from "../lib/assembly/guided.ts";
import { refToXY } from "../lib/assembly/circuits.ts";

const byId = (id) => GUIDED_STEPS.find((s) => s.id === id);

test("the build is well formed: contiguous indices, resolvable parts and refs", () => {
  GUIDED_STEPS.forEach((s, i) => {
    assert.equal(s.index, i + 1, `step ${s.id} index`);
    for (const p of s.parts) {
      assert.ok(
        LEGEND.some((l) => l.id === p),
        `step ${s.id} references unknown part ${p}`,
      );
    }
    for (const d of s.dependsOn) {
      assert.ok(byId(d), `step ${s.id} depends on unknown step ${d}`);
    }
    if (s.edge) {
      assert.ok(refToXY(s.edge.from), `${s.id} from ref ${s.edge.from} must map`);
      assert.ok(refToXY(s.edge.to), `${s.id} to ref ${s.edge.to} must map`);
    }
  });
});

test("the build includes a code-injection step and a verification step", () => {
  assert.ok(GUIDED_STEPS.some((s) => s.kind === "flash"), "needs a flash step");
  assert.ok(GUIDED_STEPS.some((s) => s.kind === "verify"), "needs a verify step");
  const flash = GUIDED_STEPS.find((s) => s.kind === "flash");
  assert.ok(flash.code?.includes("digitalWrite"), "flash step ships a sketch");
  assert.deepEqual(flash.pins, ["UNO:D2", "UNO:D13", "UNO:GND"]);
});

test("independent wiring shares a wave: order genuinely does not matter", () => {
  const waves = computeWaves(GUIDED_STEPS);
  const first = waves[0].map((s) => s.id);
  // Grounding, the LED, pin 13, the button and its wires are all independent.
  for (const id of ["w1", "c1", "w2", "c2", "w3", "w4"]) {
    assert.ok(first.includes(id), `${id} should be free to do first`);
  }
  assert.equal(
    first.includes("r1"),
    false,
    "the resistor bridges the LED's row, so it waits",
  );
});

test("software injection waits for the wiring it drives", () => {
  const waves = computeWaves(GUIDED_STEPS);
  const waveOf = waveIndexById(GUIDED_STEPS);
  // The sketch names D2 and D13, so those wires must land first.
  assert.ok(waveOf.get("flash") > waveOf.get("w2"), "flash after the D13 wire");
  assert.ok(waveOf.get("flash") > waveOf.get("w3"), "flash after the D2 wire");
  assert.ok(waveOf.get("verify") > waveOf.get("flash"), "verify after flash");
  assert.ok(waves.length >= 3, "the build is not one undifferentiated blob");
});

test("before and after states differ by exactly the step's own edge", () => {
  const before = netlistBefore(GUIDED_STEPS, "w2");
  const after = netlistAfter(GUIDED_STEPS, "w2");
  assert.equal(after.edges.length, before.edges.length + 1);
  const added = after.edges.filter(
    (e) => !before.edges.some((b) => b.id === e.id),
  );
  assert.equal(added.length, 1);
  assert.equal(added[0].id, "w2");
});

test("the first step starts from an empty board", () => {
  assert.deepEqual(netlistBefore(GUIDED_STEPS, "w1").edges, []);
  assert.equal(netlistAfter(GUIDED_STEPS, "w1").edges.length, 1);
});

test("a step with no edge leaves the circuit unchanged", () => {
  const before = netlistBefore(GUIDED_STEPS, "flash");
  const after = netlistAfter(GUIDED_STEPS, "flash");
  assert.deepEqual(
    after.edges.map((e) => e.id),
    before.edges.map((e) => e.id),
    "flashing changes the software, not the wiring",
  );
});

test("ordering notes tell the truth about freedom and constraint", () => {
  assert.match(orderingNote(byId("w1"), GUIDED_STEPS), /Any order/);
  assert.match(orderingNote(byId("r1"), GUIDED_STEPS), /Must come after/);
  assert.match(orderingNote(byId("flash"), GUIDED_STEPS), /Must come after/);
});

test("siblings in a wave exclude the step itself", () => {
  const sibs = siblingsInWave(byId("w1"), GUIDED_STEPS);
  assert.equal(sibs.some((s) => s.id === "w1"), false);
  assert.ok(sibs.length > 0, "w1 shares its wave with other free steps");
});

test("legendFor resolves a step's parts to full legend entries", () => {
  const parts = legendFor(byId("w1"));
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => typeof p.colour === "string" && p.name.length > 0));
});

test("every step lands in exactly one wave", () => {
  const waves = computeWaves(GUIDED_STEPS);
  const flat = waves.flat().map((s) => s.id);
  assert.equal(flat.length, GUIDED_STEPS.length);
  assert.equal(new Set(flat).size, GUIDED_STEPS.length, "no step appears twice");
});
