"use client";

// Two overlapping circles: what your desk holds, what the build needs, and the
// parts that satisfy both. The near-miss rows ("need 4, saw 3, get 1 more")
// are the reason this panel exists, so they are the loudest thing in it.

import { useEffect, useState } from "react";
import type { VennResult, ShortRow } from "@/lib/gapx/venn";
import { describeShortfall, summariseVenn } from "@/lib/gapx/venn";
import { describeCount } from "@/lib/gapx/counts";

export interface VennPanelProps {
  venn: VennResult;
  /** Called when a shortfall row is tapped, so the page can reveal listings. */
  onPickShortfall?: (row: ShortRow) => void;
  selectedKind?: string | null;
}

const NARROW_QUERY = "(max-width: 380px)";

export default function VennPanel({
  venn,
  onPickShortfall,
  selectedKind,
}: VennPanelProps) {
  // Circles are unreadable on a small phone; the same information reads fine
  // as stacked lists, so drop the diagram rather than shrinking it.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const haveOnly = venn.surplus.length;
  const both = venn.satisfied.length;
  const needOnly = venn.short.length + venn.unknown.length;

  return (
    <div className="card">
      <h2 style={{ fontSize: "0.95rem", marginBottom: "0.2rem" }}>
        What you have vs what this needs
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {summariseVenn(venn)}
      </p>

      {!narrow ? (
        <svg
          viewBox="0 0 320 150"
          role="img"
          aria-label={`Venn diagram: ${haveOnly} parts you own and do not need, ${both} that match, ${needOnly} still to get`}
          style={{ width: "100%", maxWidth: 420, display: "block", margin: "0 auto" }}
        >
          <circle cx="120" cy="75" r="62" fill="rgba(139,152,165,0.16)" stroke="var(--muted)" />
          <circle cx="200" cy="75" r="62" fill="rgba(245,158,11,0.14)" stroke="var(--warn)" />
          <text x="72" y="24" textAnchor="middle" fontSize="11" fill="var(--muted)">
            on your desk
          </text>
          <text x="252" y="24" textAnchor="middle" fontSize="11" fill="var(--warn)">
            this build needs
          </text>
          <text x="92" y="72" textAnchor="middle" fontSize="26" fill="var(--muted)">
            {haveOnly}
          </text>
          <text x="92" y="90" textAnchor="middle" fontSize="9" fill="var(--muted)">
            unused
          </text>
          <text x="160" y="70" textAnchor="middle" fontSize="26" fill="var(--accent)">
            {both}
          </text>
          <text x="160" y="88" textAnchor="middle" fontSize="9" fill="var(--accent)">
            covered
          </text>
          <text x="228" y="72" textAnchor="middle" fontSize="26" fill="var(--warn)">
            {needOnly}
          </text>
          <text x="228" y="90" textAnchor="middle" fontSize="9" fill="var(--warn)">
            to get
          </text>
        </svg>
      ) : null}

      {venn.short.length > 0 ? (
        <>
          <h3 style={{ fontSize: "0.85rem", color: "var(--warn)", marginTop: "0.6rem" }}>
            Still short
          </h3>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {venn.short.map((s) => (
              <li key={s.kind + s.name}>
                <button
                  type="button"
                  onClick={() => onPickShortfall?.(s)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background:
                      selectedKind === s.kind ? "rgba(245,158,11,0.12)" : "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "0.45rem 0.6rem",
                    marginBottom: "0.35rem",
                    color: "var(--text)",
                    font: "inherit",
                    cursor: onPickShortfall ? "pointer" : "default",
                  }}
                >
                  <strong>{describeShortfall(s)}</strong>
                  {s.have > 0 ? (
                    <span className="badge" style={{ marginLeft: "0.4rem" }}>
                      partly covered
                    </span>
                  ) : null}
                  {!s.critical ? (
                    <span className="badge" style={{ marginLeft: "0.4rem" }}>
                      nice to have
                    </span>
                  ) : null}
                  <span className="muted" style={{ display: "block", fontSize: "0.78rem" }}>
                    {s.why}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {venn.unknown.length > 0 ? (
        <>
          <h3 style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
            Cannot count these from the photo
          </h3>
          <ul style={{ paddingLeft: "1.1rem", margin: 0 }}>
            {venn.unknown.map((u) => (
              <li key={u.kind} style={{ marginBottom: "0.25rem" }}>
                {u.question}{" "}
                <span className="muted mono" style={{ fontSize: "0.75rem" }}>
                  (saw {describeCount(u.estimate)})
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {venn.satisfied.length > 0 ? (
        <details style={{ marginTop: "0.5rem" }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: "0.82rem" }}>
            Already covered ({venn.satisfied.length})
          </summary>
          <ul style={{ paddingLeft: "1.1rem", marginTop: "0.4rem" }}>
            {venn.satisfied.map((s) => (
              <li key={s.kind} style={{ color: "var(--accent)" }}>
                {s.name} — need {s.need}, have {s.have}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
