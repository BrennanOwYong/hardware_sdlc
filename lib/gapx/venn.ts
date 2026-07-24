// The venn: what the build needs, what the desk has, and the overlap. The
// case that matters is the near miss — four wires needed, three on the desk —
// which a boolean "do you have jumper wires?" check reports as satisfied.
//
// Pure module: type-only project imports so `node --test` can load it.
import type { CountMap, CountEstimate } from "@/lib/gapx/counts";

/** One line of the bill of materials the model produced for this build. */
export interface RequiredPart {
  kind: string;
  name: string;
  qty: number;
  why: string;
  critical?: boolean;
}

export interface SatisfiedRow {
  kind: string;
  name: string;
  need: number;
  have: number;
}

export interface ShortRow {
  kind: string;
  name: string;
  need: number;
  have: number;
  shortfall: number;
  why: string;
  critical: boolean;
}

export interface UnknownRow {
  kind: string;
  name: string;
  need: number;
  estimate: CountEstimate;
  question: string;
}

export interface SurplusRow {
  kind: string;
  have: number;
  labels: string[];
}

export interface VennResult {
  satisfied: SatisfiedRow[];
  short: ShortRow[];
  unknown: UnknownRow[];
  surplus: SurplusRow[];
  /** Every required part lands in exactly one of satisfied/short/unknown. */
  totalRequired: number;
}

/**
 * Partition the bill of materials against what the camera counted.
 *
 * A required kind lands in exactly one bucket:
 *   satisfied - we can defend having enough
 *   short     - we can defend NOT having enough, with the missing number
 *   unknown   - the count is a guess (a bundle), so we ask instead of assuming
 */
export function computeVenn(
  required: readonly RequiredPart[],
  counts: CountMap,
): VennResult {
  const satisfied: SatisfiedRow[] = [];
  const short: ShortRow[] = [];
  const unknown: UnknownRow[] = [];
  const usedKinds = new Set<string>();

  for (const req of required) {
    usedKinds.add(req.kind);
    const e: CountEstimate = counts[req.kind] ?? {
      kind: req.kind as CountEstimate["kind"],
      min: 0,
      max: 0,
      certain: true,
      labels: [],
    };

    if (!e.certain && e.max >= req.qty && e.min < req.qty) {
      // Could be enough, could not be. Ask rather than guess either way.
      unknown.push({
        kind: req.kind,
        name: req.name,
        need: req.qty,
        estimate: e,
        question: `You need ${req.qty} ${req.name.toLowerCase()}. I can see a bundle but cannot count them — do you have ${req.qty} or more?`,
      });
      continue;
    }

    const have = e.min;
    if (have >= req.qty) {
      satisfied.push({ kind: req.kind, name: req.name, need: req.qty, have });
    } else {
      short.push({
        kind: req.kind,
        name: req.name,
        need: req.qty,
        have,
        shortfall: req.qty - have,
        why: req.why,
        critical: req.critical !== false,
      });
    }
  }

  // What the desk holds that this build has no use for.
  const surplus: SurplusRow[] = Object.values(counts)
    .filter((e) => !usedKinds.has(e.kind) && e.min > 0)
    .map((e) => ({ kind: e.kind, have: e.min, labels: e.labels }));

  return {
    satisfied,
    short,
    unknown,
    surplus,
    totalRequired: required.length,
  };
}

/** One plain sentence summarising the venn, for the panel header. */
export function summariseVenn(v: VennResult): string {
  if (v.totalRequired === 0) return "Nothing planned yet.";
  if (v.short.length === 0 && v.unknown.length === 0) {
    return `You have everything: all ${v.totalRequired} parts are on the desk.`;
  }
  const bits: string[] = [];
  if (v.satisfied.length > 0) {
    bits.push(`${v.satisfied.length} of ${v.totalRequired} covered`);
  }
  const missingUnits = v.short.reduce((n, s) => n + s.shortfall, 0);
  if (missingUnits > 0) {
    bits.push(
      `${missingUnits} item${missingUnits === 1 ? "" : "s"} to get across ${v.short.length} part${v.short.length === 1 ? "" : "s"}`,
    );
  }
  if (v.unknown.length > 0) {
    bits.push(`${v.unknown.length} to confirm by hand`);
  }
  return bits.join(", ") + ".";
}

/** "jumper wires: need 4, saw 3, get 1 more" — the line the user asked for. */
export function describeShortfall(s: ShortRow): string {
  return `${s.name}: need ${s.need}, saw ${s.have}, get ${s.shortfall} more`;
}
