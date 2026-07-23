// Photo-library store tests. Run with: node --test tests/photos.test.mjs
// Node >= 23.6 strips types from imported .ts files; specifiers carry the
// .ts extension (see docs/references-p3.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  benchLabel,
  decodePhotoDataUrl,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
  PhotoError,
  PhotoStore,
} from "../lib/photos/store.ts";

const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
]);
const JPEG_URL = `data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

const INVENTORY = {
  parts: [
    {
      id: "p1",
      partType: "resistor",
      label: "220 ohm resistor",
      confidence: 0.9,
      bbox: [0.1, 0.2, 0.05, 0.05],
    },
  ],
  photoDataUrl: JPEG_URL, // must be stripped when cached
  capturedAt: "2026-07-24T10:00:00.000Z",
  source: "vlm",
};

async function makeTmpStore() {
  const base = join(fileURLToPath(new URL("./", import.meta.url)), ".tmp");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "photos-"));
  return { store: new PhotoStore(dir), dir };
}

const exists = (p) => access(p).then(() => true, () => false);

test("benchLabel pads hours and minutes", () => {
  assert.equal(benchLabel(new Date(2026, 0, 5, 7, 9)), "Bench 07:09");
  assert.equal(benchLabel(new Date(2026, 0, 5, 23, 59)), "Bench 23:59");
});

test("decodePhotoDataUrl: accepts jpeg/png, rejects everything else", () => {
  assert.deepEqual(decodePhotoDataUrl(JPEG_URL).buffer, JPEG_BYTES);
  assert.equal(decodePhotoDataUrl(JPEG_URL).mediaType, "image/jpeg");
  assert.equal(decodePhotoDataUrl(PNG_URL).mediaType, "image/png");

  const bad = [
    "not a data url",
    JPEG_BYTES.toString("base64"), // bare base64, no prefix
    `data:image/gif;base64,${JPEG_BYTES.toString("base64")}`,
    `data:text/plain;base64,${Buffer.from("hi").toString("base64")}`,
    "data:image/jpeg;base64,", // empty payload
    "data:image/jpeg;base64,!!!!", // invalid base64 characters
    "data:image/jpeg;base64,abc", // length not a multiple of 4
  ];
  for (const url of bad) {
    assert.throws(
      () => decodePhotoDataUrl(url),
      (err) => err instanceof PhotoError && err.status === 400,
      `expected 400 for: ${url.slice(0, 40)}`,
    );
  }
});

test("decodePhotoDataUrl: rejects > 8 MB with status 413", () => {
  const big = Buffer.alloc(MAX_PHOTO_BYTES + 1, 0x42);
  assert.throws(
    () => decodePhotoDataUrl(`data:image/jpeg;base64,${big.toString("base64")}`),
    (err) => err instanceof PhotoError && err.status === 413,
  );
  // Exactly at the cap passes.
  const atCap = Buffer.alloc(MAX_PHOTO_BYTES, 0x42);
  assert.equal(
    decodePhotoDataUrl(`data:image/jpeg;base64,${atCap.toString("base64")}`)
      .buffer.byteLength,
    MAX_PHOTO_BYTES,
  );
});

test("add: writes jpg + index entry; readImage round-trips the bytes", async () => {
  const { store, dir } = await makeTmpStore();
  try {
    const at = new Date(2026, 6, 24, 14, 5);
    const entry = await store.add({
      photoDataUrl: JPEG_URL,
      width: 1568,
      height: 1176,
      capturedAt: at,
    });
    assert.equal(entry.bytes, JPEG_BYTES.byteLength);
    assert.equal(entry.width, 1568);
    assert.equal(entry.height, 1176);
    assert.equal(entry.label, "Bench 14:05");
    assert.equal(entry.mediaType, "image/jpeg");
    assert.equal(entry.capturedAt, at.toISOString());
    assert.equal(entry.inventory, undefined);

    const onDisk = await readFile(join(dir, `${entry.id}.jpg`));
    assert.deepEqual(onDisk, JPEG_BYTES);

    const image = await store.readImage(entry.id);
    assert.ok(image);
    assert.deepEqual(image.buffer, JPEG_BYTES);
    assert.equal(image.mediaType, "image/jpeg");

    assert.equal(await store.readImage("no-such-id"), undefined);
    assert.equal(await store.get("no-such-id"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list: newest first", async () => {
  const { store, dir } = await makeTmpStore();
  try {
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const entry = await store.add({
        photoDataUrl: JPEG_URL,
        width: 10,
        height: 10,
        capturedAt: new Date(2026, 6, 24, 10, i),
      });
      ids.push(entry.id);
    }
    const listed = await store.list();
    assert.deepEqual(
      listed.map((p) => p.id),
      [...ids].reverse(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("eviction: keeps the newest 50, removes evicted jpgs from disk", { timeout: 300000 }, async () => {
  const { store, dir } = await makeTmpStore();
  try {
    const ids = [];
    for (let i = 0; i < MAX_PHOTOS + 5; i += 1) {
      const entry = await store.add({
        photoDataUrl: JPEG_URL,
        width: 10,
        height: 10,
        capturedAt: new Date(2026, 6, 24, 8, 0, i),
      });
      ids.push(entry.id);
    }
    const listed = await store.list();
    assert.equal(listed.length, MAX_PHOTOS);

    const kept = new Set(listed.map((p) => p.id));
    const evicted = ids.slice(0, 5);
    for (const id of evicted) {
      assert.ok(!kept.has(id), "oldest ids must be evicted from the index");
      assert.equal(await exists(join(dir, `${id}.jpg`)), false);
      assert.equal(await store.readImage(id), undefined);
    }
    for (const id of ids.slice(5)) {
      assert.ok(kept.has(id), "newest 50 ids must survive");
      assert.equal(await exists(join(dir, `${id}.jpg`)), true);
    }
    // Newest first: the last added id leads the list.
    assert.equal(listed[0].id, ids[ids.length - 1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setInventory: caches, strips photoDataUrl, persists; 404 on missing", async () => {
  const { store, dir } = await makeTmpStore();
  try {
    const entry = await store.add({
      photoDataUrl: JPEG_URL,
      width: 10,
      height: 10,
    });
    const updated = await store.setInventory(entry.id, INVENTORY);
    assert.equal(updated.inventory.parts.length, 1);
    assert.equal(updated.inventory.source, "vlm");
    assert.equal(
      updated.inventory.photoDataUrl,
      undefined,
      "cached inventory must not duplicate the image bytes",
    );

    // A fresh store instance reads the same cache back from disk.
    const reopened = new PhotoStore(dir);
    const persisted = await reopened.get(entry.id);
    assert.ok(persisted?.inventory);
    assert.equal(persisted.inventory.parts[0].label, "220 ohm resistor");

    await assert.rejects(
      () => store.setInventory("no-such-id", INVENTORY),
      (err) => err instanceof PhotoError && err.status === 404,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("remove: deletes entry + jpg together; 404 on missing", async () => {
  const { store, dir } = await makeTmpStore();
  try {
    const a = await store.add({ photoDataUrl: JPEG_URL, width: 10, height: 10 });
    const b = await store.add({ photoDataUrl: PNG_URL, width: 10, height: 10 });

    await store.remove(a.id);
    assert.equal(await store.get(a.id), undefined);
    assert.equal(await exists(join(dir, `${a.id}.jpg`)), false);

    // Index and files agree after the delete: b is intact.
    const reopened = new PhotoStore(dir);
    const listed = await reopened.list();
    assert.deepEqual(listed.map((p) => p.id), [b.id]);
    assert.equal(await exists(join(dir, `${b.id}.jpg`)), true);
    const image = await reopened.readImage(b.id);
    assert.deepEqual(image.buffer, PNG_BYTES);
    assert.equal(image.mediaType, "image/png");

    await assert.rejects(
      () => store.remove(a.id),
      (err) => err instanceof PhotoError && err.status === 404,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent adds are serialized, no lost index writes", async () => {
  const { store, dir } = await makeTmpStore();
  try {
    await Promise.all(
      Array.from({ length: 5 }, () =>
        store.add({ photoDataUrl: JPEG_URL, width: 10, height: 10 }),
      ),
    );
    const listed = await store.list();
    assert.equal(listed.length, 5);
    for (const p of listed) {
      assert.equal(await exists(join(dir, `${p.id}.jpg`)), true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
