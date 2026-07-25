// The guided build: typed steps with REAL dependencies.
//
// A linear step list lies about how building works. Running the ground wire
// and seating the LED do not depend on each other, so forcing an order is a
// fiction. Flashing firmware genuinely does depend on the wiring it drives,
// and powering on depends on everything. This module encodes which is which,
// so the UI can say "any order within this group" where that is true and
// "must come after" only where it is.
//
// Pure module: type-only project imports so `node --test` can load it.
import type { NetlistEdge, Netlist, TargetRef } from "@/lib/types";

export type StepKind = "wire" | "component" | "flash" | "verify" | "power";

/** A part in the legend, so a step can say which thing to pick up. */
export interface LegendPart {
  id: string;
  name: string;
  /** Swatch colour, so the legend reads at a glance. */
  colour: string;
  qty: number;
  /** What this part does in this build, in plain words. */
  role: string;
}

export interface GuidedStep {
  id: string;
  index: number;
  kind: StepKind;
  title: string;
  /** Written for someone who has never wired a breadboard. */
  instruction: string;
  /** What the user should see or feel when the step is right. */
  checkDetail: string;
  /** Legend part ids this step uses. */
  parts: string[];
  /** Ids of steps that MUST be done first. Empty means order-free. */
  dependsOn: string[];
  /** The connection this step adds, when it changes the circuit. */
  edge?: NetlistEdge;
  /** Sketch shown by a flash step. */
  code?: string;
  /** Pins the firmware drives, so the dependency on wiring is explicit. */
  pins?: string[];
}

export const LEGEND: LegendPart[] = [
  { id: "uno", name: "Arduino Uno", colour: "#0ea5e9", qty: 1, role: "runs the code and drives the pins" },
  { id: "breadboard", name: "Half-size breadboard", colour: "#94a3b8", qty: 1, role: "holds the circuit without soldering" },
  { id: "led", name: "LED (red)", colour: "#ef4444", qty: 1, role: "the light you switch on" },
  { id: "resistor", name: "220Ω resistor", colour: "#f59e0b", qty: 1, role: "protects the LED from too much current" },
  { id: "button", name: "Pushbutton", colour: "#22c55e", qty: 1, role: "the input you press" },
  { id: "wire-black", name: "Jumper wire (black)", colour: "#475569", qty: 2, role: "carries ground" },
  { id: "wire-red", name: "Jumper wire (red)", colour: "#dc2626", qty: 1, role: "carries the LED signal" },
  { id: "wire-yellow", name: "Jumper wire (yellow)", colour: "#eab308", qty: 1, role: "carries the button signal" },
  { id: "usb", name: "USB cable", colour: "#a855f7", qty: 1, role: "powers the board and carries your code to it" },
];

const wire = (id: string, from: TargetRef, to: TargetRef, part: string): NetlistEdge => ({
  id,
  kind: "wire",
  part,
  from,
  to,
});

const component = (
  id: string,
  from: TargetRef,
  to: TargetRef,
  part: string,
  value?: string,
): NetlistEdge => ({ id, kind: "component", part, from, to, ...(value ? { value } : {}) });

const SKETCH = `// Forge generated this from the pins it watched you wire.
const int BUTTON_PIN = 2;   // yellow wire -> UNO D2
const int LED_PIN    = 13;  // red wire    -> UNO D13

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  // INPUT_PULLUP reads LOW when the button is pressed.
  digitalWrite(LED_PIN, digitalRead(BUTTON_PIN) == LOW ? HIGH : LOW);
}
`;

/**
 * The button-and-LED build.
 *
 * Dependencies are physical facts, not authoring order:
 *  - w1..w4 and c1..c2 touch different rows, so none depends on another.
 *  - r1 bridges the LED's cathode row, so it needs the LED seated first.
 *  - flash needs every wire carrying a pin the sketch names (D2, D13, GND).
 *  - power needs the circuit complete; verify needs power and the firmware.
 */
