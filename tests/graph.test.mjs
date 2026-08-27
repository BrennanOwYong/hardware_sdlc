// The commit tree, and the cost of moving around it. The claim under test:
// switching branches costs the NET difference, never a full teardown and
// rebuild, and the fork point is where the two paths last agreed.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ancestry,
  buildTree,
  commonAncestor,
  routeSummary,
  switchCost,
} from "../lib/vcs/graph.ts";

const wire = (id, from, to, part = "wire-black") => ({ id, kind: "wire", part, from, to });

const commit = (id, parent, branch, edges, fw = "fw-" + id) => ({
  id,
  parent,
  branch,
  message: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  netlist: { edges },
  firmware: { code: "// " + fw, hash: fw },
});

const GND = wire("e1", "UNO:GND", "BB:RAIL:GND");
const LED = { id: "e2", kind: "component", part: "LED", from: "BB:5:f", to: "BB:6:f" };
const RES = { id: "e3", kind: "component", part: "resistor", value: "220Ω", from: "BB:6:h", to: "BB:RAIL:GND" };
const D13 = wire("e4", "UNO:D13", "BB:5:h", "wire-red");
const D9 = wire("e5", "UNO:D9", "BB:5:h", "wire-red");
const BTN = wire("e6", "UNO:D2", "BB:15:a", "wire-yellow");

// root -> a -> b            (main)
//              \-> c -> d   (buzzer, forked at b)
const HISTORY = [
  commit("root", null, "main", []),
  commit("a", "root", "main", [GND]),
  commit("b", "a", "main", [GND, LED, RES]),
  commit("c", "b", "main", [GND, LED, RES, D13]),
  commit("d", "b", "buzzer", [GND, LED, RES, D9]),
  commit("e", "d", "buzzer", [GND, LED, RES, D9, BTN]),
];

test("a child sits below its parent, and a fork takes its own lane", () => {
  const tree = buildTree(HISTORY);
  const n = (id) => tree.byId.get(id);
  assert.ok(n("a").row > n("root").row, "children sit below parents");
  assert.equal(n("c").lane, n("b").lane, "the first child continues the line");
  assert.notEqual(n("d").lane, n("b").lane, "the second child diverges");
  assert.equal(n("e").lane, n("d").lane, "a branch keeps its lane");
  assert.ok(tree.laneCount >= 2, "two lanes for a fork");
});

test("the fork point is marked on the commit that splits", () => {
  const tree = buildTree(HISTORY);
  assert.equal(tree.byId.get("b").isFork, true, "b has two children");
  assert.equal(tree.byId.get("a").isFork, false);
  assert.deepEqual(tree.byId.get("b").childIds.sort(), ["c", "d"]);
});

test("the diverging edge is flagged so it can be drawn bending", () => {
  const tree = buildTree(HISTORY);
  const bendy = tree.edges.filter((e) => e.diverges).map((e) => e.toId);
  assert.deepEqual(bendy, ["d"], "only the second child bends away");
  assert.equal(tree.edges.length, HISTORY.length - 1, "one edge per parented commit");
});

test("each branch's newest commit is its tip", () => {
  const tree = buildTree(HISTORY);
  const tips = tree.nodes.filter((n) => n.isBranchTip).map((n) => n.commit.id);
  assert.deepEqual(tips.sort(), ["c", "e"]);
});

test("a commit whose parent is absent is still drawn", () => {
  const tree = buildTree([commit("orphan", "missing", "stray", [GND])]);
  assert.equal(tree.nodes.length, 1);
  assert.equal(tree.nodes[0].commit.id, "orphan");
});

test("ancestry runs root-first and stops at the root", () => {
  assert.deepEqual(
    ancestry(HISTORY, "e").map((c) => c.id),
    ["root", "a", "b", "d", "e"],
  );
});

test("the common ancestor is where the two paths last agreed", () => {
  assert.equal(commonAncestor(HISTORY, "c", "e").id, "b");
  assert.equal(commonAncestor(HISTORY, "c", "c").id, "c", "a commit shares itself");
  assert.equal(commonAncestor(HISTORY, "a", "e").id, "a", "an ancestor of the other");
});

