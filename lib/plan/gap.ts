// Gap analysis: which planned parts does the bench photo already show?
// Pure and node-testable, so cross-file project imports stay type-only.
import type { PartDetection } from "@/lib/types";
import type { PlannedPart } from "@/lib/plan/contract";

/** Words that carry no identifying weight when matching a part name. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "for",
  "with",
  "and",
  "kit",
  "pack",
  "assorted",
  "premium",
  "module",
  "board",
  "sized",
  "size",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .map((t) => t.replace(/s$/, "")) // crude singularization: wires -> wire
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Aliases let "jumper wire" match a detection labelled "dupont cable". */
const ALIASES: Record<string, string[]> = {
  uno: ["arduino", "uno", "microcontroller", "duemilanove", "atmega"],
  breadboard: ["breadboard", "protoboard"],
  jumpers: ["jumper", "wire", "dupont", "lead"],
  led: ["led", "diode", "lamp"],
  resistor: ["resistor", "ohm"],
  button: ["button", "pushbutton", "switch", "tactile"],
  dht11: ["dht11", "dht", "temperature", "humidity", "sensor"],
  "usb-cable": ["usb", "cable", "cord"],
};

function aliasTokens(part: PlannedPart): string[] {
  const base = tokenize(part.name);
  const extra = part.partKey ? (ALIASES[part.partKey] ?? []) : [];
  return [...new Set([...base, ...extra])];
}

/**
 * Score 0..1 for "this detection is that planned part". Any shared meaningful
 * token counts; the score rises with how much of the part name is covered.
 */
export function matchScore(part: PlannedPart, detection: PartDetection): number {
  const wanted = aliasTokens(part);
  if (wanted.length === 0) return 0;
  const seen = new Set([
    ...tokenize(detection.label),
    ...tokenize(detection.partType),
  ]);
  const hits = wanted.filter((t) => seen.has(t)).length;
  if (hits === 0) return 0;
  return Math.min(1, hits / Math.min(wanted.length, 3));
}

export interface GapRow {
  part: PlannedPart;
  owned: boolean;
  matchedLabel: string | null;
  score: number;
}

export interface GapResult {
  have: GapRow[];
  missing: GapRow[];
}

export const MATCH_THRESHOLD = 0.5;

/**
 * Split a parts plan against what the bench photo actually showed. An empty
 * detection list (the empty-desk demo beat) puts every part in `missing`.
 */
export function analyzeGap(
  parts: PlannedPart[],
  detections: PartDetection[],
  acquired: string[] = [],
): GapResult {
  const acquiredSet = new Set(acquired);
  const have: GapRow[] = [];
  const missing: GapRow[] = [];

  for (const part of parts) {
    let best: { score: number; label: string } | null = null;
    for (const d of detections) {
      const score = matchScore(part, d);
      if (score > 0 && (!best || score > best.score)) {
        best = { score, label: d.label };
      }
    }
    const matchedByPhoto = best !== null && best.score >= MATCH_THRESHOLD;
    const matchedByAcquisition = acquiredSet.has(part.name);
    const row: GapRow = {
      part,
      owned: matchedByPhoto || matchedByAcquisition,
      matchedLabel: matchedByPhoto ? (best?.label ?? null) : null,
      score: best?.score ?? 0,
    };
    (row.owned ? have : missing).push(row);
  }

  return { have, missing };
}

/** Listings for one planned part, best-effort by partKey then by name token. */
export function listingsFor<T extends { partKey: string; title: string }>(
  part: PlannedPart,
  listings: T[],
): T[] {
  if (part.partKey) {
    const byKey = listings.filter((l) => l.partKey === part.partKey);
    if (byKey.length > 0) return byKey;
  }
  const wanted = aliasTokens(part);
  return listings.filter((l) => {
    const seen = new Set(tokenize(l.title));
    return wanted.some((t) => seen.has(t));
  });
}
