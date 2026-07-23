// Live-UX helpers (live-ux builder): the snap-on-submit state machine, the
// MediaRecorder mimeType fallback chain, clip-size policy, and the pixel-mask
// tint/scale math used by components/MaskOverlay.tsx and /inventory's live
// mode (FEEDBACK.md items 2, 9, 10). Pure functions with type-only project
// imports, so tests/liveflow.test.mjs runs this file directly under
// `node --test` with Node's type stripping (same pattern as markers.ts).
// External-API shapes verified against MDN; deep links in
// docs/references-liveux.md.

import type { PartDetection } from "@/lib/types";

/**
 * PartDetection plus the exact-pixel mask the masks builder attaches:
 * a base64 PNG (bare or data URL) where white = object pixels, full frame.
 * Declared as an intersection so this module compiles before and after
 * lib/types.ts itself gains the field.
 */
export type MaskedPart = PartDetection & { maskPng?: string };

// ---- Snap-on-submit state machine (FEEDBACK.md item 9) ----------------------

/**
 * idle      no stream; nothing on screen.
 * aim       video playing, rolling MediaRecorder, waiting for a submit.
 * captured  frame frozen + "captured" flash; identify request already flying.
 * analyzing flash done, still waiting on identify ("analyzing your shot...").
 * done      results (or the error/keyless note) on the frozen frame.
 */
export type LivePhase = "idle" | "aim" | "captured" | "analyzing" | "done";

/**
 * start     a stream began playing (Point camera / Watch my screen / Resume).
 * submit    the user submitted a search: freeze the frame, stop the camera.
 * flashed   the "captured" flash finished.
 * resolved  identify finished (success, keyless note, or error).
 * resume    "Resume camera" pressed on the done screen.
 * stop      full teardown (Stop button, track ended, unmount).
 */
export type LiveEvent =
  | "start"
  | "submit"
  | "flashed"
  | "resolved"
  | "resume"
  | "stop";

const LIVE_TRANSITIONS: Record<
  LivePhase,
  Partial<Record<LiveEvent, LivePhase>>
> = {
  idle: { start: "aim" },
  aim: { start: "aim", submit: "captured", stop: "idle" },
  // "resolved" straight from captured covers identify answers that beat the
  // flash timer; the flash keeps painting regardless.
  captured: { flashed: "analyzing", resolved: "done", stop: "idle" },
  analyzing: { resolved: "done", stop: "idle" },
  done: { start: "aim", resume: "aim", stop: "idle" },
};

/** Legal transitions advance; anything else keeps the current phase. */
export function nextLivePhase(phase: LivePhase, event: LiveEvent): LivePhase {
  return LIVE_TRANSITIONS[phase][event] ?? phase;
}

// ---- Rolling clip (FEEDBACK.md item 10) -------------------------------------

/**
 * MediaRecorder mimeType preference order. Safari records mp4, not webm, so
 * the chain ends there; MediaRecorder.isTypeSupported gates each candidate
 * (MDN, docs/references-liveux.md).
 */
export const RECORDER_MIME_CHAIN = [
  "video/webm;codecs=vp9",
  "video/webm",
  "video/mp4",
] as const;

/**
 * First supported mimeType from the chain, or null when none pass. Null means
 * "construct MediaRecorder with no mimeType and let the browser choose" (MDN:
 * the constructor then selects a supported type on its own).
 */
export function pickRecorderMime(
  isTypeSupported: (type: string) => boolean,
): string | null {
  for (const type of RECORDER_MIME_CHAIN) {
    if (isTypeSupported(type)) return type;
  }
  return null;
}

/** Clip payload cap; beyond this the clip is dropped with a note. */
export const CLIP_MAX_BYTES = 30 * 1024 * 1024;

export function shouldDropClip(bytes: number): boolean {
  return bytes > CLIP_MAX_BYTES;
}

/**
 * Containers the storage builder's POST /api/live-captures accepts for
 * clipMime (lib/photos/liveCaptures.ts CLIP_MIMES).
 */
export type ClipContainerMime = "video/webm" | "video/mp4";

/**
 * MediaRecorder reports full mime strings ("video/webm;codecs=vp9"); the
 * live-captures contract wants the bare container. Strips parameters and
 * validates; null means "unrecognized container, drop the clip".
 */
export function clipContainerMime(
  fullMime: string | null | undefined,
): ClipContainerMime | null {
  if (!fullMime) return null;
  const bare = fullMime.split(";")[0].trim().toLowerCase();
  return bare === "video/webm" || bare === "video/mp4" ? bare : null;
}

// ---- Data-URL plumbing -------------------------------------------------------

/** Bare base64 (the maskPng contract shape) -> renderable PNG data URL. */
export function maskPngToDataUrl(maskPng: string): string {
  return maskPng.startsWith("data:")
    ? maskPng
    : `data:image/png;base64,${maskPng}`;
}

/** "data:<mime>;base64,<payload>" -> "<payload>"; comma-free input unchanged. */
export function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

// ---- Exact-pixel mask rendering math (FEEDBACK.md item 2) --------------------

/** --accent (#22c55e) as RGB, the tint for highlighted mask pixels. */
export const MASK_TINT_RGB: readonly [number, number, number] = [34, 197, 94];

/** ~55% of 255: the alpha baked into fully-white mask pixels. */
export const MASK_TINT_MAX_ALPHA = 140;

