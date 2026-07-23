// Marker geometry for the game-style AR find layer (ar-find builder).
// Pure math with type-only project imports, so tests/markers.test.mjs can run
// this file directly under `node --test` with Node's type stripping.
import type { ArMarker } from "@/lib/types";

/** Halo size (fraction of the container) used when a marker has no usable w/h. */
export const FALLBACK_MARKER_SIZE = 0.12;

/** Sizes below this fraction are treated as unusable and get the fallback. */
export const MIN_MARKER_SIZE = 0.02;

/** CSS percentage box for the pulsing halo, centered on the marker. */
export interface HaloGeometry {
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Normalized bbox [x, y, w, h] (top-left corner + size, all 0..1) -> a marker
 * whose x/y sit on the center of the part. Centers are clamped into 0..1 so a
 * sloppy bbox near an edge still lands inside the picture.
 */
export function markerFromBbox(
  bbox: readonly [number, number, number, number],
  label: string,
  kind: ArMarker["kind"],
): ArMarker {
  const [x, y, w, h] = bbox;
  return {
    x: clamp01(x + w / 2),
    y: clamp01(y + h / 2),
    w,
    h,
    label,
    kind,
  };
}

function usableSize(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v >= MIN_MARKER_SIZE
    ? v
    : FALLBACK_MARKER_SIZE;
}

/**
 * Percentage geometry for the halo ellipse. Missing or degenerate w/h fall
 * back to FALLBACK_MARKER_SIZE so every marker still gets a visible glow.
 */
export function haloGeometry(
  marker: Pick<ArMarker, "x" | "y" | "w" | "h">,
): HaloGeometry {
  const w = usableSize(marker.w);
  const h = usableSize(marker.h);
  return {
    leftPct: (marker.x - w / 2) * 100,
    topPct: (marker.y - h / 2) * 100,
    widthPct: w * 100,
    heightPct: h * 100,
  };
}

/**
 * Case-insensitive substring match against a part's label and type.
 * A blank query matches nothing (no query means no pins).
 */
export function matchesQuery(
  part: { label: string; partType: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return (
    part.label.toLowerCase().includes(q) ||
    part.partType.toLowerCase().includes(q)
  );
}

/** Parts whose label/type matches the query -> "find" markers. */
export function markersForQuery(
  parts: readonly {
    label: string;
    partType: string;
    bbox: [number, number, number, number];
  }[],
  query: string,
): ArMarker[] {
  return parts
    .filter((p) => matchesQuery(p, query))
    .map((p) => markerFromBbox(p.bbox, p.label, "find"));
}
