"use client";

// Inline SVG of the workspace: half-size breadboard (rows 1..30, columns
// a..j, PWR + GND rails) above an Arduino Uno silhouette with labeled
// D0-D13 / GND / 5V pins. Geometry comes from lib/assembly/circuits.ts;
// refToXY is re-exported here so overlay consumers can share the mapping.
//
// Visual states:
//   - pulsing ring on the active step targets (SMIL <animate>)
//   - dashed ghost line from -> to for the active step
//   - solid green line + filled endpoints for seated edges
//   - red rings + red dashed line while the current step is in error

import type { ReactElement } from "react";
import type { AssemblyStep, StepPhase, TargetRef } from "@/lib/types";
import {
  BB_COL_Y,
  BB_RAIL_GND_Y,
  BB_RAIL_PWR_Y,
  BB_ROWS,
  BOARD_H,
  BOARD_W,
  UNO_A0_X,
  UNO_D13_X,
  UNO_DIGITAL_Y,
  UNO_GND_X,
  UNO_PIN_DX,
  UNO_POWER_X,
  UNO_POWER_Y,
  bbRowX,
  refToXY,
} from "@/lib/assembly/circuits";

export { refToXY };

const ACCENT = "#22c55e";
const WARN = "#f59e0b";
const ERROR = "#ef4444";
const MUTED = "#8b98a5";
const HOLE = "#0b0f14";
const PANEL = "#131a22";
const BORDER = "#22303d";

export interface BoardViewProps {
  steps: AssemblyStep[];
  currentIndex: number;
  phase: StepPhase;
  seatedIds: string[];
}

function svgXY(ref: TargetRef): { x: number; y: number } | null {
  const p = refToXY(ref);
  if (!p) return null;
  return { x: p.x * BOARD_W, y: p.y * BOARD_H };
}

function PulseRing({
  x,
  y,
  color,
  fast,
}: {
  x: number;
  y: number;
  color: string;
  fast: boolean;
}) {
  return (
    <g>
      <circle cx={x} cy={y} r={14} fill="none" stroke={color} strokeWidth={4}>
        <animate
          attributeName="r"
          values={fast ? "12;18;12" : "10;22;10"}
          dur={fast ? "0.6s" : "1.2s"}
          repeatCount="indefinite"
        />
        <animate
          attributeName="opacity"
          values="1;0.35;1"
          dur={fast ? "0.6s" : "1.2s"}
          repeatCount="indefinite"
        />
      </circle>
      {fast ? <circle cx={x} cy={y} r={7} fill={color} /> : null}
    </g>
  );
}