/**
 * In place: converts a decoded mask (white = object pixels, transparent OR
 * black elsewhere per the masks builder's contract in lib/types.ts) into an
 * accent-tinted stamp. Every pixel's RGB becomes the tint; alpha scales with
 * source luminance TIMES source alpha, so white object pixels land at
 * maxAlpha while both transparent and black backgrounds vanish (soft SAM
 * edges fade proportionally). Layout is RGBA per MDN getImageData
 * (docs/references-liveux.md).
 */
export function tintMaskPixels(
  pixels: Uint8ClampedArray,
  rgb: readonly [number, number, number] = MASK_TINT_RGB,
  maxAlpha: number = MASK_TINT_MAX_ALPHA,
): void {
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const lum =
      0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    const srcAlpha = pixels[i + 3];
    pixels[i] = rgb[0];
    pixels[i + 1] = rgb[1];
    pixels[i + 2] = rgb[2];
    pixels[i + 3] = Math.round((lum / 255) * (srcAlpha / 255) * maxAlpha);
  }
}

/** Destination rectangle for drawing a mask bitmap onto the displayed frame. */
export interface MaskDestRect {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * Aspect-preserving, centered fit of a full-frame mask bitmap onto the frame's
 * coordinate space. SAM masks share the photo's aspect, so this normally
 * degenerates to an exact full-frame stretch; a rounding-skewed mask still
 * lands centered instead of smearing. Degenerate sizes draw nothing.
 */
export function maskDestRect(
  maskW: number,
  maskH: number,
  frameW: number,
  frameH: number,
): MaskDestRect {
  if (maskW <= 0 || maskH <= 0 || frameW <= 0 || frameH <= 0) {
    return { dx: 0, dy: 0, dw: 0, dh: 0 };
  }
  const scale = Math.min(frameW / maskW, frameH / maskH);
  const dw = maskW * scale;
  const dh = maskH * scale;
  return { dx: (frameW - dw) / 2, dy: (frameH - dh) / 2, dw, dh };
}

/** Splits highlighted parts into exact-pixel renders vs bbox-halo fallbacks. */
export function partitionByMask(parts: readonly MaskedPart[]): {
  masked: MaskedPart[];
  plain: MaskedPart[];
} {
  const masked: MaskedPart[] = [];
  const plain: MaskedPart[] = [];
  for (const p of parts) {
    if (typeof p.maskPng === "string" && p.maskPng.length > 0) masked.push(p);
    else plain.push(p);
  }
  return { masked, plain };
}

// ---- Done-state copy ----------------------------------------------------------

/** "Scan complete: N items found" (FEEDBACK.md item 9 wording). */
export function scanSummary(found: number): string {
  return `Scan complete: ${found} item${found === 1 ? "" : "s"} found`;
}

// ---- Results PNG layout (FEEDBACK.md item 10) ---------------------------------

/** Geometry for the composed results PNG, all in canvas pixels. */
export interface ResultsPngLayout {
  width: number;
  height: number;
  /** Accent header bar (query + timestamp) at the very top. */
  headerH: number;
  /** Frozen frame, drawn full width directly under the header. */
  frameY: number;
  frameW: number;
  frameH: number;
  /** Table header row starts here; data rows follow at rowH intervals. */
  tableY: number;
  rowH: number;
  pad: number;
}

export const RESULTS_PNG_MIN_WIDTH = 480;
export const RESULTS_PNG_MAX_WIDTH = 1024;
export const RESULTS_PNG_HEADER_H = 56;
export const RESULTS_PNG_ROW_H = 34;
export const RESULTS_PNG_PAD = 16;

/**
 * Layout for header + frame + table. rowCount is the number of DATA rows
 * (pass at least 1 so an empty scan still fits its "no items" row); one extra
 * rowH is reserved for the table's own header row.
 */
export function resultsPngLayout(
  frameW: number,
  frameH: number,
  rowCount: number,
): ResultsPngLayout {
  const width = Math.max(
    RESULTS_PNG_MIN_WIDTH,
    Math.min(RESULTS_PNG_MAX_WIDTH, Math.round(frameW)),
  );
  const scale = frameW > 0 ? width / frameW : 1;
  const scaledFrameH = Math.max(1, Math.round(frameH * scale));
  const rows = Math.max(1, Math.floor(rowCount));
  const tableY = RESULTS_PNG_HEADER_H + scaledFrameH + RESULTS_PNG_PAD;
  return {
    width,
    height: tableY + RESULTS_PNG_ROW_H * (rows + 1) + RESULTS_PNG_PAD,
    headerH: RESULTS_PNG_HEADER_H,
    frameY: RESULTS_PNG_HEADER_H,
    frameW: width,
    frameH: scaledFrameH,
    tableY,
    rowH: RESULTS_PNG_ROW_H,
    pad: RESULTS_PNG_PAD,
  };
}

// ---- Live-capture save payload (storage builder's POST /api/live-captures) ----

/** Body for POST /api/live-captures, per the storage builder's contract. */
export interface LiveCapturePayload {
  /** Bare base64 of the recorded clip; absent when unrecorded or over cap. */
  clipBase64?: string;
  /** Bare container mime, sent together with clipBase64 or not at all. */
  clipMime?: ClipContainerMime;
  /** JPEG data URL of the frozen frame. */
  frameDataUrl: string;
  /** PNG data URL of the composed results sheet. */
  resultsPngDataUrl: string;
  query: string;
  /** ISO timestamp of the submit moment. */
  capturedAt: string;
}
