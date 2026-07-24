/**
 * Pure helpers for the live-lab streaming experiment: knob clamping,
 * percentile math, stale-verdict ordering, and rolling-window bookkeeping.
 * Zero imports so node --test loads this file directly via type stripping;
 * hooks/useStreamLoop.ts consumes the same functions in the browser.
 *
 * References: docs/references-livelab.md.
 */

/** Frame widths the live-lab page offers (px, longest edge of the capture). */
export const FRAME_WIDTHS = [320, 512, 768, 1024] as const;
export type FrameWidth = (typeof FRAME_WIDTHS)[number];

export const MIN_INTERVAL_MS = 300;
export const MAX_INTERVAL_MS = 3000;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 3;

/** Round-trip samples kept for the p50/p90 window. */
export const ROUND_TRIP_WINDOW = 30;
/** Window for the verdicts-per-minute rate. */
export const RATE_WINDOW_MS = 60_000;

/** Feel thresholds: verdict age below green is "feels live", below amber is
 * "usable with lag", anything older (or no verdict yet) is red. */
export const GREEN_MAX_AGE_MS = 1500;
export const AMBER_MAX_AGE_MS = 3000;

/** Clamps the capture interval to the 300-3000 ms knob range. Non-finite
 * input falls to the minimum so a broken knob can never stall the loop. */
export function clampIntervalMs(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)));
}

/** Clamps the overlapping-request knob to 1-3 whole requests. */
export function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return MIN_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(n)));
}

/** Snaps an arbitrary width to the nearest offered frame width. Ties pick the
 * smaller (cheaper) width; 416 is equidistant to 320 and 512 and snaps down. */
export function clampFrameWidth(w: number): FrameWidth {
  if (!Number.isFinite(w)) return FRAME_WIDTHS[0];
  let best: FrameWidth = FRAME_WIDTHS[0];
  let bestDist = Math.abs(w - best);
  for (const candidate of FRAME_WIDTHS) {
    const dist = Math.abs(w - candidate);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Linear-interpolated percentile of `values` (p in [0, 1]). Input order does
 * not matter; the array is not mutated. Returns null for an empty window so
 * the HUD can render "-" instead of a fake 0 ms.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, p));
  const idx = (sorted.length - 1) * clamped;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Stale-verdict rule: with overlapping in-flight requests, a response whose
 * sequence number is at or below the latest APPLIED sequence describes an
 * older frame than the one already shown, so it is discarded. `null` means
 * nothing has been applied yet - nothing can be stale.
 */
export function isStale(
  incomingSeq: number,
  latestAppliedSeq: number | null,
): boolean {
  return latestAppliedSeq !== null && incomingSeq <= latestAppliedSeq;
}

/** Appends a round-trip sample, keeping only the newest `cap` samples. */
export function pushRoundTrip(
  window: readonly number[],
  rtMs: number,
  cap: number = ROUND_TRIP_WINDOW,
): number[] {
  const next = [...window, rtMs];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Drops applied-verdict timestamps that fell out of the rate window. */
export function pruneTimestamps(
  appliedAtMs: readonly number[],
  nowMs: number,
  windowMs: number = RATE_WINDOW_MS,
): number[] {
  const cutoff = nowMs - windowMs;
  return appliedAtMs.filter((t) => t > cutoff);
}

/**
 * Applied verdicts in the trailing window. With the default 60 s window the
 * count IS the per-minute rate; during the first minute of a run it reads
 * low because the window is not yet full - reported as-is, not extrapolated.
 */
export function verdictsPerMinute(
  appliedAtMs: readonly number[],
  nowMs: number,
  windowMs: number = RATE_WINDOW_MS,
): number {
  return pruneTimestamps(appliedAtMs, nowMs, windowMs).length;
}

export type FeelColor = "green" | "amber" | "red";

/** Maps verdict age to the HUD feel indicator. No verdict yet reads red. */
export function feelColor(verdictAgeMs: number | null): FeelColor {
  if (verdictAgeMs === null) return "red";
  if (verdictAgeMs < GREEN_MAX_AGE_MS) return "green";
  if (verdictAgeMs < AMBER_MAX_AGE_MS) return "amber";
  return "red";
}
