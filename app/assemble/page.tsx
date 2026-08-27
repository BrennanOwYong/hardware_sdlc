"use client";

// Guided assembly, two panels.
//
// LEFT: the circuit, shown as before and after for the selected step, so you
// can see exactly what changes when you do it.
// RIGHT: the parts legend and the step list, scrolling independently, grouped
// into waves. Steps within a wave can be done in any order and the UI says so,
// rather than implying a sequence that does not exist. Steps that genuinely
// depend on earlier work (flashing firmware needs the wires it drives) name
// what they are waiting for.

import { useCallback, useMemo, useState } from "react";
import CircuitEditor from "@/components/CircuitEditor";
import PartChip from "@/components/PartChip";
import { CATALOG, specById } from "@/lib/devices/catalog";
import { detectDevicesOrDefault } from "@/lib/devices/detect";
import { autoPlace, connectionEnds, layoutProject } from "@/lib/devices/layout";
import { linkifyParts } from "@/lib/parts/gallery";
import {
  CIRCUIT_STORY,
  GUIDED_STEPS,
  LEGEND,
  computeWaves,
  legendFor,
  netlistAfter,
  netlistBefore,
  orderingNote,
  type GuidedStep,
  type StepKind,
} from "@/lib/assembly/guided";

const KIND_STYLE: Record<StepKind, { label: string; colour: string }> = {
  wire: { label: "wiring", colour: "#38bdf8" },
  component: { label: "part", colour: "#a78bfa" },
  flash: { label: "software", colour: "#f59e0b" },
  verify: { label: "check", colour: "#22c55e" },
  power: { label: "power", colour: "#ec4899" },
};

type FlashState = "idle" | "running" | "ok" | "failed";
type VerifyOutcome = "worked" | "did-not" | null;

