export type {
  PerceptionEvent,
  PerceptionListener,
  PerceptionBackend,
  MockScriptEntry,
  BackendMode,
  LiveSourceOptions,
} from "@/lib/types";

import type {
  BackendMode,
  LiveSourceOptions,
  MockScriptEntry,
  PerceptionBackend,
  PerceptionEvent,
  PerceptionListener,
} from "@/lib/types";

/** Shared listener bookkeeping for every backend. */
abstract class BaseBackend implements PerceptionBackend {
  private listeners = new Set<PerceptionListener>();

  abstract start(): void;
  abstract stop(): void;

  subscribe(l: PerceptionListener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  inject(e: PerceptionEvent): void {
    this.emit(e);
  }

  protected emit(e: PerceptionEvent): void {
    for (const l of this.listeners) {
      l(e);
    }
  }
}

export interface MockBackendOptions {
  /** >1 plays the script faster (atMs is divided by this), <1 slower. Defaults to 1. */
  speedMultiplier?: number;
}

/**
 * Plays back a scripted sequence of perception events. Each entry fires at
 * atMs / speedMultiplier after start(). start() always performs a clean
 * restart: pending timers are cancelled and the script replays from t0.
 */
export class MockScriptBackend extends BaseBackend {
  private readonly script: MockScriptEntry[];
  private readonly speedMultiplier: number;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(script: MockScriptEntry[], opts: MockBackendOptions = {}) {
    super();
    this.script = [...script].sort((a, b) => a.atMs - b.atMs);
    const m = opts.speedMultiplier;
    this.speedMultiplier = typeof m === "number" && m > 0 ? m : 1;
  }

  start(): void {
    this.stop();
    for (const entry of this.script) {
      const delay = Math.max(0, Math.round(entry.atMs / this.speedMultiplier));
      const timer = setTimeout(() => this.emit(entry.event), delay);
      this.timers.push(timer);
    }
  }

  stop(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
  }
}

/**
 * Relays inject() calls to subscribers. start()/stop() are no-ops. Drives the
 * wizard-of-oz SimulatePanel: the human clicks buttons, the panel injects the
 * matching PerceptionEvent, the assembly wizard reacts as if a camera saw it.
 */
export class ManualBackend extends BaseBackend {
  start(): void {
    // no-op: events arrive only via inject()
  }

