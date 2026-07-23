// Pin-aware Arduino firmware templates for Forge.
//
// This file stays self-contained on purpose: its only runtime import is
// node:crypto, so tests/codegen.test.mjs can load it directly through Node's
// type stripping (type-only imports are erased at runtime). Keep runtime
// imports limited to node builtins here; put SDK calls in ./llm.ts.
//
// Doc links used for this module live in docs/references-codegen.md.

import { createHash } from "node:crypto";
import type { Netlist, NetlistEdge, TargetRef } from "@/lib/types";

export type CircuitHint = "button-led" | "dht11";

export interface TweakOptions {
  speed?: "fast" | "slow";
  invert?: boolean;
  fahrenheit?: boolean;
}

export interface TemplateOutput {
  code: string;
  pinsUsed: string[];
}

export interface PinMap {
  /** Every UNO ref the netlist touches, canonical form, D-pins first. */
  unoRefs: TargetRef[];
  /** Wired digital pin numbers, ascending. */
  digitalPins: number[];
  /** Role assignments traced from wiring, when resolvable. */
  roles: { ledPin?: number; buttonPin?: number; dhtPin?: number };
}

export class CodegenError extends Error {}

const D_PIN_RE = /^UNO:D(\d{1,2})$/;

/**
 * Conductivity node for a target ref. Breadboard holes in the same row share
 * a strip per side (columns a-e and f-j), so BB:5:f and BB:5:h map to one
 * node. Arduino header pins and rails are their own nodes. Works for any
 * surface: unknown refs pass through as opaque nodes, never special-cased.
 */
function nodeOf(ref: TargetRef): string {
  if (ref.startsWith("UNO:")) return ref;
  if (ref.startsWith("BB:RAIL:")) return ref;
  const m = /^BB:(\d+):([a-j])$/i.exec(ref);
  if (m) {
    const side = m[2].toLowerCase() <= "e" ? "L" : "R";
    return `BB:${m[1]}:${side}`;
  }
  return ref;
}

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    const p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function sortUnoRefs(refs: string[]): string[] {
  return [...refs].sort((a, b) => {
    const ma = D_PIN_RE.exec(a);
    const mb = D_PIN_RE.exec(b);
    if (ma && mb) return Number(ma[1]) - Number(mb[1]);
    if (ma) return -1;
    if (mb) return 1;
    return a.localeCompare(b);
  });
}

/** Extract every UNO pin the netlist touches and trace component roles. */
export function extractPinMap(netlist: Netlist): PinMap {
  const unoRefs = new Set<string>();
  for (const edge of netlist.edges) {
    for (const ref of [edge.from, edge.to]) {
      if (ref.startsWith("UNO:")) unoRefs.add(ref);
    }
  }

  const digitalPins = [...unoRefs]
    .map((ref) => D_PIN_RE.exec(ref))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);

  // Wires conduct; components do not (for role tracing). Breadboard strip
  // merging happens inside nodeOf.
  const uf = new UnionFind();
  for (const edge of netlist.edges) {
    if (edge.kind === "wire") uf.union(nodeOf(edge.from), nodeOf(edge.to));
  }

  const terminalsOf = (match: (part: string) => boolean): string[] => {
    const nodes: string[] = [];
    for (const edge of netlist.edges) {
      if (edge.kind !== "component") continue;
      const part = (edge.part ?? "").toLowerCase();
      if (match(part)) nodes.push(nodeOf(edge.from), nodeOf(edge.to));
    }
    return nodes;
  };

  const ledTerms = terminalsOf((p) => p.includes("led"));
  const buttonTerms = terminalsOf((p) => p.includes("button") || p.includes("switch"));
  const dhtTerms = terminalsOf((p) => p.includes("dht"));

  const connects = (pin: number, terms: string[]): boolean => {
    const pinRoot = uf.find(nodeOf(`UNO:D${pin}`));
    return terms.some((t) => uf.find(t) === pinRoot);
  };

  const roles: PinMap["roles"] = {};
  for (const pin of digitalPins) {
    if (roles.ledPin === undefined && ledTerms.length > 0 && connects(pin, ledTerms)) {
      roles.ledPin = pin;
    } else if (roles.buttonPin === undefined && buttonTerms.length > 0 && connects(pin, buttonTerms)) {
      roles.buttonPin = pin;
    } else if (roles.dhtPin === undefined && dhtTerms.length > 0 && connects(pin, dhtTerms)) {
      roles.dhtPin = pin;
    }
  }

  // Two wired D-pins with one role traced: the remaining pin takes the
  // remaining role. Covers netlists where one wire lands a hole away from
  // the component terminal strip.
  if (digitalPins.length === 2) {
    const [a, b] = digitalPins;
    if (roles.ledPin !== undefined && roles.buttonPin === undefined) {
      roles.buttonPin = roles.ledPin === a ? b : a;
    } else if (roles.buttonPin !== undefined && roles.ledPin === undefined) {
      roles.ledPin = roles.buttonPin === a ? b : a;
    }
  }

  return { unoRefs: sortUnoRefs([...unoRefs]), digitalPins, roles };
}

