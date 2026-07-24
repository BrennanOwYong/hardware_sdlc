"use client";

// A direction arrow drawn between two points on a photo. The points come from
// segmentation masks where possible, so the tail sits on the object being
// moved and the head sits on the edge of its destination.
//
// Nothing here knows what the objects are: a USB plug heading for a laptop
// socket and a jumper wire heading for hole e15 draw identically.

export interface GuideArrowProps {
  /** Normalized 0..1 within the photo. */
  from: { x: number; y: number };
  to: { x: number; y: number };
  label?: string;
  /** "mask" draws confidently; "model" is dashed, because it is an estimate. */
  precision?: "mask" | "model";
  visible?: boolean;
}

export default function GuideArrow({
  from,
  to,
  label,
  precision = "mask",
  visible = true,
}: GuideArrowProps) {
  if (!visible) return null;

  // Work in a 1000x1000 space and let preserveAspectRatio="none" stretch it
  // onto the photo, so normalized coordinates land exactly where they belong
  // whatever the photo's aspect ratio is.
  const x1 = from.x * 1000;
  const y1 = from.y * 1000;
  const x2 = to.x * 1000;
  const y2 = to.y * 1000;

  // Bow the path perpendicular to the run so it arcs clear of the objects
  // rather than cutting straight through whatever sits between them.
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(len * 0.22, 160);
  const cx = (x1 + x2) / 2 - (dy / len) * bow;
  const cy = (y1 + y2) / 2 + (dx / len) * bow;

  const estimate = precision === "model";
  const stroke = estimate ? "#f59e0b" : "#22c55e";

  return (
    <svg
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    >
      <defs>
        <marker
          id="guide-head"
          viewBox="0 0 12 12"
          refX="9"
          refY="6"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 12 6 L 0 12 z" fill={stroke} />
        </marker>
      </defs>

      {/* Dark under-stroke keeps the arrow readable over a bright photo. */}
      <path
        d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
        fill="none"
        stroke="rgba(0,0,0,0.55)"
        strokeWidth={14}
        strokeLinecap="round"
      />
      <path
        d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
        fill="none"
        stroke={stroke}
        strokeWidth={8}
        strokeLinecap="round"
        strokeDasharray={estimate ? "22 16" : undefined}
        markerEnd="url(#guide-head)"
      >
        <animate
          attributeName="stroke-opacity"
          values="0.55;1;0.55"
          dur="1.6s"
          repeatCount="indefinite"
        />
      </path>

      {/* Tail dot marks the thing being moved. */}
      <circle cx={x1} cy={y1} r={11} fill={stroke} fillOpacity={0.9} />

      {label ? (
        <g transform={`translate(${x2}, ${y2})`}>
          <rect
            x={-Math.max(70, label.length * 11)}
            y={-64}
            width={Math.max(140, label.length * 22)}
            height={44}
            rx={12}
            fill="rgba(11,15,20,0.86)"
            stroke={stroke}
            strokeWidth={2}
          />
          <text
            x={0}
            y={-34}
            textAnchor="middle"
            fontSize={26}
            fill="#e6edf3"
            style={{ fontWeight: 600 }}
          >
            {label}
          </text>
        </g>
      ) : null}
    </svg>
  );
}
