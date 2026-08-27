// Snapping model detections onto segmentation masks.
//
// The old sam+vlm path handed the labelling model a TEXT LIST of region boxes
// ("Region 1: [0.12, 0.34, ...]") and asked which object sat at each one. The
// model never saw those boxes drawn on the picture, so it mapped them by
// coordinate arithmetic and frequently got it wrong — which is why a
// pixel-perfect mask could end up carrying the wrong name and the label
// appeared nowhere near the thing it described.
//
// This inverts the job. The model looks at the image and says "resistor,
// roughly here", which is a judgement it makes reliably because it is reading
// the picture rather than doing geometry in its head. Then we snap that label
// onto whichever SAM region it actually overlaps, and take SAM's tight bbox
// and mask for the position. Names from the model, pixels from segmentation,
// neither asked to do the other's job.
//
// Pure module: type-only project imports so `node --test` can load it.
import type { PartDetection } from "@/lib/types";

export interface SnapRegion {
  /** Normalized [x, y, width, height]. */
  bbox: [number, number, number, number];
  /** Mask coverage as a fraction of the frame; tighter than bbox area. */
  area: number;
  maskPng?: string;
}

export interface SnapCandidate {
  partType: string;
  label: string;
  confidence: number;
  bbox: [number, number, number, number];
}

/** Intersection over union of two normalized boxes. */
export function iou(a: readonly number[], b: readonly number[]): number {
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

/**
 * How much of the region sits inside the detection box. A mask for a thin
 * object (a jumper wire) has a small union with the model's generous box, so
 * IoU alone under-scores a correct pairing; containment rescues it.
 */
export function containment(region: readonly number[], det: readonly number[]): number {
  const [rx = 0, ry = 0, rw = 0, rh = 0] = region;
  const [dx = 0, dy = 0, dw = 0, dh = 0] = det;
  const x1 = Math.max(rx, dx);
  const y1 = Math.max(ry, dy);
  const x2 = Math.min(rx + rw, dx + dw);
  const y2 = Math.min(ry + rh, dy + dh);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const regionArea = rw * rh;
  return regionArea > 0 ? inter / regionArea : 0;
}

/**
 * Combined fit score.
 *
 * Containment is checked BOTH ways, because the two systems disagree about
 * what an object is. SAM often returns a fragment — the red body of the power
 * bank without its cables — which sits inside the model's whole-object box.
 * Just as often SAM returns a region larger than the model's conservative
 * box. Either direction is a real pairing, so the score takes whichever
 * containment is stronger and lets IoU refine it.
 */
export function fitScore(region: SnapRegion, det: SnapCandidate): number {
  const cover = Math.max(
    containment(region.bbox, det.bbox),
    containment(det.bbox, region.bbox),
  );
  return iou(region.bbox, det.bbox) * 0.35 + cover * 0.65;
}

/** Below this the pairing is noise; better a label with no mask than a label
 *  confidently pinned to the wrong object's pixels. */
export const MIN_FIT = 0.25;

export interface SnapResult {
  parts: PartDetection[];
  /** Regions no detection claimed — segmentation saw something unnamed. */
  unclaimedRegions: number;
  /** Detections that found no region; they keep the model's own bbox. */
  unmatchedDetections: number;
}

/**
 * Pair each detection with its best-fitting region, one region per detection.
 *
 * Greedy over the strongest pairs first, so a confident match claims its
 * region before a weaker detection can steal it. A detection that wins a
 * region takes that region's tight bbox and mask; a detection that wins
 * nothing keeps its own approximate box and simply has no mask, which the
 * client already handles by falling back to a halo.
 */
export function snapDetectionsToRegions(
  detections: readonly SnapCandidate[],
  regions: readonly SnapRegion[],
): SnapResult {
  const pairs: { d: number; r: number; score: number }[] = [];
  detections.forEach((det, d) => {
    regions.forEach((region, r) => {
      const score = fitScore(region, det);
      if (score >= MIN_FIT) pairs.push({ d, r, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score);

  const takenRegion = new Set<number>();
  const matchedDet = new Map<number, number>();
  for (const p of pairs) {
    if (takenRegion.has(p.r) || matchedDet.has(p.d)) continue;
    takenRegion.add(p.r);
    matchedDet.set(p.d, p.r);
  }

  const parts: PartDetection[] = [];
  detections.forEach((det, d) => {
    const r = matchedDet.get(d);
    const region = r === undefined ? undefined : regions[r];
    parts.push({
      id: `p${parts.length + 1}`,
      partType: det.partType,
      label: det.label,
      confidence: det.confidence,
      // Position comes from segmentation when we have it: SAM's box hugs the
      // object, the model's box is an estimate.
      bbox: region ? region.bbox : det.bbox,
      ...(region?.maskPng !== undefined ? { maskPng: region.maskPng } : {}),
    });
  });

  return {
    parts,
    unclaimedRegions: regions.length - takenRegion.size,
    unmatchedDetections: detections.length - matchedDet.size,
  };
}

/** One honest sentence about what the pipeline did, for the response note. */
export function snapNote(regionCount: number, result: SnapResult): string {
  const withMask = result.parts.filter((p) => p.maskPng !== undefined).length;
  return `sam+vlm: ${regionCount} regions, ${result.parts.length} labelled, masks on ${withMask} parts`;
}
