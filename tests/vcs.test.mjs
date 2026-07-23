// P3 git-for-hardware tests. Run with: node --test tests/vcs.test.mjs
// Node >= 23.6 strips types from imported .ts files by default; specifiers
// must carry the .ts extension (see docs/references-p3.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { branches, children, diff, rollbackPlan } from "../lib/vcs/diff.ts";
import { CommitStore } from "../lib/vcs/store.ts";

const wire = (id, from, to) => ({ id, kind: "wire", from, to });
const comp = (id, part, from, to, value) =>
  value === undefined
    ? { id, kind: "component", part, from, to }
    : { id, kind: "component", part, value, from, to };

async function makeTmpStore() {
  const base = join(fileURLToPath(new URL("./", import.meta.url)), ".tmp");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "vcs-"));
  return { store: new CommitStore(join(dir, "commits.json")), dir };
}

test("diff: added/removed keyed on (kind, from, to, part), not edge id", () => {
  const a = {
    edges: [
      wire("e1", "UNO:GND", "BB:RAIL:GND"),
      comp("e2", "LED", "BB:5:f", "BB:6:f"),
    ],
  };
  const b = {
    edges: [
      // same connection as e1 but a different id: must NOT show up in the diff
      wire("x1", "UNO:GND", "BB:RAIL:GND"),
      comp("e3", "resistor", "BB:6:h", "BB:RAIL:GND", "220 ohm"),
      wire("e4", "UNO:D2", "BB:15:a"),
    ],
  };
  const d = diff(a, b);
  assert.deepEqual(
    d.added.map((e) => e.id).sort(),
    ["e3", "e4"],
  );
  assert.deepEqual(
    d.removed.map((e) => e.id),
    ["e2"],
  );
});

test("rollbackPlan: removals before adds, human instructions", () => {
  const target = {
    edges: [
      wire("t1", "UNO:GND", "BB:RAIL:GND"),
      comp("t2", "LED", "BB:5:f", "BB:6:f"),
    ],
  };
  const current = {
    edges: [
      wire("c1", "UNO:GND", "BB:RAIL:GND"),
      comp("c2", "resistor", "BB:6:h", "BB:RAIL:GND", "220 ohm"),
      wire("c3", "UNO:D2", "BB:15:a"),
      // LED from target is missing in current -> plan must add it back
    ],
  };
  const ops = rollbackPlan(current, target);
  assert.equal(ops.length, 3);

  const removeIdx = ops.map((o, i) => (o.op === "remove" ? i : -1)).filter((i) => i >= 0);
  const addIdx = ops.map((o, i) => (o.op === "add" ? i : -1)).filter((i) => i >= 0);
  assert.ok(removeIdx.length === 2 && addIdx.length === 1);
  assert.ok(Math.max(...removeIdx) < Math.min(...addIdx), "removals must precede adds");

  // Removals in reverse build order: the wire placed last is pulled first.
  assert.equal(ops[0].instruction, "pull the wire UNO:D2 -> BB:15:a");
  assert.equal(ops[1].instruction, "remove the resistor between BB:6:h and BB:RAIL:GND");
  assert.equal(ops[2].instruction, "place the LED between BB:5:f and BB:6:f");
});

test("store: seeds root, create defaults to head of main, fork parentage + branch", async () => {
  const { store, dir } = await makeTmpStore();
  try {
    const initial = await store.list();
    assert.equal(initial.length, 1);
    const root = initial[0];
    assert.equal(root.parent, null);
    assert.equal(root.branch, "main");
    assert.equal(root.message, "empty board");
    assert.equal(root.netlist.edges.length, 0);

    const child = await store.create({
      message: "gnd rail wired",
      netlist: { edges: [wire("e1", "UNO:GND", "BB:RAIL:GND")] },
      firmware: { code: "// step 1", hash: "aaaa1111" },
    });
    assert.equal(child.parent, root.id, "create() defaults parent to head of main");
    assert.equal(child.branch, "main");

    const forked = await store.fork(child.id, "dht11-experiment");
    assert.equal(forked.parent, child.id, "fork parent is the source commit");
    assert.equal(forked.branch, "dht11-experiment", "fork carries the new branch label");
    assert.deepEqual(forked.netlist, child.netlist, "fork copies the board state");
    assert.equal(forked.firmware.hash, child.firmware.hash);

    const all = await store.list();
    assert.deepEqual(branches(all), ["main", "dht11-experiment"]);
    assert.deepEqual(
      children(all, child.id).map((c) => c.id),
      [forked.id],
    );

    // Head of main is still `child`; a new commit without parent lands there.
    const next = await store.create({
      message: "led placed",
      netlist: { edges: [] },
      firmware: { code: "// step 2", hash: "bbbb2222" },
    });
    assert.equal(next.parent, child.id);
    assert.equal(next.branch, "main");

    await assert.rejects(
      () => store.fork(child.id, "dht11-experiment"),
      /already exists/,
      "duplicate branch names are rejected",
    );
    await assert.rejects(
      () =>
        store.create({
          message: "orphan",
          netlist: { edges: [] },
          firmware: { code: "", hash: "x" },
          parent: "no-such-id",
        }),
      /not found/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store: concurrent creates are serialized, no lost writes", async () => {
  const { store, dir } = await makeTmpStore();
  try {
    await store.list(); // seed root
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.create({
          message: `step ${i}`,
          netlist: { edges: [] },
          firmware: { code: `// ${i}`, hash: `h${i}` },
        }),
      ),
    );
    const all = await store.list();
    assert.equal(all.length, 6, "root + 5 concurrent commits");
    // Linear chain on main: each commit's parent is the previous one.
    for (let i = 1; i < all.length; i += 1) {
      assert.equal(all[i].parent, all[i - 1].id);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
