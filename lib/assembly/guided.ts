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
  /** What this connection accomplishes electrically, in plain words. Without
   *  it a step list is a set of orders; with it, it teaches the circuit. */
  why: string;
  /** True when the app can confirm this itself (a compiler result, a device
   *  handshake). Everything else is a human observation, and a "mark done"
   *  tickbox for it records a claim nobody checked. */
  agentCheckable?: boolean;
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
      "Push one end of a black jumper wire into the pin marked GND on the Uno's top row of sockets. Push the other end into any hole on the blue-striped rail running along the bottom edge of the breadboard.",
    why: "Every part of a circuit needs a shared return path. This wire makes the whole blue rail count as the Uno's ground, so later steps can reach ground from anywhere on the board instead of running their own wire back to the Uno.",
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
      "Push the LED's long leg into row 5, hole f, and its short leg into row 6, hole f. Both holes are on the same side of the groove down the middle of the board.",
    why: "An LED only passes current one way. Its long leg is the entrance and its short leg the exit, so putting them in two different rows means the current has to travel through the LED to get from row 5 to row 6 rather than around it.",
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
      "Put one leg of the 220Ω resistor into row 6, hole h — the same row as the LED's short leg — and the other leg into any hole on the blue ground rail.",
    why: "The Uno's pin pushes 5V, which is far more than an LED can survive on its own. The resistor sits in the LED's exit path and throttles the current to a safe level. This is why it must exist before the pin is connected in the next step.",
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
      "Run the red jumper wire from the Uno's pin D13 to row 5, hole h — the same row as the LED's long leg.",
    why: "This is the switch the code operates. When the sketch sets D13 high, 5V arrives in row 5, crosses the LED, passes through the resistor and reaches ground: a complete loop, and the LED lights.",
    checkDetail: "The wire lands in row 5 on the same side of the groove as the LED's long leg.",
    parts: ["uno", "wire-red"],
    // Not authoring order: a driven 5V pin wired to an LED that has no series
    // resistor yet can destroy the LED the moment the board gets power. The
    // current limit has to exist before the current source does.
    dependsOn: ["r1"],
    edge: wire("w2", "UNO:D13", "BB:5:h", "jumper (red)"),
  },
  {
    id: "c2",
    index: 5,
    kind: "component",
    title: "Seat the button",
    instruction:
      "Sit the pushbutton so it straddles the groove down the middle of the board, with one pair of legs in row 15 and the other pair in row 17. Press until it clicks flat.",
    why: "The button's job is to join the two sides of the groove when you press it. Its legs are already joined in pairs inside the plastic — the two on the left are one terminal, the two on the right are the other — so straddling the groove is what puts a gap in the circuit for the button to close.",
    checkDetail: "The button sits flat and does not rock. Its legs land on both sides of the groove.",
    parts: ["button", "breadboard"],
    dependsOn: [],
    // The connection the button MAKES is across the groove, row 15 left to row
    // 15 right. The legs in row 17 are the same two terminals seen again.
    edge: component("c2", "BB:15:e", "BB:15:f", "pushbutton"),
  },
  {
    id: "w3",
    index: 6,
    kind: "wire",
    title: "Wire the button to pin 2",
    instruction:
      "Run the yellow jumper wire from the Uno's pin D2 to row 15, hole a — the left-hand side of the row the button sits in.",
    why: "This lets the Uno watch one side of the button. On its own the pin sees nothing useful; the next step gives it something to compare against.",
    checkDetail: "The wire is on the same side of the groove as the button's left legs.",
    parts: ["uno", "wire-yellow"],
    dependsOn: [],
    edge: wire("w3", "UNO:D2", "BB:15:a", "jumper (yellow)"),
  },
  {
    id: "w4",
    index: 7,
    kind: "wire",
    title: "Ground the other side of the button",
    instruction:
      "Run the second black jumper wire from row 15, hole j — the RIGHT-hand side of the button's row, across the groove from the yellow wire — to any hole on the blue ground rail.",
    why: "This is the half that makes the button mean something. Pin D2 holds itself high until something pulls it low; pressing the button joins the left side to this grounded right side, so the pin drops and the code knows you pressed it. Both wires must be on OPPOSITE sides of the groove — put them on the same side and the pin is grounded permanently, so the board behaves as though the button were held down forever.",
    checkDetail:
      "Trace it with a finger: yellow enters the row on the a-e side, black leaves it on the f-j side, and only the button bridges them.",
    parts: ["wire-black", "breadboard"],
    dependsOn: [],
    edge: wire("w4", "BB:15:j", "BB:RAIL:GND", "jumper (black)"),
  },
  {
    id: "power",
    index: 8,
    kind: "power",
    title: "Plug in the USB cable",
    instruction:
      "Connect the Uno to your laptop with the USB cable. The board's power light should come on.",
    why: "The USB cable does two jobs: it powers the board, and it is the road your code travels to reach it. Nothing before this point has any voltage on it, which is why the wiring is safe to rearrange until now.",
    checkDetail: "A small green light on the Uno stays lit.",
    parts: ["usb", "uno"],
    // Everything must be in place before power reaches the circuit.
    dependsOn: ["w1", "c1", "r1", "w2", "c2", "w3", "w4"],
    agentCheckable: true,
  },
  {
    id: "flash",
    index: 9,
    kind: "flash",
    title: "Put the code on the board",
    instruction:
      "Forge wrote this sketch from the pins you wired: D2 for the button, D13 for the LED. Writing it compiles the sketch and sends it to the Uno.",
    why: "The wiring decides what CAN happen; the code decides what DOES. This sketch reads D2 continuously and mirrors it onto D13, which is the behaviour the wiring was built to allow.",
    checkDetail: "The compiler reports how many bytes the sketch uses, with no errors.",
    parts: ["uno", "usb"],
    // The firmware names D2 and D13, so those wires must exist first.
    dependsOn: ["w2", "w3", "power"],
    code: SKETCH,
    pins: ["UNO:D2", "UNO:D13", "UNO:GND"],
    agentCheckable: true,
  },
  {
    id: "verify",
    index: 10,
    kind: "verify",
    title: "Press the button",
    instruction: "Hold the pushbutton down. The LED should light while you hold it.",
    why: "This closes the loop you built: your finger joins the button's two sides, D2 drops to ground, the sketch sees it and drives D13 high, and current runs through the LED and resistor back to the same ground the first wire established.",
    checkDetail: "The LED lights on press and goes dark on release.",
    parts: ["button", "led"],
    dependsOn: ["flash"],
  },
];

