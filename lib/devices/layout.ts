// Turning a device spec into hole coordinates.
//
// Everything here works in REAL MILLIMETRES. A breadboard hole sits 2.54 mm
// from its neighbour because that is the pitch of the part, and an Uno is
// 68.6 x 53.4 mm because that is the size of an Uno. Working in real units
// means two devices drawn on the same canvas are to scale against each other,
// and it means a wire that spans "three holes" spans 7.62 mm on screen the
// way it does on the desk.
//
// The renderer scales millimetres to pixels at the end and never does layout
// arithmetic of its own, so the picture cannot drift from the spec.
//
// Ref grammar (unchanged from the old board view, which is why existing
// netlists still resolve):
//   <instance>:<local>
//   BB:12:e         breadboard instance BB, row 12, column e
//   BB:RAIL:GND     the ground rail, representative hole
//   BB:RAIL:T-:4    an exact rail hole: top side, minus line, hole 4
//   UNO:D13         board instance UNO, pin D13
//
// Pure module: type-only project imports so `node --test` can load it.

import type { BreadboardSpec, BoardSpec, DeviceSpec } from "./catalog";

/** 0.1 inch: the pitch every breadboard and every 0.1" header shares. */
export const PITCH_MM = 2.54;
/** 0.3 inch: the centre channel a DIP chip straddles. */
export const DIP_CHANNEL_MM = 7.62;

/** Column letters a breadboard actually has, given its columns per half. */
export function columnLetters(spec: BreadboardSpec): string[] {
  const total = spec.columnsPerHalf * spec.halves;
  return Array.from({ length: total }, (_, i) => String.fromCharCode(97 + i));
}

/** One line of hard numbers for the device card, so the model is checkable. */
export function specSummary(spec: DeviceSpec): string {
  if (spec.kind === "breadboard") {
    const rails = spec.rails.reduce((n, r) => n + r.lines.length, 0);
    const cols = columnLetters(spec);
    const colRange =
      cols.length > 0 ? `${cols[0]}-${cols[cols.length - 1]}` : "none";
    return `${spec.tiePoints} tie points · ${spec.rows} rows · columns ${colRange} · ${rails} rail${rails === 1 ? "" : "s"} · ${PITCH_MM} mm pitch`;
  }
  return `${spec.mcu} · ${spec.clockMhz} MHz · ${spec.flashKb} KB flash · ${spec.ramKb} KB RAM · ${spec.logicV}V logic`;
}

/** Margin from the short edge of a breadboard to the first row of holes. */
const BB_EDGE_MM = 3.81;
/** Gap between a rail pair and the terminal block. */
const BB_RAIL_GAP_MM = 3.5;
/** Inset from a board's long edge to the centre of its header pins. */
const HEADER_INSET_MM = 2.6;

export interface Hole {
  /** Fully qualified ref, e.g. "BB:12:e". */
  ref: string;
  /** Ref without the instance prefix, e.g. "12:e". */
  localRef: string;
  /** Absolute position on the canvas, in millimetres. */
  x: number;
  y: number;
  /** Which structure the hole belongs to: "row", "rail" or a header id. */
  group: string;
  /** Human label used in instructions and hover text. */
  label: string;
  /** Holes on the same node are electrically joined inside the part. */
  node: string;
}

export interface DeviceGeometry {
  widthMm: number;
  heightMm: number;
  holes: Hole[];
}

export interface Placement {
  instanceId: string;
  specId: string;
  xMm: number;
  yMm: number;
}

export interface PlacedDevice {
  placement: Placement;
  spec: DeviceSpec;
  geometry: DeviceGeometry;
}

export interface ProjectLayout {
  devices: PlacedDevice[];
  widthMm: number;
  heightMm: number;
  /** Every hole on the canvas, absolute. */
  holes: Hole[];
}

function railLineId(side: "top" | "bottom", polarity: "+" | "-"): string {
  return `${side === "top" ? "T" : "B"}${polarity}`;
}

/**
 * Rail holes come in groups (five on nearly every board) with a blank slot
 * between groups. Drawing them evenly spaced would put a hole where the
 * plastic is, which is exactly the kind of small lie that makes a wireframe
 * useless for aiming at.
 */