export default function AssemblePage() {
  const steps = GUIDED_STEPS;
  const waves = useMemo(() => computeWaves(steps), [steps]);

  const [selectedId, setSelectedId] = useState<string>(steps[0]?.id ?? "");
  const [view, setView] = useState<"before" | "after">("after");
  const [doneIds, setDoneIds] = useState<string[]>([]);
  const [flashState, setFlashState] = useState<FlashState>("idle");
  const [flashOutput, setFlashOutput] = useState<string | null>(null);
  const [verifyOutcome, setVerifyOutcome] = useState<VerifyOutcome>(null);

  const selected = steps.find((s) => s.id === selectedId) ?? steps[0];

  const before = useMemo(
    () => (selected ? netlistBefore(steps, selected.id) : { edges: [] }),
    [steps, selected],
  );
  const after = useMemo(
    () => (selected ? netlistAfter(steps, selected.id) : { edges: [] }),
    [steps, selected],
  );
  const changesCircuit = after.edges.length !== before.edges.length;

  // Which physical devices this build runs on. The legend names the parts in
  // words ("Half-size breadboard"), the detector turns those words into
  // catalog models, and the wireframe draws whatever the models say. Change
  // the legend to a 170-point board and the drawing loses its rails.
  const { matches } = useMemo(
    () =>
      detectDevicesOrDefault(
        LEGEND.map((p) => p.name),
        CATALOG,
        { breadboardId: "bb-400", boardId: "uno-r3" },
      ),
    [],
  );
  const specIds = useMemo(() => matches.map((m) => m.specId), [matches]);

  // The same devices the wireframe draws on, so the written instruction and
  // the picture name the same holes on the same models.
  const layout = useMemo(
    () => layoutProject(autoPlace(specIds, specById), specById),
    [specIds],
  );

  // The holes this step aims at, so the wireframe can ring them.
  const stepRefs = useMemo(
    () => (selected?.edge ? [selected.edge.from, selected.edge.to] : []),
    [selected],
  );

  const usedParts = selected ? legendFor(selected) : [];
  const usedPartIds = new Set(usedParts.map((p) => p.id));

  const injectCode = useCallback(async () => {
    if (!selected?.code) return;
    setFlashState("running");
    setFlashOutput(null);
    try {
      const res = await fetch("/api/flash", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: selected.code }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        output?: string;
        guidance?: string;
        stage?: string;
      };
      // Never claim a hardware success that did not happen: a compile with no
      // board attached is reported as exactly that.
      setFlashState(data.ok ? "ok" : "failed");
      setFlashOutput(
        [data.stage ? `stage: ${data.stage}` : null, data.output, data.guidance]
          .filter(Boolean)
          .join("\n") || "No output returned.",
      );
      if (data.ok) {
        setDoneIds((prev) =>
          prev.includes(selected.id) ? prev : [...prev, selected.id],
        );
      }
    } catch (err) {
      setFlashState("failed");
      setFlashOutput(
        `Could not reach the flashing service: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [selected]);

  // Both ends of this step's connection, named down to the device and hole.
  const ends = useMemo(
    () =>
      selected?.edge
        ? connectionEnds(layout, selected.edge.from, selected.edge.to)
        : null,
    [selected, layout],
  );

  return (
    <>
      <h1 style={{ marginBottom: "0.2rem" }}>Guided assembly</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        {CIRCUIT_STORY}
      </p>

      <div className="assemble-split">
        {/* LEFT: the bench, given the width. */}
        <section className="assemble-stage">
          {selected ? (
            <div className="card">
              <div className="fg-ba-switch">
                <span
                  className="badge"
                  style={{
                    borderColor: KIND_STYLE[selected.kind].colour,
                    color: KIND_STYLE[selected.kind].colour,
                  }}
                >
                  {KIND_STYLE[selected.kind].label}
                </span>
                <strong style={{ fontSize: "0.95rem", flex: 1 }}>
                  {selected.title}
                </strong>
                {ends?.from && ends.to ? (
                  <code className="fg-end-ref">
                    {ends.from.ref} → {ends.to.ref}
                  </code>
                ) : null}
                <button
                  type="button"
                  className={view === "before" ? "primary" : ""}
                  onClick={() => setView("before")}
                  disabled={!changesCircuit}
                >
                  Before
                </button>
                <button
                  type="button"
                  className={view === "after" ? "primary" : ""}
                  onClick={() => setView("after")}
                >
                  After
                </button>
              </div>

              <CircuitEditor
                initialSpecIds={specIds}
                matches={matches}
                netlist={view === "before" ? before : after}
                {...(changesCircuit && view === "after"
                  ? { diffAgainst: before }
                  : {})}
                highlightRefs={stepRefs}
                ghostEdge={view === "before" ? (selected.edge ?? null) : null}
                railPosition="below"
                allowFreeEdit={false}
              />
              <p className="muted" style={{ fontSize: "0.72rem", marginBottom: 0 }}>
                {changesCircuit
                  ? "The pulsing rings are the two holes this step joins. Green is the connection it adds."
                  : "This step changes the software, not the wiring."}
              </p>
            </div>
          ) : null}
        </section>

        {/* RIGHT: the steps. Each row carries its shorthand; the detail opens
            in place, so the list stays a wiring table you can read straight
            down and the long version is one click away where you need it. */}
        <aside className="assemble-steps">
          <div className="card" style={{ marginBottom: "0.6rem" }}>
            <h2 className="fg-h3" style={{ marginTop: 0 }}>
              Parts
            </h2>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {LEGEND.map((p) => {
                const used = usedPartIds.has(p.id);
                return (
                  <li
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.45rem",
                      padding: "0.15rem 0.2rem",
                      borderRadius: 6,
                      background: used ? "rgba(34,197,94,0.12)" : "transparent",
                      opacity: used ? 1 : 0.6,
                    }}
                  >
                    <PartChip partId={p.id}>
                      {p.name}
                      {p.qty > 1 ? ` ×${p.qty}` : ""}
                    </PartChip>
                    {used ? (
                      <span className="badge" style={{ fontSize: "0.62rem" }}>
                        this step
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>

          {waves.map((wave, wi) => (
            <div key={wi} className="card" style={{ marginBottom: "0.6rem" }}>
              <h3 style={{ fontSize: "0.78rem", margin: "0 0 0.1rem" }}>
                Group {wi + 1}
              </h3>
              <p
                className="muted"
                style={{ fontSize: "0.7rem", margin: "0 0 0.4rem" }}
              >
                {wave.length > 1
                  ? "Any order within this group."
                  : "One step, after the group above."}
              </p>

              <ol className="fg-steps">
                {wave.map((s: GuidedStep) => {
                  const active = s.id === selectedId;
                  const se = s.edge
                    ? connectionEnds(layout, s.edge.from, s.edge.to)
                    : null;
                  const blocked = s.dependsOn.filter((d) => !doneIds.includes(d));
                  return (
                    <li key={s.id} className={active ? "is-active" : ""}>
                      <button
                        type="button"
                        className="fg-step-head"
                        onClick={() => setSelectedId(s.id)}
                      >
                        <span
                          aria-hidden
                          className={`fg-step-dot${active ? " fg-dot-pulse" : ""}`}
                          style={{ background: KIND_STYLE[s.kind].colour }}
                        />
                        <span className="fg-step-title">{s.title}</span>
                        {/* The shorthand IS the instruction for anyone who can
                            read it; the prose below is for anyone who cannot. */}
                        {se?.from && se.to ? (
                          <code className="fg-step-code">
                            {se.from.ref} → {se.to.ref}
                          </code>
                        ) : (
                          <span className="fg-step-kind">
                            {KIND_STYLE[s.kind].label}
                          </span>
                        )}
                      </button>

                      <details
                        open={active}
                        onToggle={(e) => {
                          if ((e.target as HTMLDetailsElement).open) setSelectedId(s.id);
                        }}
                      >
                        <summary>In full</summary>
                        <div className="fg-step-body">
                          <p>
                            {linkifyParts(s.instruction).map((seg, i) =>
                              seg.partId ? (
                                <PartChip key={i} partId={seg.partId}>
                                  {seg.text}
                                </PartChip>
                              ) : (
                                <span key={i}>{seg.text}</span>
                              ),
                            )}
                          </p>
                          <p className="fg-why">
                            <span className="muted">Why: </span>
                            {s.why}
                          </p>
                          <p className="muted" style={{ fontSize: "0.74rem" }}>
                            Right when: {s.checkDetail}
                          </p>
                          {s.dependsOn.length > 0 ? (
                            <p style={{ fontSize: "0.74rem", color: "var(--warn)" }}>
                              {orderingNote(s, steps)}
                            </p>
                          ) : null}

                          {s.kind === "flash" && s.code ? (
                            <>
                              <pre className="mono fg-sketch">{s.code}</pre>
                              <button
                                type="button"
                                className="btn btn-primary"
                                disabled={flashState === "running"}
                                onClick={() => void injectCode()}
                              >
                                {flashState === "running" ? "Writing…" : "Write code"}
                              </button>
                              {flashOutput ? (
                                <pre
                                  className="mono fg-sketch"
                                  style={{
                                    whiteSpace: "pre-wrap",
                                    color:
                                      flashState === "ok"
                                        ? "var(--accent)"
                                        : "var(--warn)",
                                  }}
                                >
                                  {flashOutput}
                                </pre>
                              ) : null}
                            </>
                          ) : null}

                          {s.kind === "verify" ? (
                            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                              <button
                                type="button"
                                className={
                                  verifyOutcome === "worked" ? "btn btn-primary" : "btn"
                                }
                                onClick={() => setVerifyOutcome("worked")}
                              >
                                It lit up
                              </button>
                              <button
                                type="button"
                                className="btn"
                                onClick={() => setVerifyOutcome("did-not")}
                              >
                                It did not
                              </button>
                              {verifyOutcome === "did-not" ? (
                                <div
                                  className="banner warn"
                                  style={{ width: "100%", marginTop: "0.4rem" }}
                                >
                                  Two things cause this. Check the LED&apos;s long
                                  leg is in the row the red wire reaches, and check
                                  the yellow and black wires sit on OPPOSITE sides
                                  of the groove — same side means the pin is
                                  grounded permanently.
                                </div>
                              ) : null}
                            </div>
                          ) : null}

                          {blocked.length > 0 && s.agentCheckable ? (
                            <p className="muted" style={{ fontSize: "0.72rem" }}>
                              Waiting on:{" "}
                              {blocked
                                .map((id) => steps.find((x) => x.id === id)?.title ?? id)
                                .join(", ")}
                              .
                            </p>
                          ) : null}
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </aside>
      </div>
    </>
  );
}