function staticBoard(): ReactElement[] {
  const els: ReactElement[] = [];

  // Breadboard body
  els.push(
    <rect
      key="bb-body"
      x={20}
      y={20}
      width={960}
      height={500}
      rx={14}
      fill={PANEL}
      stroke={BORDER}
      strokeWidth={2}
    />,
  );
  // Center channel between e and f
  els.push(
    <rect
      key="bb-gap"
      x={30}
      y={212}
      width={940}
      height={26}
      fill={HOLE}
      opacity={0.55}
    />,
  );

  // Terminal holes, rows 1..30 x columns a..j
  const cols = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  for (let row = 1; row <= BB_ROWS; row += 1) {
    const x = bbRowX(row);
    for (const col of cols) {
      const y = BB_COL_Y[col];
      if (y === undefined) continue;
      els.push(
        <circle key={`h-${row}-${col}`} cx={x} cy={y} r={5} fill={HOLE} />,
      );
    }
    // Rail holes
    els.push(
      <circle key={`rp-${row}`} cx={x} cy={BB_RAIL_PWR_Y} r={5} fill={HOLE} />,
      <circle key={`rg-${row}`} cx={x} cy={BB_RAIL_GND_Y} r={5} fill={HOLE} />,
    );
  }

  // Row number labels
  for (const row of [1, 5, 10, 15, 20, 25, 30]) {
    els.push(
      <text
        key={`rn-${row}`}
        x={bbRowX(row)}
        y={50}
        fontSize={15}
        fill={MUTED}
        textAnchor="middle"
      >
        {row}
      </text>,
    );
  }
  // Column letter labels
  for (const col of cols) {
    const y = BB_COL_Y[col];
    if (y === undefined) continue;
    els.push(
      <text
        key={`cl-${col}`}
        x={34}
        y={y + 5}
        fontSize={14}
        fill={MUTED}
        textAnchor="middle"
      >
        {col}
      </text>,
    );
  }

  // Rails
  els.push(
    <line
      key="rail-pwr-line"
      x1={50}
      y1={BB_RAIL_PWR_Y - 16}
      x2={950}
      y2={BB_RAIL_PWR_Y - 16}
      stroke={ERROR}
      strokeWidth={3}
    />,
    <line
      key="rail-gnd-line"
      x1={50}
      y1={BB_RAIL_GND_Y + 16}
      x2={950}
      y2={BB_RAIL_GND_Y + 16}
      stroke="#3b82f6"
      strokeWidth={3}
    />,
    <text
      key="rail-pwr-label"
      x={32}
      y={BB_RAIL_PWR_Y + 5}
      fontSize={18}
      fill={ERROR}
      textAnchor="middle"
    >
      +
    </text>,
    <text
      key="rail-gnd-label"
      x={32}
      y={BB_RAIL_GND_Y + 5}
      fontSize={18}
      fill="#3b82f6"
      textAnchor="middle"
    >
      −
    </text>,
    <text
      key="rail-gnd-word"
      x={962}
      y={BB_RAIL_GND_Y + 5}
      fontSize={12}
      fill="#3b82f6"
      textAnchor="middle"
    >
      GND
    </text>,
  );

  // Arduino Uno silhouette
  els.push(
    <rect
      key="uno-body"
      x={140}
      y={560}
      width={720}
      height={490}
      rx={18}
      fill="#10202e"
      stroke={BORDER}
      strokeWidth={2}
    />,
    <rect
      key="uno-usb"
      x={118}
      y={600}
      width={44}
      height={70}
      fill={BORDER}
    />,
    <text
      key="uno-label"
      x={500}
      y={840}
      fontSize={36}
      fill={MUTED}
      textAnchor="middle"
      letterSpacing={6}
    >
      ARDUINO UNO
    </text>,
  );

  // Digital header strip: GND, D13..D0
  els.push(
    <rect
      key="uno-dhdr"
      x={UNO_GND_X - 18}
      y={UNO_DIGITAL_Y - 14}
      width={UNO_D13_X + 13 * UNO_PIN_DX - UNO_GND_X + 36}
      height={28}
      fill={HOLE}
      rx={4}
    />,
  );
  const digitalPins: { name: string; x: number }[] = [
    { name: "GND", x: UNO_GND_X },
  ];
  for (let n = 13; n >= 0; n -= 1) {
    digitalPins.push({ name: `D${n}`, x: UNO_D13_X + (13 - n) * UNO_PIN_DX });
  }
  for (const pin of digitalPins) {
    els.push(
      <rect
        key={`dp-${pin.name}`}
        x={pin.x - 6}
        y={UNO_DIGITAL_Y - 6}
        width={12}
        height={12}
        fill={PANEL}
        stroke={BORDER}
      />,
      <text
        key={`dpl-${pin.name}`}
        x={pin.x + 4}
        y={UNO_DIGITAL_Y + 46}
        fontSize={15}
        fill={MUTED}
        textAnchor="end"
        transform={`rotate(-55 ${pin.x + 4} ${UNO_DIGITAL_Y + 46})`}
      >
        {pin.name}
      </text>,
    );
  }

  // Power + analog header strip
  els.push(
    <rect
      key="uno-phdr"
      x={300}
      y={UNO_POWER_Y - 14}
      width={520}
      height={28}
      fill={HOLE}
      rx={4}
    />,
  );
  const powerPins: { name: string; x: number }[] = [];
  for (const name of ["3V3", "5V", "VIN"]) {
    const x = UNO_POWER_X[name];
    if (x !== undefined) powerPins.push({ name, x });
  }
  powerPins.push({ name: "GND", x: 440 });
  for (let n = 0; n <= 5; n += 1) {
    powerPins.push({ name: `A${n}`, x: UNO_A0_X + n * UNO_PIN_DX });
  }
  for (const pin of powerPins) {
    els.push(
      <rect
        key={`pp-${pin.name}`}
        x={pin.x - 6}
        y={UNO_POWER_Y - 6}
        width={12}
        height={12}
        fill={PANEL}
        stroke={BORDER}
      />,
      <text
        key={`ppl-${pin.name}`}
        x={pin.x}
        y={UNO_POWER_Y - 24}
        fontSize={14}
        fill={MUTED}
        textAnchor="middle"
      >
        {pin.name}
      </text>,
    );
  }

  return els;
}

export default function BoardView({
  steps,
  currentIndex,
  phase,
  seatedIds,
}: BoardViewProps) {
  const seated = steps.filter((s) => seatedIds.includes(s.edge.id));
  const current =
    currentIndex >= 0 && currentIndex < steps.length
      ? steps[currentIndex]
      : null;
  const showCurrent = current !== null && phase !== "seated";

  const ringColor =
    phase === "error" ? ERROR : phase === "tip-on-target" ? ACCENT : WARN;
  const ghostColor =
    phase === "error" ? ERROR : phase === "tip-on-target" ? ACCENT : MUTED;

  return (
    <svg
      viewBox={`0 0 ${BOARD_W} ${BOARD_H}`}
      role="img"
      aria-label="Breadboard and Arduino Uno board view"
      style={{
        width: "100%",
        maxWidth: 560,
        display: "block",
        margin: "0 auto",
      }}
    >
      {staticBoard()}

      {/* Seated edges: solid green connections */}
      {seated.map((s) => {
        const a = svgXY(s.edge.from);
        const b = svgXY(s.edge.to);
        if (!a || !b) return null;
        return (
          <g key={`seated-${s.edge.id}`}>
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={ACCENT}
              strokeWidth={6}
              strokeLinecap="round"
              opacity={0.9}
            />
            <circle cx={a.x} cy={a.y} r={8} fill={ACCENT} />
            <circle cx={b.x} cy={b.y} r={8} fill={ACCENT} />
          </g>
        );
      })}

      {/* Active step: ghost line + pulsing target rings */}
      {showCurrent && current
        ? (() => {
            const a = svgXY(current.edge.from);
            const b = svgXY(current.edge.to);
            if (!a || !b) return null;
            return (
              <g key={`active-${current.edge.id}`}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={ghostColor}
                  strokeWidth={4}
                  strokeDasharray="12 8"
                  opacity={0.75}
                />
                <PulseRing
                  x={a.x}
                  y={a.y}
                  color={ringColor}
                  fast={phase === "tip-on-target"}
                />
                <PulseRing
                  x={b.x}
                  y={b.y}
                  color={ringColor}
                  fast={phase === "tip-on-target"}
                />
              </g>
            );
          })()
        : null}
    </svg>
  );
}
