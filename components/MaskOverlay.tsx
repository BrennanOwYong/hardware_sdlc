"use client";

// Exact-pixel highlight layer (live-ux builder; FEEDBACK.md item 2). Given the
// highlighted parts and the pixel size of the media's coordinate space, parts
// carrying a SAM maskPng get their OWN pixels tinted accent green (~55% alpha,
// soft rAF opacity pulse) on a canvas stretched over the photo/frame; parts
// without a mask fall back to the existing ArMarkerLayer halo + pin. Mount
// inside the same position:relative wrapper that ArMarkerLayer expects.
// Mask decode/tint shapes verified against MDN canvas docs
// (docs/references-liveux.md).

import { useEffect, useMemo, useRef } from "react";
import type { ArMarker } from "@/lib/types";
import { markerFromBbox } from "@/lib/inventory/markers";
import {
  maskDestRect,
  maskPngToDataUrl,
  partitionByMask,
  tintMaskPixels,
  type MaskedPart,
} from "@/lib/inventory/liveflow";
import ArMarkerLayer from "@/components/ArMarkerLayer";

export interface MaskOverlayProps {
  /** Highlighted parts only (search matches and tapped rows). */
  parts: readonly MaskedPart[];
  /** Width of the media's pixel coordinate space (canvas/frame width). */
  width: number;
  /** Height of the media's pixel coordinate space. */
  height: number;
  visible?: boolean;
}

/** Decoded, accent-tinted mask stamps keyed by their maskPng string. */
const tintedMaskCache = new Map<string, HTMLCanvasElement>();
const TINTED_MASK_CACHE_MAX = 48;

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to decode mask PNG"));
    img.src = src;
  });
}

/** maskPng -> offscreen canvas of accent-tinted pixels (white mask = tint). */
async function tintedMaskLayer(maskPng: string): Promise<HTMLCanvasElement> {
  const cached = tintedMaskCache.get(maskPng);
  if (cached) return cached;
  const img = await decodeImage(maskPngToDataUrl(maskPng));
  const off = document.createElement("canvas");
  off.width = Math.max(1, img.naturalWidth);
  off.height = Math.max(1, img.naturalHeight);
  const ctx = off.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, off.width, off.height);
  tintMaskPixels(data.data);
  ctx.putImageData(data, 0, 0);
  if (tintedMaskCache.size >= TINTED_MASK_CACHE_MAX) {
    const oldest = tintedMaskCache.keys().next().value;
    if (oldest !== undefined) tintedMaskCache.delete(oldest);
  }
  tintedMaskCache.set(maskPng, off);
  return off;
}

export default function MaskOverlay({
  parts,
  width,
  height,
  visible = true,
}: MaskOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const { masked, plain } = useMemo(() => partitionByMask(parts), [parts]);

  const fallbackMarkers = useMemo<ArMarker[]>(
    () => plain.map((p) => markerFromBbox(p.bbox, p.label, "find")),
    [plain],
  );

  const showMasks = visible && masked.length > 0 && width > 0 && height > 0;

  // Decode + tint each highlighted mask, then stamp them onto the overlay
  // canvas at frame scale. Cancellation guards against a stale async draw
  // landing after the selection changed.
  useEffect(() => {
    if (!showMasks) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    void (async () => {
      const layers: HTMLCanvasElement[] = [];
      for (const part of masked) {
        if (!part.maskPng) continue;
        try {
          layers.push(await tintedMaskLayer(part.maskPng));
        } catch {
          // Undecodable mask: skip it; the part keeps its table row, and a
          // future identify can replace the bad mask.
        }
      }
      if (cancelled) return;
      ctx.clearRect(0, 0, width, height);
      for (const layer of layers) {
        const { dx, dy, dw, dh } = maskDestRect(
          layer.width,
          layer.height,
          width,
          height,
        );
        if (dw > 0 && dh > 0) ctx.drawImage(layer, dx, dy, dw, dh);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showMasks, masked, width, height]);

  // Soft pulse: rAF loop breathing the canvas opacity 0.68..1.0 on top of the
  // ~55% alpha baked into the tint (net ~0.37..0.55).
  useEffect(() => {
    if (!showMasks) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const loop = (t: number) => {
      canvas.style.opacity = String(0.84 + 0.16 * Math.sin(t / 420));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [showMasks]);

  return (
    <>
      {showMasks ? (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        />
      ) : null}
      <ArMarkerLayer markers={fallbackMarkers} visible={visible} />
    </>
  );
}