test("two independent roots share nothing, and that is not an error", () => {
  const split = [commit("r1", null, "main", [GND]), commit("r2", null, "other", [LED])];
  assert.equal(commonAncestor(split, "r1", "r2"), null);
  const cost = switchCost(split, "r1", "r2");
  assert.equal(cost.base, null);
  assert.equal(cost.ops.length, 2, "still knows what to unplug and add");
});

test("switching branches costs the NET difference, not a teardown and rebuild", () => {
  // c and e share the ground wire, the LED and the resistor. A naive
  // undo-to-fork-then-replay would pull all three out and put them back.
  const cost = switchCost(HISTORY, "c", "e");
  assert.equal(cost.base.id, "b");
  const removed = cost.ops.filter((o) => o.op === "remove").map((o) => o.edge.id);
  const added = cost.ops.filter((o) => o.op === "add").map((o) => o.edge.id);
  assert.deepEqual(removed, ["e4"], "only the pin-13 wire is wrong for the target");
  assert.deepEqual(added.sort(), ["e5", "e6"], "the pin-9 wire and the button");
  assert.equal(cost.untouched, 3, "ground, LED and resistor stay where they are");
});

test("removals come before additions: free the hole before filling it", () => {
  const cost = switchCost(HISTORY, "c", "e");
  const firstAdd = cost.ops.findIndex((o) => o.op === "add");
  const lastRemove = cost.ops.map((o) => o.op).lastIndexOf("remove");
  assert.ok(lastRemove < firstAdd, "every unplug precedes every plug-in");
});

test("the route records which commits are undone and which replayed", () => {
  const cost = switchCost(HISTORY, "c", "e");
  assert.deepEqual(cost.down.map((c) => c.id), ["c"], "newest first, back to the fork");
  assert.deepEqual(cost.up.map((c) => c.id), ["d", "e"], "oldest first, up the other side");
});

test("each op names the commit that introduced the connection", () => {
  const cost = switchCost(HISTORY, "c", "e");
  const add = cost.ops.find((o) => o.edge.id === "e5");
  assert.equal(add.fromCommitId, "d", "the pin-9 wire arrived in commit d");
});

test("identical wiring with different code still needs the code re-sent", () => {
  const same = [
    commit("x", null, "main", [GND, LED], "fw-one"),
    commit("y", "x", "tweak", [GND, LED], "fw-two"),
  ];
  const cost = switchCost(same, "x", "y");
  assert.equal(cost.ops.length, 0, "nothing to unplug");
  assert.equal(cost.firmwareChanges, true);
  assert.equal(cost.targetFirmwareHash, "fw-two");
  assert.match(routeSummary(cost), /wiring is already identical/);
  assert.match(routeSummary(cost), /other version of the code/);
});

test("identical wiring AND identical code is a no-op, said plainly", () => {
  const same = [
    commit("x", null, "main", [GND], "same"),
    commit("y", "x", "twin", [GND], "same"),
  ];
  const s = routeSummary(switchCost(same, "x", "y"));
  assert.match(s, /already identical/);
  assert.match(s, /nothing to re-send/);
});

test("the summary counts what it saved by not rebuilding", () => {
  const s = routeSummary(switchCost(HISTORY, "c", "e"));
  assert.match(s, /unplug 1/);
  assert.match(s, /add 2/);
  assert.match(s, /leaving 3 in place/);
});

test("switching to where you already are costs nothing", () => {
  const cost = switchCost(HISTORY, "e", "e");
  assert.equal(cost.ops.length, 0);
  assert.equal(cost.firmwareChanges, false);
  assert.deepEqual(cost.down, []);
  assert.deepEqual(cost.up, []);
});

test("every commit lands in exactly one row, with no gaps", () => {
  const tree = buildTree(HISTORY);
  const rows = tree.nodes.map((n) => n.row).sort((a, b) => a - b);
  assert.deepEqual(rows, HISTORY.map((_, i) => i));
});
