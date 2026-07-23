// P3 git-for-hardware: pure netlist diff / rollback planning / DAG helpers.
// Client-safe: imports types only, no node builtins. The commit store lives in
// ./store.ts (server-only). Docs relied on: see docs/references-p3.md.

import type { BuildCommit, Netlist, NetlistDiff, NetlistEdge } from "../types";

/**
 * Identity key for an edge. Two edges are "the same physical connection" when
 * kind, from, to and part match; edge ids are per-commit bookkeeping and are
 * ignored on purpose.
 */
export function edgeKey(e: NetlistEdge): string {
  return [e.kind, e.from, e.to, e.part ?? ""].join("|");
}

/** Human-readable one-liner for an edge, e.g. "wire UNO:D2 -> BB:15:a". */
export function describeEdge(e: NetlistEdge): string {
  if (e.kind === "wire") {
    return `wire ${e.from} -> ${e.to}`;
  }
  const name = e.part ?? "component";
  const value = e.value ? ` (${e.value})` : "";
  return `${name}${value} ${e.from} -> ${e.to}`;
}

/**
 * Edges present in b but not a (added) and present in a but not b (removed),
 * keyed on (kind, from, to, part).
 */
export function diff(a: Netlist, b: Netlist): NetlistDiff {
  const aKeys = new Set(a.edges.map(edgeKey));
  const bKeys = new Set(b.edges.map(edgeKey));
  return {
    added: b.edges.filter((e) => !aKeys.has(edgeKey(e))),
    removed: a.edges.filter((e) => !bKeys.has(edgeKey(e))),
  };
}

export interface RollbackOp {
  op: "remove" | "add";
  edge: NetlistEdge;
  instruction: string;
}

function removeInstruction(e: NetlistEdge): string {
  if (e.kind === "wire") {
    return `pull the wire ${e.from} -> ${e.to}`;
  }
  return `remove the ${e.part ?? "component"} between ${e.from} and ${e.to}`;
}

function addInstruction(e: NetlistEdge): string {
  if (e.kind === "wire") {
    return `connect a wire ${e.from} -> ${e.to}`;
  }
  const value = e.value ? ` (${e.value})` : "";
  return `place the ${e.part ?? "component"}${value} between ${e.from} and ${e.to}`;
}

/**
 * Ordered physical steps that turn `current` into `target`.
 * Removals come first, in reverse build order (the edge placed last is pulled
 * first); additions follow in build order. Re-flashing firmware is the
 * caller's final step and is not an edge op.
 */
export function rollbackPlan(current: Netlist, target: Netlist): RollbackOp[] {
  const d = diff(target, current);
  // d.added   = edges only in `current`  -> must be removed
  // d.removed = edges only in `target`   -> must be added back
  const removals: RollbackOp[] = [...d.added]
    .reverse()
    .map((edge) => ({ op: "remove" as const, edge, instruction: removeInstruction(edge) }));
  const additions: RollbackOp[] = d.removed.map((edge) => ({
    op: "add" as const,
    edge,
    instruction: addInstruction(edge),
  }));
  return [...removals, ...additions];
}

// ---------------------------------------------------------------------------
// DAG helpers (commits form a tree: parent pointer + branch label)
// ---------------------------------------------------------------------------

/** Direct children of a commit. */
export function children(commits: BuildCommit[], id: string): BuildCommit[] {
  return commits.filter((c) => c.parent === id);
}

/** Branch labels in order of first appearance. */
export function branches(commits: BuildCommit[]): string[] {
  const seen: string[] = [];
  for (const c of commits) {
    if (!seen.includes(c.branch)) {
      seen.push(c.branch);
    }
  }
  return seen;
}

/** Latest commit on a branch (commits arrive in creation order). */
export function headOf(commits: BuildCommit[], branch: string): BuildCommit | undefined {
  for (let i = commits.length - 1; i >= 0; i -= 1) {
    const c = commits[i];
    if (c && c.branch === branch) {
      return c;
    }
  }
  return undefined;
}
