// Commit-state diagram selectors (FEEDBACK 14): pure functions that turn a
// commit's netlist (optionally diffed against another) into a drawable edge
// list with exact hole coordinates, plus the pins line for the firmware badge.
//
// This module is import-free at runtime (type-only imports) so that
// tests/diagram.test.mjs can load it under plain `node --test` with Node's
// native type stripping. That constraint is why:
//   - the coordinate mapper is injected (an XYResolver, in practice refToXY
//     from lib/assembly/circuits.ts) instead of imported — a runtime import
//     would need an extension Node accepts and tsc rejects, and
//   - edgeKey duplicates the identity rule of lib/vcs/diff.ts: two edges are
//     the same physical connection when kind, from, to and part match; edge
//     ids are per-commit bookkeeping and are ignored on purpose.

import type { Netlist, NetlistEdge, TargetRef } from "@/lib/types";

/** Maps a canonical ref to normalized 0..1 board coords; null when unknown. */
export type XYResolver = (ref: TargetRef) => { x: number; y: number } | null;

/**
 * Diff status of an edge. Without diffAgainst everything is "neutral"; with
 * it, edges only in the netlist are "added" (drawn green), edges only in
 * diffAgainst are "removed" (drawn red dashed), shared edges stay "neutral".
 */
export type EdgeStatus = "added" | "removed" | "neutral";

export interface DrawableEdge {
  edge: NetlistEdge;
  status: EdgeStatus;
  /** Normalized 0..1 endpoint coordinates (exact holes via the resolver). */
  from: { x: number; y: number };
  to: { x: number; y: number };
}

function edgeKey(e: NetlistEdge): string {
  return [e.kind, e.from, e.to, e.part ?? ""].join("|");
}

/**
 * Every edge to draw with its diff status. Order: the netlist's own edges
 * first (in netlist order), then edges only present in diffAgainst (removed),
 * so removed wiring paints on top of nothing it would occlude.
 */
export function classifyEdges(
  netlist: Netlist,
  diffAgainst?: Netlist,
): { edge: NetlistEdge; status: EdgeStatus }[] {
  if (!diffAgainst) {
    return netlist.edges.map((edge) => ({ edge, status: "neutral" as const }));
  }
  const otherKeys = new Set(diffAgainst.edges.map(edgeKey));
  const ownKeys = new Set(netlist.edges.map(edgeKey));
  const own = netlist.edges.map((edge) => ({
    edge,
    status: otherKeys.has(edgeKey(edge)) ? ("neutral" as const) : ("added" as const),
  }));
  const removed = diffAgainst.edges
    .filter((edge) => !ownKeys.has(edgeKey(edge)))
    .map((edge) => ({ edge, status: "removed" as const }));
  return [...own, ...removed];
}

/**
 * Drawable edges with exact hole coordinates. Edges whose endpoints the
 * resolver cannot place (unknown refs) are dropped rather than guessed.
 */
export function drawableEdges(
  netlist: Netlist,
  resolve: XYResolver,
  diffAgainst?: Netlist,
): DrawableEdge[] {
  const out: DrawableEdge[] = [];
  for (const { edge, status } of classifyEdges(netlist, diffAgainst)) {
    const from = resolve(edge.from);
    const to = resolve(edge.to);
    if (!from || !to) continue;
    out.push({ edge, status, from, to });
  }
  return out;
}

const D_PIN_RE = /^UNO:D(\d{1,2})$/;

/**
 * Every UNO pin the netlist touches, D-pins first in ascending numeric
 * order, then the rest alphabetically — the pins line of the firmware badge.
 * Mirrors sortUnoRefs in lib/codegen/template.ts (not imported: that module
 * pulls node:crypto, which a client component must not bundle).
 */
export function pinsUsedFromNetlist(netlist: Netlist): string[] {
  const refs = new Set<string>();
  for (const edge of netlist.edges) {
    for (const ref of [edge.from, edge.to]) {
      if (ref.startsWith("UNO:")) refs.add(ref);
    }
  }
  return [...refs].sort((a, b) => {
    const ma = D_PIN_RE.exec(a);
    const mb = D_PIN_RE.exec(b);
    if (ma && mb) return Number(ma[1]) - Number(mb[1]);
    if (ma) return -1;
    if (mb) return 1;
    return a.localeCompare(b);
  });
}
