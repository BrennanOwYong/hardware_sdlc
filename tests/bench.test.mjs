// node --test tests/bench.test.mjs
//
// Loads lib/bench/parse.ts and lib/bench/guidance.ts directly via Node's type
// stripping (cross-file project imports in those modules are type-only; the
// only runtime dependency is zod, which Node resolves from node_modules).

import test from "node:test";
import assert from "node:assert/strict";

import {
  boardListSchema,
  compileOnlyResult,
  derivePeripherals,
  detectedToDeviceCards,
  deviceIdFor,
  flashResultSchema,
  friendlyPartName,
  mergeDevices,
} from "../lib/bench/parse.ts";
import { GUIDANCE, pickGuidance } from "../lib/bench/guidance.ts";

// Fixture mirrors `arduino-cli board list --json` (v1.5.1): snake_case fields
// per the gRPC reference; see docs/references-delta-bench.md.
const boardListFixture = {
  detected_ports: [
    {
      port: {
        address: "/dev/ttyACM0",
        label: "/dev/ttyACM0",
        protocol: "serial",
        protocol_label: "Serial Port (USB)",
      },
      matching_boards: [{ name: "Arduino Uno", fqbn: "arduino:avr:uno" }],
    },
    {
      port: {
        address: "COM7",
        label: "COM7",
        protocol: "serial",
        protocol_label: "Serial Port (USB)",
      },
    },
  ],
};

// Canonical button-led commit netlist (same wiring the codegen tests use).
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

test("board list fixture parses and maps to DeviceCards", () => {
  const parsed = boardListSchema.parse(boardListFixture);
  const cards = detectedToDeviceCards(parsed, "2026-07-23T00:00:00.000Z");

  assert.equal(cards.length, 2);

  const uno = cards[0];
  assert.equal(uno.id, deviceIdFor("/dev/ttyACM0", "arduino:avr:uno"));
  assert.equal(uno.boardName, "Arduino Uno");
  assert.equal(uno.fqbn, "arduino:avr:uno");
  assert.equal(uno.port, "/dev/ttyACM0");
  assert.equal(uno.transport, "usb");
  assert.equal(uno.status, "awake");
  assert.equal(uno.lastSeen, "2026-07-23T00:00:00.000Z");
  assert.equal(uno.firmwareHash, null);
  assert.deepEqual(uno.peripherals, []);

  // A serial port with no identified board is "quiet", never "awake".
  const mystery = cards[1];
  assert.equal(mystery.boardName, "Unknown device");
  assert.equal(mystery.fqbn, null);
  assert.equal(mystery.port, "COM7");
  assert.equal(mystery.status, "quiet");
});

test("empty board list parses (WSL with no USB passthrough)", () => {
  const parsed = boardListSchema.parse({ detected_ports: [] });
  assert.deepEqual(detectedToDeviceCards(parsed, "2026-07-23T00:00:00.000Z"), []);
});

test("a known device missing from the fresh scan flips to unplugged", () => {
  const parsed = boardListSchema.parse(boardListFixture);
  const seen = detectedToDeviceCards(parsed, "2026-07-23T00:00:00.000Z");
  const gone = mergeDevices(seen, []);
  assert.equal(gone.length, 2);
  assert.ok(gone.every((d) => d.status === "unplugged"));
  // lastSeen survives the flip so the UI can say when it vanished.
  assert.equal(gone[0].lastSeen, "2026-07-23T00:00:00.000Z");

  // Replug: the fresh scan wins again.
  const back = mergeDevices(gone, seen);
  assert.equal(back.find((d) => d.port === "/dev/ttyACM0")?.status, "awake");
});

test("peripheral derivation: button-led commit -> LED on D13, button on D2", () => {
  const peripherals = derivePeripherals(buttonLedNetlist);
  assert.deepEqual(
    peripherals.sort((a, b) => a.pin.localeCompare(b.pin)),
    [
      { name: "LED", pin: "D13", source: "netlist" },
      { name: "button", pin: "D2", source: "netlist" },
    ].sort((a, b) => a.pin.localeCompare(b.pin)),
  );
});

test("peripheral derivation: dht11 spans breadboard columns, power pins skipped", () => {
  const peripherals = derivePeripherals(dhtNetlist);
  assert.deepEqual(peripherals, [
    { name: "temperature sensor", pin: "D4", source: "netlist" },
  ]);
  // UNO:5V and UNO:GND never show up as peripherals.
  assert.ok(peripherals.every((p) => p.pin.startsWith("D") || p.pin.startsWith("A")));
});

test("friendly part names stay beginner words", () => {
  assert.equal(friendlyPartName("led"), "LED");
  assert.equal(friendlyPartName("pushbutton"), "button");
  assert.equal(friendlyPartName("dht11"), "temperature sensor");
  assert.equal(friendlyPartName("buzzer"), "speaker");
  assert.equal(friendlyPartName("weird-part"), "weird-part");
});

test("guidance map keeps the exact beginner strings", () => {
  assert.equal(
    GUIDANCE["no-cli"],
    "The flashing tool is not installed on this laptop yet. See README > Flashing setup.",
  );
  assert.equal(
    GUIDANCE["no-board"],
    "I cannot see a board. Plug the flat end of the USB cable into the laptop and the other end into your Arduino.",
  );
  assert.equal(GUIDANCE["board-gone"], "The board went quiet. Check the cable is fully seated.");
  assert.equal(
    GUIDANCE["port-busy"],
    "Something else is talking to the board. Close other Arduino windows and try again.",
  );
  assert.match(GUIDANCE["power-only-cable"], /power only/);
  assert.match(GUIDANCE["wsl-linux-binary"], /WSL/);
  assert.match(GUIDANCE["wsl-linux-binary"], /ARDUINO_CLI_PATH/);
});

test("guidance selection: busy port, vanished board, stage fallbacks", () => {
  assert.equal(
    pickGuidance({ stage: "upload", output: "avrdude: ser_open(): resource busy" }),
    GUIDANCE["port-busy"],
  );
  assert.equal(
    pickGuidance({ stage: "upload", output: "Permission denied opening COM3" }),
    GUIDANCE["port-busy"],
  );
  assert.equal(
    pickGuidance({ stage: "upload", output: "can't open device /dev/ttyACM0" }),
    GUIDANCE["board-gone"],
  );
  assert.equal(
    pickGuidance({ stage: "upload", noBoard: true, boardWasSeen: true }),
    GUIDANCE["board-gone"],
  );
  assert.equal(pickGuidance({ stage: "upload", noBoard: true }), GUIDANCE["no-board"]);
  assert.equal(pickGuidance({ stage: "compile", output: "expected ';'" }), GUIDANCE["compile-failed"]);
  assert.equal(pickGuidance({ stage: "upload", output: "mystery failure" }), GUIDANCE["upload-failed"]);
  assert.equal(pickGuidance({ stage: "handshake", output: "" }), GUIDANCE["no-hello"]);
});

test("compile-only FlashResult shape: ok, stage compile, hash, guidance", () => {
  const result = compileOnlyResult("[compile]\nSketch uses 924 bytes", "abc123def456");
  const parsed = flashResultSchema.parse(result);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.stage, "compile");
  assert.equal(parsed.firmwareHash, "abc123def456");
  assert.match(parsed.guidance ?? "", /plug your Arduino in/i);
  assert.match(parsed.output, /\[compile\]/);
});
