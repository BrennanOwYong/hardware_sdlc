"use client";

// Guided assembly (P2): mode picker (Demo autoplay / Manual sim / Live
// camera / Live screen / Practice video), two-stage confirmation banner,
// BoardView or video+Overlay, step progress rail, codegen on completion,
// commit to the build timeline.
//
// Practice video mode is a live mode without hardware: the <video> element
// plays a curated real-footage clip from public/practice/ (manifest loaded
// through lib/practice/manifest) and the same frame-capture loop posts
// frames with step context to /api/perceive. Keyless servers answer with a
// note and no events, so the step machine stays put - identical to the
// camera/screen keyless behavior. References:
// docs/references-practice-modes.md.
//
// Perception arrives through hooks/usePerception (the shared hook from the
// perception builder). The hook owns media acquisition and frame capture;
// this page supplies the videoRef, the live step context (instruction +
// expected targets + awaiting-tip/awaiting-seat phase), and drains the
// hook's event log into the step-graph reducer.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useReducer,
  useState,
} from "react";
import { z } from "zod";
import type {
  BackendMode,
  CodegenResult,
  LiveSourceOptions,
  Netlist,
} from "@/lib/types";
import { buttonLedSteps, refLabel } from "@/lib/assembly/circuits";
import { demoScript } from "@/lib/assembly/mockscript";
import { fallbackCodegen } from "@/lib/assembly/codegenFallback";
import {
  createInitialState,
  currentStep,
  observedNetlist,
  progressPct,
  reducer,
} from "@/lib/assembly/stepgraph";
import { usePerception } from "@/hooks/usePerception";
import type { LiveStepContext } from "@/lib/perception";
import {
  loadPracticeManifest,
  practiceMediaUrl,
  type PracticeMediaItem,
} from "@/lib/practice/manifest";
import BoardView from "@/components/BoardView";
import Overlay from "@/components/Overlay";
import StepList from "@/components/StepList";
import SimulatePanel from "@/components/SimulatePanel";
import CodePanel from "@/components/CodePanel";

type UiMode =
  | "demo"
  | "manual"
  | "live-camera"
  | "live-screen"
  | "practice-video";

const MODE_LABELS: { id: UiMode; label: string }[] = [
  { id: "demo", label: "Demo autoplay" },
  { id: "manual", label: "Manual sim" },
  { id: "live-camera", label: "Live camera" },
  { id: "live-screen", label: "Live screen" },
  { id: "practice-video", label: "Practice video" },
];

const codegenResultSchema = z.object({
  code: z.string(),
  hash: z.string(),
  pinsUsed: z.array(z.string()),
  via: z.enum(["template", "llm"]),
  note: z.string().optional(),
});

