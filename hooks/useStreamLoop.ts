"use client";

/**
 * useStreamLoop - continuous capture loop for the live-lab streaming
 * experiment (FEEDBACK 18 / T25). Distinct from hooks/usePerception.ts (which
 * this file deliberately does not touch): usePerception polls one request at
 * a time through the perception backends; this hook fires OVERLAPPING
 * requests (up to a concurrency knob) with sequence numbers and drops stale
 * verdicts, so the experiment can measure whether overlap buys lower
 * verdict age at a given interval.
 *
 * Mechanics:
 * - A chained setTimeout ticks every clampIntervalMs(opts.intervalMs); knob
 *   changes apply on the next tick without a restart.
 * - Each tick captures a frame and fires opts.sendFrame unless
 *   clampConcurrency(opts.concurrency) requests are already in flight (the
 *   tick is then counted as skipped).
 * - Responses carry their launch sequence number. A response at or below the
 *   latest APPLIED sequence is stale - counted in dropCount, never surfaced.
 * - Rolling stats: p50/p90 round-trip over the last ROUND_TRIP_WINDOW (30)
 *   completions, applied verdicts per minute, drop/error/skip counters.
 * - start() resets everything; stop() bumps a generation token so responses
 *   from a previous run are ignored (clean teardown, also on unmount).
 *
 * Stats/ordering math lives in lib/perception/streamstats.ts so node --test
 * exercises it directly (tests/streamloop.test.mjs).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  clampConcurrency,
  clampIntervalMs,
  isStale,
  percentile,
  pruneTimestamps,
  pushRoundTrip,
} from "@/lib/perception/streamstats";

export interface StreamLoopOptions<TVerdict> {
  /** Captures one frame as raw base64; null skips the tick (video not ready). */
  getFrame: () => Promise<string | null>;
  /** Performs the request for one frame. A throw counts as a failed request. */
  sendFrame: (frameBase64: string, seq: number) => Promise<TVerdict>;
  /** Called once per APPLIED verdict; stale verdicts are dropped before this. */
  onVerdict?: (verdict: TVerdict, meta: { seq: number; roundTripMs: number }) => void;
  /** Capture cadence; clamped to 300-3000 ms. Default 1000. */
  intervalMs?: number;
  /** Max overlapping in-flight requests; clamped to 1-3. Default 2. */
  concurrency?: number;
}

export interface StreamLoopStats {
  /** Median round-trip over the last 30 completed requests, ms. */
  p50Ms: number | null;
  /** 90th-percentile round-trip over the same window, ms. */
  p90Ms: number | null;
  /** Applied verdicts in the trailing 60 s window. */
  verdictsPerMinute: number;
  /** Responses discarded because a newer frame's verdict was already applied. */
  dropCount: number;
  /** Requests currently awaiting a response. */
  inFlight: number;
  /** Requests fired since start(). */
  sent: number;
  /** Responses received since start(), ok or error. */
  completed: number;
  /** Requests that threw (network / bad response shape). */
  errorCount: number;
  /** Ticks skipped because the concurrency cap was saturated. */
  skippedTicks: number;
}

const ZERO_STATS: StreamLoopStats = {
  p50Ms: null,
  p90Ms: null,
  verdictsPerMinute: 0,
  dropCount: 0,
  inFlight: 0,
  sent: 0,
  completed: 0,
  errorCount: 0,
  skippedTicks: 0,
};

export interface UseStreamLoopResult<TVerdict> {
  running: boolean;
  stats: StreamLoopStats;
  /** Latest applied (non-stale) verdict. */
  lastVerdict: TVerdict | null;
  /** Date.now() when the latest verdict was applied - drives the age HUD. */
  lastVerdictAtMs: number | null;
  lastError: string | null;
  start: () => void;
  stop: () => void;
}

interface Counters {
  drops: number;
  inFlight: number;
  sent: number;
  completed: number;
  errors: number;
  skipped: number;
}