/** Infer the circuit from component labels when no hint is given. */
export function inferCircuitHint(netlist: Netlist): CircuitHint {
  const parts = netlist.edges
    .filter((e: NetlistEdge) => e.kind === "component")
    .map((e: NetlistEdge) => (e.part ?? "").toLowerCase());
  if (parts.some((p) => p.includes("dht"))) return "dht11";
  if (parts.some((p) => p.includes("led"))) return "button-led";
  throw new CodegenError(
    "cannot infer circuit from netlist components; pass circuitHint ('button-led' or 'dht11')",
  );
}

function generateButtonLed(netlist: Netlist, opts: TweakOptions): TemplateOutput {
  const map = extractPinMap(netlist);
  const { ledPin, buttonPin } = map.roles;
  if (ledPin === undefined || buttonPin === undefined) {
    throw new CodegenError(
      "button-led codegen needs one LED pin and one button pin traced from the netlist; " +
        `wired digital pins: [${map.digitalPins.join(", ")}], ` +
        `traced roles: led=${ledPin ?? "?"} button=${buttonPin ?? "?"}`,
    );
  }
  const pollMs = opts.speed === "fast" ? 2 : opts.speed === "slow" ? 100 : 10;
  const onWhenPressed = opts.invert !== true;
  const code = `// Forge firmware: button-led, generated from observed wiring.
// BUTTON_PIN <- UNO:D${buttonPin}
// LED_PIN    <- UNO:D${ledPin}
// Behavior: LED ${onWhenPressed ? "on" : "off"} while the button is held.

const uint8_t BUTTON_PIN = ${buttonPin};
const uint8_t LED_PIN = ${ledPin};
const unsigned long POLL_MS = ${pollMs};

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  bool pressed = (digitalRead(BUTTON_PIN) == LOW);
  digitalWrite(LED_PIN, ${onWhenPressed ? "pressed ? HIGH : LOW" : "pressed ? LOW : HIGH"});
  delay(POLL_MS);
}
`;
  return { code, pinsUsed: map.unoRefs };
}

function generateDht11(netlist: Netlist, opts: TweakOptions): TemplateOutput {
  const map = extractPinMap(netlist);
  let dhtPin = map.roles.dhtPin;
  if (dhtPin === undefined && map.digitalPins.length === 1) {
    dhtPin = map.digitalPins[0];
  }
  if (dhtPin === undefined) {
    throw new CodegenError(
      "dht11 codegen needs exactly one traced data pin; " +
        `wired digital pins: [${map.digitalPins.join(", ")}]`,
    );
  }
  // DHT11 sampling floor is about one second, so "fast" stops at 1000 ms.
  const pollMs = opts.speed === "fast" ? 1000 : opts.speed === "slow" ? 5000 : 2000;
  const fahrenheit = opts.fahrenheit === true;
  const code = `// Forge firmware: dht11, generated from observed wiring.
// DHT_PIN <- UNO:D${dhtPin}
// Requires the Adafruit DHT sensor library (DHT.h).

#include <DHT.h>

const uint8_t DHT_PIN = ${dhtPin};
const unsigned long POLL_MS = ${pollMs};

DHT dht(DHT_PIN, DHT11);

void setup() {
  Serial.begin(9600);
  dht.begin();
}

void loop() {
  float t = dht.readTemperature(${fahrenheit ? "true" : ""});
  if (isnan(t)) {
    Serial.println("DHT11 read failed");
  } else {
    Serial.print("Temperature: ");
    Serial.print(t, 1);
    Serial.println(" ${fahrenheit ? "F" : "C"}");
  }
  delay(POLL_MS);
}
`;
  return { code, pinsUsed: map.unoRefs };
}

