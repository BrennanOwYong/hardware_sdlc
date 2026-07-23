"use client";

// /bench — the pairing wizard. Polls GET /api/bench every 3s, walks a total
// beginner from "no board yet" to "equipment confirmed working", and can point
// at the physical board on a photo ("Show me on a photo" -> /api/identify ->
// ArMarkerLayer). Doc links: docs/references-delta-bench.md.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ArMarker, BenchStatus, DeviceCard, FlashResult, PartDetection } from "@/lib/types";
import { benchStatusSchema, flashResultSchema } from "@/lib/bench/parse";
import { identifyResponseSchema } from "@/lib/inventory/contract";
import ArMarkerLayer from "@/components/ArMarkerLayer";

const TEST_STAGES = ["compiling", "uploading", "waiting for hello"] as const;

interface TestState {
  running: boolean;
  stageIndex: number;
  result: FlashResult | null;
}

interface PhotoState {
  deviceId: string;
  busy: boolean;
  photoUrl: string | null;
  markers: ArMarker[];
  message: string | null;
}

function statusDotColor(status: DeviceCard["status"]): string {
  if (status === "awake") return "var(--accent)";
  if (status === "quiet") return "var(--warn)";
  return "var(--muted)";
}

function statusLabel(d: DeviceCard): string {
  if (d.status === "awake") return "awake";
  if (d.status === "quiet") return "plugged in, but not introducing itself";
  const when = d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : "earlier";
  return `unplugged (last seen ${when})`;
}

/** Which detected parts count as "the board" on a photo. */
function isBoardPart(p: PartDetection): boolean {
  const hay = `${p.partType} ${p.label}`.toLowerCase();
  return (
    p.partType === "microcontroller" ||
    hay.includes("arduino") ||
    hay.includes("uno") ||
    hay.includes("nano") ||
    hay.includes("mega")
  );
}

/** Loose keyword match from a peripheral's beginner name to a detected part. */
function matchesPeripheral(name: string, p: PartDetection): boolean {
  const hay = `${p.partType} ${p.label}`.toLowerCase();
  const keywords: Record<string, string[]> = {
    LED: ["led"],
    button: ["button", "pushbutton", "switch"],
    speaker: ["speaker", "buzzer"],
    "temperature sensor": ["dht", "sensor", "temperature"],
    "light sensor": ["ldr", "photo", "light"],
    resistor: ["resistor"],
    knob: ["potentiometer", "knob"],
    "servo motor": ["servo"],
  };
  const keys = keywords[name] ?? [name.toLowerCase()];
  return keys.some((k) => hay.includes(k));
}

function centerMarker(p: PartDetection, kind: ArMarker["kind"], label: string): ArMarker {
  return {
    x: p.bbox[0] + p.bbox[2] / 2,
    y: p.bbox[1] + p.bbox[3] / 2,
    w: p.bbox[2],
    h: p.bbox[3],
    label,
    kind,
  };
}

