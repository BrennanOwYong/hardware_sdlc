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
import BoardView from "@/components/BoardView";
import {
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

  const usedParts = selected ? legendFor(selected) : [];
  const usedPartIds = new Set(usedParts.map((p) => p.id));

  const blockedBy = selected
    ? selected.dependsOn.filter((d) => !doneIds.includes(d))
    : [];

  const toggleDone = useCallback((id: string) => {
    setDoneIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

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

  return (
    <>
      <h1 style={{ marginBottom: "0.2rem" }}>Guided assembly</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        Pick a step on the right. The board shows what changes when you do it.
      </p>

      <div className="assemble-split">
        {/* LEFT: before and after */}
        <section className="assemble-stage">
          {selected ? (
            <>
              <div className="card" style={{ marginBottom: "0.6rem" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: "0.5rem",
                    flexWrap: "wrap",
                    marginBottom: "0.4rem",
                  }}
                >
                  <span
                    className="badge"
                    style={{
                      borderColor: KIND_STYLE[selected.kind].colour,
                      color: KIND_STYLE[selected.kind].colour,
                    }}
                  >
                    {KIND_STYLE[selected.kind].label}
                  </span>
                  <strong style={{ fontSize: "0.95rem" }}>{selected.title}</strong>
                </div>

                {changesCircuit ? (
                  <div className="assemble-ba">
                    <figure style={{ margin: 0 }}>
                      <figcaption
                        className="muted"
                        style={{ fontSize: "0.72rem", marginBottom: 2 }}
                      >
                        before
                      </figcaption>
                      <BoardView netlist={before} />
                    </figure>
                    <figure style={{ margin: 0 }}>
                      <figcaption
                        style={{
                          fontSize: "0.72rem",
                          marginBottom: 2,
                          color: "var(--accent)",
                        }}
                      >
                        after — new connection in green
                      </figcaption>
                      <BoardView netlist={after} diffAgainst={before} />
                    </figure>
                  </div>
                ) : (
                  <figure style={{ margin: 0 }}>
                    <figcaption
                      className="muted"
                      style={{ fontSize: "0.72rem", marginBottom: 2 }}
                    >
                      the wiring does not change in this step
                    </figcaption>
                    <BoardView
                      netlist={after}
                      {...(selected.kind === "flash" && selected.pins
                        ? { firmware: { hash: "pending", pinsUsed: selected.pins } }
                        : {})}
                    />
                  </figure>
                )}
              </div>

              <div className="card">
                <p style={{ marginTop: 0 }}>{selected.instruction}</p>
                <p className="muted" style={{ fontSize: "0.82rem" }}>
                  Check: {selected.checkDetail}
                </p>

                <p
                  style={{
                    fontSize: "0.8rem",
                    color:
                      selected.dependsOn.length === 0
                        ? "var(--accent)"
                        : "var(--warn)",
                  }}
                >
                  {orderingNote(selected, steps)}
                </p>

                {blockedBy.length > 0 ? (
                  <div className="banner warn" style={{ marginTop: "0.4rem" }}>
                    Not ready yet: finish{" "}
                    {blockedBy
                      .map((id) => steps.find((s) => s.id === id)?.title ?? id)
                      .join(", ")}{" "}
                    first.
                  </div>
                ) : null}

                {selected.kind === "flash" && selected.code ? (
                  <>
                    <pre
                      className="mono"
                      style={{
                        background: "var(--bg)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: "0.6rem",
                        overflowX: "auto",
                        fontSize: "0.74rem",
                        lineHeight: 1.45,
                      }}
                    >
                      {selected.code}
                    </pre>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={flashState === "running" || blockedBy.length > 0}
                      onClick={() => void injectCode()}
                    >
                      {flashState === "running" ? "Sending…" : "Inject code"}
                    </button>
                    {flashOutput ? (
                      <pre
                        className="mono"
                        style={{
                          marginTop: "0.5rem",
                          fontSize: "0.72rem",
                          whiteSpace: "pre-wrap",
                          color:
                            flashState === "ok" ? "var(--accent)" : "var(--warn)",
                        }}
                      >
                        {flashOutput}
                      </pre>
                    ) : null}
                  </>
                ) : null}

                {selected.kind === "verify" ? (
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className={
                        verifyOutcome === "worked" ? "btn btn-primary" : "btn"
                      }
                      onClick={() => {
                        setVerifyOutcome("worked");
                        toggleDone(selected.id);
                      }}
                    >
                      It worked
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
                        Check the LED&apos;s long leg goes to the pin-13 row and its
                        short leg reaches ground through the resistor.
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {selected.kind !== "flash" && selected.kind !== "verify" ? (
                  <button
                    type="button"
                    className={
                      doneIds.includes(selected.id) ? "btn btn-primary" : "btn"
                    }
                    onClick={() => toggleDone(selected.id)}
                  >
                    {doneIds.includes(selected.id) ? "✓ Done" : "Mark done"}
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </section>

        {/* RIGHT: legend + steps, scrolling on its own */}
        <aside className="assemble-steps">
          <div className="card" style={{ marginBottom: "0.6rem" }}>
            <h2 style={{ fontSize: "0.85rem", marginTop: 0 }}>Parts</h2>
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
                      padding: "0.2rem 0.3rem",
                      borderRadius: 6,
                      background: used ? "rgba(34,197,94,0.12)" : "transparent",
                      opacity: used ? 1 : 0.55,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 3,
                        background: p.colour,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontSize: "0.78rem", flex: 1 }}>
                      {p.name}
                      {p.qty > 1 ? ` ×${p.qty}` : ""}
                    </span>
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
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {wave.map((s: GuidedStep) => {
                  const active = s.id === selectedId;
                  const done = doneIds.includes(s.id);
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(s.id)}
                        className={`assemble-step${active ? " is-active" : ""}`}
                      >
                        <span
                          aria-hidden
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: done
                              ? "var(--accent)"
                              : KIND_STYLE[s.kind].colour,
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: "block", fontSize: "0.8rem" }}>
                            {done ? "✓ " : ""}
                            {s.title}
                          </span>
                          <span
                            className="muted"
                            style={{ display: "block", fontSize: "0.68rem" }}
                          >
                            {KIND_STYLE[s.kind].label}
                            {s.dependsOn.length > 0 ? " · waits on earlier work" : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </aside>
      </div>
    </>
  );
}
