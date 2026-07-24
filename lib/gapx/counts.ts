// Counting what the camera actually saw. /api/identify returns one detection
// per object, so three jumper wires arrive as three detections — but a single
// detection labelled "jumper wire bundle" is an UNKNOWN count, not one. That
// distinction is the whole point: claiming precision we do not have is worse
// than admitting the ambiguity and asking.
//
// Pure module: type-only project imports so `node --test` can load it.
import type { PartDetection } from "@/lib/types";

export const PART_KINDS = [
  "uno",
  "breadboard",
  "jumpers",
  "led",
  "resistor",
  "button",
  "dht11",
  "usb-cable",
  "sensor",
  "battery",
  "other",
] as const;
export type PartKind = (typeof PART_KINDS)[number];

/** Words that identify a kind. First match wins, so order matters: the more
 *  specific kinds are listed before the general ones. */
const KIND_WORDS: [PartKind, RegExp][] = [
  ["uno", /\b(arduino|uno|mega|nano|duemilanove|atmega|esp32|microcontroller|dev\s*board)\b/i],
  ["breadboard", /\b(breadboard|protoboard|proto\s*board)\b/i],
  ["dht11", /\b(dht\s*-?\s*11|dht\s*-?\s*22|temperature\s+sensor|humidity)\b/i],
  ["jumpers", /\b(jumper|dupont|patch\s*wire|hook-?up\s*wire)\b/i],
  ["usb-cable", /\b(usb|charging\s+cable|micro\s*-?\s*b|type\s*-?\s*c|lightning)\b/i],
  ["resistor", /\b(resistor|ohm|Ω)\b/i],
  ["led", /\b(led|light\s+emitting|lamp\s+diode)\b/i],
  ["button", /\b(button|pushbutton|tactile|switch)\b/i],
  ["sensor", /\b(sensor|pir|motion|ultrasonic|photoresistor|ldr|detector)\b/i],
  ["battery", /\b(battery|power\s*bank|cell|18650|9\s*v)\b/i],
  ["jumpers", /\b(wire|cable|lead)\b/i], // generic fallback, checked last
];

/** Plural or collective wording means the count is a guess, not a fact. */
const BUNDLE_WORDS =
  /\b(bundle|pack|assort|set|kit|bag|several|multiple|various|strip|roll|box\s+of|group)\b/i;

export function kindOf(label: string, partType: string): PartKind {
  const text = `${label} ${partType}`;
  for (const [kind, re] of KIND_WORDS) {
    if (re.test(text)) return kind;
  }
  return "other";
}

/** What we believe about how many of a kind are on the desk. */
export interface CountEstimate {
  kind: PartKind;
  /** Fewest we can defend. */
  min: number;
  /** Most it could plausibly be; equals min when we are sure. */
  max: number;
  /** False when a bundle or occlusion makes the number a guess. */
  certain: boolean;
  /** The detection labels that produced this estimate, for the UI. */
  labels: string[];
}

export type CountMap = Record<string, CountEstimate>;

/**
 * Group detections into kinds and count them. A bundle detection contributes
 * an uncertain range rather than a hard number, because "3 of the 4 wires you
 * need" is only useful advice when the 3 is real.
 */
export function countByKind(detections: readonly PartDetection[]): CountMap {
  const out: CountMap = {};
  for (const d of detections) {
    const kind = kindOf(d.label, d.partType);
    const bundle = BUNDLE_WORDS.test(`${d.label} ${d.partType}`);
    const entry = out[kind] ?? {
      kind,
      min: 0,
      max: 0,
      certain: true,
      labels: [],
    };
    if (bundle) {
      // A bundle is at least a couple and could be many; never claim a number.
      entry.min += 2;
      entry.max += 12;
      entry.certain = false;
    } else {
      entry.min += 1;
      entry.max += 1;
    }
    entry.labels.push(d.label);
    out[kind] = entry;
  }
  return out;
}

export function estimateFor(counts: CountMap, kind: string): CountEstimate {
  return (
    counts[kind] ?? { kind: kind as PartKind, min: 0, max: 0, certain: true, labels: [] }
  );
}

/** "3", or "2 to 12" when the count is a guess. */
export function describeCount(e: CountEstimate): string {
  if (e.min === e.max) return String(e.min);
  return `${e.min} to ${e.max}`;
}
