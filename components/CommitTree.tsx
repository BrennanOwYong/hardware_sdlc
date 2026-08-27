"use client";

// The commit tree, drawn.
//
// A newest-first list can tell you a fork exists, in words, in a badge. It
// cannot show you WHERE two branches split or how far apart they have drifted
// since, and those are the two questions a fork raises. So the history is a
// graph: lanes for branches, a visible bend at the split, and the two commits
// you are comparing marked as the ends of a route.
//
// Geometry is deliberately dull — fixed row height, fixed lane width — because
// the interesting part is which node sits in which lane, and that is decided
// in lib/vcs/graph.ts where it can be tested.

import type { CommitTree, TreeNode } from "@/lib/vcs/graph";

const ROW_H = 46;
const LANE_W = 30;
const PAD_X = 14;
const PAD_Y = 16;
const LABEL_X = 12;

const ACCENT = "#22c55e";
const WARN = "#f59e0b";
const MUTED = "#8b98a5";
const BORDER = "#22303d";

/** One colour per lane, so a branch reads as a continuous line of work. */
const LANE_COLOURS = ["#22c55e", "#38bdf8", "#a78bfa", "#f59e0b", "#ec4899", "#14b8a6"];

function laneColour(lane: number): string {
  return LANE_COLOURS[lane % LANE_COLOURS.length] ?? MUTED;
}

function nodeXY(n: TreeNode): { x: number; y: number } {
  return { x: PAD_X + n.lane * LANE_W, y: PAD_Y + n.row * ROW_H };
}

export interface CommitTreeProps {
  tree: CommitTree;
  selectedId: string | null;
  /** The other end of the comparison, drawn as the route's start. */
  compareId: string | null;
  onSelect: (id: string) => void;
  onCompare: (id: string) => void;
  /** Commit ids on the route between the two, highlighted along the way. */
  routeIds?: readonly string[];
}

export default function CommitTree({
  tree,
  selectedId,
  compareId,
  onSelect,
  onCompare,
  routeIds = [],
}: CommitTreeProps) {
  const width = PAD_X * 2 + Math.max(0, tree.laneCount - 1) * LANE_W + LABEL_X;
  const height = PAD_Y * 2 + Math.max(0, tree.rowCount - 1) * ROW_H;
  const onRoute = new Set(routeIds);

  return (
    <div className="fg-tree">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Commit tree: each lane is a branch, and a bend is a fork"
        style={{ flexShrink: 0 }}
      >
        {tree.edges.map((e) => {
          const a = tree.byId.get(e.fromId);
          const b = tree.byId.get(e.toId);
          if (!a || !b) return null;
          const p = nodeXY(a);
          const q = nodeXY(b);
          const colour = laneColour(b.lane);
          const lit = onRoute.has(e.fromId) && onRoute.has(e.toId);
          // A diverging child bends out of its parent's lane, which is what
          // makes the fork visible instead of implied by a branch label.
          const d = e.diverges
            ? `M ${p.x} ${p.y} C ${p.x} ${p.y + ROW_H * 0.55}, ${q.x} ${q.y - ROW_H * 0.55}, ${q.x} ${q.y}`
            : `M ${p.x} ${p.y} L ${q.x} ${q.y}`;
          return (
            <path
              key={`${e.fromId}-${e.toId}`}
              d={d}
              fill="none"
              stroke={colour}
              strokeWidth={lit ? 3 : 1.6}
              opacity={lit ? 1 : 0.55}
            />
          );
        })}

        {tree.nodes.map((n) => {
          const { x, y } = nodeXY(n);
          const isSel = n.commit.id === selectedId;
          const isCmp = n.commit.id === compareId;
          const colour = laneColour(n.lane);
          return (
            <g key={n.commit.id}>
              {onRoute.has(n.commit.id) ? (
                <circle cx={x} cy={y} r={9} fill={colour} opacity={0.18} />
              ) : null}
              {/* A fork gets a ring, so the split point is findable without
                  reading every label down the column. */}
              {n.isFork ? (
                <circle cx={x} cy={y} r={8} fill="none" stroke={colour} strokeWidth={1.2} opacity={0.8} />
              ) : null}
              <circle
                cx={x}
                cy={y}
                r={isSel ? 6 : 4.5}
                fill={isSel ? colour : "#0b1119"}
                stroke={colour}
                strokeWidth={2}
              />
              {isCmp ? (
                <circle cx={x} cy={y} r={9.5} fill="none" stroke={WARN} strokeWidth={1.6} />
              ) : null}
            </g>
          );
        })}
      </svg>

      <ol className="fg-tree-list" style={{ paddingTop: PAD_Y - 14 }}>
        {tree.nodes.map((n) => {
          const isSel = n.commit.id === selectedId;
          const isCmp = n.commit.id === compareId;
          return (
            <li
              key={n.commit.id}
              style={{ height: ROW_H }}
              className={isSel ? "is-selected" : isCmp ? "is-compare" : ""}
            >
              <button type="button" onClick={() => onSelect(n.commit.id)}>
                <span className="fg-tree-msg">{n.commit.message}</span>
                <span className="fg-tree-meta">
                  <span style={{ color: laneColour(n.lane) }}>{n.commit.branch}</span>
                  {n.isBranchTip ? <span className="fg-tip">tip</span> : null}
                  {n.isFork ? <span className="fg-fork">forked here</span> : null}
                  <code>{n.commit.id.slice(0, 8)}</code>
                </span>
              </button>
              {!isSel ? (
                <button
                  type="button"
                  className="fg-tree-cmp"
                  onClick={() => onCompare(n.commit.id)}
                  title="Show what it takes to get from here to the selected commit"
                >
                  {isCmp ? "✓ from here" : "from here"}
                </button>
              ) : (
                <span className="fg-tree-cmp is-here">you are viewing this</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export { LANE_COLOURS, laneColour, ROW_H, BORDER, ACCENT };
