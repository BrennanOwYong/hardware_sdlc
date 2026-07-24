"use client";

// The idea-to-build wizard: describe an idea, let the model plan the parts,
// photograph your bench to prove what you actually own, "acquire" the gap from
// real store listings, then walk the wiring and commit the result.
//
// Acquisition is SIMULATED by design (nothing ships tonight); every acquired
// card keeps that label visible rather than pretending a parcel arrived.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Inventory, PartDetection } from "@/lib/types";
import { identifyResponseSchema } from "@/lib/inventory/contract";
import {
  LISTING_IMAGE_BASE,
  SHOP_MANIFEST_URL,
  planResponseSchema,
  shopManifestSchema,
  wirePlanResponseSchema,
  type Listing,
  type PlanTurn,
  type PlannedPart,
  type WirePlanResponse,
} from "@/lib/plan/contract";
import { analyzeGap, listingsFor } from "@/lib/plan/gap";

const MAX_EDGE = 1568;
type Beat = 1 | 2 | 3 | 4 | 5;

const BEAT_LABELS: Record<Beat, string> = {
  1: "Your idea",
  2: "What you have",
  3: "Fill the gaps",
  4: "Build it",
  5: "Done",
};

function fitDims(w: number, h: number): { w: number; h: number } {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

function rasterize(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const { w, h } = fitDims(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      URL.revokeObjectURL(url);
      if (!ctx) {
        reject(new Error("canvas unavailable"));
        return;
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not read that image"));
    };
    img.src = url;
  });
}

