// Base64 PNG -> alpha grid, for the anchor math in lib/masks/anchors.ts.
// Kept apart from anchors.ts because this one needs pngjs at runtime, while
// anchors.ts must stay importable by `node --test` with no dependencies.
import { PNG } from "pngjs";
import type { DecodedMask } from "@/lib/masks/anchors";

/**
 * Decode a SAM mask PNG. The masks are white-on-transparent, so alpha carries
 * the coverage; luminance is multiplied in so a white-on-black mask decodes
 * identically rather than reading as fully covered.
 */
export function decodeMaskPng(base64: string): DecodedMask | null {
  try {
    const raw = base64.startsWith("data:")
      ? base64.slice(base64.indexOf(",") + 1)
      : base64;
    const png = PNG.sync.read(Buffer.from(raw, "base64"));
    const alpha = new Uint8Array(png.width * png.height);
    for (let i = 0; i < alpha.length; i += 1) {
      const p = i * 4;
      const a = png.data[p + 3] ?? 0;
      const lum =
        ((png.data[p] ?? 0) + (png.data[p + 1] ?? 0) + (png.data[p + 2] ?? 0)) / 3;
      alpha[i] = Math.round((a / 255) * lum);
    }
    return { width: png.width, height: png.height, alpha };
  } catch {
    return null;
  }
}