  stop(): void {
    // no-op
  }
}

export interface LiveStepContext {
  instruction: string;
  expectedTargets: string[];
  phase: "awaiting-tip" | "awaiting-seat";
  edgeId: string;
}

export interface LiveBackendCallbacks {
  /** Returns a raw base64 JPEG (no data: prefix) of the current frame, or null when no frame is ready. */
  getFrame: () => Promise<string | null>;
  /** Returns the active assembly-step context, or null when no step is active. */
  getStepContext: () => LiveStepContext | null;
  /** Receives the latest /api/perceive note (vlm confidence / no-key notice). */
  onNote?: (note: string) => void;
}

/**
 * Live tuning knobs beyond the shared LiveSourceOptions contract. Kept local
 * to lib/perception because lib/types.ts is read-only for this builder;
 * LiveSourceOptions values remain assignable unchanged.
 */
export interface LiveTuningOptions extends LiveSourceOptions {
  /** Consecutive agreeing frames required before tip-at / seated fire. Default 2. */
  consecutiveN?: number;
}

export interface LiveBackendConfig {
  /** POST target. Defaults to /api/perceive. */
  endpoint?: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

interface PerceiveWireResponse {
  events: PerceptionEvent[];
  note?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isPerceptionEvent(v: unknown): v is PerceptionEvent {
  if (!isRecord(v) || typeof v["atMs"] !== "number") return false;
  switch (v["type"]) {
    case "detections":
      return Array.isArray(v["parts"]);
    case "tip-at":
      return typeof v["ref"] === "string";
    case "seated":
      return typeof v["edgeId"] === "string";
    case "misplaced":
      return (
        typeof v["edgeId"] === "string" &&
        Array.isArray(v["expected"]) &&
        (v["expected"] as unknown[]).every((r) => typeof r === "string") &&
        typeof v["observed"] === "string"
      );
    default:
      return false;
  }
}

function parseWireResponse(data: unknown): PerceiveWireResponse {
  if (!isRecord(data)) return { events: [] };
  const events = Array.isArray(data["events"])
    ? (data["events"] as unknown[]).filter(isPerceptionEvent)
    : [];
  const note = typeof data["note"] === "string" ? data["note"] : undefined;
  return { events, note };
}

type TipEvent = Extract<PerceptionEvent, { type: "tip-at" }>;
type SeatedEvent = Extract<PerceptionEvent, { type: "seated" }>;

export interface StreakGateOptions {
  /** Consecutive agreeing frames required before tip-at / seated fire. Default 2, minimum 1. */
  consecutiveN?: number;
}

/**
 * Temporal-consistency filter for per-frame vision verdicts. Accuracy is the
 * top concern (firmware pins come from perception), so single-frame flukes
 * must not advance the step machine:
 * - tip-at fires only after consecutiveN consecutive frames agree on the SAME
 *   target ref; a frame with a different ref restarts the streak at 1.
 * - seated fires only after consecutiveN consecutive seated verdicts.
 * - misplaced passes through immediately (safety beats latency) and resets
 *   both streaks.
 * - A frame with no tip-at/seated (including server-discarded low-confidence
 *   frames, which arrive as zero events) counts as a miss and resets the
 *   matching streak.
 * - detections events pass through untouched.
 * - Changing step context (edge or phase) resets both streaks so a streak
 *   never carries across steps.
 */
export class StreakGate {
  private readonly consecutiveN: number;
  private contextKey: string | null = null;
  private tipRef: string | null = null;
  private tipCount = 0;
  private seatCount = 0;

  constructor(opts: StreakGateOptions = {}) {
    const n = opts.consecutiveN;
    this.consecutiveN =
      typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
  }

  reset(): void {
    this.contextKey = null;
    this.tipRef = null;
    this.tipCount = 0;
    this.seatCount = 0;
  }

  /** Feeds one frame's server events; returns the events to emit downstream. */
  push(frameEvents: PerceptionEvent[], contextKey: string): PerceptionEvent[] {
    if (contextKey !== this.contextKey) {
      this.reset();
      this.contextKey = contextKey;
    }
    const out: PerceptionEvent[] = [];
    for (const e of frameEvents) {
      if (e.type === "detections") out.push(e);
    }
    const misplaced = frameEvents.filter((e) => e.type === "misplaced");
    if (misplaced.length > 0) {
      this.tipRef = null;
      this.tipCount = 0;
      this.seatCount = 0;
      out.push(...misplaced);
      return out;
    }
    const tip = frameEvents.find((e): e is TipEvent => e.type === "tip-at");
    if (tip) {
      if (this.tipRef === tip.ref) {
        this.tipCount += 1;
      } else {
        this.tipRef = tip.ref;
        this.tipCount = 1;
      }
      if (this.tipCount >= this.consecutiveN) {
        out.push(tip);
        this.tipRef = null;
        this.tipCount = 0;
      }
    } else {
      this.tipRef = null;
      this.tipCount = 0;
    }
    const seated = frameEvents.find((e): e is SeatedEvent => e.type === "seated");
    if (seated) {
      this.seatCount += 1;
      if (this.seatCount >= this.consecutiveN) {
        out.push(seated);
        this.seatCount = 0;
      }
    } else {
      this.seatCount = 0;
    }
    return out;
  }
}

/**
 * Polls the caller-supplied frame source every intervalMs, POSTs the frame
 * plus the active step context to /api/perceive, and relays the returned
 * PerceptionEvents to subscribers through a StreakGate (tip-at/seated need
 * consecutiveN agreeing frames; misplaced passes immediately). DOM specifics
 * (getUserMedia, canvas capture) live in hooks/usePerception.ts, not here.
 */
export class LiveBackend extends BaseBackend {
  private readonly intervalMs: number;
  private readonly callbacks: LiveBackendCallbacks;
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;
  private readonly gate: StreakGate;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    source: LiveTuningOptions,
    callbacks: LiveBackendCallbacks,
    config: LiveBackendConfig = {},
  ) {
    super();
    this.intervalMs = source.intervalMs ?? 1500;
    this.callbacks = callbacks;
    this.endpoint = config.endpoint ?? "/api/perceive";
    this.gate = new StreakGate({ consecutiveN: source.consecutiveN });
    const injected = config.fetchFn;
    this.fetchFn = injected
      ? injected
      : (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
  }

  start(): void {
    this.stop();
    this.gate.reset();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.inFlight) return;
    const ctx = this.callbacks.getStepContext();
    if (!ctx) return;
    this.inFlight = true;
    try {
      const frameBase64 = await this.callbacks.getFrame();
      if (!frameBase64) return;
      const res = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          frameBase64,
          instruction: ctx.instruction,
          expectedTargets: ctx.expectedTargets,
          phase: ctx.phase,
          edgeId: ctx.edgeId,
        }),
      });
      if (!res.ok) return;
      const data: unknown = await res.json();
      const parsed = parseWireResponse(data);
      if (parsed.note !== undefined) {
        this.callbacks.onNote?.(parsed.note);
      }
      // Every parsed response counts as one frame for the streaks - an empty
      // events array (low confidence, no-key, malformed verdict) is a miss.
      const gated = this.gate.push(parsed.events, `${ctx.edgeId}:${ctx.phase}`);
      for (const event of gated) {
        this.emit(event);
      }
    } catch {
      // Network/parse hiccups must not kill the polling loop.
    } finally {
      this.inFlight = false;
    }
  }
}