function railHoleXs(spec: BreadboardSpec): number[] {
  const xs: number[] = [];
  let slot = 0;
  let placed = 0;
  while (placed < spec.rows - 3) {
    if (slot % (spec.railGroup + 1) !== spec.railGroup) {
      xs.push(BB_EDGE_MM + PITCH_MM * (slot + 1));
      placed += 1;
    }
    slot += 1;
  }
  return xs;
}

function breadboardGeometry(spec: BreadboardSpec, instanceId: string): DeviceGeometry {
  const holes: Hole[] = [];
  const cols = columnLetters(spec);
  const topRails = spec.rails.find((r) => r.side === "top");
  const bottomRails = spec.rails.find((r) => r.side === "bottom");

  let y = BB_RAIL_GAP_MM;
  const railY = new Map<string, number>();

  if (topRails) {
    for (const polarity of topRails.lines) {
      railY.set(railLineId("top", polarity), y);
      y += PITCH_MM;
    }
    y += BB_RAIL_GAP_MM;
  }

  const columnY = new Map<string, number>();
  for (let half = 0; half < spec.halves; half += 1) {
    for (let c = 0; c < spec.columnsPerHalf; c += 1) {
      const letter = cols[half * spec.columnsPerHalf + c];
      if (letter === undefined) continue;
      columnY.set(letter, y);
      y += PITCH_MM;
    }
    if (half === 0 && spec.halves === 2) y += DIP_CHANNEL_MM - PITCH_MM;
  }

  if (bottomRails) {
    y += BB_RAIL_GAP_MM;
    for (const polarity of bottomRails.lines) {
      railY.set(railLineId("bottom", polarity), y);
      y += PITCH_MM;
    }
  }

  const heightMm = y + BB_RAIL_GAP_MM;
  const widthMm = BB_EDGE_MM * 2 + PITCH_MM * (spec.rows + 1);

  // Terminal holes. Within one row, the five holes of a half share a node:
  // that is the whole point of a breadboard and the reason "same row" appears
  // in every instruction.
  for (let row = 1; row <= spec.rows; row += 1) {
    const x = BB_EDGE_MM + PITCH_MM * row;
    for (let i = 0; i < cols.length; i += 1) {
      const letter = cols[i];
      if (letter === undefined) continue;
      const cy = columnY.get(letter);
      if (cy === undefined) continue;
      const half = Math.floor(i / spec.columnsPerHalf);
      holes.push({
        ref: `${instanceId}:${row}:${letter}`,
        localRef: `${row}:${letter}`,
        x,
        y: cy,
        group: "row",
        label: `row ${row}, hole ${letter}`,
        node: `${instanceId}:row${row}:h${half}`,
      });
    }
  }

  // Rail holes. Every hole on one rail line shares a node down the length of
  // the board, which is why any of them is a valid landing point for "the
  // ground rail".
  const xs = railHoleXs(spec);
  for (const [lineId, ly] of railY) {
    const polarity = lineId.endsWith("+") ? "+" : "-";
    xs.forEach((x, i) => {
      holes.push({
        ref: `${instanceId}:RAIL:${lineId}:${i}`,
        localRef: `RAIL:${lineId}:${i}`,
        x,
        y: ly,
        group: "rail",
        label: polarity === "+" ? "power (+) rail" : "ground (−) rail",
        node: `${instanceId}:rail:${lineId}`,
      });
    });
  }

  return { widthMm, heightMm, holes };
}

function boardGeometry(spec: BoardSpec, instanceId: string): DeviceGeometry {
  const holes: Hole[] = [];
  for (const header of spec.headers) {
    const y =
      header.side === "top" ? HEADER_INSET_MM : spec.heightMm - HEADER_INSET_MM;
    header.pins.forEach((pin, i) => {
      if (pin === null) return;
      holes.push({
        ref: `${instanceId}:${pin}`,
        localRef: pin,
        x: header.startMm + i * PITCH_MM,
        y,
        group: header.id,
        label: `${pinLabel(pin)} pin`,
        node: `${instanceId}:${pin}`,
      });
    });
  }
  return { widthMm: spec.widthMm, heightMm: spec.heightMm, holes };
}

