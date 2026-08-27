// Laying out the commit tree, and working out what it costs to move between
// any two points on it.
//
// A flat newest-first list hides the thing that makes forking interesting: two
// branches that share a past and then diverge. You cannot see where they split,
// and you certainly cannot see what it would take to get from the board on
// your desk to the board on the other branch.
//
// So this module does two jobs:
//   1. Assign every commit a (lane, row) so the tree can be drawn with edges
//      that visibly rejoin at the fork point.
//   2. Compute the REAL cost of moving between two commits: walk to the common
//      ancestor, undo what happened on the way down, redo what happened on the
//      way up, cancel out anything that appears on both sides, and say whether
//      the firmware has to be rewritten as well.
//
// Pure module: type-only project imports so `node --test` can load it.

import type { BuildCommit, Netlist, NetlistEdge } from "../types";

/** Same identity rule as lib/vcs/diff.ts: ids are per-commit bookkeeping. */
function edgeKey(e: NetlistEdge): string {
  return [e.kind, e.from, e.to, e.part ?? ""].join("|");
}

export interface TreeNode {
  commit: BuildCommit;
  /** Column. Lane 0 is the trunk; each divergence takes the next free lane. */
  lane: number;
  /** Row from the root down, so a child always sits below its parent. */
  row: number;
  childIds: string[];
  /** True when this commit has more than one child: the split point. */
  isFork: boolean;
  /** Latest commit on its branch — the state that branch is "at". */
  isBranchTip: boolean;
}

export interface TreeEdge {
  fromId: string;
  toId: string;
  /** Set when the child starts a new lane, so the drawing can bend the line. */
  diverges: boolean;
}

export interface CommitTree {
  nodes: TreeNode[];
  edges: TreeEdge[];
  laneCount: number;
  rowCount: number;
  byId: Map<string, TreeNode>;
}

/**
 * Build the drawable tree.
 *
 * Depth-first from each root, keeping a child on its parent's lane where it
 * can and taking a fresh lane where it cannot. Depth-first matters: it keeps a
 * branch's commits vertically contiguous, so a lane reads as one line of work
 * rather than interleaved fragments of several.
 */
export function buildTree(commits: readonly BuildCommit[]): CommitTree {
  const byIdCommit = new Map(commits.map((c) => [c.id, c]));
  const kids = new Map<string, string[]>();
  for (const c of commits) {
    if (c.parent === null || !byIdCommit.has(c.parent)) continue;
    const list = kids.get(c.parent) ?? [];
    list.push(c.id);
    kids.set(c.parent, list);
  }

  const roots = commits.filter((c) => c.parent === null || !byIdCommit.has(c.parent));
  const nodes: TreeNode[] = [];
  const edges: TreeEdge[] = [];
  const placed = new Set<string>();
  let row = 0;
  let nextLane = 0;

  const walk = (id: string, lane: number) => {
    const commit = byIdCommit.get(id);
    if (!commit || placed.has(id)) return;
    placed.add(id);
    const childIds = kids.get(id) ?? [];
    nodes.push({
      commit,
      lane,
      row: row++,
      childIds,
      isFork: childIds.length > 1,
      isBranchTip: false,
    });
    nextLane = Math.max(nextLane, lane + 1);

    childIds.forEach((childId, i) => {
      // The first child continues the line; later children are the fork, and
      // each one earns a lane of its own so the split is visible rather than
      // implied by a label.
      const childLane = i === 0 ? lane : nextLane;
      if (i > 0) nextLane += 1;
      edges.push({ fromId: id, toId: childId, diverges: i > 0 });
      walk(childId, childLane);
    });
  };

  for (const root of roots) walk(root.id, nextLane);

  // Orphans: a commit whose parent is missing from this set still deserves to
  // be drawn rather than silently dropped.
  for (const c of commits) {
    if (placed.has(c.id)) continue;
    nodes.push({
      commit: c,
      lane: nextLane++,
      row: row++,
      childIds: [],
      isFork: false,
      isBranchTip: false,
    });
  }

  // Branch tips: the last commit reached on each branch label.
  const lastOnBranch = new Map<string, string>();
  for (const n of nodes) lastOnBranch.set(n.commit.branch, n.commit.id);
  for (const n of nodes) {
    n.isBranchTip = lastOnBranch.get(n.commit.branch) === n.commit.id;
  }

  const byId = new Map(nodes.map((n) => [n.commit.id, n]));
  return { nodes, edges, laneCount: Math.max(1, nextLane), rowCount: row, byId };
}

/** Root-to-commit path, oldest first. */
export function ancestry(
  commits: readonly BuildCommit[],
  id: string,
): BuildCommit[] {
  const byId = new Map(commits.map((c) => [c.id, c]));
  const path: BuildCommit[] = [];
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return path;
}