/**
 * The circuit in one paragraph, for someone who wants to know why any of this
 * works before following orders about it.
 */
export const CIRCUIT_STORY =
  "Two loops share one ground. The output loop runs from pin D13 through the LED, through the resistor that keeps the current safe, and back to ground. The input loop holds pin D2 high until the button connects it to that same ground. The sketch watches D2 and copies it to D13, so pressing the button lights the LED.";

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
 * The order the UI actually presents steps in: wave by wave, and within a wave
 * the order they are listed.
 *
 * The authoring order in GUIDED_STEPS is not this order. It reads
 * w1, c1, r1, w2, c2… because that is how the circuit was written down, while
 * the waves put c2 in group 1 and r1 in group 2. Walking the authored array to
 * build a before-state therefore showed the resistor as already fitted on a
 * step that comes BEFORE the resistor on screen — a picture that contradicted
 * the list beside it.
 */
export function presentationOrder(steps: readonly GuidedStep[]): GuidedStep[] {
  return computeWaves(steps).flat();
}

/**
 * The circuit BEFORE a step: every edge from steps that come earlier on screen.
 *
 * Dependencies alone are too thin — most steps have none — so "before" means
 * everything earlier in presentation order, which is what a person working
 * down the list would have in front of them.
 */
export function netlistBefore(
  steps: readonly GuidedStep[],
  stepId: string,
): Netlist {
  const edges: NetlistEdge[] = [];
  for (const s of presentationOrder(steps)) {
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
