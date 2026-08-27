"use client";

// The wireframe: one renderer for every device in the catalog.
//
// Nothing in this file knows what a breadboard looks like. It asks
// lib/devices/layout.ts where the holes are and draws them. That is the whole
// reason a 3-column strip and a 63-row full-size board come out different: the
// spec differs, so the geometry differs, so the picture differs. The old view
// hardcoded one body, which meant every build was drawn on the same fictional
// board no matter what was on the desk.
//
// The SVG user unit IS one millimetre. A hole is 2.54 units from its
// neighbour because that is the real pitch, so devices are to scale against
// each other and a wire's drawn length is its real length.
//
// Two modes:
//   view — read-only. Used by the version-control page, where the wiring is
//          history and must not be editable, with diff colouring.
//   edit — drag a device to move it, drag hole to hole to lay a connection,
//          click a connection to select and delete it.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { Netlist, NetlistEdge } from "@/lib/types";
import type { BoardSpec, BreadboardSpec } from "@/lib/devices/catalog";
import {
  PITCH_MM,
  columnLetters,
  holeFor,
  nearestHole,
  resolveRef,
  type Hole,
  type PlacedDevice,
  type ProjectLayout,
} from "@/lib/devices/layout";

const ACCENT = "#22c55e";
const ERROR = "#ef4444";
const WARN = "#f59e0b";
const MUTED = "#8b98a5";
const HOLE = "#0b0f14";
const PANEL = "#131a22";
const BODY = "#182430";
const BORDER = "#22303d";

/** Snap devices to half-pitch, so two boards line up hole-to-hole. */
const GRID_MM = PITCH_MM / 2;

/**
 * Canvas size for a layout: the bench plus room to drag into.
 *
 * The canvas hugs the devices rather than sitting on a fixed minimum. A floor
 * of 180 mm meant a 90 mm breadboard was drawn into half a canvas, so the
 * board rendered at half the size it could have on a wide screen while the
 * other half stayed empty. Exported so a drop target can convert a screen
 * position into the same millimetres the renderer uses.
 */
export function canvasSize(
  layout: ProjectLayout,
  padMm = 12,
): { w: number; h: number } {
  return {
    w: Math.max(layout.widthMm + padMm, 60),
    h: Math.max(layout.heightMm + padMm, 40),
  };
}

export type PlacementTool =
  | { kind: "wire"; part: string; colour: string }
  | { kind: "component"; part: string; value?: string; colour: string };

export interface WireframeProps {
  layout: ProjectLayout;
  netlist: Netlist;
  mode: "view" | "edit";
  /** Diff colouring: edges only here are removed, edges only in netlist added. */
  diffAgainst?: Netlist;
  /** Refs to ring, for the step the user is on right now. */
  highlightRefs?: readonly string[];
  /** A connection not yet made: drawn dashed, as a target. */
  ghostEdge?: NetlistEdge | null;
  selectedEdgeId?: string | null;
  tool?: PlacementTool;
  onMoveDevice?: (instanceId: string, xMm: number, yMm: number) => void;
  onAddEdge?: (from: string, to: string) => void;
  onSelectEdge?: (edgeId: string | null) => void;
  /** Extra canvas beyond the devices, so there is room to drag into. */
  padMm?: number;
  /**
   * Whether devices can be dragged. Defaults to whether wiring can be edited,
   * but the two are separate: a commit's wiring is history and must not
   * change, while rearranging the bench to match the desk in front of you is
   * just looking at the same board from a better angle.
   */
  allowDeviceDrag?: boolean;
}

interface DragDevice {
  type: "device";
  instanceId: string;
  grabDx: number;
  grabDy: number;
}
interface DragWire {
  type: "wire";
  fromRef: string;
  x: number;
  y: number;
}
interface DragPan {
  type: "pan";
  grabX: number;
  grabY: number;
  originX: number;
  originY: number;
}
type DragState = DragDevice | DragWire | DragPan | null;

function edgeKey(e: NetlistEdge): string {
  return [e.kind, e.from, e.to, e.part ?? ""].join("|");
}

/** Jumper colour from the part name, falling back to a neutral lead. */
export function wireColour(part: string | undefined): string {
  const p = (part ?? "").toLowerCase();
  if (p.includes("black")) return "#475569";
  if (p.includes("red")) return "#dc2626";
  if (p.includes("yellow")) return "#eab308";
  if (p.includes("green")) return "#16a34a";
  if (p.includes("blue")) return "#3b82f6";
  if (p.includes("white")) return "#e2e8f0";
  return "#64748b";
}

