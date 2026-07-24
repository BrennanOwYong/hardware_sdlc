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

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import ArMarkerLayer from "@/components/ArMarkerLayer";
import GuideArrow from "@/components/GuideArrow";
import MaskOverlay from "@/components/MaskOverlay";
import CaptureHistory, { type CaptureItem } from "@/components/CaptureHistory";
import { markerFromBbox } from "@/lib/inventory/markers";
import { photoFileUrl } from "@/lib/photos/contract";
import {
  coachResponseSchema,
  truncateHistory,
  type CoachResponse,
} from "@/lib/coach/contract";

/** Shape of a stored coach photo as /api/photos?full=1 returns it. */
interface StoredCoachPhoto {
  id: string;
  width: number;
  height: number;
  coach?: {
    goal: string;
    verdict: string;
    instruction: string;
    guide?: CoachResponse["guide"];
  };
}

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
  const [pastAttempts, setPastAttempts] = useState<CaptureItem[]>([]);
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);

  // Load prior coach captures so a past attempt is one tap away.
  const loadPastAttempts = useCallback(async () => {
    try {
      const res = await fetch("/api/photos");
      if (!res.ok) return;
      const data: unknown = await res.json();
      const photos =
        data && typeof data === "object" && "photos" in data
          ? (data as { photos: CaptureItem[] }).photos
          : [];
      setPastAttempts(photos.filter((p) => p.surface === "coach"));
    } catch {
      /* history is a convenience; ignore load failures */
    }
  }, []);

  useEffect(() => {
    void loadPastAttempts();
  }, [loadPastAttempts]);

  // Persist a fresh attempt: store the JPEG, then attach the coaching result.
  const persistCapture = useCallback(
    async (f: Frame, g: string, resp: CoachResponse) => {
      try {
        const created = await fetch("/api/photos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            photoDataUrl: f.dataUrl,
            width: f.w,
            height: f.h,
            surface: "coach",
            label: g.slice(0, 60),
          }),
        });
        if (!created.ok) return;
        const { photo } = (await created.json()) as { photo: { id: string } };
        await fetch(`/api/photos/${photo.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            coach: {
              goal: g,
              verdict: resp.verdict,
              instruction: resp.instruction,
              ...(resp.guide ? { guide: resp.guide } : {}),
            },
          }),
        });
        void loadPastAttempts();
      } catch {
        /* persistence is best-effort; a failed save never blocks coaching */
      }
    },
    [loadPastAttempts],
  );

  // Reopen a stored attempt with its arrow and highlight intact, no API spend.
  const recallCapture = useCallback(async (id: string) => {
    setError(null);
    try {
      const res = await fetch("/api/photos?full=1");
      const data = (await res.json()) as { photos: StoredCoachPhoto[] };
      const found = data.photos.find((p) => p.id === id);
      if (!found || !found.coach) {
        setError("That saved attempt could not be reopened.");
        return;
      }
      setSelectedCaptureId(id);
      setGoal(found.coach.goal);
      setFrame({ dataUrl: photoFileUrl(id), w: found.width, h: found.height });
      // Rebuild a display-only response from the stored coaching result. The
      // arrow and highlight come from the saved guide, so it looks identical
      // to the live result without re-running vision.
      const guide = found.coach.guide ?? null;
      setResponse({
        verdict: found.coach.verdict as CoachResponse["verdict"],
        instruction: found.coach.instruction,
        objects: [],
        target: guide
          ? { x: guide.to.x, y: guide.to.y, label: found.coach.goal.slice(0, 24) }
          : null,
        arrow: null,
        guide,
        confidence: 1,
        note: "recalled from history",
      });
    } catch {
      setError("That saved attempt could not be reopened.");
    }
  }, []);

  const deleteCapture = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/photos/${id}`, { method: "DELETE" });
        if (selectedCaptureId === id) setSelectedCaptureId(null);
        void loadPastAttempts();
      } catch {
        /* ignore */
      }
    },
    [selectedCaptureId, loadPastAttempts],
  );

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
      // Persist the attempt so it can be reopened without re-shooting.
      void persistCapture(f, g, parsed.data);
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

      <CaptureHistory
        title="Past attempts"
        items={pastAttempts}
        selectedId={selectedCaptureId}
        onSelect={(id) => void recallCapture(id)}
        onDelete={(id) => void deleteCapture(id)}
        emptyHint="Photos you take here are saved with their guidance, so you can reopen an attempt without shooting it again."
      />

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
          {response.guide ? (
            <span
              className="badge"
              style={{
                marginLeft: "0.4rem",
                borderColor:
                  response.guide.source === "mask" ? "var(--accent)" : "var(--warn)",
                color: response.guide.source === "mask" ? "var(--accent)" : "var(--warn)",
              }}
              title={response.guide.note}
            >
              {response.guide.source === "mask"
                ? "pixel-accurate"
                : "estimated position"}
            </span>
          ) : null}
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
            {/* The destination highlighted by its OWN pixels when segmentation
                resolved it, so the user sees the exact socket rather than a
                dot floating near it. */}
            {hasResult && response?.guide?.targetMaskPng && response.guide.targetBbox ? (
              <MaskOverlay
                parts={[
                  {
                    id: "coach-target",
                    label: response.target?.label ?? "here",
                    partType: "target",
                    confidence: 1,
                    bbox: response.guide.targetBbox as [number, number, number, number],
                    maskPng: response.guide.targetMaskPng,
                  },
                ]}
                width={frame.w}
                height={frame.h}
              />
            ) : hasResult && response?.target ? (
              <TargetMarker
                x={response.target.x}
                y={response.target.y}
                label={response.target.label}
              />
            ) : null}

            {/* Arrow endpoints come from mask geometry when both objects were
                segmented; otherwise it draws dashed to admit it is an estimate. */}
            {hasResult && response?.guide ? (
              <GuideArrow
                from={response.guide.from}
                to={response.guide.to}
                label={response.target?.label}
                precision={response.guide.source}
              />
            ) : hasResult && response?.arrow ? (
              <GuideArrow
                from={response.arrow.from}
                to={response.arrow.to}
                label={response.target?.label}
                precision="model"
              />
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
