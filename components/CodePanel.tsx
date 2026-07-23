"use client";

import Link from "next/link";
import { useState } from "react";
import type { CodePanelProps, FlashResult } from "@/lib/types";
import { benchStatusSchema, flashResultSchema } from "@/lib/bench/parse";

type FlashState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "flashing" }
  | { kind: "done"; result: FlashResult };

export default function CodePanel({ result, loading, onTweak }: CodePanelProps) {
  const [copied, setCopied] = useState(false);
  const [showFlash, setShowFlash] = useState(false);
  const [fallbackGuidance, setFallbackGuidance] = useState<string | null>(null);
  const [flashState, setFlashState] = useState<FlashState>({ kind: "idle" });
  const [showFlashLog, setShowFlashLog] = useState(false);
  const [intent, setIntent] = useState("");

  if (loading) {
    return (
      <div className="card">
        <span className="badge">Firmware</span>
        <p className="muted" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
          Generating firmware...
        </p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="card">
        <span className="badge">Firmware</span>
        <p className="muted" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
          No firmware yet. Finish the assembly steps and Forge generates code
          from the pins it observed.
        </p>
      </div>
    );
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(result.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const submitTweak = () => {
    const trimmed = intent.trim();
    if (trimmed.length === 0 || !onTweak) return;
    onTweak(trimmed);
    setIntent("");
  };

  // Flash now asks the bench first: real CLI + awake board -> POST /api/flash
  // and show the staged output inline; anything missing -> the manual modal
  // with the bench's guidance string and a link to /bench.
  const startFlash = async () => {
    if (!result) return;
    setShowFlashLog(false);
    setFlashState({ kind: "checking" });
    try {
      const benchRes = await fetch("/api/bench", { cache: "no-store" });
      const bench = benchStatusSchema.safeParse(await benchRes.json());
      const awake =
        bench.success &&
        bench.data.cliAvailable &&
        bench.data.devices.some((d) => d.status === "awake");
      if (!awake) {
        setFallbackGuidance(
          bench.success && bench.data.note
            ? bench.data.note
            : "The flashing tool is not installed on this laptop yet. See README > Flashing setup.",
        );
        setFlashState({ kind: "idle" });
        setShowFlash(true);
        return;
      }

      setFlashState({ kind: "flashing" });
      const flashRes = await fetch("/api/flash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: result.code }),
      });
      const parsed = flashResultSchema.safeParse(await flashRes.json());
      setFlashState({
        kind: "done",
        result: parsed.success
          ? parsed.data
          : {
              ok: false,
              stage: "compile",
              output: "",
              guidance: "The flash reply came back garbled. Try again.",
            },
      });
    } catch {
      setFlashState({
        kind: "done",
        result: {
          ok: false,
          stage: "compile",
          output: "",
          guidance: "The server did not answer. Refresh the page and try again.",
        },
      });
    }
  };

  return (
    <div className="card">
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", alignItems: "center" }}>
        <span className="badge" style={{ color: "var(--accent)", borderColor: "var(--accent)" }}>
          via {result.via}
        </span>
        {result.pinsUsed.map((pin) => (
          <span key={pin} className="badge">
            {pin}
          </span>
        ))}
        <span className="badge mono" title={result.hash}>
          #{result.hash.slice(0, 10)}
        </span>
      </div>

      <pre
        className="mono"
        style={{
          marginTop: "0.75rem",
          padding: "0.75rem",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflowX: "auto",
          maxHeight: "22rem",
          whiteSpace: "pre",
        }}
      >
        {result.code}
      </pre>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.75rem" }}>
        <button type="button" className="btn" onClick={copyCode}>
          {copied ? "Copied" : "Copy code"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void startFlash()}
          disabled={flashState.kind === "checking" || flashState.kind === "flashing"}
        >
          {flashState.kind === "checking"
            ? "Checking bench..."
            : flashState.kind === "flashing"
              ? "Flashing..."
              : "Flash"}
        </button>
      </div>

      {flashState.kind === "flashing" ? (
        <p className="muted" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
          Compiling, then sending to your board. This can take a minute.
        </p>
      ) : null}

      {flashState.kind === "done" ? (
        <div
          style={{
            marginTop: "0.75rem",
            border: "1px solid var(--border)",
            borderLeft: `4px solid ${flashState.result.ok ? "var(--accent)" : "var(--warn)"}`,
            borderRadius: 8,
            padding: "0.6rem 0.9rem",
          }}
        >
          {flashState.result.ok && flashState.result.stage === "done" ? (
            <p style={{ color: "var(--accent)", marginBottom: "0.25rem" }}>
              Flashed. Your board is now running this code
              {flashState.result.firmwareHash ? (
                <>
                  {" "}
                  (<span className="mono">#{flashState.result.firmwareHash}</span>)
                </>
              ) : null}
              .
            </p>
          ) : flashState.result.ok ? (
            <p style={{ marginBottom: "0.25rem" }}>The code compiles cleanly.</p>
          ) : (
            <p style={{ color: "var(--warn)", marginBottom: "0.25rem" }}>
              Flashing stopped at the {flashState.result.stage} step.
            </p>
          )}
          {flashState.result.guidance ? (
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              {flashState.result.guidance} <Link href="/bench">Open the bench</Link>
            </p>
          ) : null}
          {flashState.result.output ? (
            <>
              <button type="button" className="btn" onClick={() => setShowFlashLog((s) => !s)}>
                {showFlashLog ? "Hide details" : "Show details"}
              </button>
              {showFlashLog ? (
                <pre
                  className="mono"
                  style={{
                    marginTop: "0.5rem",
                    padding: "0.6rem",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    overflowX: "auto",
                    maxHeight: "14rem",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {flashState.result.output}
                </pre>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {onTweak ? (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
          <input
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitTweak();
            }}
            placeholder='Tweak firmware, e.g. "slower" or "invert"'
            aria-label="Firmware tweak intent"
            style={{
              flex: 1,
              minWidth: 0,
              background: "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "0.55rem 0.75rem",
              fontSize: "0.9rem",
            }}
          />
          <button
            type="button"
            className="btn"
            onClick={submitTweak}
            disabled={intent.trim().length === 0}
          >
            Tweak
          </button>
        </div>
      ) : null}

      {showFlash ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Flash firmware"
          onClick={() => setShowFlash(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
            padding: "1rem",
          }}
        >
          <div
            className="card"
            style={{ maxWidth: 440, width: "100%", marginBottom: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Flash firmware</h2>
            {fallbackGuidance ? (
              <p className="banner warn" style={{ fontSize: "0.9rem" }}>
                {fallbackGuidance}
              </p>
            ) : null}
            <p className="muted" style={{ fontSize: "0.9rem" }}>
              Forge could not flash from here right now. Check the{" "}
              <Link href="/bench">bench page</Link> to pair your board, or use
              the manual path:
            </p>
            <ol style={{ paddingLeft: "1.2rem", fontSize: "0.9rem", marginBottom: "0.5rem" }}>
              <li>Copy the sketch above.</li>
              <li>
                Paste it into a Wokwi Arduino UNO project (wokwi.com) to
                simulate, or into the Arduino IDE.
              </li>
              <li>
                Arduino IDE: select Arduino UNO, then Upload. CLI:{" "}
                <span className="mono">
                  arduino-cli compile --fqbn arduino:avr:uno
                </span>{" "}
                then{" "}
                <span className="mono">
                  arduino-cli upload -p PORT --fqbn arduino:avr:uno
                </span>
                .
              </li>
            </ol>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setShowFlash(false)}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