export function useStreamLoop<TVerdict>(
  opts: StreamLoopOptions<TVerdict>,
): UseStreamLoopResult<TVerdict> {
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<StreamLoopStats>(ZERO_STATS);
  const [lastVerdict, setLastVerdict] = useState<TVerdict | null>(null);
  const [lastVerdictAtMs, setLastVerdictAtMs] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Generation token: bumped by start() and stop(). Every async continuation
  // checks it, so responses belonging to a stopped run are discarded.
  const genRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);
  const latestAppliedRef = useRef<number | null>(null);
  const roundTripsRef = useRef<number[]>([]);
  const appliedAtRef = useRef<number[]>([]);
  const countersRef = useRef<Counters>({ ...ZERO_COUNTERS });

  const publishStats = useCallback(() => {
    const now = Date.now();
    appliedAtRef.current = pruneTimestamps(appliedAtRef.current, now);
    const c = countersRef.current;
    setStats({
      p50Ms: percentile(roundTripsRef.current, 0.5),
      p90Ms: percentile(roundTripsRef.current, 0.9),
      verdictsPerMinute: appliedAtRef.current.length,
      dropCount: c.drops,
      inFlight: c.inFlight,
      sent: c.sent,
      completed: c.completed,
      errorCount: c.errors,
      skippedTicks: c.skipped,
    });
  }, []);

  const fireRequest = useCallback(
    async (gen: number): Promise<void> => {
      const c = countersRef.current;
      let frame: string | null = null;
      try {
        frame = await optsRef.current.getFrame();
      } catch (err) {
        if (gen !== genRef.current) return;
        setLastError(err instanceof Error ? err.message : String(err));
        return;
      }
      if (gen !== genRef.current || frame === null) return;

      const seq = ++seqRef.current;
      const startedAt = Date.now();
      c.inFlight += 1;
      c.sent += 1;
      publishStats();
      try {
        const verdict = await optsRef.current.sendFrame(frame, seq);
        if (gen !== genRef.current) return;
        const roundTripMs = Date.now() - startedAt;
        roundTripsRef.current = pushRoundTrip(roundTripsRef.current, roundTripMs);
        c.completed += 1;
        if (isStale(seq, latestAppliedRef.current)) {
          c.drops += 1;
        } else {
          latestAppliedRef.current = seq;
          const now = Date.now();
          appliedAtRef.current = pruneTimestamps(
            [...appliedAtRef.current, now],
            now,
          );
          setLastVerdict(verdict);
          setLastVerdictAtMs(now);
          optsRef.current.onVerdict?.(verdict, { seq, roundTripMs });
        }
      } catch (err) {
        if (gen !== genRef.current) return;
        c.completed += 1;
        c.errors += 1;
        setLastError(err instanceof Error ? err.message : String(err));
      } finally {
        if (gen === genRef.current) {
          c.inFlight = Math.max(0, c.inFlight - 1);
          publishStats();
        }
      }
    },
    [publishStats],
  );

  const tick = useCallback(
    (gen: number): void => {
      if (gen !== genRef.current) return;
      // Schedule the next tick first so a slow capture never stretches the
      // cadence; the interval knob is re-read every tick.
      timerRef.current = setTimeout(
        () => tick(gen),
        clampIntervalMs(optsRef.current.intervalMs ?? 1000),
      );
      const cap = clampConcurrency(optsRef.current.concurrency ?? 2);
      if (countersRef.current.inFlight >= cap) {
        countersRef.current.skipped += 1;
        publishStats();
        return;
      }
      void fireRequest(gen);
    },
    [fireRequest, publishStats],
  );

  const stop = useCallback(() => {
    genRef.current += 1;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // In-flight responses of the old generation are discarded, so the counter
    // must not keep them pinned. Cumulative stats stay visible after stop.
    countersRef.current.inFlight = 0;
    setRunning(false);
    publishStats();
  }, [publishStats]);

  const start = useCallback(() => {
    stop();
    genRef.current += 1;
    seqRef.current = 0;
    latestAppliedRef.current = null;
    roundTripsRef.current = [];
    appliedAtRef.current = [];
    countersRef.current = { ...ZERO_COUNTERS };
    setLastVerdict(null);
    setLastVerdictAtMs(null);
    setLastError(null);
    setStats(ZERO_STATS);
    setRunning(true);
    tick(genRef.current);
  }, [stop, tick]);

  // Clean teardown on unmount.
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return { running, stats, lastVerdict, lastVerdictAtMs, lastError, start, stop };
}

const ZERO_COUNTERS: Counters = {
  drops: 0,
  inFlight: 0,
  sent: 0,
  completed: 0,
  errors: 0,
  skipped: 0,
};
