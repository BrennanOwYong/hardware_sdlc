// node --test tests/codegen.test.mjs
//
// Imports lib/codegen/template.ts directly via Node's type stripping
// (Node >= 23.6 strips types by default; template.ts keeps runtime imports
// to node builtins and uses `import type` for the shared contract).

import test from "node:test";
import assert from "node:assert/strict";

import {
  CodegenError,
  assertPinsMatch,
  extractPinMap,
  generateTemplate,
  inferCircuitHint,
  parseIntent,
  sha256,
} from "../lib/codegen/template.ts";

// Canonical demo circuit: button-to-LED, 7 steps.
const buttonLedNetlist = {
  edges: [
    { id: "e1", kind: "wire", from: "UNO:GND", to: "BB:RAIL:GND" },
    { id: "e2", kind: "component", part: "led", value: "red", from: "BB:5:f", to: "BB:6:f" },
    { id: "e3", kind: "component", part: "resistor", value: "220", from: "BB:6:h", to: "BB:RAIL:GND" },
    { id: "e4", kind: "wire", from: "UNO:D13", to: "BB:5:h" },
    { id: "e5", kind: "component", part: "pushbutton", from: "BB:15:e", to: "BB:17:e" },
    { id: "e6", kind: "wire", from: "UNO:D2", to: "BB:15:a" },
    { id: "e7", kind: "wire", from: "BB:17:a", to: "BB:RAIL:GND" },
  ],
};

// Secondary circuit: DHT11, data on UNO:D4, VCC/GND to rails.
const dhtNetlist = {
  edges: [
    { id: "d1", kind: "component", part: "dht11", from: "BB:3:f", to: "BB:5:f" },
    { id: "d2", kind: "wire", from: "UNO:D4", to: "BB:4:h" },
    { id: "d3", kind: "wire", from: "UNO:5V", to: "BB:RAIL:PWR" },
    { id: "d4", kind: "wire", from: "BB:3:h", to: "BB:RAIL:PWR" },
    { id: "d5", kind: "wire", from: "BB:5:h", to: "BB:RAIL:GND" },
    { id: "d6", kind: "wire", from: "UNO:GND", to: "BB:RAIL:GND" },
  ],
};

test("button-led: pins in generated code exactly match netlist pins", () => {
  const out = generateTemplate(buttonLedNetlist, "button-led");
  assert.doesNotThrow(() => assertPinsMatch(buttonLedNetlist, out.code));
  assert.match(out.code, /const uint8_t BUTTON_PIN = 2;/);
  assert.match(out.code, /const uint8_t LED_PIN = 13;/);
  assert.match(out.code, /INPUT_PULLUP/);
  assert.deepEqual(out.pinsUsed, ["UNO:D2", "UNO:D13", "UNO:GND"]);
});

test("button-led: roles traced from breadboard strip connectivity", () => {
  const map = extractPinMap(buttonLedNetlist);
  assert.deepEqual(map.digitalPins, [2, 13]);
  assert.equal(map.roles.ledPin, 13);
  assert.equal(map.roles.buttonPin, 2);
});

test("dht11: pins in generated code exactly match netlist pins", () => {
  const out = generateTemplate(dhtNetlist, "dht11");
  assert.doesNotThrow(() => assertPinsMatch(dhtNetlist, out.code));
  assert.match(out.code, /#include <DHT\.h>/);
  assert.match(out.code, /const uint8_t DHT_PIN = 4;/);
  assert.match(out.code, /Serial\.begin\(9600\);/);
  assert.deepEqual(out.pinsUsed, ["UNO:D4", "UNO:5V", "UNO:GND"]);
});

test("circuit hint inferred from component labels", () => {
  assert.equal(inferCircuitHint(buttonLedNetlist), "button-led");
  assert.equal(inferCircuitHint(dhtNetlist), "dht11");
  assert.throws(
    () => inferCircuitHint({ edges: [{ id: "x", kind: "wire", from: "UNO:GND", to: "BB:RAIL:GND" }] }),
    CodegenError,
  );
});

test("canned tweaks never change pinsUsed (button-led)", () => {
  const base = generateTemplate(buttonLedNetlist, "button-led");
  for (const intent of ["make it faster", "slower please", "invert the logic"]) {
    const opts = parseIntent(intent, "button-led");
    assert.notEqual(opts, null, `intent should be canned: ${intent}`);
    const tweaked = generateTemplate(buttonLedNetlist, "button-led", opts);
    assert.deepEqual(tweaked.pinsUsed, base.pinsUsed, `pinsUsed changed for: ${intent}`);
    assert.doesNotThrow(() => assertPinsMatch(buttonLedNetlist, tweaked.code));
    assert.notEqual(tweaked.code, base.code, `code should change for: ${intent}`);
  }
});

test("canned tweaks never change pinsUsed (dht11)", () => {
  const base = generateTemplate(dhtNetlist, "dht11");
  for (const intent of ["faster", "slow it down", "print fahrenheit"]) {
    const opts = parseIntent(intent, "dht11");
    assert.notEqual(opts, null, `intent should be canned: ${intent}`);
    const tweaked = generateTemplate(dhtNetlist, "dht11", opts);
    assert.deepEqual(tweaked.pinsUsed, base.pinsUsed, `pinsUsed changed for: ${intent}`);
    assert.doesNotThrow(() => assertPinsMatch(dhtNetlist, tweaked.code));
    assert.notEqual(tweaked.code, base.code, `code should change for: ${intent}`);
  }
});

test("fahrenheit tweak converts the DHT output", () => {
  const opts = parseIntent("show fahrenheit", "dht11");
  const out = generateTemplate(dhtNetlist, "dht11", opts);
  assert.match(out.code, /readTemperature\(true\)/);
  assert.match(out.code, /" F"/);
});

test("inapplicable or unknown intents are not canned", () => {
  assert.equal(parseIntent("fahrenheit", "button-led"), null);
  assert.equal(parseIntent("invert it", "dht11"), null);
  assert.equal(parseIntent("make it purple and majestic", "button-led"), null);
});

test("hash is stable for identical input", () => {
  const a = generateTemplate(buttonLedNetlist, "button-led");
  const b = generateTemplate(buttonLedNetlist, "button-led");
  assert.equal(a.code, b.code);
  assert.equal(sha256(a.code), sha256(b.code));
  assert.match(sha256(a.code), /^[0-9a-f]{64}$/);

  const inverted = generateTemplate(
    buttonLedNetlist,
    "button-led",
    parseIntent("invert", "button-led"),
  );
  assert.notEqual(sha256(inverted.code), sha256(a.code));
});

test("assertPinsMatch rejects a pin outside the netlist", () => {
  const out = generateTemplate(buttonLedNetlist, "button-led");
  const withExtra = `${out.code}// also touches D7\n`;
  assert.throws(() => assertPinsMatch(buttonLedNetlist, withExtra), /D7/);
});

test("assertPinsMatch rejects firmware missing a wired pin", () => {
  const code = [
    "const uint8_t LED_PIN = 13;",
    "void setup() { pinMode(LED_PIN, OUTPUT); }",
    "void loop() { digitalWrite(LED_PIN, HIGH); }",
    "",
  ].join("\n");
  assert.throws(() => assertPinsMatch(buttonLedNetlist, code), /missing wired pin/);
});

test("assertPinsMatch rejects bare pin literals in pin calls", () => {
  const out = generateTemplate(buttonLedNetlist, "button-led");
  const withBare = `${out.code}void extra() { pinMode(13, OUTPUT); }\n`;
  assert.throws(() => assertPinsMatch(buttonLedNetlist, withBare), /bare pin literal/);
});
