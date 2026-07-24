"use client";

// A horizontal strip of past captures, shared by the inventory and coach
// pages so history looks and behaves the same on both. Dumb by design: it is
// handed a list and two callbacks, and it renders thumbnails served straight
// from disk (no re-processing) with a delete affordance.

import { photoFileUrl } from "@/lib/photos/contract";

export interface CaptureItem {
  id: string;
  label: string;
  capturedAt: string;
  /** "inventory" | "coach"; absent means an older inventory capture. */
  surface?: string;
}

export interface CaptureHistoryProps {
  title: string;
  items: CaptureItem[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  /** Shown when the strip is empty, so the feature explains itself. */
  emptyHint: string;
}

function timeAgo(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const mins = Math.max(0, Math.round((nowMs - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function CaptureHistory({
  title,
  items,
  selectedId,
  onSelect,
  onDelete,
  emptyHint,
}: CaptureHistoryProps) {
  // A fixed reference avoids Date.now() during render churn; recomputed each
  // mount, which is precise enough for "5m ago".
  const now = Date.now();

  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: "0.4rem",
        }}
      >
        <h2 style={{ fontSize: "0.9rem", margin: 0 }}>{title}</h2>
        <span className="muted" style={{ fontSize: "0.75rem" }}>
          {items.length > 0
            ? `${items.length} saved · newest ${timeAgo(items[0].capturedAt, now)}`
            : ""}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
          {emptyHint}
        </p>
      ) : (
        <div
          style={{
            display: "flex",
            gap: "0.55rem",
            overflowX: "auto",
            paddingBottom: "0.3rem",
          }}
        >
          {items.map((it) => {
            const selected = it.id === selectedId;
            return (
              <div
                key={it.id}
                style={{
                  position: "relative",
                  flex: "0 0 auto",
                  width: 104,
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelect(it.id)}
                  title={it.label}
                  style={{
                    width: "100%",
                    padding: 0,
                    border: `2px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                    borderRadius: 8,
                    overflow: "hidden",
                    background: "var(--bg)",
                    cursor: "pointer",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photoFileUrl(it.id)}
                    alt={it.label}
                    style={{
                      width: "100%",
                      height: 74,
                      objectFit: "cover",
                      display: "block",
                    }}
                  />
                  <span
                    style={{
                      display: "block",
                      fontSize: "0.68rem",
                      color: "var(--text)",
                      padding: "0.2rem 0.3rem",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      textAlign: "left",
                    }}
                  >
                    {it.label}
                  </span>
                  <span
                    className="muted"
                    style={{
                      display: "block",
                      fontSize: "0.62rem",
                      padding: "0 0.3rem 0.25rem",
                      textAlign: "left",
                    }}
                  >
                    {timeAgo(it.capturedAt, now)}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${it.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(it.id);
                  }}
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    border: "none",
                    background: "rgba(11,15,20,0.8)",
                    color: "var(--muted)",
                    cursor: "pointer",
                    lineHeight: 1,
                    fontSize: "0.85rem",
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
