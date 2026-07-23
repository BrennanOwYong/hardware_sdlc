// Client-side deterministic fallback for /api/codegen. Used only when the
// codegen route is unreachable or returns a non-ok status, so the guided
// assembly demo never dead-ends. The real route (codegen builder) is the
// source of truth; this mirrors its "template" degradation mode.

import type { CodegenResult, Netlist } from "@/lib/types";

/** Unique UNO pin names ("D2", "D13", "GND", "5V") observed in a netlist. */
export function extractUnoPins(netlist: Netlist): string[] {
  const pins: string[] = [];
  for (const edge of netlist.edges) {
    for (const ref of [edge.from, edge.to]) {
      if (ref.startsWith("UNO:")) {
        const pin = ref.slice(4);
        if (!pins.includes(pin)) pins.push(pin);
      }
    }
  }
  return pins;
}

/** djb2-xor hash, 8 hex chars. Deterministic, dependency-free. */
export function hashCode(code: string): string {
  let h = 5381;
  for (let i = 0; i < code.length; i += 1) {
    h = (Math.imul(h, 33) ^ code.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const BUTTON_LED_SKETCH = `// Forge — generated from the observed netlist (local template fallback)
// Observed: button on D2 (INPUT_PULLUP), LED on D13.
// Behavior: LED on while the button is pressed.

const int BUTTON_PIN = 2;   // observed at UNO:D2
const int LED_PIN = 13;     // observed at UNO:D13

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  // INPUT_PULLUP: the button pulls D2 LOW when pressed.
  digitalWrite(LED_PIN, digitalRead(BUTTON_PIN) == LOW ? HIGH : LOW);
}
`;

function genericSketch(pins: string[]): string {
  const digital = pins.filter((p) => /^D\d+$/.test(p));
  const setupLines = digital
    .map((p) => `  pinMode(${p.slice(1)}, OUTPUT); // observed at UNO:${p}`)
    .join("\n");
  return `// Forge — generated from the observed netlist (local template fallback)
// Observed UNO pins: ${pins.length > 0 ? pins.join(", ") : "none"}

void setup() {
${setupLines.length > 0 ? setupLines : "  // no digital pins observed yet"}
  Serial.begin(9600);
}

void loop() {
  Serial.println("Forge build running");
  delay(1000);
}
`;
}

export function fallbackCodegen(netlist: Netlist): CodegenResult {
  const pins = extractUnoPins(netlist);
  const code =
    pins.includes("D2") && pins.includes("D13")
      ? BUTTON_LED_SKETCH
      : genericSketch(pins);
  return {
    code,
    hash: hashCode(code),
    pinsUsed: pins.map((p) => `UNO:${p}`),
    via: "template",
  };
}
