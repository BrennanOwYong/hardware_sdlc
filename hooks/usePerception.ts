"use client";

/**
 * usePerception - React glue for the perception backends. Owns every DOM
 * concern: getUserMedia / getDisplayMedia acquisition, <video> attachment,
 * offscreen-canvas frame capture (~1024px wide JPEG @ 0.7), and track release.
 * The backends in lib/perception stay DOM-free.
 *
 * Capture size rationale (docs/references-delta-accuracy.md): pin-level
 * accuracy needs the model to READ silkscreen labels and count breadboard
 * holes. claude-sonnet-5 is a high-resolution vision model (long edge up to
 * 2576px), so a 1024px frame is processed unresized; at 640px the labels
 * blur below legibility. Quality 0.7 avoids JPEG artifacts on small text.
 *
 * Live source "file" (practice video, docs/references-practice-modes.md):
 * no media acquisition at all - the <video> element plays a bundled practice
 * clip (src = fileUrl, loop, muted, playsInline; play() awaited from the
 * start() click so its promise rejection surfaces as `error`), and the same
 * frame-capture loop runs off the element. stop() pauses, removes the src
 * attribute, and calls load() so the element releases the file.
 *
 * References (see docs/references-perception.md):
 * - getUserMedia: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
 * - getDisplayMedia: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
 * Both need a secure context (HTTPS or localhost); getDisplayMedia is
 * desktop-only and needs a user gesture - suits the screen-simulation demo.
 * File playback needs neither: muted <video> is exempt from autoplay
 * blocking (MDN autoplay guide, docs/references-practice-modes.md).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  BackendMode,
  MockScriptEntry,
  PerceptionBackend,
  PerceptionEvent,
} from "@/lib/types";
import {
  LiveBackend,
  ManualBackend,
  MockScriptBackend,
  type LiveStepContext,
  type LiveTuningOptions,
} from "@/lib/perception";

const CAPTURE_WIDTH = 1024;
const JPEG_QUALITY = 0.7;

export interface UsePerceptionOptions {
  /** mock mode: the scripted events to replay. */
  script?: MockScriptEntry[];
  /** mock mode: >1 replays the script faster. */
  speedMultiplier?: number;
  /** live mode: capture source + poll interval (+ optional consecutiveN streak
   * knob from lib/perception). Defaults to camera @ 1500ms, consecutiveN 2. */
  live?: LiveTuningOptions;
  /** live mode: the <video> element the captured stream is attached to. */
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  /** live mode: supplies the active step context; return null to pause polling. */
  getStepContext?: () => LiveStepContext | null;
}

export interface UsePerceptionResult {
  lastEvent: PerceptionEvent | null;
  events: PerceptionEvent[];
  running: boolean;
  /** Media-acquisition or backend failure (e.g. camera permission denied). */
  error: string | null;
  /** Latest /api/perceive note in live mode (vlm confidence / no-key notice). */
  note: string | null;
  start: () => void;
  stop: () => void;
  inject: (e: PerceptionEvent) => void;
}

export function usePerception(
  mode: BackendMode,
  opts: UsePerceptionOptions = {},
): UsePerceptionResult {
  const [lastEvent, setLastEvent] = useState<PerceptionEvent | null>(null);
  const [events, setEvents] = useState<PerceptionEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const backendRef = useRef<PerceptionBackend | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const handleEvent = useCallback((e: PerceptionEvent) => {
    setEvents((prev) => [...prev, e]);
    setLastEvent(e);
  }, []);

  const releaseMedia = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    const video = optsRef.current.videoRef?.current;
    if (video) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      // File source cleanup: pause, drop the src attribute, and load() so the
      // element detaches the practice clip (MDN HTMLMediaElement pattern).
      if (video.getAttribute("src")) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    }
  }, []);

  const stop = useCallback(() => {
    backendRef.current?.stop();
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    backendRef.current = null;
    releaseMedia();
    setRunning(false);
  }, [releaseMedia]);

  /** Draws the current video frame onto an offscreen canvas -> raw base64 JPEG. */
  const captureFrame = useCallback(async (): Promise<string | null> => {
    const video = optsRef.current.videoRef?.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0) return null;
    let canvas = canvasRef.current;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvasRef.current = canvas;
    }
    const width = Math.min(CAPTURE_WIDTH, video.videoWidth);
    const height = Math.max(
      1,
      Math.round((video.videoHeight / video.videoWidth) * width),
    );
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    const comma = dataUrl.indexOf(",");
    return comma >= 0 ? dataUrl.slice(comma + 1) : null;
  }, []);

  const acquireMedia = useCallback(async (): Promise<void> => {
    const live = optsRef.current.live ?? { source: "camera" as const };
    if (live.source === "file") {
      // Practice video: no getUserMedia/getDisplayMedia. The <video> element
      // plays the bundled clip and the capture loop reads frames off it.
      if (!live.fileUrl) {
        throw new Error(
          "practice video unavailable: no video file was selected",
        );
      }
      const video = optsRef.current.videoRef?.current;
      if (!video) {
        throw new Error(
          "practice video unavailable: the video element is not on screen yet",
        );
      }
      video.srcObject = null;
      video.src = live.fileUrl;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      // play() returns a promise; awaiting it from the start() click surfaces
      // NotSupportedError (bad/missing file) as the hook's `error`.
      await video.play();
      return;
    }
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices
    ) {
      throw new Error(
        "media capture unavailable: camera/screen access needs HTTPS (or localhost)",
      );
    }
    const stream =
      live.source === "screen"
        ? await navigator.mediaDevices.getDisplayMedia({ video: true })
        : await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment" },
          });
    streamRef.current = stream;
    const video = optsRef.current.videoRef?.current;
    if (video) {
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
    }
  }, []);

  const startAsync = useCallback(async (): Promise<void> => {
    stop();
    setError(null);
    setEvents([]);
    setLastEvent(null);
    setNote(null);
    try {
      let backend: PerceptionBackend;
      if (mode === "mock") {
        backend = new MockScriptBackend(optsRef.current.script ?? [], {
          speedMultiplier: optsRef.current.speedMultiplier,
        });
      } else if (mode === "manual") {
        backend = new ManualBackend();
      } else {
        await acquireMedia();
        const live = optsRef.current.live ?? { source: "camera" as const };
        backend = new LiveBackend(live, {
          getFrame: captureFrame,
          getStepContext: () => optsRef.current.getStepContext?.() ?? null,
          onNote: (n) => setNote(n),
        });
      }
      unsubscribeRef.current = backend.subscribe(handleEvent);
      backendRef.current = backend;
      backend.start();
      setRunning(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      stop();
    }
  }, [mode, stop, acquireMedia, captureFrame, handleEvent]);

  const start = useCallback(() => {
    void startAsync();
  }, [startAsync]);

  const inject = useCallback((e: PerceptionEvent) => {
    const backend = backendRef.current;
    if (backend && backend.inject) {
      backend.inject(e);
    }
  }, []);

  // Stop on unmount and whenever the mode switches.
  useEffect(() => {
    return () => {
      stop();
    };
  }, [mode, stop]);

  return { lastEvent, events, running, error, note, start, stop, inject };
}
