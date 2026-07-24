// Server-side: replace the coach's eyeballed coordinates with mask-derived
// ones. The language model is good at naming what it sees and saying what to
// do about it; it is bad at reporting exactly where a thing is. Segmentation
// is the opposite. This module joins the two.
import { segmentImage, type SamBox } from "@/lib/perception/sam";
import { decodeMaskPng } from "@/lib/masks/decode";
import {
  bboxCenter,
  guideBetween,
  matchObject,
  type AnchorSource,
  type DecodedMask,
  type Point01,
} from "@/lib/masks/anchors";
import type { CoachResponse } from "@/lib/coach/contract";

export interface PreciseGuide {
  from: Point01;
  to: Point01;
  source: AnchorSource;
  /** The destination object's own pixels, so the UI can highlight it exactly. */
  targetMaskPng?: string;
  /** Bounding box of the destination, for sizing the highlight. */
  targetBbox?: [number, number, number, number];
  note: string;
}

interface Candidate {
  label: string;
  bbox: [number, number, number, number];
  mask: DecodedMask | null;
  maskPng?: string;
}

/**
 * Which named object is being moved and which is the destination?
 *
 * The coach's `arrow.from` sits on the thing in the user's hand and `arrow.to`
 * on where it belongs, so proximity to those two points identifies the roles
 * without needing the model to label them explicitly. When there is no arrow,
 * the target point alone identifies the destination.
 */
function pickRoles(
  response: CoachResponse,
): { mover: { label: string; bbox: number[] } | null; destination: { label: string; bbox: number[] } | null } {
  const objects = response.objects ?? [];
  const nearest = (p: Point01 | null) => {
    if (!p || objects.length === 0) return null;
    let best: { label: string; bbox: number[] } | null = null;
    let bestD = Infinity;
    for (const o of objects) {
      const c = bboxCenter(o.bbox);
      const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { label: o.label, bbox: o.bbox };
      }
    }
    return best;
  };

  const destPoint: Point01 | null = response.target
    ? { x: response.target.x, y: response.target.y }
    : response.arrow
      ? response.arrow.to
      : null;
  const moverPoint: Point01 | null = response.arrow ? response.arrow.from : null;

  const destination = nearest(destPoint);
  let mover = nearest(moverPoint);
  // The mover and the destination must be different objects, otherwise the
  // arrow collapses onto one thing and says nothing.
  if (mover && destination && mover.label === destination.label) {
    mover =
      objects
        .filter((o) => o.label !== destination.label)
        .map((o) => ({ label: o.label, bbox: o.bbox }))[0] ?? null;
  }
  return { mover, destination };
}

/**
 * Segment the coached photo and re-anchor the guidance onto real pixels.
 * Every failure path returns a usable result built from the model's own
 * estimate, with a note saying so, because a coach that shows nothing is
 * worse than a coach that shows an approximate arrow and admits it.
 */
export async function preciseGuide(
  imageBase64: string,
  response: CoachResponse,
): Promise<PreciseGuide | null> {
  const fallbackFrom: Point01 | null = response.arrow?.from ?? null;
  const fallbackTo: Point01 | null =
    response.arrow?.to ??
    (response.target ? { x: response.target.x, y: response.target.y } : null);

  if (!fallbackTo) return null; // nothing to point at yet

  const estimate: PreciseGuide = {
    from: fallbackFrom ?? { x: fallbackTo.x, y: Math.min(1, fallbackTo.y + 0.25) },
    to: fallbackTo,
    source: "model",
    note: "positions estimated by the vision model",
  };

  if (!process.env.REPLICATE_API_TOKEN) {
    return { ...estimate, note: "no segmentation token: positions are estimates" };
  }

  let boxes: SamBox[];
  try {
    const seg = await segmentImage(imageBase64);
    boxes = seg.boxes;
  } catch {
    return { ...estimate, note: "segmentation unavailable: positions are estimates" };
  }
  if (boxes.length === 0) {
    return { ...estimate, note: "segmentation found nothing: positions are estimates" };
  }

  const candidates: Candidate[] = boxes.map((b) => ({
    // SAM does not name regions, so matching leans on box overlap; the label
    // is left blank rather than invented.
    label: "",
    bbox: b.bbox,
    mask: b.maskPng ? decodeMaskPng(b.maskPng) : null,
    ...(b.maskPng ? { maskPng: b.maskPng } : {}),
  }));

  const { mover, destination } = pickRoles(response);

  const destMatch = destination
    ? matchObject({ label: destination.label, bbox: destination.bbox }, candidates)
    : null;
  const moverMatch = mover
    ? matchObject({ label: mover.label, bbox: mover.bbox }, candidates)
    : null;

  const geo = guideBetween(
    { mask: moverMatch?.mask ?? null, fallback: estimate.from },
    { mask: destMatch?.mask ?? null, fallback: estimate.to },
  );

  return {
    from: geo.from,
    to: geo.to,
    source: geo.source,
    ...(destMatch?.maskPng ? { targetMaskPng: destMatch.maskPng } : {}),
    ...(destMatch ? { targetBbox: destMatch.bbox } : {}),
    note:
      geo.source === "mask"
        ? "anchored on segmented pixels"
        : "partly estimated: segmentation did not match both objects",
  };
}
