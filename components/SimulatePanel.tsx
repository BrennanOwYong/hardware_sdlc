"use client";

// Manual simulation controls: fire well-formed PerceptionEvents for the
// current step so the two-stage confirmation flow can be driven by hand
// (used when screen-sharing MS Paint / Google Slides stands in for a real
// workspace, or with no camera at all).

import type { PerceptionEvent, SimulatePanelProps } from "@/lib/types";
import { wrongRefFor } from "@/lib/assembly/circuits";

export default function SimulatePanel({ step, onInject }: SimulatePanelProps) {
  if (!step) {
    return (
      <div className="card">
        <h2 style={{ fontSize: "0.95rem" }}>Simulate perception</h2>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          No active step. All steps are seated or the build has not started.
        </p>
      </div>
    );
  }

  const correctRef = step.targets[0]?.ref ?? step.edge.from;
  const wrongRef = wrongRefFor(step);
  const expected = step.targets.map((t) => t.ref);

  const fire = (event: PerceptionEvent) => onInject(event);

  const buttons: { label: string; kind: string; event: PerceptionEvent }[] = [
    {
      label: "Tip on correct target",
      kind: "good",
      event: { type: "tip-at", atMs: Date.now(), ref: correctRef },
    },
    {
      label: "Tip on wrong hole",
      kind: "warn",
      event: { type: "tip-at", atMs: Date.now(), ref: wrongRef },
    },
    {
      label: "Seat it",
      kind: "good",
      event: { type: "seated", atMs: Date.now(), edgeId: step.edge.id },
    },
    {
      label: "Misplace it",
      kind: "bad",
      event: {
        type: "misplaced",
        atMs: Date.now(),
        edgeId: step.edge.id,
        expected,
        observed: `tip seated at ${wrongRef} (one hole off)`,
      },
    },
  ];

  return (
    <div className="card">
      <h2 style={{ fontSize: "0.95rem" }}>Simulate perception</h2>
      <p className="muted" style={{ fontSize: "0.8rem" }}>
        Step {step.index + 1}: correct target {correctRef}, wrong hole{" "}
        {wrongRef}
      </p>
      <div className="grid2">
        {buttons.map((b) => (
          <button
            key={b.label}
            type="button"
            className="btn"
            style={{
              borderColor:
                b.kind === "good"
                  ? "#22c55e"
                  : b.kind === "bad"
                    ? "#ef4444"
                    : "#f59e0b",
            }}
            onClick={() => fire(b.event)}
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}
