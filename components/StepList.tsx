"use client";

// Progress rail for the guided assembly: one row per step with a status
// glyph. Seated steps show a green check, the current step shows its phase
// color, later steps stay muted.

import type { AssemblyStep, StepPhase } from "@/lib/types";

export interface StepListProps {
  steps: AssemblyStep[];
  currentIndex: number;
  phase: StepPhase;
  seatedIds: string[];
}

function rowState(
  index: number,
  currentIndex: number,
  phase: StepPhase,
  isSeated: boolean,
): { glyph: string; color: string } {
  if (isSeated || index < currentIndex) return { glyph: "✓", color: "#22c55e" };
  if (index > currentIndex) return { glyph: "○", color: "#8b98a5" };
  if (phase === "error") return { glyph: "✕", color: "#ef4444" };
  if (phase === "tip-on-target") return { glyph: "●", color: "#22c55e" };
  return { glyph: "●", color: "#f59e0b" };
}

function shortLabel(step: AssemblyStep): string {
  const { edge } = step;
  const what = edge.kind === "wire" ? "Wire" : (edge.part ?? "Part");
  const value = edge.value ? ` ${edge.value}` : "";
  return `${what}${value}: ${edge.from} → ${edge.to}`;
}

export default function StepList({
  steps,
  currentIndex,
  phase,
  seatedIds,
}: StepListProps) {
  return (
    <div className="card" style={{ padding: "0.75rem" }}>
      <h2 style={{ fontSize: "0.95rem" }}>Build steps</h2>
      <ol style={{ listStyle: "none" }}>
        {steps.map((step) => {
          const isSeated = seatedIds.includes(step.edge.id);
          const { glyph, color } = rowState(
            step.index,
            currentIndex,
            phase,
            isSeated,
          );
          const isCurrent = step.index === currentIndex;
          return (
            <li
              key={step.id}
              style={{
                display: "flex",
                gap: "0.6rem",
                alignItems: "baseline",
                padding: "0.3rem 0.2rem",
                borderRadius: 6,
                background: isCurrent ? "rgba(34,197,94,0.06)" : "transparent",
              }}
            >
              <span
                aria-hidden
                style={{ color, width: "1.1rem", textAlign: "center" }}
              >
                {glyph}
              </span>
              <span style={{ flex: 1 }}>
                <span
                  className="mono"
                  style={{
                    fontSize: "0.8rem",
                    color: isCurrent ? "#e6edf3" : "#8b98a5",
                  }}
                >
                  {step.index + 1}. {shortLabel(step)}
                </span>
                {isCurrent ? (
                  <span
                    className="muted"
                    style={{
                      display: "block",
                      fontSize: "0.78rem",
                      marginTop: 2,
                    }}
                  >
                    {step.instruction}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
