// Gap analysis and shopping-match tests for the idea-to-build wizard.
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeGap, listingsFor, matchScore, tokenize } from "../lib/plan/gap.ts";
import { extractJson, fallbackWirePlan, buildPlanPrompt } from "../lib/plan/pure.ts";

const part = (name, partKey) => ({ name, partKey, qty: 1, why: "because" });
const det = (label, partType) => ({
  id: label,
  label,
  partType,
  confidence: 0.9,
  bbox: [0, 0, 0.1, 0.1],
});

test("tokenize drops noise words and singularizes", () => {
  assert.deepEqual(tokenize("Jumper Wires (assorted pack)"), ["jumper", "wire"]);
  assert.deepEqual(tokenize("the kit of a board"), []);
});

test("matchScore links a planned part to a differently-worded detection", () => {
  assert.ok(matchScore(part("Arduino Uno", "uno"), det("Arduino Duemilanove board", "microcontroller")) > 0);
  assert.ok(matchScore(part("Jumper wires", "jumpers"), det("Dupont cable bundle", "jumper-wire")) > 0);
  assert.equal(matchScore(part("Arduino Uno", "uno"), det("ceramic mug", "container")), 0);
});

test("empty desk puts every planned part in missing", () => {
  const parts = [part("Arduino Uno", "uno"), part("LED", "led")];
  const { have, missing } = analyzeGap(parts, []);
  assert.equal(have.length, 0);
  assert.equal(missing.length, 2);
});

test("a bench photo showing a board moves that part to have", () => {
  const parts = [part("Arduino Uno", "uno"), part("LED", "led")];
  const { have, missing } = analyzeGap(parts, [det("Arduino Uno R3", "microcontroller")]);
  assert.equal(have.length, 1);
  assert.equal(have[0].part.name, "Arduino Uno");
  assert.equal(have[0].matchedLabel, "Arduino Uno R3");
  assert.equal(missing.length, 1);
});

test("acquiring a part counts as owned without a photo match", () => {
  const parts = [part("LED", "led")];
  const before = analyzeGap(parts, []);
  assert.equal(before.missing.length, 1);
  const after = analyzeGap(parts, [], ["LED"]);
  assert.equal(after.have.length, 1);
  assert.equal(after.have[0].matchedLabel, null, "acquired parts have no photo match");
});

test("listingsFor prefers partKey then falls back to title tokens", () => {
  const listings = [
    { partKey: "uno", title: "Arduino Uno - R3" },
    { partKey: "led", title: "LED assortment" },
    { partKey: "other", title: "Breadboard jumper wire bundle" },
  ];
  assert.deepEqual(listingsFor(part("Arduino Uno", "uno"), listings).map((l) => l.partKey), ["uno"]);
  const byToken = listingsFor(part("jumper wire", undefined), listings);
  assert.equal(byToken.length, 1);
  assert.equal(byToken[0].partKey, "other");
});

test("extractJson survives fenced and bare model output", () => {
  assert.deepEqual(extractJson('```json\n{"reply":"hi"}\n```'), { reply: "hi" });
  assert.deepEqual(extractJson('chatter {"reply":"hi"} trailer'), { reply: "hi" });
  assert.equal(extractJson("no json here"), null);
});

test("fallbackWirePlan wires the parts it was given and always ships checks", () => {
  const plan = fallbackWirePlan(["Arduino Uno", "Half-size breadboard", "LED", "220 ohm resistor"]);
  assert.ok(plan.steps.length >= 3);
  assert.ok(plan.checks.length >= 1);
  assert.ok(plan.endStateSummary.includes("Arduino Uno"));
  assert.deepEqual(
    plan.steps.map((s) => s.index),
    plan.steps.map((_, i) => i + 1),
    "steps are numbered from one",
  );
});

test("plan prompt carries the idea, the history and the JSON contract", () => {
  const prompt = buildPlanPrompt("a night light", ["User: hello"]);
  assert.ok(prompt.includes("a night light"));
  assert.ok(prompt.includes("User: hello"));
  assert.ok(prompt.includes("partKey"));
});
