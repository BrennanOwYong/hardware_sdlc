// Choosing which catalog model an inventory label refers to.
//
// The identify pass returns free text: "Arduino Uno R3 board", "small
// breadboard", "half-size solderless breadboard". This turns that into a
// specific model so the wireframe can draw the right body, and it reports how
// it decided, because a guessed model that draws 63 rows when the desk has 17
// is worse than saying "assumed".
//
// Accuracy of the detector is deliberately not the point yet. The point is
// that the model identity flows through one place, so improving detection
// later changes nothing downstream.
//
// Pure module: type-only project imports so `node --test` can load it.

import type { BreadboardSpec, DeviceSpec } from "./catalog";

export type MatchBasis = "model-name" | "class-default" | "assumed";

export interface DeviceMatch {
  specId: string;
  model: string;
  /** The inventory label that produced this match, or "" when assumed. */
  from: string;
  basis: MatchBasis;
  confidence: number;
  /** Plain sentence for the device card, so the UI never bluffs. */
  why: string;
}

export interface DetectResult {
  matches: DeviceMatch[];
  /** Labels that named no catalog device: LEDs, wires, tools, clutter. */
  unmatched: string[];
}

const TIE_POINT_RE = /\b(170|270|400|830)\b/;

/** Rank breadboards by how strongly a label pins the model down. */
function matchBreadboard(
  label: string,
  specs: readonly BreadboardSpec[],
): { spec: BreadboardSpec; basis: MatchBasis; confidence: number } | null {
  const lower = label.toLowerCase();
  if (!/bread ?board|proto ?board|tie[- ]point/.test(lower)) return null;

  // A tie-point count in the label is the strongest signal there is: it names
  // exactly one geometry.
  const ties = TIE_POINT_RE.exec(lower);
  if (ties) {
    const n = Number(ties[1]);
    const exact = specs.find((s) => s.tiePoints === n);
    if (exact) return { spec: exact, basis: "model-name", confidence: 0.92 };
  }
  for (const spec of specs) {
    if (spec.aka.some((a) => a !== "breadboard" && lower.includes(a))) {
      return { spec, basis: "model-name", confidence: 0.8 };
    }
  }
  if (/\bmini\b|\btiny\b|\bsmall\b/.test(lower)) {
    const mini = specs.find((s) => s.id === "bb-170");
    if (mini) return { spec: mini, basis: "class-default", confidence: 0.5 };
  }
  if (/\bfull[- ]size\b|\blarge\b|\bbig\b/.test(lower)) {
    const full = specs.find((s) => s.id === "bb-830");
    if (full) return { spec: full, basis: "class-default", confidence: 0.55 };
  }
  const half = specs.find((s) => s.id === "bb-400");
  return half ? { spec: half, basis: "class-default", confidence: 0.4 } : null;
}

function matchBoard(
  label: string,
  specs: readonly DeviceSpec[],
): { spec: DeviceSpec; basis: MatchBasis; confidence: number } | null {
  const lower = label.toLowerCase();
  let best: { spec: DeviceSpec; confidence: number } | null = null;
  for (const spec of specs) {
    if (spec.kind !== "board") continue;
    for (const alias of spec.aka) {
      if (!lower.includes(alias)) continue;
      // A longer alias is a more specific claim: "uno r3" beats "uno".
      const confidence = Math.min(0.95, 0.6 + alias.length * 0.03);
      if (!best || confidence > best.confidence) best = { spec, confidence };
    }
  }
  return best ? { ...best, basis: "model-name" as const } : null;
}

function whyFor(match: Omit<DeviceMatch, "why">, spec: DeviceSpec): string {
  if (match.basis === "assumed") {
    return `Nothing in the photo named a ${spec.kind === "breadboard" ? "breadboard" : "board"}, so the wireframe assumes a ${spec.model}. Swap it from the palette if that is wrong.`;
  }
  if (match.basis === "class-default") {
    return `"${match.from}" says breadboard but not which one; drawn as a ${spec.model}. Pick the exact model from the palette to make the row count match your desk.`;
  }
  return `"${match.from}" names this model directly.`;
}

/**
 * Devices to draw for a project, given the labels its inventory produced.
 *
 * Exactly one board and one breadboard survive: two Unos in frame is far more
 * often one Uno seen twice than a two-board build, and a wireframe that
 * silently doubles a part teaches the wrong circuit.
 */
export function detectDevices(
  labels: readonly string[],
  catalog: readonly DeviceSpec[],
): DetectResult {
  const breadboardSpecs = catalog.filter(
    (s): s is BreadboardSpec => s.kind === "breadboard",
  );
  const matches: DeviceMatch[] = [];
  const unmatched: string[] = [];

  let bestBoard: DeviceMatch | null = null;
  let bestBoard2: DeviceMatch | null = null;

  for (const label of labels) {
    const board = matchBoard(label, catalog);
    if (board) {
      const m: DeviceMatch = {
        specId: board.spec.id,
        model: board.spec.model,
        from: label,
        basis: board.basis,
        confidence: board.confidence,
        why: "",
      };
      m.why = whyFor(m, board.spec);
      if (!bestBoard || m.confidence > bestBoard.confidence) bestBoard = m;
      continue;
    }
    const bb = matchBreadboard(label, breadboardSpecs);
    if (bb) {
      const m: DeviceMatch = {
        specId: bb.spec.id,
        model: bb.spec.model,
        from: label,
        basis: bb.basis,
        confidence: bb.confidence,
        why: "",
      };
      m.why = whyFor(m, bb.spec);
      if (!bestBoard2 || m.confidence > bestBoard2.confidence) bestBoard2 = m;
      continue;
    }
    unmatched.push(label);
  }

  if (bestBoard2) matches.push(bestBoard2);
  if (bestBoard) matches.push(bestBoard);
  return { matches, unmatched };
}

/**
 * The same thing, but never empty: a build needs something to be drawn on.
 * The fallbacks are labelled "assumed" so the card says so out loud.
 */
export function detectDevicesOrDefault(
  labels: readonly string[],
  catalog: readonly DeviceSpec[],
  defaults: { breadboardId: string; boardId: string },
): DetectResult {
  const found = detectDevices(labels, catalog);
  const has = (kind: string) =>
    found.matches.some(
      (m) => catalog.find((s) => s.id === m.specId)?.kind === kind,
    );

  const filled = [...found.matches];
  if (!has("breadboard")) {
    const spec = catalog.find((s) => s.id === defaults.breadboardId);
    if (spec) {
      const m: DeviceMatch = {
        specId: spec.id,
        model: spec.model,
        from: "",
        basis: "assumed",
        confidence: 0.2,
        why: "",
      };
      m.why = whyFor(m, spec);
      filled.unshift(m);
    }
  }
  if (!has("board")) {
    const spec = catalog.find((s) => s.id === defaults.boardId);
    if (spec) {
      const m: DeviceMatch = {
        specId: spec.id,
        model: spec.model,
        from: "",
        basis: "assumed",
        confidence: 0.2,
        why: "",
      };
      m.why = whyFor(m, spec);
      filled.push(m);
    }
  }
  return { matches: filled, unmatched: found.unmatched };
}