/** "GND2" is a second physical GND pin; it prints as GND. */
export function pinLabel(pin: string): string {
  return /^(GND|RESET|VIN|3V3|5V)\d$/.test(pin) ? pin.slice(0, -1) : pin;
}

/** Local geometry for a spec, holes at device-local millimetres. */
export function geometryFor(spec: DeviceSpec, instanceId: string): DeviceGeometry {
  return spec.kind === "breadboard"
    ? breadboardGeometry(spec, instanceId)
    : boardGeometry(spec, instanceId);
}

export type SpecLookup = (id: string) => DeviceSpec | undefined;

/** Place every device on one canvas, holes translated to absolute mm. */
export function layoutProject(
  placements: readonly Placement[],
  lookup: SpecLookup,
): ProjectLayout {
  const devices: PlacedDevice[] = [];
  const holes: Hole[] = [];
  let widthMm = 0;
  let heightMm = 0;

  for (const placement of placements) {
    const spec = lookup(placement.specId);
    if (!spec) continue;
    const local = geometryFor(spec, placement.instanceId);
    const absolute: Hole[] = local.holes.map((h) => ({
      ...h,
      x: h.x + placement.xMm,
      y: h.y + placement.yMm,
    }));
    devices.push({
      placement,
      spec,
      geometry: { ...local, holes: absolute },
    });
    holes.push(...absolute);
    widthMm = Math.max(widthMm, placement.xMm + local.widthMm);
    heightMm = Math.max(heightMm, placement.yMm + local.heightMm);
  }

  return { devices, holes, widthMm, heightMm };
}

/**
 * Resolve a ref to absolute millimetres.
 *
 * "BB:RAIL:GND" and "BB:RAIL:PWR" are the loose form every existing netlist
 * uses: they name a rail without naming a hole, because on real hardware any
 * hole on that rail is the same electrical point. They resolve to a hole near
 * the middle of the line so the drawn wire lands somewhere sensible.
 */
export function resolveRef(
  layout: ProjectLayout,
  ref: string,
): { x: number; y: number } | null {
  const exact = layout.holes.find((h) => h.ref === ref);
  if (exact) return { x: exact.x, y: exact.y };

  const loose = /^([^:]+):RAIL:(PWR|GND|\+|-)$/.exec(ref);
  if (loose) {
    const instance = loose[1];
    const polarity = loose[2] === "PWR" || loose[2] === "+" ? "+" : "-";
    // A board can carry two lines of the same polarity, one per side. Pick ONE
    // line and take the hole at its centre; mixing both lines into a single
    // list puts the "middle" hole at the seam between them, which is how a
    // ground wire ends up drawn to the end of a rail instead of its middle.
    const lineIds = [
      ...new Set(
        layout.holes
          .filter((h) => h.group === "rail" && h.ref.startsWith(`${instance}:RAIL:`))
          .map((h) => h.ref.split(":")[2] ?? "")
          .filter((id) => id.endsWith(polarity)),
      ),
    ].sort();
    const chosen = lineIds[0];
    if (chosen === undefined) return null;
    const line = layout.holes.filter(
      (h) => h.ref.startsWith(`${instance}:RAIL:${chosen}:`),
    );
    const mid = line[Math.floor(line.length / 2)];
    return mid ? { x: mid.x, y: mid.y } : null;
  }
  return null;
}

/** Hole record for a ref, loose rail refs included. */
export function holeFor(layout: ProjectLayout, ref: string): Hole | null {
  const exact = layout.holes.find((h) => h.ref === ref);
  if (exact) return exact;
  const xy = resolveRef(layout, ref);
  if (!xy) return null;
  return layout.holes.find((h) => h.x === xy.x && h.y === xy.y) ?? null;
}

/** A sentence a first-timer can act on, naming the model it belongs to. */
export function describeRef(layout: ProjectLayout, ref: string): string {
  const hole = holeFor(layout, ref);
  if (!hole) return ref;
  const owner = layout.devices.find((d) =>
    hole.ref.startsWith(`${d.placement.instanceId}:`),
  );
  const model = owner ? owner.spec.model : "";
  return model ? `${hole.label} on the ${model}` : hole.label;
}

