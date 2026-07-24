"use client";

// Physical-move coach (FEEDBACK item 12, test T19): the user states a goal
// ("plug the USB cable into the Arduino's USB socket"), photographs their
// attempt, and the coach judges the REAL scene: named objects get ArMarkerLayer
// pins, the exact destination gets a distinct pulsing amber target, a movement
// arrow shows the correction, and the instruction banner says how to move in
// beginner physical terms. "Try again with a new photo" bumps the attempt and
// carries the prior instructions so the coach knows what it already said.
// Photo intake reuses the inventory raster pipeline (<= 1568 px JPEG).
// Every exchange fire-and-forgets to /api/journal with the frame.

import { useCallback, useRef, useState, type ChangeEvent } from "react";
import ArMarkerLayer from "@/components/ArMarkerLayer";
import { markerFromBbox } from "@/lib/inventory/markers";
import {
  coachResponseSchema,
  truncateHistory,
  type CoachResponse,
} from "@/lib/coach/contract";

/** Photo export cap; vision docs recommend small long edges (docs/references-coach.md). */
const MAX_EDGE = 1568;
const JPEG_QUALITY = 0.85;
const GOAL_MAX = 200;

const AMBER = "#f59e0b";

interface Frame {
  dataUrl: string;
  w: number;
  h: number;
}

function fitDims(w: number, h: number): { w: number; h: number } {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load image"));
    img.src = src;
  });
}

/** File -> <= 1568 px JPEG data URL (the inventory photo pipeline). */
async function rasterizeFile(file: File): Promise<Frame> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { w, h } = fitDims(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return { dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY), w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Fire-and-forget journal entry; failures never touch the coaching flow. */
function journalExchange(
  goal: string,
  attempt: number,
  verdict: string,
  instruction: string,
  frameDataUrl: string,
): void {
  void fetch("/api/journal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Shape matches POST /api/journal (lib/journal/store.ts AppendJournalInput):
    // the instruction is the entry summary; attempt travels as a string.
    body: JSON.stringify({
      kind: "coach",
      summary: instruction,
      goal,
      attempt: String(attempt),
      verdict,
      frameDataUrl,
    }),
  }).catch(() => {
    // Journal is best-effort; the coach works without it.
  });
}

/** Distinct pulsing target: amber halo + steady ring + label, on the exact spot. */
function TargetMarker({ x, y, label }: { x: number; y: number; label: string }) {
  const halo = 0.14; // fraction of the photo, matches the halo scale of ArMarkerLayer
  return (
    <div aria-hidden="true" style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
      <span
        style={{
          position: "absolute",
          left: `${(x - halo / 2) * 100}%`,
          top: `${(y - halo / 2) * 100}%`,
          width: `${halo * 100}%`,
          height: `${halo * 100}%`,
          borderRadius: 999,
          background:
            "radial-gradient(circle, rgba(245, 158, 11, 0.5) 0%, rgba(245, 158, 11, 0.18) 60%, rgba(245, 158, 11, 0) 100%)",
          boxShadow: "0 0 18px 6px rgba(245, 158, 11, 0.4)",
          animation: "forge-pulse 1.1s ease-out infinite",
          pointerEvents: "none",
        }}
      />
      <span
        style={{
          position: "absolute",
          left: `${x * 100}%`,
          top: `${y * 100}%`,
          width: 26,
          height: 26,
          marginLeft: -13,
          marginTop: -13,
          borderRadius: 999,
          border: `3px solid ${AMBER}`,
          boxShadow: "0 0 8px rgba(245, 158, 11, 0.7)",
        }}
      />
      <span
        style={{
          position: "absolute",
          left: `${x * 100}%`,
          top: `${y * 100}%`,
          width: 6,
          height: 6,
          marginLeft: -3,
          marginTop: -3,
          borderRadius: 999,
          background: AMBER,
        }}
      />
      <span
        className="ar-label"
        style={{
          position: "absolute",
          left: `${x * 100}%`,
          top: `${y * 100}%`,
          transform: "translate(-50%, 18px)",
          borderColor: AMBER,
        }}
      >
        {label}
      </span>
    </div>
  );
}