/**
 * A jumper sags. Drawing connections as straight diagonals reads as a
 * schematic; drawing the arc reads as a wire you could pick up, and it keeps
 * two connections between the same pair of holes visually distinct.
 */
function wirePath(
  a: { x: number; y: number },
  b: { x: number; y: number },
  lift: number,
): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Bow perpendicular to the run, scaled by length so short hops stay tidy.
  const bow = Math.min(len * 0.18, 9) * lift;
  const nx = -dy / len;
  const ny = dx / len;
  return `M ${a.x} ${a.y} Q ${mx + nx * bow} ${my + ny * bow} ${b.x} ${b.y}`;
}

function BreadboardBody({ device }: { device: PlacedDevice }) {
  const spec = device.spec as BreadboardSpec;
  const { xMm: x, yMm: y } = device.placement;
  const { widthMm: w, heightMm: h } = device.geometry;
  const cols = columnLetters(spec);
  const els: ReactElement[] = [];

  els.push(
    <rect
      key="body"
      x={x}
      y={y}
      width={w}
      height={h}
      rx={1.6}
      fill={BODY}
      stroke={BORDER}
      strokeWidth={0.4}
    />,
  );

  // The centre channel, drawn from where the holes actually stop.
  if (spec.halves === 2 && spec.columnsPerHalf > 0) {
    const lastFirstHalf = cols[spec.columnsPerHalf - 1];
    const firstSecondHalf = cols[spec.columnsPerHalf];
    const eY = device.geometry.holes.find((hh) => hh.localRef === `1:${lastFirstHalf}`)?.y;
    const fY = device.geometry.holes.find((hh) => hh.localRef === `1:${firstSecondHalf}`)?.y;
    if (eY !== undefined && fY !== undefined) {
      els.push(
        <rect
          key="channel"
          x={x + 1.2}
          y={eY + PITCH_MM * 0.6}
          width={w - 2.4}
          height={fY - eY - PITCH_MM * 1.2}
          fill={HOLE}
          opacity={0.5}
        />,
      );
    }
  }

  // Rail stripes, drawn against the line of holes they belong to.
  for (const rail of spec.rails) {
    for (const polarity of rail.lines) {
      const lineId = `${rail.side === "top" ? "T" : "B"}${polarity}`;
      const line = device.geometry.holes.filter((hh) =>
        hh.ref.includes(`RAIL:${lineId}:`),
      );
      const first = line[0];
      const last = line[line.length - 1];
      if (!first || !last) continue;
      const colour = polarity === "+" ? "#dc2626" : "#3b82f6";
      const off = polarity === "+" ? -1.5 : 1.5;
      els.push(
        <line
          key={`rail-${lineId}`}
          x1={first.x - 2}
          y1={first.y + off}
          x2={last.x + 2}
          y2={last.y + off}
          stroke={colour}
          strokeWidth={0.35}
          opacity={0.9}
        />,
        <text
          key={`rail-lbl-${lineId}`}
          x={first.x - 3.4}
          y={first.y + 0.9}
          fontSize={2.6}
          fill={colour}
          textAnchor="middle"
        >
          {polarity === "+" ? "+" : "−"}
        </text>,
      );
    }
  }

  // Row numbers every five, and column letters at both ends.
  for (let row = 5; row <= spec.rows; row += 5) {
    const hole = device.geometry.holes.find((hh) => hh.localRef === `${row}:${cols[0]}`);
    if (!hole) continue;
    els.push(
      <text
        key={`rn-${row}`}
        x={hole.x}
        y={hole.y - 1.6}
        fontSize={1.9}
        fill={MUTED}
        textAnchor="middle"
      >
        {row}
      </text>,
    );
  }
  for (const letter of cols) {
    const hole = device.geometry.holes.find((hh) => hh.localRef === `1:${letter}`);
    if (!hole) continue;
    els.push(
      <text
        key={`cl-${letter}`}
        x={x + 1.6}
        y={hole.y + 0.8}
        fontSize={2}
        fill={MUTED}
        textAnchor="middle"
      >
        {letter}
      </text>,
    );
  }

  els.push(
    <text
      key="model"
      x={x + w - 1.5}
      y={y + h - 1.2}
      fontSize={2.2}
      fill={MUTED}
      textAnchor="end"
      opacity={0.75}
    >
      {spec.model}
    </text>,
  );

  return <g>{els}</g>;
}