/** Deterministic template generation, parameterized only by netlist pins. */
export function generateTemplate(
  netlist: Netlist,
  hint: CircuitHint,
  opts: TweakOptions = {},
): TemplateOutput {
  return hint === "dht11" ? generateDht11(netlist, opts) : generateButtonLed(netlist, opts);
}

/**
 * Map a free-text intent onto canned template options. Returns null when no
 * applicable keyword matches, or when any matched keyword does not apply to
 * the circuit (those intents go to the LLM path or the mock fallback).
 */
export function parseIntent(intent: string, hint: CircuitHint): TweakOptions | null {
  const text = intent.toLowerCase();
  const opts: TweakOptions = {};
  let matched = 0;
  let inapplicable = 0;

  if (/\bfast(er)?\b|\bquick(er)?\b|\bspeed\s*up\b/.test(text)) {
    opts.speed = "fast";
    matched += 1;
  }
  if (/\bslow(er|ly)?\b/.test(text)) {
    opts.speed = "slow";
    matched += 1;
  }
  if (/\binvert(ed)?\b|\bflip(ped)?\b|\breverse(d)?\b/.test(text)) {
    if (hint === "button-led") {
      opts.invert = true;
      matched += 1;
    } else {
      inapplicable += 1;
    }
  }
  if (/\bfahrenheit\b|\bdeg(rees)?\s*f\b/.test(text)) {
    if (hint === "dht11") {
      opts.fahrenheit = true;
      matched += 1;
    } else {
      inapplicable += 1;
    }
  }

  if (matched === 0 || inapplicable > 0) return null;
  return opts;
}

/**
 * The pins-in-code == wired-pins check. Throws CodegenError unless:
 * - every UNO:Dx pin in the netlist appears in the code (as a Dx token or a
 *   *_PIN constant value), and
 * - no other D-pin appears, and
 * - pinMode/digitalRead/digitalWrite never take a bare numeric pin literal
 *   (pins must flow through named *_PIN constants so they stay auditable).
 */
export function assertPinsMatch(netlist: Netlist, code: string): void {
  const expected = new Set<number>();
  for (const edge of netlist.edges) {
    for (const ref of [edge.from, edge.to]) {
      const m = D_PIN_RE.exec(ref);
      if (m) expected.add(Number(m[1]));
    }
  }

  const bare = /\b(?:pinMode|digitalWrite|digitalRead)\s*\(\s*(\d{1,2})\b/.exec(code);
  if (bare) {
    throw new CodegenError(
      `bare pin literal ${bare[1]} passed to ${bare[0].trim()}(; pins must go through named *_PIN constants`,
    );
  }

  const found = new Set<number>();
  for (const m of code.matchAll(/\bD(\d{1,2})\b/g)) found.add(Number(m[1]));
  for (const m of code.matchAll(/_PIN\s*=\s*(\d{1,2})\b/g)) found.add(Number(m[1]));

  const missing = [...expected].filter((p) => !found.has(p)).sort((a, b) => a - b);
  if (missing.length > 0) {
    throw new CodegenError(
      `firmware is missing wired pin(s): ${missing.map((p) => `D${p}`).join(", ")}`,
    );
  }
  const extra = [...found].filter((p) => !expected.has(p)).sort((a, b) => a - b);
  if (extra.length > 0) {
    throw new CodegenError(
      `firmware references pin(s) not present in the netlist: ${extra.map((p) => `D${p}`).join(", ")}`,
    );
  }
}

/** sha256 hex digest of the firmware source. */
export function sha256(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}
