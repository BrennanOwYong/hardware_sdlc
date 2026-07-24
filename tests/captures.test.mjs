// Capture history: coach photos and their processing output must round-trip
// so a past attempt reopens instead of being re-shot.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhotoStore, MAX_PHOTOS } from "../lib/photos/store.ts";

// A 1x1 JPEG data URL, enough for the store to decode and persist.
const TINY_JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==";

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), "forge-captures-"));
  return { store: new PhotoStore(dir), dir };
}

const COACH = {
  goal: "plug the USB cable into the laptop",
  verdict: "adjust",
  instruction: "Slide the plug two centimetres left to the rectangular port.",
  guide: {
    from: { x: 0.3, y: 0.6 },
    to: { x: 0.62, y: 0.48 },
    source: "mask",
    targetMaskPng: "abc123==",
    targetBbox: [0.55, 0.44, 0.14, 0.09],
    note: "anchored on segmented pixels",
  },
};

test("a coach capture persists its surface tag and full guidance", async () => {
  const { store, dir } = await freshStore();
  try {
    const added = await store.add({
      photoDataUrl: TINY_JPEG,
      width: 1,
      height: 1,
      surface: "coach",
      label: COACH.goal,
    });
    assert.equal(added.surface, "coach");
    assert.equal(added.label, COACH.goal, "coach labels its capture with the goal");

    const withCoach = await store.setCoach(added.id, COACH);
    assert.equal(withCoach.coach.instruction, COACH.instruction);
    assert.equal(withCoach.coach.guide.source, "mask");
    assert.equal(withCoach.coach.guide.targetMaskPng, "abc123==");

    // And it survives a reload from disk, not just in-memory state.
    const reopened = new PhotoStore(dir);
    const found = (await reopened.list()).find((p) => p.id === added.id);
    assert.equal(found.surface, "coach");
    assert.equal(found.coach.guide.to.x, 0.62);
    assert.deepEqual(found.coach.guide.targetBbox, [0.55, 0.44, 0.14, 0.09]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an untagged legacy photo is treated as inventory, never coach", async () => {
  const { store, dir } = await freshStore();
  try {
    const p = await store.add({ photoDataUrl: TINY_JPEG, width: 1, height: 1 });
    assert.equal(p.surface, undefined, "no tag written when none supplied");
    const raw = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    assert.equal(raw.photos[0].surface, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setCoach flips the surface even if the photo was added untagged", async () => {
  const { store, dir } = await freshStore();
  try {
    const p = await store.add({ photoDataUrl: TINY_JPEG, width: 1, height: 1 });
    const tagged = await store.setCoach(p.id, COACH);
    assert.equal(tagged.surface, "coach");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setCoach on a missing id is a 404, not a crash", async () => {
  const { store, dir } = await freshStore();
  try {
    await assert.rejects(() => store.setCoach("nope", COACH), /not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the 50-photo cap still evicts oldest, coach captures included", async () => {
  const { store, dir } = await freshStore();
  try {
    const ids = [];
    for (let i = 0; i < MAX_PHOTOS + 3; i += 1) {
      const p = await store.add({
        photoDataUrl: TINY_JPEG,
        width: 1,
        height: 1,
        surface: i % 2 === 0 ? "coach" : "inventory",
      });
      ids.push(p.id);
    }
    const list = await store.list();
    assert.equal(list.length, MAX_PHOTOS);
    // The three oldest are gone; the newest survive.
    assert.equal(list.some((p) => p.id === ids[0]), false);
    assert.equal(list.some((p) => p.id === ids[ids.length - 1]), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