function BoardBody({ device }: { device: PlacedDevice }) {
  const spec = device.spec as BoardSpec;
  const { xMm: x, yMm: y } = device.placement;
  const { widthMm: w, heightMm: h } = device.geometry;
  const els: ReactElement[] = [];

  els.push(
    <rect
      key="pcb"
      x={x}
      y={y}
      width={w}
      height={h}
      rx={2.4}
      fill="#0f2436"
      stroke={BORDER}
      strokeWidth={0.4}
    />,
  );

  // USB connector on the left edge: the thing you actually plug into.
  els.push(
    <rect
      key="usb"
      x={x - 2.6}
      y={y + h * 0.12}
      width={3.2}
      height={spec.usb === "type-b" ? 11 : 7}
      rx={0.6}
      fill={BORDER}
    />,
    <text
      key="usb-lbl"
      x={x - 1}
      y={y + h * 0.12 - 1.2}
      fontSize={1.9}
      fill={MUTED}
      textAnchor="middle"
    >
      {spec.usb}
    </text>,
  );

  // Header strips drawn along the pins the spec actually declares.
  for (const header of spec.headers) {
    const pins = device.geometry.holes.filter((hh) => hh.group === header.id);
    const first = pins[0];
    const last = pins[pins.length - 1];
    if (!first || !last) continue;
    els.push(
      <rect
        key={`hdr-${header.id}`}
        x={first.x - 1.4}
        y={first.y - 1.4}
        width={last.x - first.x + 2.8}
        height={2.8}
        rx={0.4}
        fill={HOLE}
      />,
    );
    for (const pin of pins) {
      const up = header.side === "top";
      els.push(
        <text
          key={`pl-${pin.ref}`}
          x={pin.x}
          y={up ? pin.y + 4.6 : pin.y - 2.4}
          fontSize={1.7}
          fill={MUTED}
          textAnchor="start"
          transform={`rotate(-60 ${pin.x} ${up ? pin.y + 4.6 : pin.y - 2.4})`}
        >
          {pin.label.replace(" pin", "")}
        </text>,
      );
    }
  }

  els.push(
    <text
      key="silk"
      x={x + w / 2}
      y={y + h / 2 + 1}
      fontSize={3.4}
      fill={MUTED}
      textAnchor="middle"
      letterSpacing={0.6}
      opacity={0.8}
    >
      {spec.model}
    </text>,
    <text
      key="silk-sub"
      x={x + w / 2}
      y={y + h / 2 + 5}
      fontSize={2.2}
      fill={MUTED}
      textAnchor="middle"
      opacity={0.6}
    >
      {spec.mcu} · {spec.logicV}V logic
    </text>,
  );

  return <g>{els}</g>;
}

function componentGlyph(
  edge: NetlistEdge,
  mx: number,
  my: number,
  colour: string,
): ReactElement {
  const part = (edge.part ?? "").toLowerCase();
  if (part.includes("led")) {
    return (
      <g>
        <circle cx={mx} cy={my} r={2.2} fill={colour} stroke={HOLE} strokeWidth={0.4} />
        <circle cx={mx} cy={my} r={0.8} fill={HOLE} opacity={0.6} />
      </g>
    );
  }
  if (part.includes("resistor")) {
    return (
      <rect
        x={mx - 3.2}
        y={my - 1.3}
        width={6.4}
        height={2.6}
        rx={0.6}
        fill={PANEL}
        stroke={colour}
        strokeWidth={0.6}
      />
    );
  }
  if (part.includes("button") || part.includes("switch")) {
    return (
      <g>
        <rect
          x={mx - 2.4}
          y={my - 2.4}
          width={4.8}
          height={4.8}
          rx={0.6}
          fill={PANEL}
          stroke={colour}
          strokeWidth={0.6}
        />
        <circle cx={mx} cy={my} r={1} fill={colour} />
      </g>
    );
  }
  return (
    <rect
      x={mx - 2}
      y={my - 2}
      width={4}
      height={4}
      fill={PANEL}
      stroke={colour}
      strokeWidth={0.6}
      transform={`rotate(45 ${mx} ${my})`}
    />
  );
}