export interface LiveCreateOptions extends LiveTuningOptions, LiveBackendCallbacks, LiveBackendConfig {}

function isMockScript(opts: unknown): opts is MockScriptEntry[] {
  return (
    Array.isArray(opts) &&
    opts.every(
      (entry) =>
        isRecord(entry) && typeof entry["atMs"] === "number" && "event" in entry,
    )
  );
}

function isMockOptionsObject(
  opts: unknown,
): opts is { script?: MockScriptEntry[]; speedMultiplier?: number } {
  return (
    isRecord(opts) &&
    !Array.isArray(opts) &&
    (opts["script"] === undefined || isMockScript(opts["script"]))
  );
}

function isLiveCreateOptions(opts: unknown): opts is LiveCreateOptions {
  return (
    isRecord(opts) &&
    (opts["source"] === "camera" || opts["source"] === "screen") &&
    typeof opts["getFrame"] === "function" &&
    typeof opts["getStepContext"] === "function"
  );
}

export function createBackend(
  mode: BackendMode,
  opts?: unknown,
): PerceptionBackend {
  switch (mode) {
    case "mock": {
      if (isMockScript(opts)) return new MockScriptBackend(opts);
      if (isMockOptionsObject(opts)) {
        const speed = opts.speedMultiplier;
        return new MockScriptBackend(opts.script ?? [], {
          speedMultiplier: typeof speed === "number" ? speed : undefined,
        });
      }
      return new MockScriptBackend([]);
    }
    case "manual":
      return new ManualBackend();
    case "live": {
      if (!isLiveCreateOptions(opts)) {
        throw new Error(
          "createBackend('live', opts) needs { source: 'camera' | 'screen', getFrame, getStepContext } - use usePerception('live', ...) which wires these from the DOM",
        );
      }
      return new LiveBackend(
        {
          source: opts.source,
          intervalMs: opts.intervalMs,
          consecutiveN: opts.consecutiveN,
        },
        {
          getFrame: opts.getFrame,
          getStepContext: opts.getStepContext,
          onNote: opts.onNote,
        },
        { endpoint: opts.endpoint, fetchFn: opts.fetchFn },
      );
    }
  }
}
