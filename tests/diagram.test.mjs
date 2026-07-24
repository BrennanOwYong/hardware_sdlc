// Commit-state diagram selector tests (FEEDBACK 14 / T21).
// Run: node --test tests/diagram.test.mjs
// lib/diagram/selectors.ts is import-free at runtime (type-only imports), so
// node --test loads it via type stripping; the coordinate resolver (refToXY
// from lib/assembly/circuits.ts, itself runtime-import-free) is injected.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyEdges,
  drawableEdges,
  pinsUsedFromNetlist,
} from "../lib/diagram/selectors.ts";
import { refToXY } from "../lib/assembly/circuits.ts";

const wire = (id, from, to) => ({ id, kind: "wire", from, to });
const comp = (id, part, from, to, value) =>
  value === undefined
    ? { id, kind: "component", part, from, to }
    : { id, kind: "component", part, value, from, to };

test("classifyEdges: no diffAgainst -> every edge neutral, netlist order", () => {
  const netlist = {
    edges: [wire("e1", "UNO:GND", "BB:RAIL:GND"), comp("e2", "LED", "BB:5:f", "BB:6:f")],
  };
  const classified = classifyEdges(netlist);
  assert.deepEqual(
    classified.map((c) => [c.edge.id, c.status]),
    [
      ["e1", "neutral"],
      ["e2", "neutral"],
    ],
  );
});

test("classifyEdges: diff keyed on (kind, from, to, part), not edge id", () => {
  const older = {
    edges: [
      wire("a1", "UNO:GND", "BB:RAIL:GND"),
      comp("a2", "LED", "BB:5:f", "BB:6:f"),
      wire("a3", "UNO:D4", "BB:11:j"),
    ],
  };
  const newer = {
    edges: [
      // Same physical connection as a1 under a different id: shared/neutral.
      wire("b1", "UNO:GND", "BB:RAIL:GND"),
      comp("b2", "LED", "BB:5:f", "BB:6:f"),
      wire("b3", "UNO:D2", "BB:15:a"),
    ],
  };
  const classified = classifyEdges(newer, older);
  const byStatus = (s) => classified.filter((c) => c.status === s).map((c) => c.edge.id);
  assert.deepEqual(byStatus("neutral"), ["b1", "b2"], "shared edges stay neutral");
  assert.deepEqual(byStatus("added"), ["b3"], "edges only in netlist are added (green)");
  assert.deepEqual(byStatus("removed"), ["a3"], "edges only in diffAgainst are removed (red dashed)");
});

test("drawableEdges: exact hole coordinates from the injected resolver", () => {
  const netlist = {
    edges: [wire("e6", "UNO:D2", "BB:15:a"), wire("e1", "UNO:GND", "BB:RAIL:GND")],
  };
  const drawables = drawableEdges(netlist, refToXY);
  assert.equal(drawables.length, 2);

  const d2 = drawables[0];
  // UNO:D2 sits at x = (240 + 11*40)/1000, y = 600/1080 on the board canvas.
  assert.deepEqual(d2.from, { x: 0.68, y: 0.5556 });
  // BB:15:a sits at x = (55 + 14*30)/1000, y = 70/1080.
  assert.deepEqual(d2.to, { x: 0.475, y: 0.0648 });
  // The selector must agree with the canonical mapper exactly.
  assert.deepEqual(d2.from, refToXY("UNO:D2"));
  assert.deepEqual(d2.to, refToXY("BB:15:a"));

  const gnd = drawables[1];
  assert.deepEqual(gnd.from, refToXY("UNO:GND"));
  assert.deepEqual(gnd.to, { x: 0.49, y: 0.4444 }, "BB:RAIL:GND representative point");
});

test("drawableEdges: edges with unmappable refs are dropped, never guessed", () => {
  const netlist = {
    edges: [
      wire("ok", "UNO:D13", "BB:5:h"),
      wire("bad", "BB:99:a", "BB:RAIL:GND"), // row 99 does not exist
      wire("bad2", "ESP32:D1", "BB:1:a"), // unknown board
    ],
  };
  const drawables = drawableEdges(netlist, refToXY);
  assert.deepEqual(
    drawables.map((d) => d.edge.id),
    ["ok"],
  );
});

test("drawableEdges: diff mode carries removed edges with coordinates", () => {
  const older = { edges: [wire("a1", "UNO:D4", "BB:11:j")] };
  const newer = { edges: [wire("b1", "UNO:D2", "BB:15:a")] };
  const drawables = drawableEdges(newer, refToXY, older);
  assert.deepEqual(
    drawables.map((d) => [d.edge.id, d.status]),
    [
      ["b1", "added"],
      ["a1", "removed"],
    ],
  );
  assert.deepEqual(drawables[1].from, refToXY("UNO:D4"));
  assert.deepEqual(drawables[1].to, refToXY("BB:11:j"));
});

test("pinsUsedFromNetlist: unique UNO refs, D-pins numeric first, rest alpha", () => {
  const netlist = {
    edges: [
      wire("e1", "UNO:GND", "BB:RAIL:GND"),
      wire("e4", "UNO:D13", "BB:5:h"),
      wire("e6", "UNO:D2", "BB:15:a"),
      wire("e7", "UNO:D2", "BB:17:a"), // duplicate pin collapses
      wire("e8", "UNO:5V", "BB:RAIL:PWR"),
      comp("e2", "LED", "BB:5:f", "BB:6:f"),
    ],
  };
  assert.deepEqual(pinsUsedFromNetlist(netlist), [
    "UNO:D2",
    "UNO:D13",
    "UNO:5V",
    "UNO:GND",
  ]);
  assert.deepEqual(pinsUsedFromNetlist({ edges: [] }), []);
});