/**
 * Where two commits last agreed. Null when they share no history at all,
 * which is a real case (two independent roots) and not an error.
 */
export function commonAncestor(
  commits: readonly BuildCommit[],
  a: string,
  b: string,
): BuildCommit | null {
  const pathA = ancestry(commits, a);
  const idsB = new Set(ancestry(commits, b).map((c) => c.id));
  for (let i = pathA.length - 1; i >= 0; i -= 1) {
    const c = pathA[i];
    if (c && idsB.has(c.id)) return c;
  }
  return null;
}

export interface SwitchOp {
  op: "remove" | "add";
  edge: NetlistEdge;
  /** Which commit introduced (or removed) this, for "why am I doing this". */
  fromCommitId: string;
}

export interface SwitchCost {
  /** The fork point the two paths share, when they have one. */
  base: BuildCommit | null;
  /** Commits walked backwards, newest first: the work being undone. */
  down: BuildCommit[];
  /** Commits walked forwards, oldest first: the work being redone. */
  up: BuildCommit[];
  /** Physical steps, removals before additions. */
  ops: SwitchOp[];
  /** True when the target runs different code, so wiring alone is not enough. */
  firmwareChanges: boolean;
  targetFirmwareHash: string;
  /**
   * Connections present on BOTH sides that a naive undo-then-redo would pull
   * out and push straight back in. Counted so the UI can say what it saved.
   */
  untouched: number;
}

/**
 * What it takes to get from the board you have to the board on another branch.
 *
 * Deliberately NOT "undo everything back to the fork, then rebuild". That is
 * correct and wasteful: most of the wiring is identical on both sides, and
 * telling someone to unplug a ground wire only to plug it back in three steps
 * later is how a tool loses trust. The op list is the net difference between
 * the two end states; the down/up commit lists are kept so the UI can still
 * explain the route.
 */
export function switchCost(
  commits: readonly BuildCommit[],
  fromId: string,
  toId: string,
): SwitchCost {
  const byId = new Map(commits.map((c) => [c.id, c]));
  const from = byId.get(fromId);
  const to = byId.get(toId);
  const base = commonAncestor(commits, fromId, toId);

  const after = (id: string) => {
    const path = ancestry(commits, id);
    const cut = base ? path.findIndex((c) => c.id === base.id) + 1 : 0;
    return path.slice(cut);
  };

  const down = from ? [...after(fromId)].reverse() : [];
  const up = to ? after(toId) : [];

  const current: Netlist = from?.netlist ?? { edges: [] };
  const target: Netlist = to?.netlist ?? { edges: [] };
  const currentKeys = new Set(current.edges.map(edgeKey));
  const targetKeys = new Set(target.edges.map(edgeKey));

  // Who introduced each edge, so a step can say which commit it belongs to.
  const origin = new Map<string, string>();
  for (const c of commits) {
    for (const e of c.netlist.edges) {
      if (!origin.has(edgeKey(e))) origin.set(edgeKey(e), c.id);
    }
  }

  const removals: SwitchOp[] = [...current.edges]
    .filter((e) => !targetKeys.has(edgeKey(e)))
    .reverse()
    .map((edge) => ({
      op: "remove" as const,
      edge,
      fromCommitId: origin.get(edgeKey(edge)) ?? fromId,
    }));

  const additions: SwitchOp[] = target.edges
    .filter((e) => !currentKeys.has(edgeKey(e)))
    .map((edge) => ({
      op: "add" as const,
      edge,
      fromCommitId: origin.get(edgeKey(edge)) ?? toId,
    }));

  const untouched = current.edges.filter((e) => targetKeys.has(edgeKey(e))).length;

  return {
    base,
    down,
    up,
    ops: [...removals, ...additions],
    firmwareChanges: (from?.firmware.hash ?? "") !== (to?.firmware.hash ?? ""),
    targetFirmwareHash: to?.firmware.hash ?? "",
    untouched,
  };
}

/** One line describing the route, before any step detail. */
export function routeSummary(cost: SwitchCost): string {
  const removals = cost.ops.filter((o) => o.op === "remove").length;
  const additions = cost.ops.filter((o) => o.op === "add").length;
  const parts: string[] = [];
  if (removals > 0) parts.push(`unplug ${removals}`);
  if (additions > 0) parts.push(`add ${additions}`);
  const wiring =
    parts.length === 0
      ? "The wiring is already identical"
      : `${parts.join(", ")} connection${removals + additions === 1 ? "" : "s"}`;
  const kept =
    cost.untouched > 0 && parts.length > 0
      ? `, leaving ${cost.untouched} in place`
      : "";
  const code = cost.firmwareChanges
    ? ", then put the other version of the code on the board"
    : ". The code is the same on both, so nothing to re-send";
  return `${wiring}${kept}${code}.`;
}
