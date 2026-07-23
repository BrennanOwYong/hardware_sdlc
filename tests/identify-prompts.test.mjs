// Identify prompt-builder verification: general-object scope (Ctrl-F for real
// life) in both the vision-only prompt and the sam+vlm region prompt.
// lib/inventory/prompts.ts has only a type-level project import, so Node 24
// type stripping runs it directly.
import test from "node:test";
import assert from "node:assert/strict";

const { buildVisionPrompt, buildRegionPrompt } = await import(
  "../lib/inventory/prompts.ts"
);

/** SamBox fixtures: normalized bbox + mask area, same shape as sam.ts. */
const boxes = [
  { bbox: [0.1, 0.2, 0.3, 0.4], area: 0.12 },
  { bbox: [0.55, 0.5, 0.2, 0.25], area: 0.05 },
];

const NON_ELECTRONIC_BUCKETS = [
  "tool",
  "battery",
  "stationery",
  "accessory",
  "container",
  "other",
];
const NON_ELECTRONIC_EXAMPLES = ["tweezers", "power bank", "phone stand"];
const ELECTRONIC_CATEGORIES = [
  "microcontroller",
  "breadboard",
  "jumper-wire",
  "resistor",
  "led",
  "pushbutton",
  "sensor",
  "capacitor",
];

test("vision prompt: names EVERY object, with non-electronic buckets and examples", () => {
  const p = buildVisionPrompt();
  assert.match(p, /EVERY distinct object/);
  for (const bucket of NON_ELECTRONIC_BUCKETS)
    assert.ok(p.includes(bucket), `vision prompt names bucket "${bucket}"`);
  for (const example of NON_ELECTRONIC_EXAMPLES)
    assert.ok(p.includes(example), `vision prompt names example "${example}"`);
});

test("vision prompt: electronics keep their detail (categories, chip names, resistor values)", () => {
  const p = buildVisionPrompt();
  for (const cat of ELECTRONIC_CATEGORIES)
    assert.ok(p.includes(cat), `vision prompt keeps category "${cat}"`);
  assert.match(p, /chip markings|board names/);
  assert.ok(p.includes("220Ω resistor"), "resistor-value example survives");
});

test("vision prompt: simulated-workspace paragraph and bbox normalization survive", () => {
  const p = buildVisionPrompt();
  assert.match(p, /SIMULATED workspace/);
  assert.match(p, /normalized to 0\.\.1/);
  assert.match(p, /strict JSON array/);
});

test("vision prompt: SEARCH FOCUS paragraph appears only with a query", () => {
  const bare = buildVisionPrompt();
  assert.ok(!bare.includes("SEARCH FOCUS"), "no query -> no focus paragraph");
  const focused = buildVisionPrompt("red multimeter probe");
  assert.ok(focused.includes("SEARCH FOCUS"), "query -> focus paragraph");
  assert.ok(focused.includes('"red multimeter probe"'), "query text embedded");
  assert.ok(focused.startsWith(bare), "focus paragraph appends, base unchanged");
});

test("region prompt: numbers every region and states the count", () => {
  const p = buildRegionPrompt(boxes);
  assert.ok(p.includes("2 candidate regions"), "region count stated");
  assert.ok(
    p.includes("Region 1: [0.100, 0.200, 0.300, 0.400]"),
    "region 1 numbered with its normalized box",
  );
  assert.ok(
    p.includes("Region 2: [0.550, 0.500, 0.200, 0.250]"),
    "region 2 numbered with its normalized box",
  );
});

test("region prompt: covers non-electronic objects with buckets and examples", () => {
  const p = buildRegionPrompt(boxes);
  assert.match(p, /EVERY region/);
  for (const bucket of NON_ELECTRONIC_BUCKETS)
    assert.ok(p.includes(bucket), `region prompt names bucket "${bucket}"`);
  for (const example of NON_ELECTRONIC_EXAMPLES)
    assert.ok(p.includes(example), `region prompt names example "${example}"`);
  for (const cat of ELECTRONIC_CATEGORIES)
    assert.ok(p.includes(cat), `region prompt keeps category "${cat}"`);
});

test('region prompt: "ignore" reserved for true background, never for non-electronics', () => {
  const p = buildRegionPrompt(boxes);
  assert.match(p, /"ignore" .*ONLY for true background/);
  assert.match(p, /table surface/);
  assert.match(p, /shadows/);
  assert.match(p, /Do NOT use "ignore" for non-electronic objects/);
});

test("region prompt: reply schema carries region numbers, no bbox field", () => {
  const p = buildRegionPrompt(boxes);
  assert.ok(p.includes('{"region": <region number>'), "reply keyed by region");
  assert.ok(!p.includes('"bbox"'), "no bbox in the region reply schema");
});

test("region prompt: SEARCH FOCUS paragraph appears only with a query", () => {
  const bare = buildRegionPrompt(boxes);
  assert.ok(!bare.includes("SEARCH FOCUS"), "no query -> no focus paragraph");
  const focused = buildRegionPrompt(boxes, "yellow LED");
  assert.ok(focused.includes("SEARCH FOCUS"), "query -> focus paragraph");
  assert.ok(focused.includes('"yellow LED"'), "query text embedded");
  assert.ok(focused.startsWith(bare), "focus paragraph appends, base unchanged");
});
