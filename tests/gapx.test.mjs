// Quantity-aware gap analysis: the 3-of-4 case is the reason this exists.
import test from "node:test";
import assert from "node:assert/strict";
import { countByKind, kindOf, describeCount } from "../lib/gapx/counts.ts";
import { computeVenn, summariseVenn, describeShortfall } from "../lib/gapx/venn.ts";

const det = (label, partType = "component") => ({
  id: `${label}-${Math.round(label.length * 7)}`,
  label,
  partType,
  confidence: 0.9,
  bbox: [0, 0, 0.1, 0.1],
});

const req = (kind, name, qty, why = "needed", critical = true) => ({
  kind,
  name,
  qty,
  why,
  critical,
});

test("kindOf routes labels to part kinds, specific before generic", () => {
  assert.equal(kindOf("Arduino Uno R3", "microcontroller"), "uno");
  assert.equal(kindOf("Half-size breadboard", "breadboard"), "breadboard");
  assert.equal(kindOf("Dupont cable", "wire"), "jumpers");
  assert.equal(kindOf("DHT11 temperature sensor", "sensor"), "dht11");
  assert.equal(kindOf("PIR motion sensor", "sensor"), "sensor");
  assert.equal(kindOf("Clear plastic pen", "stationery"), "other");
});

test("three separate wires count as three", () => {
  const counts = countByKind([
    det("jumper wire", "wire"),
    det("jumper wire", "wire"),
    det("jumper wire", "wire"),
  ]);
  assert.equal(counts.jumpers.min, 3);
  assert.equal(counts.jumpers.max, 3);
  assert.equal(counts.jumpers.certain, true);
  assert.equal(describeCount(counts.jumpers), "3");
});

test("a bundle is an uncertain range, never a hard number", () => {
  const counts = countByKind([det("jumper wire bundle (assorted)", "wire")]);
  assert.equal(counts.jumpers.certain, false);
  assert.ok(counts.jumpers.max > counts.jumpers.min);
  assert.match(describeCount(counts.jumpers), /to/);
});

test("THE CASE: 3 wires on the desk, 4 needed -> short by exactly 1", () => {
  const counts = countByKind([
    det("jumper wire", "wire"),
    det("jumper wire", "wire"),
    det("jumper wire", "wire"),
  ]);
  const v = computeVenn([req("jumpers", "Jumper wires", 4)], counts);
  assert.equal(v.satisfied.length, 0);
  assert.equal(v.short.length, 1);
  assert.equal(v.short[0].need, 4);
  assert.equal(v.short[0].have, 3);
  assert.equal(v.short[0].shortfall, 1);
  assert.equal(
    describeShortfall(v.short[0]),
    "Jumper wires: need 4, saw 3, get 1 more",
  );
});

test("exact satisfaction and surplus both land in the right lobe", () => {
  const counts = countByKind([
    det("Arduino Uno", "microcontroller"),
    det("jumper wire", "wire"),
    det("jumper wire", "wire"),
    det("ceramic mug", "container"),
  ]);
  const v = computeVenn(
    [req("uno", "Arduino Uno", 1), req("jumpers", "Jumper wires", 2)],
    counts,
  );
  assert.equal(v.short.length, 0);
  assert.equal(v.satisfied.length, 2);
  assert.deepEqual(
    v.surplus.map((s) => s.kind),
    ["other"],
    "the mug is surplus to this build",
  );
});

test("a bundle that might or might not cover the need becomes a question", () => {
  const counts = countByKind([det("resistor assortment pack", "resistor")]);
  const v = computeVenn([req("resistor", "220 ohm resistors", 4)], counts);
  assert.equal(v.short.length, 0);
  assert.equal(v.satisfied.length, 0);
  assert.equal(v.unknown.length, 1);
  assert.match(v.unknown[0].question, /cannot count/);
});

test("an empty desk makes every required part short by its full quantity", () => {
  const v = computeVenn(
    [req("uno", "Arduino Uno", 1), req("led", "LED", 2)],
    countByKind([]),
  );
  assert.equal(v.satisfied.length, 0);
  assert.equal(v.short.length, 2);
  assert.equal(v.short[1].shortfall, 2);
});

test("the partition is exhaustive: every required part lands in exactly one bucket", () => {
  const counts = countByKind([
    det("Arduino Uno", "microcontroller"),
    det("jumper wire", "wire"),
    det("resistor pack", "resistor"),
  ]);
  const required = [
    req("uno", "Arduino Uno", 1),
    req("jumpers", "Jumper wires", 4),
    req("resistor", "Resistors", 3),
    req("led", "LED", 1),
  ];
  const v = computeVenn(required, counts);
  const placed =
    v.satisfied.length + v.short.length + v.unknown.length;
  assert.equal(placed, required.length);
  assert.equal(v.totalRequired, required.length);
});

test("summary counts missing units, not just missing part types", () => {
  const v = computeVenn(
    [req("jumpers", "Jumper wires", 4), req("led", "LED", 3)],
    countByKind([det("jumper wire", "wire")]),
  );
  const s = summariseVenn(v);
  assert.match(s, /6 items to get/, "3 wires short plus 3 LEDs short");
});

test("a fully covered build says so plainly", () => {
  const v = computeVenn(
    [req("uno", "Arduino Uno", 1)],
    countByKind([det("Arduino Uno", "microcontroller")]),
  );
  assert.match(summariseVenn(v), /You have everything/);
});
