// Step-graph reducer tests. Run with:
//   node --test tests/stepgraph.test.mjs
//
// Imports .ts modules directly via Node's native type stripping (Node 24;
// flagless since 23.6.0). Both imported modules keep all their imports
// type-only, so no runtime resolution of "@/lib/types" happens; the .ts
// extension in the specifiers below is mandatory under type stripping.
// See docs/references-p2.md.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createInitialState,
  currentStep,
  observedNetlist,
  phaseForStep,
  progressPct,
  reducer,
} from "../lib/assembly/stepgraph.ts";
import { buttonLedSteps } from "../lib/assembly/circuits.ts";

function tipAt(ref) {
  return { type: "tip-at", atMs: 0, ref };
}
function seated(edgeId) {
  return { type: "seated", atMs: 0, edgeId };
}
function misplaced(edgeId, expected, observed) {
  return { type: "misplaced", atMs: 0, edgeId, expected, observed };
}

test("canonical circuit has 7 steps with mapped targets", () => {
  assert.equal(buttonLedSteps.length, 7);
  for (const step of buttonLedSteps) {
    assert.equal(step.targets.length, 2);
    for (const t of step.targets) {
      assert.ok(t.x >= 0 && t.x <= 1, `${t.ref} x in 0..1`);
      assert.ok(t.y >= 0 && t.y <= 1, `${t.ref} y in 0..1`);
    }
  }
  assert.deepEqual(
    buttonLedSteps.map((s) => s.edge.id),
    ["e1", "e2", "e3", "e4", "e5", "e6", "e7"],
  );
});

test("happy path: two-stage advance through all 7 steps", () => {
  let s = createInitialState(buttonLedSteps);
  assert.equal(s.phase, "active");
  assert.equal(progressPct(s), 0);

  for (const step of buttonLedSteps) {
    assert.equal(currentStep(s), step);
    // Stage 1: tip touches a correct target
    s = reducer(s, tipAt(step.targets[0].ref));
    assert.equal(s.phase, "tip-on-target", `step ${step.index} stage 1`);
    // Stage 2: the wire seats
    s = reducer(s, seated(step.edge.id));
    assert.equal(s.phase, "seated", `step ${step.index} stage 2`);
    // UI auto-advance (~800ms later in the app)
    s = reducer(s, { type: "advance" });
  }

  assert.equal(s.complete, true);
  assert.equal(currentStep(s), null);
  assert.equal(progressPct(s), 100);
  const netlist = observedNetlist(s);
  assert.equal(netlist.edges.length, 7);
  assert.deepEqual(
    netlist.edges.map((e) => e.id),
    ["e1", "e2", "e3", "e4", "e5", "e6", "e7"],
  );
});

test("wrong hole: near-miss recorded, step stays blocked", () => {
  let s = createInitialState(buttonLedSteps);
  s = reducer(s, tipAt("BB:9:c"));
  assert.equal(s.phase, "active");
  assert.match(s.nearMiss, /BB:9:c/);
  // No seat, no advance possible
  s = reducer(s, { type: "advance" });
  assert.equal(s.currentIndex, 0);
  assert.equal(progressPct(s), 0);
  // Tip moving from correct target to a wrong hole drops back to active
  s = reducer(s, tipAt("UNO:GND"));
  assert.equal(s.phase, "tip-on-target");
  assert.equal(s.nearMiss, null);
  s = reducer(s, tipAt("BB:9:c"));
  assert.equal(s.phase, "active");
  assert.match(s.nearMiss, /Not there yet/);
});

test("false-seat rejection: seated for a non-current edge is ignored", () => {
  const s0 = createInitialState(buttonLedSteps);
  const s1 = reducer(s0, seated("e5"));
  assert.equal(s1, s0, "state object unchanged");
  assert.equal(s1.seatedIds.length, 0);
  // Misplaced for a non-current edge is also ignored
  const s2 = reducer(s0, misplaced("e5", ["BB:15:e", "BB:17:e"], "BB:16:e"));
  assert.equal(s2, s0);
});

test("misplaced blocks, reset recovers, then the step completes", () => {
  let s = createInitialState(buttonLedSteps);
  s = reducer(s, tipAt("UNO:GND"));
  s = reducer(
    s,
    misplaced("e1", ["UNO:GND", "BB:RAIL:GND"], "wire seated in row 2 hole a"),
  );
  assert.equal(s.phase, "error");
  assert.match(s.errorMessage, /Pull it out and retry/);
  assert.match(s.errorMessage, /wire seated in row 2 hole a/);

  // Blocked: seat and tip events are ignored while in error
  const blocked = reducer(s, seated("e1"));
  assert.equal(blocked.phase, "error");
  assert.equal(blocked.seatedIds.length, 0);
  const blockedTip = reducer(s, tipAt("UNO:GND"));
  assert.equal(blockedTip.phase, "error");

  // Reset -> active, then normal two-stage completion
  s = reducer(s, { type: "reset" });
  assert.equal(s.phase, "active");
  assert.equal(s.errorMessage, null);
  s = reducer(s, tipAt("UNO:GND"));
  assert.equal(s.phase, "tip-on-target");
  s = reducer(s, seated("e1"));
  assert.equal(s.phase, "seated");
  s = reducer(s, { type: "advance" });
  assert.equal(s.currentIndex, 1);
  assert.equal(s.phase, "active");
});

test("observedNetlist contains seated edges only, in step order", () => {
  let s = createInitialState(buttonLedSteps);
  for (const step of buttonLedSteps.slice(0, 3)) {
    s = reducer(s, tipAt(step.targets[0].ref));
    s = reducer(s, seated(step.edge.id));
    s = reducer(s, { type: "advance" });
  }
  const netlist = observedNetlist(s);
  assert.deepEqual(
    netlist.edges.map((e) => e.id),
    ["e1", "e2", "e3"],
  );
  assert.equal(progressPct(s), 43); // 3/7 rounded
  assert.equal(phaseForStep(s, 0), "seated");
  assert.equal(phaseForStep(s, 3), "active");
  assert.equal(phaseForStep(s, 4), "pending");
});

test("restart returns to the initial state", () => {
  let s = createInitialState(buttonLedSteps);
  s = reducer(s, tipAt("UNO:GND"));
  s = reducer(s, seated("e1"));
  s = reducer(s, { type: "advance" });
  s = reducer(s, { type: "restart" });
  assert.equal(s.currentIndex, 0);
  assert.equal(s.phase, "active");
  assert.equal(s.seatedIds.length, 0);
  assert.equal(s.complete, false);
});

test("seated events do not double-count or fire after completion", () => {
  let s = createInitialState(buttonLedSteps);
  s = reducer(s, seated("e1"));
  assert.equal(s.seatedIds.length, 1);
  const again = reducer(s, seated("e1"));
  assert.equal(again, s, "duplicate seat ignored while phase is seated");
  // Complete the rest
  for (const step of buttonLedSteps.slice(1)) {
    s = reducer(s, { type: "advance" });
    s = reducer(s, seated(step.edge.id));
  }
  s = reducer(s, { type: "advance" });
  assert.equal(s.complete, true);
  const after = reducer(s, seated("e1"));
  assert.equal(after, s, "seat after completion ignored");
});