export default function BuilderPage() {
  const [beat, setBeat] = useState<Beat>(1);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Beat 1
  const [idea, setIdea] = useState("");
  const [turns, setTurns] = useState<PlanTurn[]>([]);
  const [parts, setParts] = useState<PlannedPart[]>([]);

  // Beat 2
  const [benchPhoto, setBenchPhoto] = useState<string | null>(null);
  const [detections, setDetections] = useState<PartDetection[] | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Beat 3
  const [listings, setListings] = useState<Listing[]>([]);
  const [acquired, setAcquired] = useState<string[]>([]);

  // Beat 4/5
  const [wirePlan, setWirePlan] = useState<WirePlanResponse | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [simulating, setSimulating] = useState(false);
  const [committed, setCommitted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(SHOP_MANIFEST_URL);
        if (!res.ok) return;
        const parsed = shopManifestSchema.safeParse(await res.json());
        if (parsed.success && !cancelled) setListings(parsed.data.listings);
      } catch {
        /* the acquire beat degrades to links-only */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const gap = useMemo(
    () => analyzeGap(parts, detections ?? [], acquired),
    [parts, detections, acquired],
  );

  const sendIdea = useCallback(async () => {
    const text = idea.trim();
    if (!text) return;
    setBusy(true);
    setNote(null);
    const history = [...turns, { role: "user" as const, text }];
    setTurns(history);
    setIdea("");
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea: text, history: turns.slice(-8) }),
      });
      const parsed = planResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error("planner replied in an odd shape");
      setTurns([...history, { role: "assistant", text: parsed.data.reply }]);
      if (parsed.data.note) setNote(parsed.data.note);
      if (parsed.data.parts?.length) setParts(parsed.data.parts);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [idea, turns]);

  const onPhoto = useCallback(async (file: File) => {
    setBusy(true);
    setNote(null);
    try {
      const dataUrl = await rasterize(file);
      setBenchPhoto(dataUrl);
      const res = await fetch("/api/identify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageBase64: dataUrl }),
      });
      const parsed = identifyResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error("identify replied in an odd shape");
      const inv: Inventory = parsed.data.inventory;
      setDetections(inv.parts);
      setNote(
        parsed.data.note ??
          (inv.parts.length === 0
            ? "Nothing recognisable on that surface, so every part counts as missing."
            : `Found ${inv.parts.length} thing${inv.parts.length === 1 ? "" : "s"} on your bench.`),
      );
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
      setDetections([]);
    } finally {
      setBusy(false);
    }
  }, []);

  const buildWirePlan = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/wireplan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: turns[0]?.text ?? "a simple starter circuit",
          parts: parts.map((p) => ({
            name: p.name,
            ...(p.partKey ? { partKey: p.partKey } : {}),
          })),
        }),
      });
      const parsed = wirePlanResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error("wiring planner replied in an odd shape");
      setWirePlan(parsed.data);
      setStepIdx(0);
      if (parsed.data.note) setNote(parsed.data.note);
      setBeat(4);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [parts, turns]);

  // "Simulate my build": auto-advance the steps so the whole flow demos without
  // hardware, the same trick the assembly demo script uses.
  useEffect(() => {
    if (!simulating || !wirePlan) return;
    if (stepIdx >= wirePlan.steps.length - 1) {
      const done = setTimeout(() => {
        setSimulating(false);
        setBeat(5);
      }, 1200);
      return () => clearTimeout(done);
    }
    const t = setTimeout(() => setStepIdx((i) => i + 1), 1800);
    return () => clearTimeout(t);
  }, [simulating, stepIdx, wirePlan]);

  const commitPlan = useCallback(async () => {
    if (!wirePlan) return;
    setBusy(true);
    try {
      const edges = wirePlan.steps.map((s, i) => ({
        id: `plan-${i + 1}`,
        kind: "wire" as const,
        from: s.fromPart,
        to: s.toPart,
      }));
      const res = await fetch("/api/commits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: `plan: ${turns[0]?.text ?? "starter build"}`.slice(0, 120),
          netlist: { edges },
          firmware: { code: "// planned build, firmware not generated yet", hash: "planonly" },
          ...(benchPhoto ? { photoDataUrl: benchPhoto } : {}),
        }),
      });
      if (!res.ok) throw new Error(`commit failed (${res.status})`);
      setCommitted(true);
      setNote("Committed. Open the timeline to see it in the build history.");
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [wirePlan, turns, benchPhoto]);

  const step = wirePlan?.steps[stepIdx] ?? null;

  return (
    <>
      <h1>Builder</h1>
      <p className="muted" style={{ marginTop: "-0.5rem" }}>
        Describe what you want to make. Forge plans the parts, checks your bench,
        fills the gaps, and walks you through the wiring.
      </p>

      {/* Beat rail */}
      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", margin: "0.75rem 0" }}>
        {([1, 2, 3, 4, 5] as Beat[]).map((b) => (
          <button
            key={b}
            type="button"
            className={beat === b ? "btn btn-primary" : "btn"}
            style={{ fontSize: "0.8rem", padding: "0.3rem 0.7rem", opacity: b <= beat ? 1 : 0.5 }}
            onClick={() => b <= beat && setBeat(b)}
          >
            {b}. {BEAT_LABELS[b]}
          </button>
        ))}
      </div>

      {note ? <div className="banner warn">{note}</div> : null}

      {/* Beat 1: idea */}
      {beat === 1 ? (
        <div className="card">
          <h2 style={{ fontSize: "0.95rem" }}>What do you want to build?</h2>
          {turns.map((t, i) => (
            <p
              key={i}
              style={{
                margin: "0.4rem 0",
                color: t.role === "user" ? "var(--text)" : "var(--accent)",
              }}
            >
              <strong>{t.role === "user" ? "You: " : "Forge: "}</strong>
              {t.text}
            </p>
          ))}
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem" }}>
            <input
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && void sendIdea()}
              placeholder="a night light that turns on when the room gets dark"
              aria-label="Your idea"
              style={{
                flex: 1,
                padding: "0.6rem 0.9rem",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                color: "var(--text)",
              }}
            />
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void sendIdea()}>
              {busy ? "Thinking…" : "Send"}
            </button>
          </div>

          {parts.length > 0 ? (
            <>
              <h3 style={{ fontSize: "0.9rem", marginTop: "1rem" }}>
                Parts you will need
              </h3>
              <ul style={{ paddingLeft: "1.1rem" }}>
                {parts.map((p) => (
                  <li key={p.name} style={{ marginBottom: "0.3rem" }}>
                    <strong>{p.name}</strong>
                    {p.qty > 1 ? ` ×${p.qty}` : ""}{" "}
                    <span className="muted">— {p.why}</span>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn-primary" onClick={() => setBeat(2)}>
                Next: show Forge your bench
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {/* Beat 2: what you have */}
      {beat === 2 ? (
        <div className="card">
          <h2 style={{ fontSize: "0.95rem" }}>What is on your bench?</h2>
          <p className="muted">
            Photograph your desk exactly as it is. An empty desk is a perfectly
            good answer; Forge will just say you need everything.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPhoto(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? "Looking…" : "Photograph my bench"}
          </button>

          {benchPhoto ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={benchPhoto}
              alt="your bench"
              style={{ width: "100%", borderRadius: 8, marginTop: "0.75rem" }}
            />
          ) : null}

          {detections ? (
            <>
              <div className="grid2" style={{ marginTop: "0.75rem" }}>
                <div>
                  <h3 style={{ fontSize: "0.9rem", color: "var(--accent)" }}>
                    You already have ({gap.have.length})
                  </h3>
                  {gap.have.length === 0 ? (
                    <p className="muted">Nothing from the plan yet.</p>
                  ) : (
                    <ul style={{ paddingLeft: "1.1rem" }}>
                      {gap.have.map((r) => (
                        <li key={r.part.name}>
                          {r.part.name}{" "}
                          <span className="muted">
                            {r.matchedLabel ? `(saw: ${r.matchedLabel})` : "(acquired)"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h3 style={{ fontSize: "0.9rem", color: "var(--warn)" }}>
                    You still need ({gap.missing.length})
                  </h3>
                  <ul style={{ paddingLeft: "1.1rem" }}>
                    {gap.missing.map((r) => (
                      <li key={r.part.name}>{r.part.name}</li>
                    ))}
                  </ul>
                </div>
              </div>
              <button type="button" className="btn btn-primary" onClick={() => setBeat(3)}>
                Next: fill the gaps
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {/* Beat 3: acquire */}
      {beat === 3 ? (
        <div className="card">
          <h2 style={{ fontSize: "0.95rem" }}>Fill the gaps</h2>
          <p className="muted">
            Real listings, pulled from real stores. Acquiring here is a
            simulation so the build can continue tonight; the links are live if
            you want to order for real.
          </p>
          {gap.missing.length === 0 ? (
            <p style={{ color: "var(--accent)" }}>
              Nothing missing. Straight to the build.
            </p>
          ) : (
            gap.missing.map((row) => {
              const options = listingsFor(row.part, listings);
              return (
                <div key={row.part.name} style={{ marginBottom: "1rem" }}>
                  <h3 style={{ fontSize: "0.9rem" }}>{row.part.name}</h3>
                  {options.length === 0 ? (
                    <p className="muted">
                      No stored listing for this one; search your usual store.
                    </p>
                  ) : (
                    <div style={{ display: "flex", gap: "0.6rem", overflowX: "auto" }}>
                      {options.slice(0, 3).map((l) => (
                        <div
                          key={l.url}
                          style={{
                            minWidth: 180,
                            border: "1px solid var(--border)",
                            borderRadius: 8,
                            padding: "0.5rem",
                          }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={LISTING_IMAGE_BASE + l.imageFile}
                            alt={l.title}
                            style={{
                              width: "100%",
                              height: 110,
                              objectFit: "contain",
                              background: "#fff",
                              borderRadius: 6,
                            }}
                          />
                          <p style={{ fontSize: "0.78rem", margin: "0.4rem 0 0.2rem" }}>
                            {l.title.slice(0, 70)}
                          </p>
                          <p className="muted" style={{ fontSize: "0.75rem", margin: 0 }}>
                            {l.currency} {l.price} · {l.store}
                          </p>
                          <a
                            href={l.url}
                            target="_blank"
                            rel="noreferrer"
                            className="muted"
                            style={{ fontSize: "0.75rem" }}
                          >
                            view listing ↗
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn"
                    style={{ marginTop: "0.4rem" }}
                    onClick={() => setAcquired((a) => [...a, row.part.name])}
                  >
                    Acquire (simulated)
                  </button>
                </div>
              );
            })
          )}
          {acquired.length > 0 ? (
            <p className="badge">simulated acquisition · {acquired.length} part(s)</p>
          ) : null}
          <div style={{ marginTop: "0.6rem" }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void buildWirePlan()}>
              {busy ? "Planning the wiring…" : "Next: build it"}
            </button>
          </div>
        </div>
      ) : null}

      {/* Beat 4: assemble */}
      {beat === 4 && wirePlan ? (
        <div className="card">
          <h2 style={{ fontSize: "0.95rem" }}>
            Step {stepIdx + 1} of {wirePlan.steps.length}
          </h2>
          {step ? (
            <>
              <div className="banner" style={{ fontSize: "1.05rem" }}>
                {step.instruction}
              </div>
              <p className="muted">Check: {step.checkDetail}</p>
              <p className="badge">
                {step.fromPart} → {step.toPart}
              </p>
            </>
          ) : null}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.6rem" }}>
            <button
              type="button"
              className="btn"
              disabled={stepIdx === 0}
              onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
            >
              Back
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                stepIdx >= wirePlan.steps.length - 1
                  ? setBeat(5)
                  : setStepIdx((i) => i + 1)
              }
            >
              {stepIdx >= wirePlan.steps.length - 1 ? "Finish" : "Next step"}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setStepIdx(0);
                setSimulating(true);
              }}
            >
              {simulating ? "Simulating…" : "Simulate my build"}
            </button>
          </div>
        </div>
      ) : null}

      {/* Beat 5: done */}
      {beat === 5 && wirePlan ? (
        <div className="card">
          <h2 style={{ fontSize: "0.95rem", color: "var(--accent)" }}>
            ✓ End state
          </h2>
          <p>{wirePlan.endStateSummary}</p>
          <h3 style={{ fontSize: "0.9rem" }}>Check before powering on</h3>
          <ul style={{ paddingLeft: "1.1rem" }}>
            {wirePlan.checks.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || committed}
              onClick={() => void commitPlan()}
            >
              {committed ? "✓ Committed" : busy ? "Committing…" : "Commit this plan"}
            </button>
            <Link className="btn" href="/timeline">
              Open timeline
            </Link>
          </div>
        </div>
      ) : null}
    </>
  );
}
