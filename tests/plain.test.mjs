// Instructions a non-technical person can follow. The rule these tests hold:
// no ref notation inside a sentence, and every sentence names a real object.
import test from "node:test";
import assert from "node:assert/strict";
import {
  addStep,
  changeSentence,
  diffHeadline,
  partPhrase,
  plainPlan,
  removeStep,
} from "../lib/vcs/plain.ts";
import { specById } from "../lib/devices/catalog.ts";
import { autoPlace, connectionEnds, layoutProject } from "../lib/devices/layout.ts";

const layout = layoutProject(autoPlace(["bb-400", "uno-r3"], specById), specById);
const namer = (ref) => connectionEnds(layout, ref, ref).from;

const gndWire = {
  id: "e1",
  kind: "wire",
  part: "wire-black",
  from: "UNO:GND",
  to: "BB:RAIL:GND",
};
const led = {
  id: "e2",
  kind: "component",
  part: "LED",
  value: "red",
  from: "BB:5:f",
  to: "BB:6:f",
};

/** The failure this whole module exists to prevent. */
const NOTATION = /UNO:|BB:|->|→/;

test("no instruction sentence contains ref notation", () => {
  const steps = [
    addStep(gndWire, namer, 0),
    removeStep(gndWire, namer, 4),
    addStep(led, namer, 1),
    removeStep(led, namer, 3),
  ];
  for (const s of steps) {
    assert.doesNotMatch(s.body, NOTATION, `body leaked notation: ${s.body}`);
    assert.doesNotMatch(s.title, NOTATION);
  }
});

test("the refs survive as a checkable footnote beside the sentence", () => {
  const step = removeStep(gndWire, namer, 4);
  assert.equal(step.refs, "UNO:GND · BB:RAIL:GND");
});

test("a wire is named by its colour, the way it sits in your hand", () => {
  assert.equal(partPhrase(gndWire), "black jumper wire");
  assert.equal(partPhrase({ kind: "wire", from: "a", to: "b", id: "x" }), "jumper wire");
  assert.equal(partPhrase(led), "LED (red)");
});

test("removing says which wire to grab and where its ends are", () => {
  const step = removeStep(gndWire, namer, 4);
  assert.match(step.title, /Take out the black jumper wire/);
  assert.match(step.body, /GND pin/);
  assert.match(step.body, /ground/);
  assert.match(step.body, /Leave everything else where it is/);
});

test("a rail end says any hole will do, because any hole will", () => {
  const step = addStep(gndWire, namer, 0);
  assert.match(step.body, /any hole on the/);
});

test("each step states the delta from the state before it", () => {
  assert.match(addStep(gndWire, namer, 3).delta, /from 3 to 4/);
  assert.match(removeStep(gndWire, namer, 3).delta, /from 3 to 2/);
});

test("a plan reads as a running sequence, not four independent facts", () => {
  const steps = plainPlan(
    [
      { op: "remove", edge: gndWire },
      { op: "remove", edge: led },
      { op: "add", edge: gndWire },
    ],
    namer,
    5,
  );
  assert.match(steps[0].delta, /from 5 to 4/);
  assert.match(steps[1].delta, /from 4 to 3/);
  assert.match(steps[2].delta, /from 3 to 4/);
});

test("history speaks in the past, instructions in the imperative", () => {
  assert.match(changeSentence(gndWire, namer, "added"), /now runs between/);
  assert.match(changeSentence(gndWire, namer, "removed"), /was taken out/);
  assert.doesNotMatch(changeSentence(led, namer, "added"), NOTATION);
});

test("the headline says whether the code moved as well as the wiring", () => {
  assert.match(diffHeadline(2, 1, true), /2 connections added, 1 taken out, and the code changed too/);
  assert.match(diffHeadline(0, 0, true), /Only the code on the board changed/);
  assert.match(diffHeadline(0, 0, false), /Nothing changed/);
});

test("an unknown ref falls back to the ref instead of inventing a place", () => {
  const orphan = { id: "z", kind: "wire", part: "wire-red", from: "BB:99:z", to: "UNO:D13" };
  const step = addStep(orphan, namer, 0);
  assert.match(step.body, /BB:99:z/, "better a raw ref than a confident wrong place");
});

test("part names read as parts, not as typos", () => {
  const led = { id: "e", kind: "component", part: "led", value: "red", from: "BB:5:f", to: "BB:6:f" };
  assert.equal(partPhrase(led), "LED (red)");
  const res = { id: "r", kind: "component", part: "resistor", value: "220", from: "BB:6:h", to: "BB:RAIL:GND" };
  assert.equal(partPhrase(res), "resistor (220Ω)", "a bare number is an ohm value missing its unit");
});
