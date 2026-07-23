// Pure parsing + mapping for the bench: arduino-cli JSON output -> DeviceCard,
// netlist -> beginner-named peripherals, session merge, FlashResult shaping.
//
// Runtime imports: zod only (Node resolves it from node_modules, so
// tests/bench.test.mjs can load this file through Node's type stripping).
// Cross-file project imports stay type-only — the established repo pattern.
//
// JSON shapes verified against the official docs and a local probe of
// arduino-cli 1.5.1; deep links in docs/references-delta-bench.md.

import { z } from "zod";
import type {
  DeviceCard,
  FlashResult,
  Netlist,
  NetlistEdge,
  PeripheralInfo,
} from "@/lib/types";

// --- arduino-cli JSON schemas (snake_case per the gRPC message reference) ---

/** `arduino-cli board list --json` -> { detected_ports: DetectedPort[] } */
export const boardListSchema = z.object({
  detected_ports: z
    .array(
      z.object({
        port: z.object({
          address: z.string(),
          label: z.string().optional(),
          protocol: z.string().optional(),
          protocol_label: z.string().optional(),
        }),
        matching_boards: z
          .array(z.object({ name: z.string(), fqbn: z.string().optional() }))
          .optional(),
      }),
    )
    .optional()
    .default([]),
});
export type BoardListJson = z.infer<typeof boardListSchema>;

/** `arduino-cli version --json` -> PascalCase keys (probed on 1.5.1). */
export const versionSchema = z.object({ VersionString: z.string() });

/** `arduino-cli core list --json` -> { platforms: [{ id, installed_version }] } */
export const coreListSchema = z.object({
  platforms: z
    .array(z.object({ id: z.string(), installed_version: z.string().optional() }))
    .optional()
    .default([]),
});

// --- board list -> DeviceCard ------------------------------------------------

/** Stable id per physical hookup: port address + fqbn (or "unknown"). */
export function deviceIdFor(portAddress: string, fqbn: string | null): string {
  return `${portAddress}::${fqbn ?? "unknown"}`.replace(/[^A-Za-z0-9:._/-]/g, "_");
}

/**
 * Maps a parsed `board list --json` payload to bare DeviceCards.
 * Identified boards are "awake"; a serial port with no matching board is
 * "quiet" (something is plugged in but it did not introduce itself).
 * firmwareHash/peripherals are enriched later by the registry.
 */
export function detectedToDeviceCards(json: BoardListJson, nowIso: string): DeviceCard[] {
  const cards: DeviceCard[] = [];
  for (const dp of json.detected_ports) {
    const first = dp.matching_boards?.[0];
    const fqbn = first?.fqbn ?? null;
    cards.push({
      id: deviceIdFor(dp.port.address, fqbn),
      boardName: first?.name ?? "Unknown device",
      fqbn,
      port: dp.port.address,
      transport: "usb",
      status: first ? "awake" : "quiet",
      lastSeen: nowIso,
      firmwareHash: null,
      peripherals: [],
    });
  }
  return cards;
}

/**
 * Merges the fresh scan into the session's known devices. Devices in the scan
 * win; known devices missing from the scan flip to "unplugged" and keep their
 * last-seen stamp so the UI can say when the board vanished.
 */
export function mergeDevices(known: DeviceCard[], scanned: DeviceCard[]): DeviceCard[] {
  const merged: DeviceCard[] = [...scanned];
  for (const old of known) {
    if (!scanned.some((d) => d.id === old.id)) {
      merged.push({ ...old, status: "unplugged" });
    }
  }
  return merged;
}

// --- netlist -> peripherals --------------------------------------------------

const UNO_PIN_RE = /^UNO:(D\d{1,2}|A\d)$/;
const BB_HOLE_RE = /^BB:(\d{1,2}):([a-j])$/;

/** Beginner names for netlist part labels. */
const FRIENDLY_PART_NAMES: Record<string, string> = {
  led: "LED",
  pushbutton: "button",
  button: "button",
  resistor: "resistor",
  dht11: "temperature sensor",
  buzzer: "speaker",
  speaker: "speaker",
  potentiometer: "knob",
  photoresistor: "light sensor",
  ldr: "light sensor",
  servo: "servo motor",
};

export function friendlyPartName(part: string): string {
  return FRIENDLY_PART_NAMES[part.toLowerCase()] ?? part.toLowerCase();
}

interface Hole {
  column: number;
  /** Breadboard halves: rows a-e share a strip, rows f-j share a strip. */
  half: "L" | "R";
}

