// Unified image storage + live-capture store tests.
// Run with: node --test tests/livecaptures.test.mjs
// Covers lib/photos/storage.ts (content-type map, traversal protection,
// Range negotiation) and lib/photos/liveCaptures.ts (zod contract,
// save/list round trip). Node >= 23.6 strips types from imported .ts files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cacheControlFor,
  contentTypeFor,
  resolveImagePath,
  resolveRange,
} from "../lib/photos/storage.ts";
import {
  LiveCaptureError,
  LiveCaptureStore,
  liveCaptureRequestSchema,
  MAX_CLIP_BYTES,
} from "../lib/photos/liveCaptures.ts";

const exists = (p) => access(p).then(() => true, () => false);

// --- content-type mapping -----------------------------------------------------

test("contentTypeFor maps the served extensions, case-insensitive", () => {
  assert.equal(contentTypeFor("a.jpg"), "image/jpeg");
  assert.equal(contentTypeFor("a.jpeg"), "image/jpeg");
  assert.equal(contentTypeFor("a.png"), "image/png");
  assert.equal(contentTypeFor("a.mp4"), "video/mp4");
  assert.equal(contentTypeFor("a.webm"), "video/webm");
  assert.equal(contentTypeFor("manifest.json"), "application/json");
  assert.equal(contentTypeFor("ATTRIBUTION.md"), "text/markdown");
  assert.equal(contentTypeFor("UNO-CLOSEUP.JPG"), "image/jpeg");
});

test("contentTypeFor refuses unknown or missing extensions", () => {
  assert.equal(contentTypeFor("a.svg"), undefined);
  assert.equal(contentTypeFor("a.html"), undefined);
  assert.equal(contentTypeFor("a.exe"), undefined);
  assert.equal(contentTypeFor("no-extension"), undefined);
  assert.equal(contentTypeFor("trailing-dot."), undefined);
});

