// Build-journal tests (FEEDBACK 13 / T20). Run: node --test tests/journal.test.mjs
// Node >= 23.6 strips types from imported .ts files; specifiers carry the .ts
// extension (same convention as tests/vcs.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { JournalStore, JournalError, decodeFrameDataUrl } from "../lib/journal/store.ts";
import { CommitStore } from "../lib/vcs/store.ts";

// Real JPEG magic bytes, base64-encoded.
const JPEG_DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

async function makeTmp() {
  const base = join(fileURLToPath(new URL("./", import.meta.url)), ".tmp");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "journal-"));
  const framesDir = join(dir, "frames");
  return {
    dir,
    framesDir,
    store: new JournalStore(join(dir, "pending.json"), framesDir),
  };
}

test("decodeFrameDataUrl: accepts jpeg/png, rejects everything else", () => {
  assert.equal(decodeFrameDataUrl(JPEG_DATA_URL).extension, "jpg");
  assert.equal(decodeFrameDataUrl(PNG_DATA_URL).extension, "png");
  for (const bad of [
    "data:image/gif;base64,R0lGODlh",
    "data:image/jpeg;base64,not!!base64",
    "plain text",
    "data:image/jpeg;base64,",
  ]) {
    assert.throws(
      () => decodeFrameDataUrl(bad),
      (err) => err instanceof JournalError && err.status === 400,
      `expected 400 for ${bad}`,
    );
  }
});

test("store: append/list round trip preserves fields, assigns id + ISO time", async () => {
  const { store, dir } = await makeTmp();
  try {
    const coach = await store.appendPending({
      kind: "coach",
      summary: "seated the LED across rows 5 and 6",
      goal: "place the red LED",
      attempt: "1",
      verdict: "seated",
    });
    const flash = await store.appendPending({
      kind: "flash",
      summary: "compiled abc123def456",
      firmwareHash: "abc123def456",
    });

    assert.ok(coach.id.length > 0 && coach.id !== flash.id);
    assert.ok(!Number.isNaN(new Date(coach.at).getTime()), "at is a parseable timestamp");
    assert.equal(coach.kind, "coach");
    assert.equal(coach.verdict, "seated");
    assert.equal(coach.framePath, undefined, "no frame saved without frameDataUrl");
    assert.equal(flash.firmwareHash, "abc123def456");

    const listed = await store.listPending();
    assert.deepEqual(
      listed.map((e) => e.id),
      [coach.id, flash.id],
      "append order preserved",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store: frameDataUrl writes journal/<id>.jpg and sets framePath", async () => {
  const { store, framesDir, dir } = await makeTmp();
  try {
    const entry = await store.appendPending({
      kind: "coach",
      summary: "wire from D13 into row 5",
      frameDataUrl: JPEG_DATA_URL,
    });
    assert.equal(entry.framePath, `journal/${entry.id}.jpg`);
    const bytes = await readFile(join(framesDir, `${entry.id}.jpg`));
    assert.deepEqual(
      [...bytes.subarray(0, 3)],
      [0xff, 0xd8, 0xff],
      "stored bytes start with the JPEG magic",
    );

    const png = await store.appendPending({
      kind: "coach",
      summary: "png frame",
      frameDataUrl: PNG_DATA_URL,
    });
    assert.equal(png.framePath, `journal/${png.id}.png`, "png input keeps its true type");

    await assert.rejects(
      () =>
        store.appendPending({
          kind: "coach",
          summary: "bad frame",
          frameDataUrl: "data:image/gif;base64,R0lGODlh",
        }),
      (err) => err instanceof JournalError && err.status === 400,
    );
    assert.equal((await store.listPending()).length, 2, "rejected append stored nothing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store: drainPending returns everything once and clears; restore refills", async () => {
  const { store, dir } = await makeTmp();
  try {
    const a = await store.appendPending({ kind: "coach", summary: "step one" });
    const b = await store.appendPending({ kind: "flash", summary: "compiled x", firmwareHash: "x" });

    const drained = await store.drainPending();
    assert.deepEqual(drained.map((e) => e.id), [a.id, b.id]);
    assert.deepEqual(await store.listPending(), [], "drain clears the pending list");
    assert.deepEqual(await store.drainPending(), [], "second drain is empty");

    await store.restorePending(drained);
    const c = await store.appendPending({ kind: "coach", summary: "after restore" });
    assert.deepEqual(
      (await store.listPending()).map((e) => e.id),
      [a.id, b.id, c.id],
      "restored entries keep ids and precede new appends",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store: concurrent appends serialize, no lost writes", async () => {
  const { store, dir } = await makeTmp();
  try {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.appendPending({ kind: "coach", summary: `step ${i}` }),
      ),
    );
    assert.equal((await store.listPending()).length, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("drain-on-commit: drained entries land on the commit; old commits stay valid", async () => {
  const { store, dir } = await makeTmp();
  const commitsPath = join(dir, "commits.json");
  const commits = new CommitStore(commitsPath);
  try {
    await commits.list(); // seed the pre-journal root commit

    await store.appendPending({
      kind: "coach",
      summary: "seated the LED",
      verdict: "seated",
    });
    await store.appendPending({
      kind: "flash",
      summary: "compiled deadbeef0123",
      firmwareHash: "deadbeef0123",
    });

    const journal = await store.drainPending();
    const commit = await commits.create({
      message: "button-led complete",
      netlist: { edges: [{ id: "e1", kind: "wire", from: "UNO:GND", to: "BB:RAIL:GND" }] },
      firmware: { code: "// fw", hash: "deadbeef0123" },
      journal,
    });

    assert.equal(commit.journal?.length, 2);
    assert.equal(commit.journal?.[0].summary, "seated the LED");
    assert.equal(commit.journal?.[1].firmwareHash, "deadbeef0123");
    assert.deepEqual(await store.listPending(), [], "nothing left pending");

    // A second commit with an empty drain carries no journal field at all.
    const bare = await commits.create({
      message: "no journal between commits",
      netlist: { edges: [] },
      firmware: { code: "// fw2", hash: "beef" },
      journal: await store.drainPending(),
    });
    assert.equal(bare.journal, undefined);

    // Round trip through a fresh store instance: the on-disk guards accept
    // both the journal-carrying commit and the pre-journal root.
    const reread = await new CommitStore(commitsPath).list();
    assert.equal(reread.length, 3, "root + 2 commits survive the shape guards");
    assert.equal(reread[0].journal, undefined, "root commit has no journal field");
    assert.equal(reread[1].journal?.length, 2, "journal persisted on disk");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
