"use client";

// P3 git-for-hardware timeline: commit list (newest first, branch badges),
// two-commit diff with photos, rollback plan, fork.
// Guards below re-check API payload shapes because lib/vcs/store.ts (which
// owns the server-side guards) imports node builtins and cannot be bundled
// into a client page.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BuildCommit, NetlistEdge } from "@/lib/types";
import { describeEdge, diff, type RollbackOp } from "@/lib/vcs/diff";

// --- payload guards ----------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isEdge(v: unknown): v is NetlistEdge {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    (v.kind === "wire" || v.kind === "component") &&
    (v.part === undefined || typeof v.part === "string") &&
    (v.value === undefined || typeof v.value === "string") &&
    typeof v.from === "string" &&
    typeof v.to === "string"
  );
}

function isCommit(v: unknown): v is BuildCommit {
  if (!isRecord(v)) return false;
  const firmware = v.firmware;
  const netlist = v.netlist;
  return (
    typeof v.id === "string" &&
    (v.parent === null || typeof v.parent === "string") &&
    typeof v.branch === "string" &&
    typeof v.message === "string" &&
    typeof v.createdAt === "string" &&
    (v.photoDataUrl === undefined || typeof v.photoDataUrl === "string") &&
    isRecord(netlist) &&
    Array.isArray(netlist.edges) &&
    netlist.edges.every(isEdge) &&
    isRecord(firmware) &&
    typeof firmware.code === "string" &&
    typeof firmware.hash === "string"
  );
}

function isCommitsPayload(v: unknown): v is { commits: BuildCommit[] } {
  return isRecord(v) && Array.isArray(v.commits) && v.commits.every(isCommit);
}

function isOp(v: unknown): v is RollbackOp {
  return (
    isRecord(v) &&
    (v.op === "remove" || v.op === "add") &&
    typeof v.instruction === "string" &&
    isEdge(v.edge)
  );
}

function isPlanPayload(v: unknown): v is { ops: RollbackOp[]; targetFirmwareHash: string } {
  return (
    isRecord(v) &&
    Array.isArray(v.ops) &&
    v.ops.every(isOp) &&
    typeof v.targetFirmwareHash === "string"
  );
}

function readError(v: unknown): string | null {
  return isRecord(v) && typeof v.error === "string" ? v.error : null;
}

// --- small helpers -------------------------------------------------------------

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

interface PlanState {
  ops: RollbackOp[];
  targetFirmwareHash: string;
  fromId: string;
  toId: string;
}

// --- page ----------------------------------------------------------------------