test("cacheControlFor: immutable media, revalidated json/md", () => {
  assert.equal(
    cacheControlFor("image/jpeg"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(
    cacheControlFor("video/webm"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(cacheControlFor("application/json"), "no-store");
  assert.equal(cacheControlFor("text/markdown"), "no-store");
});

// --- traversal protection ------------------------------------------------------

test("resolveImagePath accepts plain nested names", () => {
  const root = join(sep, "srv", "images");
  assert.equal(
    resolveImagePath(root, ["practice", "uno-closeup.jpg"]),
    resolve(root, "practice", "uno-closeup.jpg"),
  );
  assert.equal(
    resolveImagePath(root, ["live-view", "abc-frame.jpg"]),
    resolve(root, "live-view", "abc-frame.jpg"),
  );
});

test("resolveImagePath rejects traversal and malformed segments", () => {
  const root = join(sep, "srv", "images");
  const bad = [
    [],
    [""],
    [".."],
    ["..", "secrets.png"],
    ["practice", "..", "..", "etc", "passwd.md"],
    ["practice/evil.jpg"], // separator smuggled into one segment
    ["practice\\evil.jpg"],
    ["/etc/passwd.md"],
    [".hidden.jpg"], // dot-leading names refused by the allowlist
    ["practice", "."],
    ["a\0b.jpg"],
  ];
  for (const segments of bad) {
    assert.equal(
      resolveImagePath(root, segments),
      undefined,
      `expected rejection for: ${JSON.stringify(segments)}`,
    );
  }
});

// --- Range negotiation ---------------------------------------------------------

test("resolveRange: absent, malformed, or multi-range headers serve full", () => {
  assert.deepEqual(resolveRange(null, 100), { kind: "full" });
  assert.deepEqual(resolveRange(undefined, 100), { kind: "full" });
  assert.deepEqual(resolveRange("bytes=-", 100), { kind: "full" });
  assert.deepEqual(resolveRange("bytes=0-10,20-30", 100), { kind: "full" });
  assert.deepEqual(resolveRange("items=0-10", 100), { kind: "full" });
  assert.deepEqual(resolveRange("bytes=30-10", 100), { kind: "full" });
});

test("resolveRange: single ranges, suffix, open end, clamping", () => {
  assert.deepEqual(resolveRange("bytes=0-499", 1000), {
    kind: "range",
    start: 0,
    end: 499,
  });
  assert.deepEqual(resolveRange("bytes=500-", 1000), {
    kind: "range",
    start: 500,
    end: 999,
  });
  assert.deepEqual(resolveRange("bytes=-200", 1000), {
    kind: "range",
    start: 800,
    end: 999,
  });
  // end past the file clamps to the last byte
  assert.deepEqual(resolveRange("bytes=900-5000", 1000), {
    kind: "range",
    start: 900,
    end: 999,
  });
  // suffix longer than the file covers the whole file
  assert.deepEqual(resolveRange("bytes=-5000", 1000), {
    kind: "range",
    start: 0,
    end: 999,
  });
});

test("resolveRange: unsatisfiable starts and empty files", () => {
  assert.deepEqual(resolveRange("bytes=1000-", 1000), { kind: "unsatisfiable" });
  assert.deepEqual(resolveRange("bytes=1500-1600", 1000), {
    kind: "unsatisfiable",
  });
  assert.deepEqual(resolveRange("bytes=-0", 1000), { kind: "unsatisfiable" });
  assert.deepEqual(resolveRange("bytes=0-", 0), { kind: "unsatisfiable" });
});

// --- live-capture contract ------------------------------------------------------

const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FRAME_URL = `data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`;
const RESULTS_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
const CLIP_BYTES = Buffer.from("tiny-webm-stand-in-bytes");
const CLIP_B64 = CLIP_BYTES.toString("base64");

const validBody = {
  clipBase64: CLIP_B64,
  clipMime: "video/webm",
  frameDataUrl: FRAME_URL,
  resultsPngDataUrl: RESULTS_URL,
  query: "find the 220 ohm resistor",
  capturedAt: "2026-07-24T10:00:00.000Z",
};

test("liveCaptureRequestSchema accepts full and clipless bodies", () => {
  assert.equal(liveCaptureRequestSchema.safeParse(validBody).success, true);
  const {
    clipBase64: _clip,
    clipMime: _mime,
    ...clipless
  } = validBody;
  assert.equal(liveCaptureRequestSchema.safeParse(clipless).success, true);
});

test("liveCaptureRequestSchema rejects malformed bodies", () => {
  const cases = [
    { ...validBody, clipMime: undefined }, // clip without mime
    { ...validBody, clipBase64: undefined }, // mime without clip
    { ...validBody, clipMime: "video/avi" },
    { ...validBody, frameDataUrl: "" },
    { ...validBody, resultsPngDataUrl: undefined },
    { ...validBody, capturedAt: "not a date" },
    { ...validBody, query: undefined },
  ];
  for (const body of cases) {
    assert.equal(
      liveCaptureRequestSchema.safeParse(body).success,
      false,
      `expected rejection for: ${JSON.stringify(Object.keys(body))}`,
    );
  }
});

// --- live-capture store ----------------------------------------------------------

async function makeTmpStore() {
  const base = join(fileURLToPath(new URL("./", import.meta.url)), ".tmp");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "livecaptures-"));
  return { store: new LiveCaptureStore(dir), dir };
}

test("save + list round trip: files on disk, urls in meta, newest first", async () => {
  const { store, dir } = await makeTmpStore();
  try {
    const older = await store.save(validBody);
    const newer = await store.save({
      frameDataUrl: FRAME_URL,
      resultsPngDataUrl: RESULTS_URL,
      query: "led polarity",
      capturedAt: "2026-07-24T11:30:00.000Z",
    });

    // Clip capture: all four files, clip extension from the mime.
    assert.equal(await exists(join(dir, `${older.id}.webm`)), true);
    assert.deepEqual(
      await readFile(join(dir, `${older.id}.webm`)),
      CLIP_BYTES,
    );
    assert.deepEqual(
      await readFile(join(dir, `${older.id}-frame.jpg`)),
      JPEG_BYTES,
    );
    assert.deepEqual(
      await readFile(join(dir, `${older.id}-results.png`)),
      PNG_BYTES,
    );
    assert.equal(older.clipMime, "video/webm");
    assert.equal(older.clipBytes, CLIP_BYTES.byteLength);
    assert.equal(older.files.clip, `/api/images/live-view/${older.id}.webm`);
    assert.equal(
      older.files.frame,
      `/api/images/live-view/${older.id}-frame.jpg`,
    );
    assert.equal(
      older.files.results,
      `/api/images/live-view/${older.id}-results.png`,
    );
    assert.equal(older.files.meta, `/api/images/live-view/${older.id}.json`);

    // Clipless capture: no clip file, no clip fields.
    assert.equal(newer.files.clip, undefined);
    assert.equal(newer.clipMime, undefined);
    assert.equal(await exists(join(dir, `${newer.id}.webm`)), false);
    assert.equal(await exists(join(dir, `${newer.id}-frame.jpg`)), true);

    // The stored <id>.json equals the returned meta.
    const onDisk = JSON.parse(
      await readFile(join(dir, `${older.id}.json`), "utf8"),
    );
    assert.deepEqual(onDisk, older);

    // list(): newest capturedAt first, and a fresh instance sees the same.
    const listed = await new LiveCaptureStore(dir).list();
    assert.deepEqual(
      listed.map((c) => c.id),
      [newer.id, older.id],
    );
    assert.equal(listed[0].query, "led polarity");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("save: mp4 clips take the .mp4 extension", async () => {
  const { store, dir } = await makeTmpStore();
  try {
    const meta = await store.save({ ...validBody, clipMime: "video/mp4" });
    assert.equal(await exists(join(dir, `${meta.id}.mp4`)), true);
    assert.equal(meta.files.clip, `/api/images/live-view/${meta.id}.mp4`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("save rejects wrong still types and oversized clips before writing", async () => {
  const { store, dir } = await makeTmpStore();
  try {
    await assert.rejects(
      () => store.save({ ...validBody, frameDataUrl: RESULTS_URL }),
      (err) => err instanceof LiveCaptureError && err.status === 400,
      "png offered as the jpeg frame must 400",
    );
    await assert.rejects(
      () => store.save({ ...validBody, resultsPngDataUrl: FRAME_URL }),
      (err) => err instanceof LiveCaptureError && err.status === 400,
      "jpeg offered as the results png must 400",
    );
    await assert.rejects(
      () => store.save({ ...validBody, clipBase64: "!!!not-base64!!!" }),
      (err) => err instanceof LiveCaptureError && err.status === 400,
    );
    const oversized = Buffer.alloc(MAX_CLIP_BYTES + 1, 0x42).toString("base64");
    await assert.rejects(
      () => store.save({ ...validBody, clipBase64: oversized }),
      (err) => err instanceof LiveCaptureError && err.status === 413,
    );
    assert.deepEqual(await store.list(), [], "nothing may reach disk");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list: missing directory means empty; off-shape json is skipped", async () => {
  const base = join(fileURLToPath(new URL("./", import.meta.url)), ".tmp");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "livecaptures-"));
  try {
    assert.deepEqual(
      await new LiveCaptureStore(join(dir, "never-created")).list(),
      [],
    );

    const store = new LiveCaptureStore(dir);
    const saved = await store.save(validBody);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "stray.json"), "{not json", "utf8");
    await writeFile(join(dir, "offshape.json"), JSON.stringify({ id: 1 }), "utf8");
    const listed = await store.list();
    assert.deepEqual(listed.map((c) => c.id), [saved.id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