export default function CoachPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Submitted-state source of truth (state mirrors are for display only). */
  const attemptRef = useRef(1);
  const historyRef = useRef<string[]>([]);
  const lastGoalRef = useRef<string | null>(null);
  const lastResponseRef = useRef<CoachResponse | null>(null);

  const [goal, setGoal] = useState("");
  const [frame, setFrame] = useState<Frame | null>(null);
  const [response, setResponse] = useState<CoachResponse | null>(null);
  const [attempt, setAttempt] = useState(1);
  const [history, setHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitFrame = useCallback(async (f: Frame, g: string) => {
    // A new goal starts a fresh session; the same goal after a reply is the
    // next attempt and carries what the coach already said.
    let nextAttempt = 1;
    let nextHistory: string[] = [];
    if (g === lastGoalRef.current && lastResponseRef.current) {
      nextHistory = truncateHistory([
        ...historyRef.current,
        lastResponseRef.current.instruction,
      ]);
      nextAttempt = attemptRef.current + 1;
    }
    lastGoalRef.current = g;
    attemptRef.current = nextAttempt;
    historyRef.current = nextHistory;
    setAttempt(nextAttempt);
    setHistory(nextHistory);
    setFrame(f);
    setResponse(null);
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: g,
          imageBase64: f.dataUrl,
          attempt: nextAttempt,
          ...(nextHistory.length > 0 ? { history: nextHistory } : {}),
        }),
      });
      const raw: unknown = await res.json();
      const parsed = coachResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          res.ok
            ? "unexpected /api/coach response shape"
            : `coach request failed (HTTP ${res.status})`,
        );
      }
      setResponse(parsed.data);
      lastResponseRef.current = parsed.data;
      journalExchange(g, nextAttempt, parsed.data.verdict, parsed.data.instruction, f.dataUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const onFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      const g = goal.trim().slice(0, GOAL_MAX);
      if (!file || !g) return;
      void (async () => {
        try {
          const f = await rasterizeFile(file);
          await submitFrame(f, g);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [goal, submitFrame],
  );

  const startOver = useCallback(() => {
    lastGoalRef.current = null;
    lastResponseRef.current = null;
    attemptRef.current = 1;
    historyRef.current = [];
    setAttempt(1);
    setHistory([]);
    setFrame(null);
    setResponse(null);
    setError(null);
  }, []);

  const trimmedGoal = goal.trim();
  const markers = response
    ? response.objects.map((o) => markerFromBbox(o.bbox, o.label, "find"))
    : [];
  const hasResult = response !== null && !loading;

  return (
    <>
      <h1>Coach — show me your move</h1>

      <div className="card">
        <label htmlFor="coach-goal" style={{ display: "block", marginBottom: "0.4rem" }}>
          What are you trying to do?
        </label>
        <input
          id="coach-goal"
          type="text"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          maxLength={GOAL_MAX}
          placeholder="plug the USB cable into the Arduino’s USB socket"
          style={{
            width: "100%",
            padding: "0.6rem 0.9rem",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--text)",
            fontSize: "1rem",
          }}
        />
        <div
          style={{
            display: "flex",
            gap: "0.6rem",
            alignItems: "center",
            flexWrap: "wrap",
            marginTop: "0.6rem",
          }}
        >
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading || !trimmedGoal}
          >
            {hasResult ? "Try again with a new photo" : "Photograph your attempt"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onFileChange}
            style={{ display: "none" }}
          />
          {frame || response ? (
            <button type="button" className="btn" onClick={startOver} disabled={loading}>
              Start over
            </button>
          ) : null}
          <span className="badge">attempt {attempt}</span>
          {loading ? <span className="muted">Coaching…</span> : null}
        </div>
        {!trimmedGoal ? (
          <p className="muted" style={{ margin: "0.6rem 0 0", fontSize: "0.85rem" }}>
            Type your goal first, then photograph what you did. Deliberately
            wrong guesses welcome: the coach tells you how to move.
          </p>
        ) : null}
      </div>

      {error ? <div className="banner error">{error}</div> : null}

      {response ? (
        response.verdict === "done" ? (
          <div className="banner" style={{ borderLeftColor: "var(--accent)" }}>
            <strong style={{ color: "var(--accent)" }}>✓ Done.</strong>{" "}
            {response.instruction}
          </div>
        ) : response.verdict === "adjust" ? (
          <div className="banner warn">
            <strong style={{ color: AMBER }}>Adjust:</strong> {response.instruction}
          </div>
        ) : (
          <div
            className="banner"
            style={{ borderLeftColor: "var(--muted)", color: "var(--muted)" }}
          >
            <strong>Can’t see enough.</strong> {response.instruction}
          </div>
        )
      ) : null}
      {response?.note ? (
        <p className="muted" style={{ fontSize: "0.8rem", marginTop: "-0.35rem" }}>
          {response.note}
        </p>
      ) : null}

      {frame ? (
        <div className="card">
          <div style={{ position: "relative" }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- the attempt photo is an in-memory data URL */}
            <img
              src={frame.dataUrl}
              alt={`Your attempt photo for "${lastGoalRef.current ?? trimmedGoal}"`}
              style={{
                width: "100%",
                display: "block",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "#000",
              }}
            />
            <ArMarkerLayer markers={markers} visible={hasResult} />
            {hasResult && response?.target ? (
              <TargetMarker
                x={response.target.x}
                y={response.target.y}
                label={response.target.label}
              />
            ) : null}
            {hasResult && response?.arrow ? (
              <svg
                aria-hidden="true"
                viewBox={`0 0 ${frame.w} ${frame.h}`}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  pointerEvents: "none",
                }}
              >
                <defs>
                  <marker
                    id="coach-arrowhead"
                    markerWidth="8"
                    markerHeight="8"
                    refX="6"
                    refY="4"
                    orient="auto"
                  >
                    <path d="M0,0 L8,4 L0,8 z" fill={AMBER} />
                  </marker>
                </defs>
                <line
                  x1={response.arrow.from.x * frame.w}
                  y1={response.arrow.from.y * frame.h}
                  x2={response.arrow.to.x * frame.w}
                  y2={response.arrow.to.y * frame.h}
                  stroke={AMBER}
                  strokeWidth={Math.max(3, frame.w * 0.004)}
                  strokeDasharray={`${Math.max(8, frame.w * 0.012)} ${Math.max(6, frame.w * 0.008)}`}
                  strokeLinecap="round"
                  markerEnd="url(#coach-arrowhead)"
                  opacity={0.9}
                />
              </svg>
            ) : null}
            {loading ? (
              <span
                style={{
                  position: "absolute",
                  bottom: 12,
                  left: "50%",
                  transform: "translateX(-50%)",
                  background: "rgba(11, 15, 20, 0.85)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                  padding: "0.25rem 0.9rem",
                  borderRadius: 999,
                  fontSize: "0.85rem",
                  whiteSpace: "nowrap",
                }}
              >
                the coach is studying your photo…
              </span>
            ) : null}
          </div>
          {hasResult ? (
            <p className="muted" style={{ margin: "0.6rem 0 0", fontSize: "0.85rem" }}>
              Green pins name what the coach sees; the pulsing amber ring is the
              exact destination{response?.arrow ? "; the dashed arrow is your move" : ""}.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="card">
          <p className="muted" style={{ marginBottom: 0 }}>
            No photo yet. State your goal, make your move (wrong guesses are
            fine), and photograph the result. The coach marks up your real
            scene and tells you what to change.
          </p>
        </div>
      )}

      {history.length > 0 ? (
        <div className="card">
          <h2 style={{ fontSize: "0.95rem", marginTop: 0 }}>
            What the coach already told you
          </h2>
          <ol style={{ margin: 0, paddingLeft: "1.2rem" }}>
            {history.map((h, i) => (
              <li key={i} className="muted" style={{ fontSize: "0.85rem" }}>
                {h}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </>
  );
}