export default function TimelinePage() {
  const [commits, setCommits] = useState<BuildCommit[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [forking, setForking] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/commits");
      const data: unknown = await res.json();
      if (!res.ok || !isCommitsPayload(data)) {
        throw new Error(readError(data) ?? "unexpected /api/commits response");
      }
      setCommits(data.commits);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const indexOf = useMemo(() => {
    const m = new Map<string, number>();
    commits.forEach((c, i) => m.set(c.id, i));
    return m;
  }, [commits]);

  const selectedCommits = useMemo(
    () =>
      selected
        .map((id) => commits.find((c) => c.id === id))
        .filter((c): c is BuildCommit => c !== undefined),
    [selected, commits],
  );

  // With two selected: older/newer by creation order in the store.
  const pair = useMemo(() => {
    if (selectedCommits.length !== 2) return null;
    const sorted = [...selectedCommits].sort(
      (x, y) => (indexOf.get(x.id) ?? 0) - (indexOf.get(y.id) ?? 0),
    );
    const older = sorted[0];
    const newer = sorted[1];
    if (!older || !newer) return null;
    return { older, newer };
  }, [selectedCommits, indexOf]);

  const pairDiff = useMemo(
    () => (pair ? diff(pair.older.netlist, pair.newer.netlist) : null),
    [pair],
  );

  const single = selectedCommits.length === 1 ? selectedCommits[0] : undefined;

  const toggle = (id: string) => {
    setPlan(null);
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((s) => s !== id);
      if (prev.length >= 2) {
        const keep = prev[prev.length - 1];
        return keep === undefined ? [id] : [keep, id];
      }
      return [...prev, id];
    });
  };

  const loadPlan = async () => {
    if (!pair) return;
    setPlanLoading(true);
    try {
      const res = await fetch(
        `/api/commits/rollback-plan?from=${encodeURIComponent(pair.newer.id)}&to=${encodeURIComponent(pair.older.id)}`,
      );
      const data: unknown = await res.json();
      if (!res.ok || !isPlanPayload(data)) {
        throw new Error(readError(data) ?? "rollback plan request failed");
      }
      setPlan({
        ops: data.ops,
        targetFirmwareHash: data.targetFirmwareHash,
        fromId: pair.newer.id,
        toId: pair.older.id,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanLoading(false);
    }
  };

  const fork = async () => {
    const from = single;
    if (!from) return;
    const branch = window.prompt('New branch name (e.g. "dht11-experiment"):');
    if (!branch || branch.trim() === "") return;
    setForking(true);
    try {
      const res = await fetch("/api/commits/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromId: from.id, branch: branch.trim() }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        throw new Error(readError(data) ?? "fork request failed");
      }
      setError(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setForking(false);
    }
  };

  const newestFirst = useMemo(() => [...commits].reverse(), [commits]);

  return (
    <>
      <h1>Timeline</h1>
      <p className="muted" style={{ fontSize: "0.9rem" }}>
        git for hardware: every working board state is a commit. Tap one commit
        to inspect or fork it, tap two to diff and plan a rollback.
      </p>

      {error && <div className="banner error">{error}</div>}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", margin: "0.75rem 0" }}>
        <button
          className="btn"
          disabled={!pair || planLoading}
          onClick={() => void loadPlan()}
          style={{ opacity: !pair || planLoading ? 0.5 : 1 }}
        >
          {planLoading ? "Planning…" : "Rollback"}
        </button>
        <button
          className="btn"
          disabled={!single || forking}
          onClick={() => void fork()}
          style={{ opacity: !single || forking ? 0.5 : 1 }}
        >
          {forking ? "Forking…" : "Fork"}
        </button>
        {selected.length > 0 && (
          <button
            className="btn"
            onClick={() => {
              setSelected([]);
              setPlan(null);
            }}
          >
            Clear
          </button>
        )}
      </div>

      {plan && (
        <div className="card">
          <h2>Rollback plan</h2>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Physical steps to revert {shortId(plan.fromId)} back to {shortId(plan.toId)}.
            Removals come first.
          </p>
          <ol style={{ paddingLeft: "1.5rem", marginTop: "0.5rem" }}>
            {plan.ops.map((op, i) => (
              <li
                key={`${op.op}-${op.edge.id}-${i}`}
                className="mono"
                style={{
                  color: op.op === "remove" ? "var(--error)" : "var(--accent)",
                  marginBottom: "0.25rem",
                }}
              >
                {op.instruction}
              </li>
            ))}
            <li className="mono" style={{ color: "var(--warn)" }}>
              re-flash firmware {plan.targetFirmwareHash.slice(0, 12)}
            </li>
          </ol>
        </div>
      )}

      {pair && pairDiff && (
        <div className="card">
          <h2>Diff</h2>
          <p className="muted mono" style={{ fontSize: "0.75rem" }}>
            {shortId(pair.older.id)} (fw {pair.older.firmware.hash.slice(0, 8)}) →{" "}
            {shortId(pair.newer.id)} (fw {pair.newer.firmware.hash.slice(0, 8)})
          </p>
          {pairDiff.added.length === 0 && pairDiff.removed.length === 0 ? (
            <p className="muted" style={{ marginTop: "0.5rem" }}>
              No netlist changes between these commits.
            </p>
          ) : (
            <ul style={{ listStyle: "none", marginTop: "0.5rem" }}>
              {pairDiff.added.map((e) => (
                <li key={`a-${e.id}`} className="mono" style={{ color: "var(--accent)" }}>
                  + {describeEdge(e)}
                </li>
              ))}
              {pairDiff.removed.map((e) => (
                <li key={`r-${e.id}`} className="mono" style={{ color: "var(--error)" }}>
                  - {describeEdge(e)}
                </li>
              ))}
            </ul>
          )}
          {(pair.older.photoDataUrl || pair.newer.photoDataUrl) && (
            <div className="grid2" style={{ marginTop: "0.75rem" }}>
              {[pair.older, pair.newer].map((c, i) => (
                <figure key={c.id}>
                  {c.photoDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.photoDataUrl}
                      alt={`Board photo for commit ${shortId(c.id)}`}
                      style={{
                        maxWidth: "100%",
                        borderRadius: 8,
                        border: "1px solid var(--border)",
                        display: "block",
                      }}
                    />
                  ) : (
                    <div
                      className="muted"
                      style={{
                        border: "1px dashed var(--border)",
                        borderRadius: 8,
                        padding: "1.5rem 0.5rem",
                        textAlign: "center",
                        fontSize: "0.8rem",
                      }}
                    >
                      no photo
                    </div>
                  )}
                  <figcaption className="muted" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
                    {i === 0 ? "A (older)" : "B (newer)"} · {c.message}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      )}

      {single && (
        <div className="card">
          <h2>{single.message}</h2>
          <p className="muted mono" style={{ fontSize: "0.75rem" }}>
            {shortId(single.id)} · branch {single.branch} · fw{" "}
            {single.firmware.hash.slice(0, 8)} · {formatWhen(single.createdAt)}
          </p>
          {single.netlist.edges.length === 0 ? (
            <p className="muted" style={{ marginTop: "0.5rem" }}>
              Empty board.
            </p>
          ) : (
            <ul style={{ listStyle: "none", marginTop: "0.5rem" }}>
              {single.netlist.edges.map((e) => (
                <li key={e.id} className="mono">
                  {describeEdge(e)}
                </li>
              ))}
            </ul>
          )}
          {single.photoDataUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={single.photoDataUrl}
              alt={`Board photo for commit ${shortId(single.id)}`}
              style={{
                maxWidth: "100%",
                borderRadius: 8,
                border: "1px solid var(--border)",
                marginTop: "0.75rem",
                display: "block",
              }}
            />
          )}
        </div>
      )}

      {!loaded && <p className="muted">Loading commits…</p>}
      {loaded && commits.length === 0 && !error && (
        <div className="banner warn">No commits yet.</div>
      )}

      {newestFirst.map((c) => {
        const sel = selected.indexOf(c.id);
        return (
          <button
            key={c.id}
            onClick={() => toggle(c.id)}
            className="card"
            style={{
              width: "100%",
              textAlign: "left",
              cursor: "pointer",
              font: "inherit",
              color: "inherit",
              display: "block",
              borderColor: sel >= 0 ? "var(--accent)" : "var(--border)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: "0.5rem",
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <strong>{c.message}</strong>
              <span style={{ display: "inline-flex", gap: "0.35rem" }}>
                <span
                  className="badge"
                  style={
                    c.branch === "main"
                      ? undefined
                      : { borderColor: "var(--warn)", color: "var(--warn)" }
                  }
                >
                  {c.branch}
                </span>
                {sel >= 0 && (
                  <span
                    className="badge"
                    style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
                  >
                    {sel === 0 ? "A" : "B"}
                  </span>
                )}
              </span>
            </div>
            <div className="muted mono" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
              {shortId(c.id)} · fw {c.firmware.hash.slice(0, 8)} ·{" "}
              {c.netlist.edges.length} edge{c.netlist.edges.length === 1 ? "" : "s"} ·{" "}
              {formatWhen(c.createdAt)}
            </div>
          </button>
        );
      })}
    </>
  );
}
