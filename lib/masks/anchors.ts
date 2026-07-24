// Turning a segmentation mask into the exact points guidance should aim at.
//
// The coach used to draw its arrow wherever the language model guessed the
// objects were, which is a dot near the right area rather than on the thing.
// A mask knows precisely which pixels belong to an object, so the arrow can
// start on the real edge of the plug and end on the real edge of the port.
//
// Nothing here knows what a breadboard is: it is pure geometry over a bitmap,
// so "USB plug into a laptop socket" works exactly like "wire into hole e15".
//
// Pure module: type-only project imports so `node --test` can load it.

export interface Point01 {
  x: number;
  y: number;
}

export interface DecodedMask {
  width: number;
  height: number;
  /** One byte per pixel, row-major: non-zero means the object covers it. */
  alpha: Uint8Array;
}

/** Pixels below this alpha are background; PNG edges are anti-aliased. */
export const ALPHA_THRESHOLD = 96;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Index helper kept inline-cheap: these loops run over every mask pixel. */
function covered(mask: DecodedMask, x: number, y: number): boolean {
  return (mask.alpha[y * mask.width + x] ?? 0) >= ALPHA_THRESHOLD;
}

/** Every covered pixel, as normalized points. Used by the shape helpers. */
function* coveredPixels(mask: DecodedMask): Generator<[number, number]> {
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (covered(mask, x, y)) yield [x, y];
    }
  }
}

export function maskIsEmpty(mask: DecodedMask): boolean {
  for (const _ of coveredPixels(mask)) return false;
  return true;
}

/**
 * The object's centre of mass. For a wire or a USB cable this sits on the
 * cable itself rather than in the middle of its bounding box, which is the
 * whole reason to prefer it over a bbox centre.
 */
export function maskCentroid(mask: DecodedMask): Point01 | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const [x, y] of coveredPixels(mask)) {
    sx += x;
    sy += y;
    n += 1;
  }
  if (n === 0) return null;
  return {
    x: clamp01(sx / n / mask.width),
    y: clamp01(sy / n / mask.height),
  };
}

/** Tight bounds of the covered pixels, normalized. */
export function maskBounds(
  mask: DecodedMask,
): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of coveredPixels(mask)) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return null;
  return {
    x: minX / mask.width,
    y: minY / mask.height,
    w: (maxX - minX + 1) / mask.width,
    h: (maxY - minY + 1) / mask.height,
  };
}

/** Centre of the bounding box: the fallback when a mask is missing or empty. */
export function bboxCenter(bbox: readonly number[]): Point01 {
  const [x = 0, y = 0, w = 0, h = 0] = bbox;
  return { x: clamp01(x + w / 2), y: clamp01(y + h / 2) };
}

/**
 * The covered pixel closest to `toward`. An arrow head placed here lands ON
 * the destination object's edge facing the traveller, instead of floating at
 * its centre or hovering outside it.
 */
export function nearestEdgePoint(mask: DecodedMask, toward: Point01): Point01 | null {
  const tx = toward.x * mask.width;
  const ty = toward.y * mask.height;
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const [x, y] of coveredPixels(mask)) {
    const d = (x - tx) ** 2 + (y - ty) ** 2;
    if (d < bestD) {
      bestD = d;
      best = [x, y];
    }
  }
  if (!best) return null;
  return { x: clamp01(best[0] / mask.width), y: clamp01(best[1] / mask.height) };
}

/**
 * The covered pixel furthest from `from`. Useful for an arrow tail: start at
 * the far end of the object being moved so the arrow spans it visibly.
 */
export function farthestEdgePoint(mask: DecodedMask, from: Point01): Point01 | null {
  const fx = from.x * mask.width;
  const fy = from.y * mask.height;
  let best: [number, number] | null = null;
  let bestD = -1;
  for (const [x, y] of coveredPixels(mask)) {
    const d = (x - fx) ** 2 + (y - fy) ** 2;
    if (d > bestD) {
      bestD = d;
      best = [x, y];
    }
  }
  if (!best) return null;
  return { x: clamp01(best[0] / mask.width), y: clamp01(best[1] / mask.height) };
}

export type AnchorSource = "mask" | "model";

export interface GuideGeometry {
  /** Where the arrow starts: on the moving object. */
  from: Point01;
  /** Where the arrow ends: on the destination object's near edge. */
  to: Point01;
  source: AnchorSource;
}

/**
 * Compute arrow geometry between two objects.
 *
 * With both masks: the arrow spans from the mover's edge nearest the
 * destination to the destination's edge nearest the mover, so both ends touch
 * real pixels of real objects. Without masks: fall back to the supplied
 * estimates and label the result honestly so the UI can say which it used.
 */
export function guideBetween(
  mover: { mask?: DecodedMask | null; fallback: Point01 },
  destination: { mask?: DecodedMask | null; fallback: Point01 },
): GuideGeometry {
  const moverMask = mover.mask && !maskIsEmpty(mover.mask) ? mover.mask : null;
  const destMask =
    destination.mask && !maskIsEmpty(destination.mask) ? destination.mask : null;

  if (!moverMask && !destMask) {
    return { from: mover.fallback, to: destination.fallback, source: "model" };
  }

  // Seed each end with the other's best-known position, then refine both so
  // the endpoints face each other rather than facing a guessed centre.
  const destSeed = destMask
    ? (maskCentroid(destMask) ?? destination.fallback)
    : destination.fallback;
  const moverSeed = moverMask ? (maskCentroid(moverMask) ?? mover.fallback) : mover.fallback;

  const from = moverMask
    ? (nearestEdgePoint(moverMask, destSeed) ?? moverSeed)
    : mover.fallback;
  const to = destMask
    ? (nearestEdgePoint(destMask, from) ?? destSeed)
    : destination.fallback;

  // Only claim "mask" when BOTH ends came from real pixels; a half-guessed
  // arrow is a guessed arrow.
  return { from, to, source: moverMask && destMask ? "mask" : "model" };
}

/** Lowercased word set, for the label matching below. */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/[\s-]+/)
      .filter((w) => w.length > 2),
  );
}

function overlap(a: readonly number[], b: readonly number[]): number {
  const [ax = 0, ay = 0, aw = 0, ah = 0] = a;
  const [bx = 0, by = 0, bw = 0, bh = 0] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

export interface MatchCandidate {
  label: string;
  bbox: readonly number[];
}

/**
 * Match an object the coach named to an object segmentation found. Label
 * agreement is the strong signal; box overlap breaks ties and rescues cases
 * where the two models chose different words for the same thing.
 */
export function matchObject<T extends MatchCandidate>(
  wanted: MatchCandidate,
  candidates: readonly T[],
): T | null {
  const wantedWords = words(wanted.label);
  let best: { item: T; score: number } | null = null;
  for (const c of candidates) {
    const shared = [...words(c.label)].filter((w) => wantedWords.has(w)).length;
    const iou = overlap(wanted.bbox, c.bbox);
    const score = shared * 2 + iou * 3;
    if (score > 0 && (!best || score > best.score)) best = { item: c, score };
  }
  // A weak score means we matched noise; better to fall back than to point at
  // the wrong object with total confidence.
  return best && best.score >= 1 ? best.item : null;
}