export default function BenchPage() {
  const [status, setStatus] = useState<BenchStatus | null>(null);
  const [test, setTest] = useState<TestState>({ running: false, stageIndex: 0, result: null });
  const [photo, setPhoto] = useState<PhotoState | null>(null);
  const [showTestLog, setShowTestLog] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingPhotoDevice = useRef<DeviceCard | null>(null);

  // Poll the bench every 3s while the page is open.
  useEffect(() => {
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch("/api/bench", { cache: "no-store" });
        const parsed = benchStatusSchema.safeParse(await res.json());
        if (alive && parsed.success) setStatus(parsed.data);
      } catch {
        // keep the last known state; the next tick retries
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // Advance the staged progress label while a test runs.
  useEffect(() => {
    if (!test.running) return;
    const timer = window.setInterval(() => {
      setTest((t) =>
        t.running && t.stageIndex < TEST_STAGES.length - 1
          ? { ...t, stageIndex: t.stageIndex + 1 }
          : t,
      );
    }, 4000);
    return () => window.clearInterval(timer);
  }, [test.running]);

  const runTest = async (): Promise<void> => {
    setShowTestLog(false);
    setTest({ running: true, stageIndex: 0, result: null });
    try {
      const res = await fetch("/api/bench/test", { method: "POST" });
      const parsed = flashResultSchema.safeParse(await res.json());
      setTest({
        running: false,
        stageIndex: 0,
        result: parsed.success
          ? parsed.data
          : {
              ok: false,
              stage: "handshake",
              output: "",
              guidance: "The test reply came back garbled. Try once more.",
            },
      });
    } catch {
      setTest({
        running: false,
        stageIndex: 0,
        result: {
          ok: false,
          stage: "handshake",
          output: "",
          guidance: "The server did not answer. Refresh the page and try again.",
        },
      });
    }
  };

  const openPhotoPicker = (device: DeviceCard): void => {
    pendingPhotoDevice.current = device;
    fileInputRef.current?.click();
  };

  const handlePhotoFile = async (file: File): Promise<void> => {
    const device = pendingPhotoDevice.current;
    if (!device) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("could not read the photo"));
      reader.readAsDataURL(file);
    });
    const dims = await new Promise<{ w: number; h: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = dataUrl;
    });

    setPhoto({ deviceId: device.id, busy: true, photoUrl: dataUrl, markers: [], message: null });
    try {
      const res = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: dataUrl,
          ...(dims.w > 0 ? { imageWidth: dims.w, imageHeight: dims.h } : {}),
        }),
      });
      const json: unknown = await res.json();
      const parsed = identifyResponseSchema.safeParse(json);
      if (!parsed.success) {
        const errText =
          typeof json === "object" && json !== null && "error" in json
            ? String((json as { error: unknown }).error)
            : "the photo check failed";
        setPhoto({
          deviceId: device.id,
          busy: false,
          photoUrl: dataUrl,
          markers: [],
          message: `I could not read that photo (${errText}). Try another shot.`,
        });
        return;
      }

      const parts = parsed.data.inventory.parts;
      const markers: ArMarker[] = [];
      const boardPart = parts.find(isBoardPart);
      if (boardPart) {
        markers.push(centerMarker(boardPart, "board", `${device.boardName} - this one`));
      }
      const missing: string[] = [];
      for (const per of device.peripherals) {
        const hit = parts.find((p) => !isBoardPart(p) && matchesPeripheral(per.name, p));
        if (hit) {
          markers.push(centerMarker(hit, "peripheral", `${per.name} on ${per.pin}`));
        } else {
          missing.push(per.name);
        }
      }

      let message: string | null = null;
      if (!boardPart) {
        message =
          "I looked at the photo but could not spot your board. Try again with the whole board in the shot, in good light.";
      } else if (missing.length > 0) {
        message = `Found the board. Not spotted in this photo: ${missing.join(", ")}.`;
      }
      setPhoto({ deviceId: device.id, busy: false, photoUrl: dataUrl, markers, message });
    } catch {
      setPhoto({
        deviceId: device.id,
        busy: false,
        photoUrl: dataUrl,
        markers: [],
        message: "The photo check did not go through. Check your connection and try again.",
      });
    }
  };

  const awakeDevice = status?.devices.find((d) => d.status === "awake");

  return (
    <div>
      <h1>Bench</h1>
      <p className="muted">
        This page pairs Forge with the physical board on your desk and proves it
        works before you flash anything real.
      </p>

      {/* hidden shared file input for "Show me on a photo" */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        aria-label="Take or choose a photo of your workbench"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void handlePhotoFile(file);
        }}
      />

      {status === null ? (
        <div className="card">
          <p className="muted" style={{ marginBottom: 0 }}>
            Checking the bench...
          </p>
        </div>
      ) : !status.cliAvailable ? (
        <div className="banner warn">
          {status.note ?? "The flashing tool is not installed on this laptop yet. See README > Flashing setup."}
        </div>
      ) : (
        <>
          {status.devices.length === 0 ? (
            <div className="card">
              <h2>No board yet</h2>
              <p className="muted" style={{ marginBottom: 0 }}>
                I&apos;m watching this laptop&apos;s USB ports. Plug the flat
                end of the cable into the laptop and the other end into your
                board.
              </p>
              {status.note ? (
                <p className="muted" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
                  {status.note}
                </p>
              ) : null}
              <p className="muted" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
                Plugged it in and still nothing? Some cables carry power only.
                Try a different cable - one from a printer or external drive
                usually works. Cheap boards may also need the CH340 driver.
              </p>
            </div>
          ) : (
            <>
              {awakeDevice ? (
                <div className="banner">
                  Found it: {awakeDevice.boardName} on {awakeDevice.port}.
                </div>
              ) : status.note ? (
                <div className="banner warn">{status.note}</div>
              ) : null}

              {status.devices.map((d) => (
                <div key={d.id} className="card">
                  <div
                    style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", alignItems: "center" }}
                  >
                    <span
                      aria-hidden
                      style={{
                        display: "inline-block",
                        width: 10,
                        height: 10,
                        borderRadius: 999,
                        background: statusDotColor(d.status),
                      }}
                    />
                    <strong>{d.boardName}</strong>
                    <span className="badge">{statusLabel(d)}</span>
                  </div>
                  <p className="muted mono" style={{ marginTop: "0.4rem", marginBottom: "0.25rem" }}>
                    {d.fqbn ?? "board type unknown"} · {d.port ?? "no port"} · {d.transport}
                  </p>
                  {d.firmwareHash ? (
                    <p className="muted" style={{ marginBottom: "0.25rem" }}>
                      Latest firmware in your{" "}
                      <Link href="/timeline">timeline</Link>:{" "}
                      <span className="mono">#{d.firmwareHash}</span>
                    </p>
                  ) : null}
                  {d.peripherals.length > 0 ? (
                    <ul style={{ paddingLeft: "1.2rem", marginBottom: "0.5rem" }}>
                      {d.peripherals.map((p) => (
                        <li key={`${p.pin}-${p.name}`} className="muted" style={{ fontSize: "0.9rem" }}>
                          {p.name} on {p.pin}
                          {p.source === "netlist" ? " - wired in your last commit" : ""}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted" style={{ fontSize: "0.9rem", marginBottom: "0.5rem" }}>
                      Nothing wired to its pins in your last commit yet.
                    </p>
                  )}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                    {d.status === "awake" ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void runTest()}
                        disabled={test.running}
                      >
                        {test.running ? "Testing..." : "Test my board"}
                      </button>
                    ) : null}
                    <button type="button" className="btn" onClick={() => openPhotoPicker(d)}>
                      Show me on a photo
                    </button>
                  </div>

                  {photo && photo.deviceId === d.id ? (
                    <div style={{ marginTop: "0.75rem" }}>
                      {photo.busy ? (
                        <p className="muted">Looking at your photo...</p>
                      ) : null}
                      {photo.photoUrl ? (
                        <div style={{ position: "relative", maxWidth: "100%" }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={photo.photoUrl}
                            alt="Your workbench photo with the detected board highlighted"
                            style={{ width: "100%", borderRadius: 8, display: "block" }}
                          />
                          <ArMarkerLayer markers={photo.markers} visible={!photo.busy} />
                        </div>
                      ) : null}
                      {photo.message ? (
                        <p className="muted" style={{ marginTop: "0.4rem", marginBottom: 0 }}>
                          {photo.message}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </>
          )}

          {test.running ? (
            <div className="card">
              <p style={{ marginBottom: 0 }}>
                Testing your board: <strong>{TEST_STAGES[test.stageIndex]}</strong>
                ...
              </p>
              <p className="muted" style={{ marginTop: "0.25rem", marginBottom: 0 }}>
                This can take a minute the first time.
              </p>
            </div>
          ) : null}

          {test.result ? (
            <div className="card">
              {test.result.ok && test.result.stage === "done" ? (
                <p style={{ color: "var(--accent)", marginBottom: "0.25rem" }}>
                  Your board answered and its light blinked. Equipment confirmed
                  working.
                </p>
              ) : (
                <p style={{ color: "var(--warn)", marginBottom: "0.25rem" }}>
                  The test stopped at the {test.result.stage} step.
                </p>
              )}
              {test.result.guidance ? (
                <p className="muted" style={{ marginBottom: "0.5rem" }}>
                  {test.result.guidance}
                </p>
              ) : null}
              {test.result.output ? (
                <>
                  <button type="button" className="btn" onClick={() => setShowTestLog((s) => !s)}>
                    {showTestLog ? "Hide details" : "Show details"}
                  </button>
                  {showTestLog ? (
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
                      {test.result.output}
                    </pre>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
