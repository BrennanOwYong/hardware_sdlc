"use client";

// Game-style AR find layer (implemented by the ar-find builder; the bench
// builder consumes it too, so it stays dumb: markers in, DOM out).
// Contract: overlay a position:relative parent that wraps the media (canvas,
// <video>, or image). Each ArMarker gets a pulsing halo (.ar-halo), a bobbing
// map pin (.ar-pin, inline SVG), and a label chip (.ar-label). Positions come
// from normalized 0..1 coords rendered as CSS percentages, so markers stay
// glued to the media through resizes. Renders null when hidden or empty.

import type { ArMarkerLayerProps } from "@/lib/types";
import { haloGeometry } from "@/lib/inventory/markers";

const PIN_SIZE = 28;

function MapPin() {
  return (
    <svg
      width={PIN_SIZE}
      height={PIN_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"
        fill="#22c55e"
        stroke="#06130a"
        strokeWidth="1"
      />
      <circle cx="12" cy="9" r="2.6" fill="#06130a" />
    </svg>
  );
}

export default function ArMarkerLayer({
  markers,
  visible = true,
}: ArMarkerLayerProps) {
  if (!visible || markers.length === 0) return null;
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      {markers.map((m, i) => {
        const halo = haloGeometry(m);
        return (
          <div key={`${m.kind}-${m.label}-${i}`}>
            <span
              className="ar-halo"
              style={{
                left: `${halo.leftPct}%`,
                top: `${halo.topPct}%`,
                width: `${halo.widthPct}%`,
                height: `${halo.heightPct}%`,
              }}
            />
            {/* Centering uses margins, not transform: the bob animation owns transform. */}
            <span
              className="ar-pin"
              style={{
                left: `${m.x * 100}%`,
                top: `${m.y * 100}%`,
                marginLeft: -PIN_SIZE / 2,
                marginTop: -PIN_SIZE,
              }}
            >
              <MapPin />
            </span>
            <span
              className="ar-label"
              style={{
                position: "absolute",
                left: `${m.x * 100}%`,
                top: `${m.y * 100}%`,
                transform: "translate(-50%, 8px)",
              }}
            >
              {m.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
