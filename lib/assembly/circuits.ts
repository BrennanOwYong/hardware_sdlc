// Canonical circuits + board geometry for guided assembly.
//
// This module is import-free at runtime (type-only imports) so that
// tests/stepgraph.test.mjs can load it under plain `node --test` with
// Node's native type stripping (see docs/references-p2.md).
//
// Coordinate system: one SVG canvas of BOARD_W x BOARD_H units holding a
// half-size breadboard (rows 1..30, columns a..j, PWR + GND rails) stacked
// above an Arduino Uno silhouette. refToXY() returns coordinates normalized
// to 0..1 so the same numbers drive BoardView (SVG) and Overlay (canvas
// over live video).

import type {
  AssemblyStep,
  NetlistEdge,
  StepTarget,
  TargetRef,
} from "@/lib/types";

export const BOARD_W = 1000;
export const BOARD_H = 1080;

// Breadboard geometry (SVG units)
export const BB_ROWS = 30;
export const BB_ROW_X0 = 55; // x of row 1
export const BB_ROW_DX = 30; // spacing between rows
export const BB_COL_Y: Record<string, number | undefined> = {
  a: 70,
  b: 100,
  c: 130,
  d: 160,
  e: 190,
  f: 260,
  g: 290,
  h: 320,
  i: 350,
  j: 380,
};
export const BB_RAIL_PWR_Y = 440;
export const BB_RAIL_GND_Y = 480;
export const BB_RAIL_X = 490; // representative connection point on a rail

// Arduino Uno geometry (SVG units)
export const UNO_DIGITAL_Y = 600; // top header (GND, D13..D0)
export const UNO_GND_X = 200;
export const UNO_D13_X = 240;
export const UNO_PIN_DX = 40;
export const UNO_POWER_Y = 1010; // bottom header (3V3, 5V, VIN, A0..A5)
export const UNO_POWER_X: Record<string, number | undefined> = {
  "3V3": 320,
  "5V": 380,
  VIN: 500,
};
export const UNO_A0_X = 620;

function norm(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round((x / BOARD_W) * 10000) / 10000,
    y: Math.round((y / BOARD_H) * 10000) / 10000,
  };
}

/** Row x coordinate in SVG units for breadboard row 1..30. */
export function bbRowX(row: number): number {
  return BB_ROW_X0 + (row - 1) * BB_ROW_DX;
}

/**
 * Map a canonical target ref ("UNO:D2", "BB:12:e", "BB:RAIL:GND") to
 * normalized 0..1 coordinates on the board view. Returns null for refs
 * this board does not know.
 */
export function refToXY(ref: TargetRef): { x: number; y: number } | null {
  const hole = /^BB:(\d{1,2}):([a-j])$/.exec(ref);
  if (hole) {
    const row = Number(hole[1]);
    if (row < 1 || row > BB_ROWS) return null;
    const colY = BB_COL_Y[hole[2]];
    if (colY === undefined) return null;
    return norm(bbRowX(row), colY);
  }
  if (ref === "BB:RAIL:PWR") return norm(BB_RAIL_X, BB_RAIL_PWR_Y);
  if (ref === "BB:RAIL:GND") return norm(BB_RAIL_X, BB_RAIL_GND_Y);
  const digital = /^UNO:D(\d{1,2})$/.exec(ref);
  if (digital) {
    const n = Number(digital[1]);
    if (n > 13) return null;
    return norm(UNO_D13_X + (13 - n) * UNO_PIN_DX, UNO_DIGITAL_Y);
  }
  if (ref === "UNO:GND") return norm(UNO_GND_X, UNO_DIGITAL_Y);
  const power = UNO_POWER_X[ref.replace(/^UNO:/, "")];
  if (ref.startsWith("UNO:") && power !== undefined) {
    return norm(power, UNO_POWER_Y);
  }
  const analog = /^UNO:A([0-5])$/.exec(ref);
  if (analog) {
    return norm(UNO_A0_X + Number(analog[1]) * UNO_PIN_DX, UNO_POWER_Y);
  }
  return null;
}

/** First-timer friendly name for a target ref, used in instructions and banners. */
export function refLabel(ref: TargetRef): string {
  if (ref === "BB:RAIL:GND") return "the blue GND rail on the breadboard";
  if (ref === "BB:RAIL:PWR") return "the red power (+) rail on the breadboard";
  const hole = /^BB:(\d{1,2}):([a-j])$/.exec(ref);
  if (hole) return `breadboard row ${hole[1]}, hole ${hole[2]}`;
  if (ref === "UNO:GND") return "the GND pin on the Arduino digital header";
  const pin = /^UNO:(.+)$/.exec(ref);
  if (pin) return `the ${pin[1]} pin on the Arduino`;
  return ref;
}

/** A plausible near-miss ref for the simulate panel ("one row off"). */
export function wrongRefFor(step: AssemblyStep): TargetRef {
  const target = step.targets[0];
  const ref = target ? target.ref : "BB:1:a";
  const hole = /^BB:(\d{1,2}):([a-j])$/.exec(ref);
  if (hole) {
    const row = Number(hole[1]);
    const off = row < BB_ROWS ? row + 1 : row - 1;
    return `BB:${off}:${hole[2]}`;
  }
  const digital = /^UNO:D(\d{1,2})$/.exec(ref);
  if (digital) {
    const n = Number(digital[1]);
    return `UNO:D${n >= 1 ? n - 1 : 1}`;
  }
  if (ref === "UNO:GND") return "UNO:D13";
  if (ref === "UNO:5V") return "UNO:3V3";
  if (ref === "BB:RAIL:GND") return "BB:RAIL:PWR";
  if (ref === "BB:RAIL:PWR") return "BB:RAIL:GND";
  return "BB:1:a";
}