export const GUIDED_STEPS: GuidedStep[] = [
  {
    id: "w1",
    index: 1,
    kind: "wire",
    title: "Ground the breadboard",
    instruction:
      "Push one end of a black jumper into the Uno's GND pin, and the other end into the blue rail running along the breadboard.",
    checkDetail: "Both ends sit flush; a gentle tug does not pull them out.",
    parts: ["uno", "breadboard", "wire-black"],
    dependsOn: [],
    edge: wire("w1", "UNO:GND", "BB:RAIL:GND", "jumper (black)"),
  },
  {
    id: "c1",
    index: 2,
    kind: "component",
    title: "Seat the LED",
    instruction:
      "Push the LED into the breadboard so its long leg lands in row 5 and its short leg in row 6. The long leg is the positive side.",
    checkDetail: "The two legs sit in different rows; sharing a row would short it out.",
    parts: ["led", "breadboard"],
    dependsOn: [],
    edge: component("c1", "BB:5:f", "BB:6:f", "LED", "red"),
  },
  {
    id: "r1",
    index: 3,
    kind: "component",
    title: "Add the resistor",
    instruction:
      "Bridge the LED's short-leg row (row 6) to the blue ground rail with the 220Ω resistor.",
    checkDetail: "The resistor spans from row 6 to the blue rail, not across the LED itself.",
    parts: ["resistor", "breadboard"],
    // Physical: it bridges the row the LED's cathode sits in.
    dependsOn: ["c1"],
    edge: component("r1", "BB:6:h", "BB:RAIL:GND", "resistor", "220Ω"),
  },
  {
    id: "w2",
    index: 4,
    kind: "wire",
    title: "Wire the LED to pin 13",
    instruction:
      "Run the red jumper from the Uno's pin D13 to row 5, the row holding the LED's long leg.",
    checkDetail: "The wire reaches the long-leg row only; nothing else shares it.",
    parts: ["uno", "wire-red"],
    dependsOn: [],
    edge: wire("w2", "UNO:D13", "BB:5:h", "jumper (red)"),
  },
  {
    id: "c2",
    index: 5,
    kind: "component",
    title: "Seat the button",
    instruction:
      "Straddle the pushbutton across the breadboard's centre channel so its legs land in rows 15 and 17.",
    checkDetail: "The button sits flat and does not rock when pressed.",
    parts: ["button", "breadboard"],
    dependsOn: [],
    edge: component("c2", "BB:15:e", "BB:17:e", "pushbutton"),
  },
  {
    id: "w3",
    index: 6,
    kind: "wire",
    title: "Wire the button to pin 2",
    instruction: "Run the yellow jumper from the Uno's pin D2 to row 15.",
    checkDetail: "The wire lands in the same row as one button leg.",
    parts: ["uno", "wire-yellow"],
    dependsOn: [],
    edge: wire("w3", "UNO:D2", "BB:15:a", "jumper (yellow)"),
  },
  {
    id: "w4",
    index: 7,
    kind: "wire",
    title: "Ground the button",
    instruction: "Run the second black jumper from row 17 to the blue ground rail.",
    checkDetail: "Pressing the button now connects row 15 to ground through the switch.",
    parts: ["wire-black", "breadboard"],
    dependsOn: [],
    edge: wire("w4", "BB:17:a", "BB:RAIL:GND", "jumper (black)"),
  },
  {
    id: "power",
    index: 8,
    kind: "power",
    title: "Plug in the USB cable",
    instruction:
      "Connect the Uno to your laptop with the USB cable. The board's power light should come on.",
    checkDetail: "A small green light on the Uno stays lit.",
    parts: ["usb", "uno"],
    // Everything must be in place before power reaches the circuit.
    dependsOn: ["w1", "c1", "r1", "w2", "c2", "w3", "w4"],
  },
  {
    id: "flash",
    index: 9,
    kind: "flash",
    title: "Send the code to the board",
    instruction:
      "Forge wrote this sketch from the pins it watched you wire. Press Inject code to compile it and send it to the Uno.",
    checkDetail: "The compiler reports how many bytes the sketch uses, with no errors.",
    parts: ["uno", "usb"],
    // The firmware names D2 and D13, so those wires must exist first.
    dependsOn: ["w2", "w3", "power"],
    code: SKETCH,
    pins: ["UNO:D2", "UNO:D13", "UNO:GND"],
  },
  {
    id: "verify",
    index: 10,
    kind: "verify",
    title: "Press the button",
    instruction: "Hold the pushbutton down. The LED should light while you hold it.",
    checkDetail: "The LED lights on press and goes dark on release.",
    parts: ["button", "led"],
    dependsOn: ["flash"],
  },
];

/**
 * Group steps into waves: everything in a wave has its dependencies met by
 * earlier waves, so the steps inside it can be done in any order. This is
 * what lets the UI stop pretending wiring is sequential.
 */
export function computeWaves(steps: readonly GuidedStep[]): GuidedStep[][] {
  const done = new Set<string>();
  const remaining = [...steps];
  const waves: GuidedStep[][] = [];

  while (remaining.length > 0) {
    const ready = remaining.filter((s) => s.dependsOn.every((d) => done.has(d)));
    if (ready.length === 0) {
      // A cycle or a missing id: surface the rest rather than looping forever.
      waves.push([...remaining]);
      break;
    }
    waves.push(ready);
    for (const s of ready) {
      done.add(s.id);
      remaining.splice(remaining.indexOf(s), 1);
    }
  }
  return waves;
}

/** Which wave each step belongs to, for the UI's grouping headers. */
export function waveIndexById(steps: readonly GuidedStep[]): Map<string, number> {
  const map = new Map<string, number>();
  computeWaves(steps).forEach((wave, i) => {
    for (const s of wave) map.set(s.id, i);
  });
  return map;
}

/**
 * The circuit BEFORE a step: every edge from steps that must already be done.
 * Dependencies alone are too thin (most steps have none), so "before" means
 * every step earlier in the listed order, which is how a person reading the
 * list top to bottom would have built it.
 */
export function netlistBefore(
  steps: readonly GuidedStep[],
  stepId: string,
): Netlist {
  const edges: NetlistEdge[] = [];
  for (const s of steps) {
    if (s.id === stepId) break;
    if (s.edge) edges.push(s.edge);
  }
  return { edges };
}

/** The circuit AFTER the step: the before-state plus this step's own edge. */
export function netlistAfter(
  steps: readonly GuidedStep[],
  stepId: string,
): Netlist {
  const before = netlistBefore(steps, stepId);
  const step = steps.find((s) => s.id === stepId);
  return step?.edge ? { edges: [...before.edges, step.edge] } : before;
}

/** Human sentence for a step's ordering freedom, shown on the card. */
export function orderingNote(
  step: GuidedStep,
  steps: readonly GuidedStep[],
): string {
  if (step.dependsOn.length === 0) {
    return "Any order — this does not depend on the other steps.";
  }
  const names = step.dependsOn
    .map((id) => steps.find((s) => s.id === id)?.title ?? id)
    .join(", ");
  return `Must come after: ${names}.`;
}

/** Steps sharing a wave with this one, excluding itself. */
export function siblingsInWave(
  step: GuidedStep,
  steps: readonly GuidedStep[],
): GuidedStep[] {
  const waves = computeWaves(steps);
  const wave = waves.find((w) => w.some((s) => s.id === step.id));
  return wave ? wave.filter((s) => s.id !== step.id) : [];
}

export function legendFor(step: GuidedStep): LegendPart[] {
  return LEGEND.filter((p) => step.parts.includes(p.id));
}
