// Saying what changed, to someone who has never wired anything.
//
// The old text was "pull the wire UNO:GND -> BB:RAIL:GND". Every part of that
// is machine notation: UNO:GND is a ref, the arrow is a direction that does
// not exist on a wire, and nothing in it tells you which of the four wires on
// your desk to grab. The ref still matters — it is how the app and the person
// agree on one exact hole — but it belongs beside the sentence as a checkable
// footnote, not inside it as the sentence itself.
//
// Every line here follows the same shape:
//   what to do · to which part · at which two places · what it changes
// and each is written as a DELTA from the state before it, because that is
// the only thing the reader has to act on.
//
// Pure module: the naming of a hole is injected, so this file stays free of
// device geometry and `node --test` can load it.

import type { NetlistEdge } from "../types";

/** How a ref should be spoken. Supplied by the caller from the bench layout. */
export interface RefName {
  where: string;
  device: string;
  anyHoleOnLine: boolean;
}

export type RefNamer = (ref: string) => RefName | null;

export interface PlainStep {
  /** Four or five words: what this does. */
  title: string;
  /** The instruction itself, in full sentences, naming real objects. */
  body: string;
  /** The two refs, for checking against the board. Never inside `body`. */
  refs: string;
  /** What the board looks like after, relative to before. */
  delta: string;
}

/** Acronyms that are wrong in lower case, however the netlist spelled them. */
const SHOUTED = ["led", "usb", "dht11", "lcd", "ic", "mcu"];

function properCase(raw: string): string {
  const lower = raw.toLowerCase();
  return SHOUTED.includes(lower) ? lower.toUpperCase() : raw;
}

/** "black jumper wire", "220Ω resistor", "LED" — what you pick up. */
export function partPhrase(edge: NetlistEdge): string {
  const raw = properCase((edge.part ?? "").trim());
  if (edge.kind === "wire") {
    const colour = /wire-([a-z]+)/.exec(raw)?.[1] ?? raw.replace(/wire/i, "").trim();
    return colour ? `${colour} jumper wire` : "jumper wire";
  }
  if (!raw) return "part";
  // A bare "220" is an ohm value that lost its unit somewhere upstream.
  const value = /^\d+$/.test(edge.value ?? "") ? `${edge.value}Ω` : edge.value;
  return value ? `${raw} (${value})` : raw;
}

function spoken(name: RefName | null, ref: string): string {
  if (!name) return ref;
  const place = name.anyHoleOnLine ? `any hole on the ${name.where}` : name.where;
  return `${place} of the ${name.device}`;
}

function shortPlace(name: RefName | null, ref: string): string {
  return name ? name.where : ref;
}

function countLine(before: number, after: number): string {
  if (after === before) return "The wiring does not change.";
  const dir = after > before ? "adds" : "takes away";
  const n = Math.abs(after - before);
  return `This ${dir} ${n} connection, so the board goes from ${before} to ${after}.`;
}

/** Put a connection in. */
export function addStep(
  edge: NetlistEdge,
  name: RefNamer,
  before: number,
): PlainStep {
  const a = name(edge.from);
  const b = name(edge.to);
  const thing = partPhrase(edge);
  const body =
    edge.kind === "wire"
      ? `Take a ${thing}. Push one end into ${spoken(a, edge.from)}, and the other end into ${spoken(b, edge.to)}. Push until it sits flush; a gentle tug should not pull it out.`
      : `Take the ${thing}. Its two legs go into ${spoken(a, edge.from)} and ${spoken(b, edge.to)}, so it bridges the two. Press it flat against the board.`;
  return {
    title: edge.kind === "wire" ? `Add the ${thing}` : `Fit the ${thing}`,
    body,
    refs: `${edge.from} · ${edge.to}`,
    delta: countLine(before, before + 1),
  };
}

/** Take a connection out. */
export function removeStep(
  edge: NetlistEdge,
  name: RefNamer,
  before: number,
): PlainStep {
  const a = name(edge.from);
  const b = name(edge.to);
  const thing = partPhrase(edge);
  const body =
    edge.kind === "wire"
      ? `Find the ${thing} running between ${shortPlace(a, edge.from)} and ${shortPlace(b, edge.to)}. Pull both ends straight up and out. Leave everything else where it is.`
      : `Lift the ${thing} out. Its legs are in ${shortPlace(a, edge.from)} and ${shortPlace(b, edge.to)}. Pull it straight up so the legs do not bend.`;
  return {
    title: `Take out the ${thing}`,
    body,
    refs: `${edge.from} · ${edge.to}`,
    delta: countLine(before, before - 1),
  };
}

/**
 * A rollback read as a sequence, each step a delta from the one before it.
 *
 * The op list arrives already ordered (removals first, in reverse build
 * order); this only turns each op into words and tracks the running count, so
 * step three can say what the board looks like by the time you reach it.
 */
export function plainPlan(
  ops: readonly { op: "remove" | "add"; edge: NetlistEdge }[],
  name: RefNamer,
  startCount: number,
): PlainStep[] {
  const steps: PlainStep[] = [];
  let count = startCount;
  for (const op of ops) {
    const step =
      op.op === "remove"
        ? removeStep(op.edge, name, count)
        : addStep(op.edge, name, count);
    steps.push(step);
    count += op.op === "remove" ? -1 : 1;
  }
  return steps;
}

/**
 * One sentence for a change that already happened, for the history view.
 * Past tense, because this is a record rather than an instruction.
 */
export function changeSentence(
  edge: NetlistEdge,
  name: RefNamer,
  direction: "added" | "removed",
): string {
  const a = name(edge.from);
  const b = name(edge.to);
  const thing = partPhrase(edge);
  const between = `${shortPlace(a, edge.from)} and ${shortPlace(b, edge.to)}`;
  if (direction === "added") {
    return edge.kind === "wire"
      ? `A ${thing} now runs between ${between}.`
      : `The ${thing} was fitted between ${between}.`;
  }
  return edge.kind === "wire"
    ? `The ${thing} between ${between} was taken out.`
    : `The ${thing} between ${between} was removed.`;
}

/** Headline for a whole diff: the change in one line, before any detail. */
export function diffHeadline(added: number, removed: number, softwareChanged: boolean): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} connection${added === 1 ? "" : "s"} added`);
  if (removed > 0) parts.push(`${removed} taken out`);
  if (parts.length === 0) {
    return softwareChanged
      ? "The wiring is identical. Only the code on the board changed."
      : "Nothing changed: same wiring, same code.";
  }
  return `${parts.join(", ")}${softwareChanged ? ", and the code changed too" : ", the code is unchanged"}.`;
}