function mustXY(ref: TargetRef): StepTarget {
  const xy = refToXY(ref);
  if (!xy) throw new Error(`circuits.ts: unmapped target ref ${ref}`);
  return { ref, x: xy.x, y: xy.y };
}

function mkStep(
  index: number,
  instruction: string,
  edge: NetlistEdge,
): AssemblyStep {
  return {
    id: `step-${edge.id}`,
    index,
    instruction,
    edge,
    targets: [mustXY(edge.from), mustXY(edge.to)],
  };
}

/**
 * Canonical demo circuit: button-to-LED, 7 steps.
 * Firmware behavior: D2 INPUT_PULLUP reads the button, D13 drives the LED,
 * LED on while the button is pressed.
 */
export const buttonLedSteps: AssemblyStep[] = [
  mkStep(
    0,
    "Ground first. Take a black jumper wire. Push one end into the GND pin on the Arduino digital header (next to D13), and the other end into any hole on the blue GND rail of the breadboard.",
    { id: "e1", kind: "wire", from: "UNO:GND", to: "BB:RAIL:GND" },
  ),
  mkStep(
    1,
    "Place the red LED across two rows: the long leg (anode) goes into row 5 hole f, the short leg (cathode) into row 6 hole f.",
    {
      id: "e2",
      kind: "component",
      part: "LED",
      value: "red",
      from: "BB:5:f",
      to: "BB:6:f",
    },
  ),
  mkStep(
    2,
    "Take the 220-ohm resistor (red-red-brown bands). Push one leg into row 6 hole h (the same row as the LED's short leg) and the other leg into the blue GND rail.",
    {
      id: "e3",
      kind: "component",
      part: "resistor",
      value: "220Ω",
      from: "BB:6:h",
      to: "BB:RAIL:GND",
    },
  ),
  mkStep(
    3,
    "Signal wire for the LED. Push one end of a jumper wire into the D13 pin on the Arduino and the other end into row 5 hole h (the same row as the LED's long leg).",
    { id: "e4", kind: "wire", from: "UNO:D13", to: "BB:5:h" },
  ),
  mkStep(
    4,
    "Place the pushbutton so it straddles rows 15 and 17: one pair of legs in row 15, the other pair in row 17, on the e-hole side. It should click flat onto the board.",
    {
      id: "e5",
      kind: "component",
      part: "pushbutton",
      from: "BB:15:e",
      to: "BB:17:e",
    },
  ),
  mkStep(
    5,
    "Button signal wire. Push one end of a jumper wire into the D2 pin on the Arduino and the other end into row 15 hole a (the same row as the button's top legs).",
    { id: "e6", kind: "wire", from: "UNO:D2", to: "BB:15:a" },
  ),
  mkStep(
    6,
    "Last wire. Connect row 17 hole a (the same row as the button's bottom legs) to the blue GND rail.",
    { id: "e7", kind: "wire", from: "BB:17:a", to: "BB:RAIL:GND" },
  ),
];

/**
 * Stretch circuit: DHT11 temperature sensor, data on UNO:D4, firmware prints
 * Celsius to Serial. 6 steps.
 */
export const dht11Steps: AssemblyStep[] = [
  mkStep(
    0,
    "Ground first. Jumper wire from the GND pin on the Arduino digital header to the blue GND rail on the breadboard.",
    { id: "d1", kind: "wire", from: "UNO:GND", to: "BB:RAIL:GND" },
  ),
  mkStep(
    1,
    "Power the rail. Jumper wire from the 5V pin on the Arduino power header to the red power (+) rail on the breadboard.",
    { id: "d2", kind: "wire", from: "UNO:5V", to: "BB:RAIL:PWR" },
  ),
  mkStep(
    2,
    "Place the DHT11 sensor facing you with its three legs in rows 10, 11 and 12, hole f: VCC in row 10, DATA in row 11, GND in row 12.",
    {
      id: "d3",
      kind: "component",
      part: "DHT11",
      from: "BB:10:f",
      to: "BB:12:f",
    },
  ),
  mkStep(
    3,
    "Sensor power. Jumper wire from row 10 hole j (the VCC row) to the red power (+) rail.",
    { id: "d4", kind: "wire", from: "BB:10:j", to: "BB:RAIL:PWR" },
  ),
  mkStep(
    4,
    "Data wire. Push one end into the D4 pin on the Arduino and the other end into row 11 hole j (the DATA row).",
    { id: "d5", kind: "wire", from: "UNO:D4", to: "BB:11:j" },
  ),
  mkStep(
    5,
    "Sensor ground. Jumper wire from row 12 hole j (the GND row) to the blue GND rail.",
    { id: "d6", kind: "wire", from: "BB:12:j", to: "BB:RAIL:GND" },
  ),
];