export interface ConnectionEnd {
  /** The canonical ref, shown as a code so it can be checked against a step. */
  ref: string;
  /** The device this end lands on. */
  device: string;
  /** The hole or pin, named the way a person would say it out loud. */
  where: string;
  /** True when the ref names a rail rather than one exact hole. */
  anyHoleOnLine: boolean;
}

/**
 * The two ends of a connection, spelled out.
 *
 * "Run a jumper from GND to the rail" is the kind of instruction that assumes
 * you already know where GND is. Both ends get named down to the device and
 * the hole, so a step can be followed without inference — and so a step can be
 * checked afterwards against what is on the bench.
 */
export function connectionEnds(
  layout: ProjectLayout,
  from: string,
  to: string,
): { from: ConnectionEnd | null; to: ConnectionEnd | null } {
  const end = (ref: string): ConnectionEnd | null => {
    const hole = holeFor(layout, ref);
    if (!hole) return null;
    const owner = layout.devices.find((d) =>
      hole.ref.startsWith(`${d.placement.instanceId}:`),
    );
    return {
      ref,
      device: owner ? owner.spec.model : "unknown device",
      where: hole.label,
      anyHoleOnLine: hole.group === "rail" && !ref.includes(`RAIL:${hole.ref.split(":")[2]}:`),
    };
  };
  return { from: end(from), to: end(to) };
}

/** Nearest hole to a point, within a radius. Used for drag-to-wire snapping. */
export function nearestHole(
  layout: ProjectLayout,
  xMm: number,
  yMm: number,
  radiusMm = PITCH_MM * 0.9,
): Hole | null {
  let best: Hole | null = null;
  let bestDist = Infinity;
  for (const hole of layout.holes) {
    const d = Math.hypot(hole.x - xMm, hole.y - yMm);
    if (d < bestDist) {
      bestDist = d;
      best = hole;
    }
  }
  return best !== null && bestDist <= radiusMm ? best : null;
}

/** True when two refs land on the same internal node: already connected. */
export function sameNode(layout: ProjectLayout, a: string, b: string): boolean {
  const ha = holeFor(layout, a);
  const hb = holeFor(layout, b);
  return ha !== null && hb !== null && ha.node === hb.node;
}

/**
 * Lay the bench out left to right: breadboards first, boards to their right.
 *
 * Stacking them vertically made the bench taller than it was wide, so on a
 * wide screen the drawing could only ever fill a narrow strip down the middle
 * while the rest of the column sat empty. Side by side is also how a bench
 * actually looks: the board next to the breadboard, jumpers crossing the gap.
 */
export function autoPlace(specIds: readonly string[], lookup: SpecLookup): Placement[] {
  const ordered = [...specIds].sort((a, b) => {
    const sa = lookup(a)?.kind === "breadboard" ? 0 : 1;
    const sb = lookup(b)?.kind === "breadboard" ? 0 : 1;
    return sa - sb;
  });
  const placements: Placement[] = [];
  const used = new Map<string, number>();
  const GAP_MM = 14; // room for a jumper to arc across without hiding a hole
  let x = 6;
  let tallest = 0;
  for (const specId of ordered) {
    const spec = lookup(specId);
    if (!spec) continue;
    const base = instanceBase(spec);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const instanceId = n === 1 ? base : `${base}${n}`;
    const geo = geometryFor(spec, instanceId);
    tallest = Math.max(tallest, geo.heightMm);
    placements.push({ instanceId, specId, xMm: x, yMm: 6 });
    // A USB socket overhangs the left edge, so boards need clearance there.
    x += geo.widthMm + GAP_MM;
  }
  // Centre each device vertically against the tallest, the way you would
  // square things up on a desk.
  return placements.map((p) => {
    const spec = lookup(p.specId);
    if (!spec) return p;
    const h = geometryFor(spec, p.instanceId).heightMm;
    return { ...p, yMm: 6 + (tallest - h) / 2 };
  });
}

/** Instance prefix for a spec. "BB" and "UNO" keep old netlists resolving. */
export function instanceBase(spec: DeviceSpec): string {
  if (spec.kind === "breadboard") return "BB";
  if (spec.id === "uno-r3") return "UNO";
  if (spec.id === "mega-2560") return "MEGA";
  if (spec.id === "nano") return "NANO";
  return "MCU";
}
