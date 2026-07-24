"use client";

// P3 git-for-hardware timeline: commit list (newest first, branch badges),
// two-commit diff with photos, rollback plan, fork. Delta additions:
//   - build journal (FEEDBACK 13): each commit card carries a collapsible
//     list of the coach steps and flash events drained into it, with coach
//     frames as thumbnails (via /api/images) and firmware-hash badges
//   - commit-state diagram (FEEDBACK 14): one selected commit renders its
//     hole-precise netlist on BoardView with a firmware badge; two selected
//     render ONE diagram in diff mode next to the existing sentence list
// Guards below re-check API payload shapes because lib/vcs/store.ts (which
// owns the server-side guards) imports node builtins and cannot be bundled
// into a client page.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BuildCommit, JournalEntry, NetlistEdge } from "@/lib/types";
import { describeEdge, diff, type RollbackOp } from "@/lib/vcs/diff";
import { pinsUsedFromNetlist } from "@/lib/diagram/selectors";
import BoardView from "@/components/BoardView";

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

function optionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === "string";
}

function isJournalEntry(v: unknown): v is JournalEntry {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.at === "string" &&
    (v.kind === "coach" || v.kind === "flash") &&
    typeof v.summary === "string" &&
    optionalString(v.detail) &&
    optionalString(v.framePath) &&
    optionalString(v.goal) &&
    optionalString(v.attempt) &&
    optionalString(v.verdict) &&
    optionalString(v.firmwareHash)
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
    typeof firmware.hash === "string" &&
    (v.journal === undefined ||
      (Array.isArray(v.journal) && v.journal.every(isJournalEntry)))
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

/** Firmware badge props for a commit's diagram: short-hashable hash + the
 * UNO pins its netlist touches (pins are derivable from the netlist alone). */
function firmwareBadgeFor(c: BuildCommit): { hash: string; pinsUsed: string[] } {
  return { hash: c.firmware.hash, pinsUsed: pinsUsedFromNetlist(c.netlist) };
}

/** Collapsible build journal under a commit: entry summaries with
 * timestamps, coach frames as thumbnails, flash entries with hash badges. */
function JournalList({ entries }: { entries: JournalEntry[] }) {
  return (
    <details style={{ marginTop: "0.5rem" }}>
      <summary
        className="muted"
        style={{ cursor: "pointer", fontSize: "0.8rem" }}
      >
        build journal ({entries.length}{" "}
        {entries.length === 1 ? "entry" : "entries"})
      </summary>
      <ul style={{ listStyle: "none", marginTop: "0.5rem" }}>
        {entries.map((e) => (
          <li
            key={e.id}
            style={{
              display: "flex",
              gap: "0.5rem",
              alignItems: "flex-start",
              marginBottom: "0.5rem",
            }}
          >
            {e.framePath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/images/${e.framePath}`}
                alt={`Frame for journal entry: ${e.summary}`}
                width={56}
                height={42}
                style={{
                  objectFit: "cover",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  flexShrink: 0,
                }}
              />
            ) : null}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: "0.85rem" }}>
                <span className="badge" style={{ marginRight: "0.35rem" }}>
                  {e.kind}
                </span>
                {e.summary}
                {e.kind === "flash" && e.firmwareHash ? (
                  <span
                    className="badge mono"
                    style={{
                      marginLeft: "0.35rem",
                      borderColor: "var(--accent)",
                      color: "var(--accent)",
                    }}
                  >
                    {e.firmwareHash.slice(0, 8)}
                  </span>
                ) : null}
              </div>
              <div className="muted mono" style={{ fontSize: "0.7rem" }}>
                {formatWhen(e.at)}
                {e.verdict ? ` · ${e.verdict}` : ""}
              </div>
              {e.detail ? (
                <div className="muted" style={{ fontSize: "0.75rem" }}>
                  {e.detail}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

// --- page ----------------------------------------------------------------------


export default function TimelinePage() {
  const [commits, setCommits] = useState<BuildCommit[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // null means "compare against my parent", the sensible default for a
  // sequence. Picking an explicit target is the rare secondary action.
  const [compareId, setCompareId] = useState<string | null>(null);
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

  const newestFirst = useMemo(() => [...commits].reverse(), [commits]);

  // Land on the newest commit so the page is never an empty right pane.
  useEffect(() => {
    if (!selectedId && newestFirst.length > 0) {
      setSelectedId(newestFirst[0]?.id ?? null);
    }
  }, [newestFirst, selectedId]);

  const byId = useMemo(() => {
    const m = new Map<string, BuildCommit>();
    commits.forEach((c) => m.set(c.id, c));
    return m;
  }, [commits]);

  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  // Default comparison: the commit this one grew out of.
  const compareTo = useMemo(() => {
    if (!selected) return null;
    if (compareId) return byId.get(compareId) ?? null;
    return selected.parent ? (byId.get(selected.parent) ?? null) : null;
  }, [selected, compareId, byId]);

  const stateDiff = useMemo(
    () => (selected && compareTo ? diff(compareTo.netlist, selected.netlist) : null),
    [selected, compareTo],
  );

  const pick = (id: string) => {
    setSelectedId(id);
    setCompareId(null);
    setPlan(null);
  };

  const loadPlan = async () => {
    if (!selected || !compareTo) return;
    setPlanLoading(true);
    try {
      const res = await fetch(
        `/api/commits/rollback-plan?from=${encodeURIComponent(selected.id)}&to=${encodeURIComponent(compareTo.id)}`,
      );
      const data: unknown = await res.json();
      if (!res.ok || !isPlanPayload(data)) {
        throw new Error(readError(data) ?? "rollback plan request failed");
      }
      setPlan({
        ops: data.ops,
        targetFirmwareHash: data.targetFirmwareHash,
        fromId: selected.id,
        toId: compareTo.id,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanLoading(false);
    }
  };

  const fork = async () => {
    if (!selected) return;
    const branch = window.prompt('New branch name (e.g. "dht11-experiment"):');
    if (!branch || branch.trim() === "") return;
    setForking(true);
    try {
      const res = await fetch("/api/commits/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromId: selected.id, branch: branch.trim() }),
      });
      const data: unknown = await res.json();
      if (!res.ok) throw new Error(readError(data) ?? "fork request failed");
      setError(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setForking(false);
    }
  };

  return (
    <>
      <h1>Timeline</h1>
      <p className="muted" style={{ fontSize: "0.9rem" }}>
        git for hardware: every working board state is a commit. Pick a point on
        the left; the right shows that state and what changed to reach it.
      </p>

      {error && <div className="banner error">{error}</div>}

      <div className="timeline-split">
        {/* LEFT: the build progression */}
        <aside className="timeline-rail">
          <h2 style={{ fontSize: "0.8rem", color: "var(--muted)", marginBottom: "0.5rem" }}>
            Progress ({commits.length})
          </h2>
          {!loaded ? (
            <p className="muted">Loading…</p>
          ) : newestFirst.length === 0 ? (
            <p className="muted">
              No commits yet. Finish a build on Assemble and commit it.
            </p>
          ) : (
            <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {newestFirst.map((c, i) => {
                const isSel = c.id === selectedId;
                const isCmp = compareTo?.id === c.id && !isSel;
                return (
                  <li key={c.id} style={{ position: "relative" }}>
                    {i < newestFirst.length - 1 ? (
                      <span
                        aria-hidden
                        style={{
                          position: "absolute",
                          left: 11,
                          top: 26,
                          bottom: -6,
                          width: 2,
                          background: "var(--border)",
                        }}
                      />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => pick(c.id)}
                      aria-current={isSel ? "true" : undefined}
                      className={`timeline-node${isSel ? " is-selected" : ""}`}
                    >
                      <span
                        aria-hidden
                        className="timeline-dot"
                        style={{
                          background: isSel
                            ? "var(--accent)"
                            : isCmp
                              ? "var(--warn)"
                              : "var(--panel)",
                          borderColor: isSel
                            ? "var(--accent)"
                            : isCmp
                              ? "var(--warn)"
                              : "var(--border)",
                        }}
                      />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: "block", fontSize: "0.85rem" }}>
                          {c.message}
                        </span>
                        <span
                          className="muted mono"
                          style={{ display: "block", fontSize: "0.68rem" }}
                        >
                          {formatWhen(c.createdAt)} · {c.branch} ·{" "}
                          {shortId(c.id)}
                          {isCmp ? " · comparing" : ""}
                        </span>
                      </span>
                      {c.photoDataUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={c.photoDataUrl}
                          alt=""
                          width={38}
                          height={28}
                          style={{
                            objectFit: "cover",
                            borderRadius: 4,
                            border: "1px solid var(--border)",
                            flexShrink: 0,
                          }}
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </aside>

        {/* RIGHT: the state at that point */}
        <section className="timeline-detail">
          {!selected ? (
            <div className="card">
              <p className="muted">Pick a point on the left to inspect it.</p>
            </div>
          ) : (
            <>
              <div className="card">
                <h2 style={{ fontSize: "1rem", marginBottom: "0.2rem" }}>
                  {selected.message}
                </h2>
                <p className="muted mono" style={{ fontSize: "0.75rem" }}>
                  {shortId(selected.id)} · branch {selected.branch} · fw{" "}
                  {selected.firmware.hash.slice(0, 8)} ·{" "}
                  {formatWhen(selected.createdAt)}
                </p>

                <div
                  style={{
                    display: "flex",
                    gap: "0.4rem",
                    alignItems: "center",
                    flexWrap: "wrap",
                    margin: "0.5rem 0",
                  }}
                >
                  <label className="muted" style={{ fontSize: "0.75rem" }}>
                    compare to
                  </label>
                  <select
                    value={compareId ?? ""}
                    onChange={(e) => {
                      setCompareId(e.target.value || null);
                      setPlan(null);
                    }}
                    aria-label="Comparison target"
                    style={{
                      background: "var(--bg)",
                      color: "var(--text)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "0.25rem 0.4rem",
                      fontSize: "0.75rem",
                      maxWidth: 260,
                    }}
                  >
                    <option value="">
                      {selected.parent
                        ? "its parent (default)"
                        : "nothing (this is the root)"}
                    </option>
                    {newestFirst
                      .filter((c) => c.id !== selected.id)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.message.slice(0, 40)} · {shortId(c.id)}
                        </option>
                      ))}
                  </select>
                </div>

                <div style={{ margin: "0.5rem 0" }}>
                  <BoardView
                    netlist={selected.netlist}
                    {...(compareTo ? { diffAgainst: compareTo.netlist } : {})}
                    firmware={firmwareBadgeFor(selected)}
                  />
                  <p
                    className="muted"
                    style={{ fontSize: "0.72rem", textAlign: "center", marginTop: "0.25rem" }}
                  >
                    {compareTo
                      ? "green = added since the comparison · red dashed = removed · gray = unchanged"
                      : "the board as this commit left it"}
                  </p>
                </div>

                {selected.netlist.edges.length === 0 ? (
                  <p className="muted">Empty board.</p>
                ) : null}

                {selected.journal && selected.journal.length > 0 ? (
                  <JournalList entries={selected.journal} />
                ) : null}

                <div
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    flexWrap: "wrap",
                    marginTop: "0.6rem",
                  }}
                >
                  <button
                    className="btn"
                    disabled={forking}
                    onClick={() => void fork()}
                  >
                    {forking ? "Forking…" : "Fork from here"}
                  </button>
                  <button
                    className="btn"
                    disabled={!compareTo || planLoading}
                    style={{ opacity: !compareTo ? 0.5 : 1 }}
                    onClick={() => void loadPlan()}
                  >
                    {planLoading ? "Planning…" : "Plan rollback to comparison"}
                  </button>
                </div>
              </div>

              {stateDiff && compareTo ? (
                <div className="card">
                  <h3 style={{ fontSize: "0.9rem" }}>
                    What changed since {shortId(compareTo.id)}
                  </h3>
                  {stateDiff.added.length === 0 && stateDiff.removed.length === 0 ? (
                    <p className="muted">
                      Same wiring. Only the firmware differs
                      {selected.firmware.hash === compareTo.firmware.hash
                        ? " (and not even that)"
                        : ""}
                      .
                    </p>
                  ) : (
                    <>
                      {stateDiff.added.length > 0 ? (
                        <ul style={{ paddingLeft: "1.1rem", color: "var(--accent)" }}>
                          {stateDiff.added.map((e) => (
                            <li key={`a-${e.id}`}>added {describeEdge(e)}</li>
                          ))}
                        </ul>
                      ) : null}
                      {stateDiff.removed.length > 0 ? (
                        <ul style={{ paddingLeft: "1.1rem", color: "var(--error)" }}>
                          {stateDiff.removed.map((e) => (
                            <li key={`r-${e.id}`}>removed {describeEdge(e)}</li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}

              {plan ? (
                <div className="card">
                  <h3 style={{ fontSize: "0.9rem" }}>
                    Rollback: {shortId(plan.fromId)} → {shortId(plan.toId)}
                  </h3>
                  {plan.ops.length === 0 ? (
                    <p className="muted">Nothing to undo physically.</p>
                  ) : (
                    <ol style={{ paddingLeft: "1.2rem" }}>
                      {plan.ops.map((op, i) => (
                        <li key={`${op.op}-${i}`} style={{ marginBottom: "0.25rem" }}>
                          {op.instruction}
                        </li>
                      ))}
                    </ol>
                  )}
                  <p className="badge mono">
                    then re-flash firmware {plan.targetFirmwareHash.slice(0, 8)}
                  </p>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </>
  );
}
