// Practice-mode builder verification: manifest zod schema + loader.
// lib/practice/manifest.ts imports only zod at runtime, so Node 24 type
// stripping runs it directly (same pattern as markers.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const {
  practiceMediaItemSchema,
  practiceManifestSchema,
  practiceMediaUrl,
  loadPracticeManifest,
  PRACTICE_MANIFEST_URL,
} = await import("../lib/practice/manifest.ts");

const validItem = {
  file: "uno-closeup.jpg",
  title: "Arduino Uno close-up with readable pin labels",
  credit: "Dllu",
  license: "CC BY-SA 4.0",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Arduino_Uno_dllu.jpg",
};

const validManifest = {
  photos: [validItem],
  videos: [
    {
      file: "wiring-hands-1.mp4",
      title: "Engineering student working on a breadboard circuit",
      credit: "Allan González (Pexels)",
      license: "Pexels License",
      sourceUrl:
        "https://www.pexels.com/video/engineering-student-working-on-breadboard-circuit-31575752/",
    },
  ],
};

test("practiceManifestSchema accepts a valid fixture", () => {
  const parsed = practiceManifestSchema.safeParse(validManifest);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.photos.length, 1);
  assert.equal(parsed.data.videos[0].file, "wiring-hands-1.mp4");
});

test("the shipped data/images/practice/manifest.json passes the schema", async () => {
  const path = fileURLToPath(
    new URL("../data/images/practice/manifest.json", import.meta.url),
  );
  const raw = JSON.parse(await readFile(path, "utf8"));
  const parsed = practiceManifestSchema.safeParse(raw);
  assert.equal(parsed.success, true, "shipped manifest must validate");
  assert.ok(parsed.data.photos.length >= 1, "at least one photo");
  assert.ok(parsed.data.videos.length >= 1, "at least one video");
});

test("practiceMediaItemSchema rejects a missing credit", () => {
  const { credit: _credit, ...noCredit } = validItem;
  assert.equal(practiceMediaItemSchema.safeParse(noCredit).success, false);
});

test("practiceMediaItemSchema rejects an empty file name", () => {
  assert.equal(
    practiceMediaItemSchema.safeParse({ ...validItem, file: "" }).success,
    false,
  );
});

test("practiceMediaItemSchema rejects a non-URL sourceUrl", () => {
  assert.equal(
    practiceMediaItemSchema.safeParse({ ...validItem, sourceUrl: "not a url" })
      .success,
    false,
  );
});

test("practiceManifestSchema rejects malformed top-level shapes", () => {
  assert.equal(practiceManifestSchema.safeParse(null).success, false);
  assert.equal(practiceManifestSchema.safeParse([]).success, false);
  assert.equal(
    practiceManifestSchema.safeParse({ photos: "nope", videos: [] }).success,
    false,
  );
  assert.equal(
    practiceManifestSchema.safeParse({ photos: [validItem] }).success,
    false,
    "videos array is required",
  );
  assert.equal(
    practiceManifestSchema.safeParse({ photos: [{ file: "x.jpg" }], videos: [] })
      .success,
    false,
    "items missing required fields are rejected",
  );
});

test("practiceMediaUrl builds the images-API path", () => {
  assert.equal(
    practiceMediaUrl({ file: "uno-closeup.jpg" }),
    "/api/images/practice/uno-closeup.jpg",
  );
});

test("loadPracticeManifest returns the typed manifest via the injected fetch", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(validManifest), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const manifest = await loadPracticeManifest(fetchFn);
  assert.deepEqual(calls, [PRACTICE_MANIFEST_URL]);
  assert.equal(manifest.photos[0].file, "uno-closeup.jpg");
});

test("loadPracticeManifest throws a plain message on HTTP failure", async () => {
  const fetchFn = async () => new Response("nope", { status: 404 });
  await assert.rejects(
    () => loadPracticeManifest(fetchFn),
    /HTTP 404/,
  );
});

test("loadPracticeManifest throws a plain message on invalid JSON", async () => {
  const fetchFn = async () => new Response("{oops", { status: 200 });
  await assert.rejects(
    () => loadPracticeManifest(fetchFn),
    /not valid JSON/,
  );
});

test("loadPracticeManifest throws a plain message on a schema mismatch", async () => {
  const fetchFn = async () =>
    new Response(JSON.stringify({ photos: [], nope: true }), { status: 200 });
  await assert.rejects(
    () => loadPracticeManifest(fetchFn),
    /unexpected shape/,
  );
});