function holeOf(ref: string): Hole | null {
  const m = BB_HOLE_RE.exec(ref);
  if (!m) return null;
  const column = Number(m[1]);
  const row = m[2] ?? "a";
  return { column, half: row <= "e" ? "L" : "R" };
}

function unoPinOf(ref: string): string | null {
  const m = UNO_PIN_RE.exec(ref);
  return m ? (m[1] ?? null) : null;
}

/**
 * Derives beginner-named peripherals from a commit netlist: for every wire
 * leaving a UNO data pin (D2, A0, ...), traces one breadboard strip hop
 * (same column + half, or a column spanned by a multi-pin component) to the
 * component sitting there. Power pins (5V/GND/VIN) are skipped on purpose —
 * a beginner cares about "LED on D13", not the ground rail.
 */
export function derivePeripherals(netlist: Netlist): PeripheralInfo[] {
  const components = netlist.edges.filter(
    (e): e is NetlistEdge & { part: string } => e.kind === "component" && e.part !== undefined,
  );

  const found: PeripheralInfo[] = [];
  const seenPins = new Set<string>();

  const record = (pin: string, name: string): void => {
    if (seenPins.has(pin)) return;
    seenPins.add(pin);
    found.push({ name, pin, source: "netlist" });
  };

  for (const edge of netlist.edges) {
    const ends: Array<[string, string]> = [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ];
    for (const [a, b] of ends) {
      const pin = unoPinOf(a);
      if (pin === null) continue;

      // Component wired straight to the UNO pin.
      if (edge.kind === "component" && edge.part !== undefined) {
        record(pin, friendlyPartName(edge.part));
        continue;
      }

      // Wire into the breadboard: find the component on the same strip.
      const hole = holeOf(b);
      if (!hole) continue;
      for (const comp of components) {
        const endpoints = [holeOf(comp.from), holeOf(comp.to)].filter(
          (h): h is Hole => h !== null,
        );
        const sameStrip = endpoints.some(
          (h) => h.half === hole.half && h.column === hole.column,
        );
        // Multi-pin packages (e.g. a DHT11 spanning columns 3..5) also own the
        // columns between their outer pins on the same half.
        const spans =
          endpoints.length === 2 &&
          endpoints[0] !== undefined &&
          endpoints[1] !== undefined &&
          endpoints[0].half === hole.half &&
          endpoints[1].half === hole.half &&
          Math.min(endpoints[0].column, endpoints[1].column) <= hole.column &&
          hole.column <= Math.max(endpoints[0].column, endpoints[1].column);
        if (sameStrip || spans) {
          record(pin, friendlyPartName(comp.part));
          break;
        }
      }
    }
  }
  return found;
}

// --- runtime mirrors of the shared contracts (for client-side fetch parsing) --

/** Mirrors PeripheralInfo from lib/types.ts. */
export const peripheralInfoSchema = z.object({
  name: z.string(),
  pin: z.string(),
  source: z.enum(["netlist", "vision", "user"]),
});

/** Mirrors DeviceCard from lib/types.ts. */
export const deviceCardSchema = z.object({
  id: z.string(),
  boardName: z.string(),
  fqbn: z.string().nullable(),
  port: z.string().nullable(),
  transport: z.enum(["usb", "wifi-ota"]),
  status: z.enum(["awake", "quiet", "unplugged"]),
  lastSeen: z.string().nullable(),
  firmwareHash: z.string().nullable(),
  peripherals: z.array(peripheralInfoSchema),
});

/** Mirrors BenchStatus from lib/types.ts; GET /api/bench response. */
export const benchStatusSchema = z.object({
  cliAvailable: z.boolean(),
  cliPath: z.string().nullable(),
  coreInstalled: z.boolean(),
  devices: z.array(deviceCardSchema),
  note: z.string().optional(),
});

/** Mirrors FlashResult from lib/types.ts; /api/flash + /api/bench/test response. */
export const flashResultSchema = z.object({
  ok: z.boolean(),
  stage: z.enum(["compile", "upload", "handshake", "done"]),
  output: z.string(),
  firmwareHash: z.string().optional(),
  guidance: z.string().optional(),
});

// --- FlashResult shaping -----------------------------------------------------

/**
 * The compile-succeeded-but-nothing-to-upload-to result: still ok=true, so
 * the UI can celebrate the code being valid while explaining the next step.
 */
export function compileOnlyResult(output: string, firmwareHash: string): FlashResult {
  return {
    ok: true,
    stage: "compile",
    output,
    firmwareHash,
    guidance:
      "The code compiles cleanly. No board is plugged in yet, so I could not send it anywhere - plug your Arduino in and press Flash again.",
  };
}
