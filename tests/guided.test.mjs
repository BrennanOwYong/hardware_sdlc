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
  presentationOrder,
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
  // Grounding, the LED and the whole button branch are independent of each other.
  for (const id of ["w1", "c1", "c2", "w3", "w4"]) {
    assert.ok(first.includes(id), `${id} should be free to do first`);
  }
  assert.equal(
    first.includes("r1"),
    false,
    "the resistor bridges the LED's row, so it waits",
  );
  assert.equal(
    first.includes("w2"),
    false,
    "the pin-13 wire is a 5V source: it waits for the resistor that limits it",
  );
});

test("the LED's current limit exists before its power source does", () => {
  const waveOf = waveIndexById(GUIDED_STEPS);
  // Wiring a driven pin to an unprotected LED can destroy it the moment the
  // board powers up, so this ordering is a safety fact, not a preference.
  assert.ok(
    waveOf.get("w2") > waveOf.get("r1"),
    "pin 13 must not reach the LED before the 220Ω resistor is in place",
  );
  assert.ok(waveOf.get("r1") > waveOf.get("c1"), "the resistor needs the LED seated");
});

test("the button's two wires land on opposite sides of the centre groove", () => {
  const byId = new Map(GUIDED_STEPS.map((s) => [s.id, s]));
  const signal = byId.get("w3").edge;
  const ground = byId.get("w4").edge;
  const side = (ref) => (/^BB:\d+:([a-e])$/.test(ref) ? "left" : "right");
  const signalHole = [signal.from, signal.to].find((r) => r.startsWith("BB:"));
  const groundHole = [ground.from, ground.to].find((r) => r.startsWith("BB:") && !r.includes("RAIL"));
  // Same side means D2 is permanently grounded and the button does nothing:
  // the circuit behaves as though it were held down forever.
  assert.notEqual(
    side(signalHole),
    side(groundHole),
    "signal and ground on one side would short the pin to ground",
  );
});

test("the button edge is the connection it CLOSES, across the groove", () => {
  const button = GUIDED_STEPS.find((s) => s.id === "c2").edge;
  const [, , fromCol] = button.from.split(":");
  const [, , toCol] = button.to.split(":");
  const leftHalf = (c) => "abcde".includes(c);
  assert.notEqual(
    leftHalf(fromCol),
    leftHalf(toCol),
    "a pushbutton bridges the groove; an edge within one half is a leg pair, not the switch",
  );
});

test("every step says why it exists, not only what to do", () => {
  for (const s of GUIDED_STEPS) {
    assert.ok(s.why && s.why.length > 40, `${s.id} needs a real explanation`);
    assert.doesNotMatch(s.why, /BB:|UNO:/, `${s.id} explains in words, not refs`);
  }
});

test("only steps the app can confirm are marked agent-checkable", () => {
  const checkable = GUIDED_STEPS.filter((s) => s.agentCheckable).map((s) => s.id);
  assert.deepEqual(checkable.sort(), ["flash", "power"]);
  // Everything else is a human observation; a tickbox for it would record a
  // claim nobody verified.
  const verify = GUIDED_STEPS.find((s) => s.id === "verify");
  assert.notEqual(verify.agentCheckable, true);
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

test("the before-state never shows a step that has not come up yet", () => {
  // The authoring order in GUIDED_STEPS is not the order the UI presents, so
  // walking the array put the resistor on the board during "Seat the button".
  const before = netlistBefore(GUIDED_STEPS, "c2");
  const ids = before.edges.map((e) => e.id);
  assert.ok(!ids.includes("r1"), "the resistor belongs to a later group");
  assert.ok(!ids.includes("w2"), "the pin-13 wire belongs to a later group");
  assert.deepEqual(ids, ["w1", "c1"], "only what the list showed above it");
});

test("every step's before-state is a subset of the steps shown above it", () => {
  const order = presentationOrder(GUIDED_STEPS);
  order.forEach((step, i) => {
    const allowed = new Set(
      order.slice(0, i).map((s) => s.edge?.id).filter(Boolean),
    );
    for (const e of netlistBefore(GUIDED_STEPS, step.id).edges) {
      assert.ok(allowed.has(e.id), `${step.id} shows ${e.id} too early`);
    }
  });
});

test("presentation order groups by wave, not by how the file was written", () => {
  const order = presentationOrder(GUIDED_STEPS).map((s) => s.id);
  assert.ok(order.indexOf("c2") < order.indexOf("r1"), "button before resistor");
  assert.ok(order.indexOf("r1") < order.indexOf("w2"), "resistor before pin 13");
  assert.equal(order.length, GUIDED_STEPS.length, "no step lost or duplicated");
});