function AssembleInner() {
  const searchParams = useSearchParams();
  const autoDemo = searchParams.get("demo") === "auto";

  const [uiMode, setUiMode] = useState<UiMode>("demo");
  const [state, dispatch] = useReducer(
    reducer,
    buttonLedSteps,
    createInitialState,
  );

  const [codegen, setCodegen] = useState<CodegenResult | null>(null);
  const [codegenLoading, setCodegenLoading] = useState(false);
  const [codegenNote, setCodegenNote] = useState<string | null>(null);
  const [commitState, setCommitState] = useState<
    "idle" | "saving" | "done" | "failed"
  >("idle");
  const [commitMessage, setCommitMessage] = useState(
    "button-led: all 7 steps seated",
  );
  const codegenRequested = useRef(false);

  // Practice video: manifest entries + which clip the user picked.
  const [practiceVideos, setPracticeVideos] = useState<PracticeMediaItem[]>([]);
  const [practiceFile, setPracticeFile] = useState<string | null>(null);
  const [practiceNote, setPracticeNote] = useState<string | null>(null);
  const practiceLoadRequested = useRef(false);

  const perceptionMode: BackendMode =
    uiMode === "demo" ? "mock" : uiMode === "manual" ? "manual" : "live";
  const live = useMemo<LiveSourceOptions | undefined>(() => {
    if (uiMode === "live-camera") return { source: "camera", intervalMs: 1000 };
    if (uiMode === "live-screen") return { source: "screen", intervalMs: 1000 };
    if (uiMode === "practice-video" && practiceFile) {
      return {
        source: "file",
        fileUrl: practiceMediaUrl({ file: practiceFile }),
        intervalMs: 1000,
      };
    }
    return undefined;
  }, [uiMode, practiceFile]);
  const script = uiMode === "demo" ? demoScript : undefined;

  // Fetch the practice manifest once, on first entry into practice mode.
  // A failure degrades to a note; every other mode keeps working.
  useEffect(() => {
    if (uiMode !== "practice-video" || practiceLoadRequested.current) return;
    practiceLoadRequested.current = true;
    loadPracticeManifest()
      .then((manifest) => {
        setPracticeVideos(manifest.videos);
        setPracticeFile(manifest.videos[0]?.file ?? null);
        if (manifest.videos.length === 0) {
          setPracticeNote(
            "The practice media list has no videos, so there is nothing to play here. Demo, Manual, and the live modes still work.",
          );
        }
      })
      .catch((err: unknown) => {
        setPracticeNote(
          `Practice videos unavailable: ${err instanceof Error ? err.message : String(err)}. Demo, Manual, and the live modes still work.`,
        );
      });
  }, [uiMode]);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Live mode step context: the hook reads this through a ref on every poll,
  // so a fresh closure per render is fine. Returning null pauses polling
  // (during the seated beat, the error block, and after completion).
  const getStepContext = (): LiveStepContext | null => {
    const step = currentStep(state);
    if (!step) return null;
    if (state.phase !== "active" && state.phase !== "tip-on-target") {
      return null;
    }
    return {
      instruction: step.instruction,
      expectedTargets: step.targets.map((t) => t.ref),
      phase: state.phase === "tip-on-target" ? "awaiting-seat" : "awaiting-tip",
      edgeId: step.edge.id,
    };
  };

  const {
    events,
    running,
    error: perceptionError,
    note: perceptionNote,
    start,
    stop,
    inject,
  } = usePerception(perceptionMode, { script, live, videoRef, getStepContext });

  // Drain the hook's event log into the step-graph reducer exactly once per
  // event. start() clears the log, so a shrinking array resets the cursor.
  const processedRef = useRef(0);
  useEffect(() => {
    if (events.length < processedRef.current) processedRef.current = 0;
    for (; processedRef.current < events.length; processedRef.current += 1) {
      dispatch(events[processedRef.current]);
    }
  }, [events]);

  // Manual mode: inject() only reaches a backend after start(), and the
  // ManualBackend needs no user gesture, so start it as soon as the mode is
  // selected.
  useEffect(() => {
    if (uiMode === "manual" && !running) start();
  }, [uiMode, running, start]);

  const resetBuild = useCallback(() => {
    dispatch({ type: "restart" });
    codegenRequested.current = false;
    setCodegen(null);
    setCodegenNote(null);
    setCodegenLoading(false);
    setCommitState("idle");
  }, []);

  const playDemo = useCallback(() => {
    resetBuild();
    start();
  }, [resetBuild, start]);

  const switchMode = useCallback(
    (m: UiMode) => {
      stop();
      setUiMode(m);
      resetBuild();
    },
    [stop, resetBuild],
  );

  // ?demo=auto starts the scripted build on first load.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoDemo && uiMode === "demo" && !autoStarted.current) {
      autoStarted.current = true;
      start();
    }
  }, [autoDemo, uiMode, start]);

  // Two-stage confirmation: after "seated", auto-advance ~800ms later.
  useEffect(() => {
    if (state.phase !== "seated" || state.complete) return;
    const t = setTimeout(() => dispatch({ type: "advance" }), 800);
    return () => clearTimeout(t);
  }, [state.phase, state.currentIndex, state.complete]);

  // Demo autoplay: clear the deliberate error after a beat so the script's
  // correction events land on an active step.
  useEffect(() => {
    if (uiMode !== "demo" || state.phase !== "error") return;
    const t = setTimeout(() => dispatch({ type: "reset" }), 1500);
    return () => clearTimeout(t);
  }, [uiMode, state.phase]);

  // All steps seated -> generate firmware from the observed netlist.
  const runCodegen = useCallback(
    async (netlist: Netlist, intent?: string) => {
      setCodegenLoading(true);
      setCodegenNote(null);
      try {
        const res = await fetch("/api/codegen", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            netlist,
            circuitHint: "button-led",
            ...(intent ? { intent } : {}),
          }),
        });
        if (!res.ok) throw new Error(`codegen route returned ${res.status}`);
        const parsed = codegenResultSchema.safeParse(await res.json());
        if (!parsed.success) {
          throw new Error("codegen response failed validation");
        }
        const { note, ...result } = parsed.data;
        setCodegen(result);
        if (note) setCodegenNote(note);
      } catch (err) {
        const local = fallbackCodegen(netlist);
        setCodegen(local);
        setCodegenNote(
          `Codegen route unavailable (${err instanceof Error ? err.message : String(err)}). Showing the local deterministic template instead.`,
        );
      } finally {
        setCodegenLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!state.complete || codegenRequested.current) return;
    codegenRequested.current = true;
    void runCodegen(observedNetlist(state));
  }, [state, runCodegen]);

  const commitBuild = useCallback(async () => {
    if (!codegen) return;
    setCommitState("saving");
    try {
      const res = await fetch("/api/commits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: commitMessage,
          netlist: observedNetlist(state),
          firmware: { code: codegen.code, hash: codegen.hash },
        }),
      });
      if (!res.ok) throw new Error(`commits route returned ${res.status}`);
      setCommitState("done");
    } catch {
      setCommitState("failed");
    }
  }, [codegen, commitMessage, state]);

  const step = currentStep(state);
  const seatedSteps = state.steps.filter((s) =>
    state.seatedIds.includes(s.edge.id),
  );
  const isLive =
    uiMode === "live-camera" ||
    uiMode === "live-screen" ||
    uiMode === "practice-video";
  const practiceItem =
    uiMode === "practice-video" && practiceFile
      ? (practiceVideos.find((v) => v.file === practiceFile) ?? null)
      : null;
  const pct = progressPct(state);

  const stageHint = step
    ? step.edge.kind === "wire"
      ? `Stage 1 of 2: touch the wire tip to ${refLabel(step.edge.from)}`
      : `Stage 1 of 2: touch the ${step.edge.part ?? "part"}'s first leg to ${refLabel(step.edge.from)}`
    : "";

  return (
    <>
      <h1>Guided assembly</h1>

      {/* Mode picker */}
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          marginBottom: "0.75rem",
        }}
      >
        {MODE_LABELS.map((m) => (
          <button
            key={m.id}
            type="button"
            className={uiMode === m.id ? "btn btn-primary" : "btn"}
            onClick={() => switchMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {uiMode === "demo" ? (
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
            marginBottom: "0.75rem",
          }}
        >
          <button type="button" className="btn btn-primary" onClick={playDemo}>
            {running ? "Replay demo" : "Play demo"}
          </button>
          <button type="button" className="btn" onClick={resetBuild}>
            Restart build
          </button>
          <span className="badge">scripted perception</span>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: "0.75rem",
          }}
        >
          {isLive ? (
            // getDisplayMedia / getUserMedia need a user gesture, so live
            // capture starts from this click, never automatically. Practice
            // video keeps the same click-to-start flow: play() is awaited
            // inside start() and the capture loop begins with playback.
            running ? (
              <button type="button" className="btn" onClick={stop}>
                Stop capture
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={start}
                disabled={uiMode === "practice-video" && !practiceFile}
              >
                {uiMode === "live-camera"
                  ? "Start camera"
                  : uiMode === "live-screen"
                    ? "Share screen"
                    : "Play practice video"}
              </button>
            )
          ) : null}
          <button type="button" className="btn" onClick={resetBuild}>
            Restart build
          </button>
          {isLive && running ? (
            <span className="badge">watching every ~1s</span>
          ) : null}
        </div>
      )}

      {/* Practice video: clip picker (when more than one) + degrade note */}
      {uiMode === "practice-video" && practiceNote ? (
        <div className="banner warn">{practiceNote}</div>
      ) : null}
      {uiMode === "practice-video" && practiceVideos.length > 1 ? (
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: "0.75rem",
          }}
          role="group"
          aria-label="Practice video clip"
        >
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            Clip:
          </span>
          {practiceVideos.map((v) => (
            <button
              key={v.file}
              type="button"
              className={practiceFile === v.file ? "btn btn-primary" : "btn"}
              aria-pressed={practiceFile === v.file}
              onClick={() => {
                // Switching clips mid-run stops capture; the user restarts
                // with the Play button (same gesture flow as the live modes).
                stop();
                setPracticeFile(v.file);
              }}
            >
              {v.title}
            </button>
          ))}
        </div>
      ) : null}

      {isLive && perceptionError ? (
        <div className="banner warn">
          {uiMode === "practice-video" ? (
            <>
              Practice video failed: {perceptionError}. The clip lives under
              /practice/; Demo and Manual sim work without it.
            </>
          ) : (
            <>
              Live capture failed: {perceptionError}. Camera needs HTTPS (or
              localhost); screen share is desktop-only. Manual sim and Demo
              autoplay work without either.
            </>
          )}
        </div>
      ) : null}

      {/* Instruction banner: the two-stage messaging */}
      {state.complete ? (
        <div className="banner" style={{ fontSize: "1.05rem" }}>
          <strong style={{ color: "#22c55e" }}>
            ✓ All {state.steps.length} steps seated.
          </strong>{" "}
          Generating firmware from the pins the system watched you use.
        </div>
      ) : state.phase === "error" ? (
        <div className="banner error">
          <strong style={{ color: "#ef4444" }}>Wrong placement.</strong>{" "}
          {state.errorMessage}
          <div style={{ marginTop: "0.5rem" }}>
            <button
              type="button"
              className="btn"
              onClick={() => dispatch({ type: "reset" })}
            >
              I pulled it out - retry
            </button>
          </div>
        </div>
      ) : state.phase === "tip-on-target" ? (
        <div
          className="banner"
          style={{
            fontSize: "1.35rem",
            fontWeight: 700,
            color: "#22c55e",
            textAlign: "center",
          }}
        >
          Correct - push it in now
        </div>
      ) : state.phase === "seated" ? (
        <div className="banner" style={{ textAlign: "center" }}>
          <strong style={{ color: "#22c55e" }}>✓ Seated.</strong> Moving to the
          next step…
        </div>
      ) : step ? (
        <div className="banner">
          <strong>
            Step {step.index + 1} of {state.steps.length}:
          </strong>{" "}
          {step.instruction}
          <div className="muted" style={{ marginTop: 4, fontSize: "0.85rem" }}>
            {stageHint}
          </div>
          {state.nearMiss ? (
            <div
              style={{
                marginTop: 4,
                fontSize: "0.85rem",
                color: "#f59e0b",
              }}
            >
              {state.nearMiss}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Progress bar */}
      <div
        aria-label={`Progress ${pct}%`}
        style={{
          height: 8,
          borderRadius: 4,
          background: "#22303d",
          overflow: "hidden",
          marginBottom: "0.75rem",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "#22c55e",
            transition: "width 300ms ease",
          }}
        />
      </div>

      {/* Board view, or video + overlay in live modes */}
      {isLive ? (
        <>
          <div
            style={{
              position: "relative",
              marginBottom: "0.75rem",
              borderRadius: 10,
              overflow: "hidden",
              border: "1px solid #22303d",
              minHeight: 220,
              background: "#0b0f14",
            }}
          >
            {/* usePerception attaches the captured MediaStream here - or, in
                practice-video mode, sets src to the bundled clip and loops
                it. The frame may be a simulated workspace (screen-captured
                cutouts); cutouts are treated as real parts by the
                perception layer. */}
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              style={{ width: "100%", display: "block" }}
            />
            <Overlay step={step} phase={state.phase} seatedSteps={seatedSteps} />
          </div>
          {practiceItem ? (
            <p
              className="muted"
              style={{ margin: "-0.5rem 0 0.75rem", fontSize: "0.8rem" }}
            >
              Footage: {practiceItem.title} — {practiceItem.credit} (
              {practiceItem.license})
            </p>
          ) : null}
          {perceptionNote ? (
            <p
              className="muted"
              style={{
                margin: "-0.5rem 0 0.75rem",
                fontSize: "0.8rem",
              }}
            >
              {perceptionNote}
            </p>
          ) : null}
        </>
      ) : (
        <div className="card" style={{ marginBottom: "0.75rem" }}>
          <BoardView
            steps={state.steps}
            currentIndex={state.currentIndex}
            phase={state.phase}
            seatedIds={state.seatedIds}
          />
        </div>
      )}

      {uiMode === "manual" ? (
        <SimulatePanel step={step} onInject={inject} />
      ) : null}

      <StepList
        steps={state.steps}
        currentIndex={state.currentIndex}
        phase={state.phase}
        seatedIds={state.seatedIds}
      />

      {/* Firmware + commit, once the build is complete */}
      {state.complete ? (
        <>
          {codegenNote ? <div className="banner warn">{codegenNote}</div> : null}
          <CodePanel
            result={codegen}
            loading={codegenLoading}
            onTweak={(intent) =>
              void runCodegen(observedNetlist(state), intent)
            }
          />
          <div className="card">
            <h2 style={{ fontSize: "0.95rem" }}>Commit this build</h2>
            <input
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              aria-label="Commit message"
              style={{
                width: "100%",
                background: "#0b0f14",
                color: "#e6edf3",
                border: "1px solid #22303d",
                borderRadius: 8,
                padding: "0.5rem 0.75rem",
                marginBottom: "0.5rem",
                fontSize: "0.9rem",
              }}
            />
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!codegen || commitState === "saving"}
                onClick={() => void commitBuild()}
              >
                {commitState === "saving" ? "Committing…" : "Commit this build"}
              </button>
              {commitState === "done" ? (
                <Link className="btn" href="/timeline">
                  ✓ Committed - open timeline
                </Link>
              ) : null}
              {commitState === "failed" ? (
                <span className="banner error" style={{ margin: 0 }}>
                  Commit failed: /api/commits unavailable. The timeline builder
                  ships that route.
                </span>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

export default function AssemblePage() {
  return (
    <Suspense fallback={<p className="muted">Loading guided assembly…</p>}>
      <AssembleInner />
    </Suspense>
  );
}
