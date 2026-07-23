// Pure step-graph reducer for guided assembly: the two-stage confirmation
// state machine (tip-on-target, then seated) with false-seat rejection and
// misplacement blocking.
//
// This module is import-free at runtime (type-only imports) so that
// tests/stepgraph.test.mjs can load it under plain `node --test` with
// Node's native type stripping (see docs/references-p2.md). That constraint
// is also why humanizeRef lives here instead of importing refLabel from
// circuits.ts: a runtime import would need an extension Node accepts and
// tsc rejects.

import type {
  AssemblyStep,
  Netlist,
  PerceptionEvent,
  StepPhase,
  TargetRef,
} from "@/lib/types";

export interface StepGraphState {
  steps: AssemblyStep[];
  /** Index of the step being worked on; steps.length once complete. */
  currentIndex: number;
  /** Phase of the current step. */
  phase: StepPhase;
  /** Edge ids of steps confirmed seated, in seat order. */
  seatedIds: string[];
  /** Note recorded when the tip touches a wrong ref; cleared on progress. */
  nearMiss: string | null;
  /** Human fix message while phase is "error". */
  errorMessage: string | null;
  complete: boolean;
}

export type StepGraphEvent =
  | PerceptionEvent
  | { type: "advance" }
  | { type: "reset" }
  | { type: "restart" };

/** Compact human name for a ref, used in near-miss and error messages. */
export function humanizeRef(ref: TargetRef): string {
  const hole = /^BB:(\d{1,2}):([a-j])$/.exec(ref);
  if (hole) return `row ${hole[1]} hole ${hole[2]}`;
  if (ref === "BB:RAIL:GND") return "the GND rail";
  if (ref === "BB:RAIL:PWR") return "the power rail";
  const pin = /^UNO:(.+)$/.exec(ref);
  if (pin) return `the ${pin[1]} pin`;
  return ref;
}

export function createInitialState(steps: AssemblyStep[]): StepGraphState {
  return {
    steps,
    currentIndex: 0,
    phase: "active",
    seatedIds: [],
    nearMiss: null,
    errorMessage: null,
    complete: steps.length === 0,
  };
}

export function currentStep(state: StepGraphState): AssemblyStep | null {
  if (state.complete || state.currentIndex >= state.steps.length) return null;
  return state.steps[state.currentIndex];
}

export function progressPct(state: StepGraphState): number {
  if (state.steps.length === 0) return 0;
  return Math.round((state.seatedIds.length / state.steps.length) * 100);
}

/** Netlist assembled from seated steps only: the edges the system observed. */
export function observedNetlist(state: StepGraphState): Netlist {
  return {
    edges: state.steps
      .filter((s) => state.seatedIds.includes(s.edge.id))
      .map((s) => s.edge),
  };
}

/** Display phase for any step index (for the step list rail). */
export function phaseForStep(state: StepGraphState, index: number): StepPhase {
  if (state.complete || index < state.currentIndex) return "seated";
  if (index > state.currentIndex) return "pending";
  return state.phase;
}

function fixMessage(step: AssemblyStep, observed: string): string {
  const expected = step.targets.map((t) => humanizeRef(t.ref)).join(" or ");
  return `Wrong hole: expected ${expected}, saw ${observed}. Pull it out and retry.`;
}

/**
 * Pure reducer. Perception events drive the two-stage confirmation:
 *   active --tip-at(correct ref)--> tip-on-target
 *   active --tip-at(wrong ref)---> active (near-miss note recorded)
 *   active|tip-on-target --seated(current edge)--> seated (UI advances ~800ms later)
 *   seated(non-current edge) is ignored (false-seat rejection)
 *   misplaced(current edge) --> error (blocks everything until reset)
 * UI actions: advance (only from seated), reset (error -> active), restart.
 */
export function reducer(
  state: StepGraphState,
  event: StepGraphEvent,
): StepGraphState {
  switch (event.type) {
    case "detections":
      return state; // inventory concern, not step logic
    case "tip-at": {
      const step = currentStep(state);
      if (!step) return state;
      if (state.phase === "error" || state.phase === "seated") return state;
      const refs = step.targets.map((t) => t.ref);
      if (refs.includes(event.ref)) {
        if (state.phase === "tip-on-target" && state.nearMiss === null) {
          return state;
        }
        return { ...state, phase: "tip-on-target", nearMiss: null };
      }
      return {
        ...state,
        phase: "active",
        nearMiss: `Tip seen at ${humanizeRef(event.ref)} (${event.ref}). Target is ${refs
          .map(humanizeRef)
          .join(" or ")}. Not there yet.`,
      };
    }
    case "seated": {
      const step = currentStep(state);
      if (!step) return state;
      if (state.phase === "error") return state; // blocked until reset
      if (state.phase === "seated") return state;
      if (event.edgeId !== step.edge.id) return state; // false-seat rejection
      return {
        ...state,
        phase: "seated",
        nearMiss: null,
        errorMessage: null,
        seatedIds: [...state.seatedIds, step.edge.id],
      };
    }
    case "misplaced": {
      const step = currentStep(state);
      if (!step) return state;
      if (event.edgeId !== step.edge.id) return state;
      if (state.phase === "seated") return state;
      return {
        ...state,
        phase: "error",
        errorMessage: fixMessage(step, event.observed),
      };
    }
    case "advance": {
      if (state.phase !== "seated" || state.complete) return state;
      const next = state.currentIndex + 1;
      if (next >= state.steps.length) {
        return { ...state, currentIndex: next, complete: true };
      }
      return {
        ...state,
        currentIndex: next,
        phase: "active",
        nearMiss: null,
        errorMessage: null,
      };
    }
    case "reset": {
      if (state.complete) return state;
      if (
        state.phase === "active" &&
        state.errorMessage === null &&
        state.nearMiss === null
      ) {
        return state;
      }
      if (state.phase === "seated") return state;
      return { ...state, phase: "active", errorMessage: null, nearMiss: null };
    }
    case "restart":
      return createInitialState(state.steps);
  }
}