export default function Wireframe({
  layout,
  netlist,
  mode,
  diffAgainst,
  highlightRefs = [],
  ghostEdge = null,
  selectedEdgeId = null,
  tool,
  onMoveDevice,
  onAddEdge,
  onSelectEdge,
  padMm = 12,
  allowDeviceDrag,
}: WireframeProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const [hover, setHover] = useState<Hole | null>(null);
  // Zoom is a real magnifier, not a redraw: the view window shrinks while the
  // geometry stays in millimetres, so a hole is the same 2.54 mm from its
  // neighbour at every zoom level and nothing has to be re-laid-out.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const { w: canvasW, h: canvasH } = canvasSize(layout, padMm);
  const editable = mode === "edit";
  const draggable = allowDeviceDrag ?? editable;
  const viewW = canvasW / zoom;
  const viewH = canvasH / zoom;

  /** Keep the window inside the bench, so zooming never strands you off-board. */
  const clampPan = useCallback(
    (x: number, y: number) => ({
      x: Math.min(Math.max(0, x), Math.max(0, canvasW - canvasW / zoom)),
      y: Math.min(Math.max(0, y), Math.max(0, canvasH - canvasH / zoom)),
    }),
    [canvasW, canvasH, zoom],
  );

  /** Zoom about a fixed point, so the hole under the cursor stays under it. */
  const zoomAbout = useCallback(
    (next: number, atX: number, atY: number) => {
      const z = Math.min(8, Math.max(1, next));
      setZoom(z);
      setPan(() => {
        const nx = atX - (atX - pan.x) * (zoom / z);
        const ny = atY - (atY - pan.y) * (zoom / z);
        return {
          x: Math.min(Math.max(0, nx), Math.max(0, canvasW - canvasW / z)),
          y: Math.min(Math.max(0, ny), Math.max(0, canvasH - canvasH / z)),
        };
      });
    },
    [pan, zoom, canvasW, canvasH],
  );

  const toMm = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      // The drawn area under "meet": the larger axis is letterboxed.
      const scale = Math.min(rect.width / viewW, rect.height / viewH);
      const drawnW = viewW * scale;
      const drawnH = viewH * scale;
      const offX = rect.left + (rect.width - drawnW) / 2;
      const offY = rect.top + (rect.height - drawnH) / 2;
      return {
        x: pan.x + (clientX - offX) / scale,
        y: pan.y + (clientY - offY) / scale,
      };
    },
    [pan, viewW, viewH],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      const p = toMm(e.clientX, e.clientY);
      if (drag.type === "pan") {
        setPan(clampPan(drag.originX - (p.x - drag.grabX), drag.originY - (p.y - drag.grabY)));
      } else if (drag.type === "device") {
        const nx = Math.round((p.x - drag.grabDx) / GRID_MM) * GRID_MM;
        const ny = Math.round((p.y - drag.grabDy) / GRID_MM) * GRID_MM;
        onMoveDevice?.(drag.instanceId, Math.max(0, nx), Math.max(0, ny));
      } else {
        setDrag({ ...drag, x: p.x, y: p.y });
        setHover(nearestHole(layout, p.x, p.y));
      }
    },
    [drag, layout, onMoveDevice, toMm],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      if (drag?.type === "wire") {
        const p = toMm(e.clientX, e.clientY);
        const target = nearestHole(layout, p.x, p.y);
        // Landing on nothing cancels rather than dropping a wire in mid-air:
        // an unanchored connection is not a thing you can build.
        if (target && target.ref !== drag.fromRef) {
          onAddEdge?.(drag.fromRef, target.ref);
        }
      }
      setDrag(null);
      setHover(null);
    },
    [drag, layout, onAddEdge, toMm],
  );

  const startDeviceDrag = (device: PlacedDevice) => (e: React.PointerEvent) => {
    if (!draggable) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toMm(e.clientX, e.clientY);
    setDrag({
      type: "device",
      instanceId: device.placement.instanceId,
      grabDx: p.x - device.placement.xMm,
      grabDy: p.y - device.placement.yMm,
    });
  };

  const startWireDrag = (hole: Hole) => (e: React.PointerEvent) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toMm(e.clientX, e.clientY);
    setDrag({ type: "wire", fromRef: hole.ref, x: p.x, y: p.y });
  };

  const otherKeys = diffAgainst ? new Set(diffAgainst.edges.map(edgeKey)) : null;
  const ownKeys = new Set(netlist.edges.map(edgeKey));
  const removed = diffAgainst
    ? diffAgainst.edges.filter((e) => !ownKeys.has(edgeKey(e)))
    : [];
  // A step aims at "the ground rail", not at rail hole 12. Resolve every
  // target to the hole that will actually be drawn, so loose refs still ring.
  const highlight = new Set(
    highlightRefs
      .map((r) => holeFor(layout, r)?.ref)
      .filter((r): r is string => r !== undefined),
  );

  const drawEdge = (edge: NetlistEdge, status: "added" | "removed" | "neutral") => {
    const a = resolveRef(layout, edge.from);
    const b = resolveRef(layout, edge.to);
    if (!a || !b) return null;
    const base = edge.kind === "component" ? ACCENT : wireColour(edge.part);
    const colour =
      status === "removed" ? ERROR : status === "added" && diffAgainst ? ACCENT : base;
    const selected = selectedEdgeId === edge.id;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return (
      <g
        key={`${status}-${edge.id}`}
        opacity={diffAgainst && status === "neutral" ? 0.35 : 1}
        onClick={editable ? () => onSelectEdge?.(selected ? null : edge.id) : undefined}
        style={editable ? { cursor: "pointer" } : undefined}
      >
        <path
          d={wirePath(a, b, edge.kind === "component" ? 0 : 1)}
          fill="none"
          stroke={colour}
          strokeWidth={selected ? 0.95 : 0.62}
          strokeLinecap="round"
          strokeDasharray={status === "removed" ? "2 1.4" : undefined}
        />
        {selected ? (
          <path
            d={wirePath(a, b, edge.kind === "component" ? 0 : 1)}
            fill="none"
            stroke={WARN}
            strokeWidth={2}
            opacity={0.3}
            strokeLinecap="round"
          />
        ) : null}
        <circle cx={a.x} cy={a.y} r={0.8} fill={colour} />
        <circle cx={b.x} cy={b.y} r={0.8} fill={colour} />
        {edge.kind === "component"
          ? componentGlyph(edge, mid.x, mid.y, colour)
          : null}
        {edge.kind === "component" && edge.part ? (
          <text
            x={mid.x}
            y={mid.y - 3.4}
            fontSize={2.1}
            fill={colour}
            textAnchor="middle"
          >
            {edge.part}
            {edge.value ? ` ${edge.value}` : ""}
          </text>
        ) : null}
      </g>
    );
  };

  // Wheel zoom is bound by hand with { passive: false }. React registers
  // onWheel at the document root as a PASSIVE listener, where preventDefault
  // is ignored — which is exactly how zooming the bench also scrolled the page
  // out from under it.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toMm(e.clientX, e.clientY);
      zoomAbout(zoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18), p.x, p.y);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [toMm, zoomAbout, zoom]);

  const zoomStep = (factor: number) =>
    zoomAbout(zoom * factor, pan.x + viewW / 2, pan.y + viewH / 2);

  return (
    <div className="fg-canvas-wrap">
      <div className="fg-zoom">
        <button type="button" onClick={() => zoomStep(1 / 1.4)} aria-label="Zoom out" disabled={zoom <= 1}>
          −
        </button>
        <span>{zoom.toFixed(1)}×</span>
        <button type="button" onClick={() => zoomStep(1.4)} aria-label="Zoom in" disabled={zoom >= 8}>
          +
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
        >
          Fit
        </button>
      </div>
    <svg
      ref={svgRef}
      viewBox={`${pan.x} ${pan.y} ${viewW} ${viewH}`}
      role="img"
      aria-label={
        mode === "edit"
          ? "Circuit editor: drag devices to move them, drag hole to hole to lay a connection"
          : "Circuit wireframe: scroll to zoom, drag to move the view"
      }
      preserveAspectRatio="xMidYMid meet"
      style={{
        width: "100%",
        height: "auto",
        maxHeight: "76vh",
        margin: "0 auto",
        display: "block",
        touchAction: "none",
        cursor: drag?.type === "pan" ? "grabbing" : undefined,
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      onPointerDown={(e) => {
        // Empty canvas drags the view. Devices and holes stop the event
        // before it reaches here, so panning never fights placing.
        if (e.target !== svgRef.current) return;
        const p = toMm(e.clientX, e.clientY);
        setDrag({ type: "pan", grabX: p.x, grabY: p.y, originX: pan.x, originY: pan.y });
      }}
    >
      {/* Bench grid, one square per pitch, so distances read at a glance. */}
      <defs>
        <pattern id="fg-grid" width={PITCH_MM} height={PITCH_MM} patternUnits="userSpaceOnUse">
          <path
            d={`M ${PITCH_MM} 0 L 0 0 0 ${PITCH_MM}`}
            fill="none"
            stroke={BORDER}
            strokeWidth={0.12}
            opacity={0.5}
          />
        </pattern>
      </defs>
      <rect width={canvasW} height={canvasH} fill="url(#fg-grid)" />

      {layout.devices.map((device) => (
        <g
          key={device.placement.instanceId}
          onPointerDown={startDeviceDrag(device)}
          style={editable ? { cursor: "grab" } : undefined}
        >
          {device.spec.kind === "breadboard" ? (
            <BreadboardBody device={device} />
          ) : (
            <BoardBody device={device} />
          )}
        </g>
      ))}

      {/* Holes. Every one is a real receptacle from the spec; there are no
          decorative holes, so anything you can aim at, you can wire. */}
      {layout.holes.map((hole) => {
        const lit = highlight.has(hole.ref);
        return (
          <g key={hole.ref}>
            <circle cx={hole.x} cy={hole.y} r={0.62} fill={HOLE} />
            {editable ? (
              <circle
                cx={hole.x}
                cy={hole.y}
                r={1.3}
                fill="transparent"
                onPointerDown={startWireDrag(hole)}
                onPointerEnter={() => !drag && setHover(hole)}
                onPointerLeave={() => !drag && setHover(null)}
                style={{ cursor: "crosshair" }}
              >
                <title>{hole.label}</title>
              </circle>
            ) : null}
            {lit ? (
              <circle cx={hole.x} cy={hole.y} r={2} fill="none" stroke={WARN} strokeWidth={0.5}>
                <animate
                  attributeName="r"
                  values="1.6;3.2;1.6"
                  dur="1.2s"
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="1;0.3;1"
                  dur="1.2s"
                  repeatCount="indefinite"
                />
              </circle>
            ) : null}
          </g>
        );
      })}

      {netlist.edges.map((edge) =>
        drawEdge(edge, otherKeys && !otherKeys.has(edgeKey(edge)) ? "added" : "neutral"),
      )}
      {removed.map((edge) => drawEdge(edge, "removed"))}

      {/* The step's target connection, before it exists. */}
      {ghostEdge
        ? (() => {
            const a = resolveRef(layout, ghostEdge.from);
            const b = resolveRef(layout, ghostEdge.to);
            if (!a || !b) return null;
            return (
              <path
                d={wirePath(a, b, 1)}
                fill="none"
                stroke={WARN}
                strokeWidth={0.6}
                strokeDasharray="1.6 1.3"
                opacity={0.9}
              />
            );
          })()
        : null}

      {/* Live rubber band while laying a connection. */}
      {drag?.type === "wire"
        ? (() => {
            const a = resolveRef(layout, drag.fromRef);
            if (!a) return null;
            const end = hover ? { x: hover.x, y: hover.y } : { x: drag.x, y: drag.y };
            return (
              <g>
                <path
                  d={wirePath(a, end, 1)}
                  fill="none"
                  stroke={tool ? tool.colour : WARN}
                  strokeWidth={0.62}
                  strokeDasharray="2 1.2"
                />
                <circle cx={a.x} cy={a.y} r={1.4} fill={tool ? tool.colour : WARN} />
                {hover ? (
                  <circle
                    cx={hover.x}
                    cy={hover.y}
                    r={2}
                    fill="none"
                    stroke={ACCENT}
                    strokeWidth={0.5}
                  />
                ) : null}
              </g>
            );
          })()
        : null}

      {/* Hover readout: the exact hole under the cursor, named the way the
          instructions name it. */}
      {editable && hover ? (
        <g>
          <rect
            x={Math.min(hover.x + 2, canvasW - 40)}
            y={Math.max(hover.y - 6.5, 0)}
            width={38}
            height={5}
            rx={1}
            fill="#0b1119"
            stroke={BORDER}
            strokeWidth={0.2}
          />
          <text
            x={Math.min(hover.x + 3.4, canvasW - 38.6)}
            y={Math.max(hover.y - 3, 3.5)}
            fontSize={2.4}
            fill={ACCENT}
            fontFamily="ui-monospace, monospace"
          >
            {hover.ref}
          </text>
        </g>
      ) : null}
    </svg>
    </div>
  );
}
