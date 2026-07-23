// Prompt builders for POST /api/identify — vision-only and sam+vlm region
// labeling. Kept out of the route file so node --test can import them via
// Node 24 type stripping (same pattern as lib/perception/perceive.ts): only
// type-level project imports, no runtime deps.
//
// Scope: Ctrl-F for real life. The identifier names EVERY distinct object on
// the workbench — electronics with full detail (chip names, resistor values)
// AND non-electronic objects (tools, batteries, stationery, accessories,
// containers) with honest partType buckets and specific labels.
import type { SamBox } from "@/lib/perception/sam";

const SIMULATED_PARAGRAPH = `IMPORTANT CONTEXT: the frame may be a SIMULATED workspace — a screen capture of MS Paint, Google Slides, or a drawing/diagram containing image cutouts or illustrations of parts and objects. Treat every cutout or illustration exactly as if it were a real physical object. Real photos of real objects are handled the same way.`;

const ELECTRONICS_DETAIL = `Electronic parts keep full detail. Read chip markings and board names (e.g. "Arduino Uno R3", "ESP32-WROOM"), resistor color-band values (e.g. "220Ω resistor"), and LED colors. Use these partType categories for electronics: microcontroller | breadboard | jumper-wire | resistor | led | pushbutton | sensor | capacitor.`;

const NON_ELECTRONICS_DETAIL = `Non-electronic objects are inventory too — never skip them. Give each an honest partType bucket: tool (tweezers, screwdriver, pliers, wire stripper), battery (USB power bank, AA cell), stationery (pen, pencil, notebook, sticky note), accessory (phone stand, cable, glasses case), container (parts box, cup, tray), or other (extend with another honest lowercase kebab-case bucket when none fits). Labels stay specific: "curved tweezers", "USB power bank", "phone stand", "blue ballpoint pen".`;

/** With a search query, the prompt gains a focused-hunt instruction. */
export function buildVisionPrompt(query?: string): string {
  const base = `You are the workbench identifier for Forge — Ctrl-F for real life on an electronics workbench.

${SIMULATED_PARAGRAPH}

Identify and name EVERY distinct object visible on the workbench — electronics AND everything else (a power bank, tweezers, a pen, a phone stand all count). Count each physical object separately — four jumper wires means four entries. Use any readable text labels in the image as hints, but the bbox must cover the object shape itself, not its caption.

${ELECTRONICS_DETAIL}

${NON_ELECTRONICS_DETAIL}

Reply with ONLY a strict JSON array — no prose, no markdown, no code fences. Each element:
{"partType": "<lowercase kebab-case category from the buckets above>", "label": "<short human name with distinguishing detail, e.g. 'Jumper wire (red)', '220Ω resistor', or 'curved tweezers'>", "confidence": <number 0..1>, "bbox": [x, y, width, height]}

bbox values MUST be normalized to 0..1 relative to the full image, where x,y is the top-left corner. If you reason in pixels, divide by the image dimensions before answering.`;
  if (!query) return base;
  return `${base}

SEARCH FOCUS: the user is hunting for "${query}". Look extra hard for anything matching that description by name, type, or color (cutouts and illustrations count as real objects) and include every visible match in the JSON array with a tight bbox. Still list the other objects you can see.`;
}

/**
 * sam+vlm mode: SAM already proposed numbered regions; one vision call labels
 * every region (or marks it "ignore"). Bboxes come from SAM, names from the
 * model, so the reply schema carries no bbox. "ignore" is reserved for true
 * background (table surface, shadows) — non-electronic objects are labeled,
 * never ignored.
 */
export function buildRegionPrompt(boxes: SamBox[], query?: string): string {
  const regionLines = boxes
    .map(
      (b, i) =>
        `Region ${i + 1}: [${b.bbox.map((v) => v.toFixed(3)).join(", ")}]`,
    )
    .join("\n");
  const base = `You are the workbench identifier for Forge — Ctrl-F for real life on an electronics workbench.

${SIMULATED_PARAGRAPH}

A segmentation model has already outlined ${boxes.length} candidate regions in this image. Each region is a normalized [x, y, width, height] box (top-left origin, 0..1 of the full image):
${regionLines}

For EVERY region, decide which object its box contains — electronics AND everything else on the bench (a power bank, tweezers, a pen, a phone stand all count). Use any readable text labels near the region as hints.

${ELECTRONICS_DETAIL}

${NON_ELECTRONICS_DETAIL}

Reply with ONLY a strict JSON array — no prose, no markdown, no code fences — with exactly one element per region:
{"region": <region number>, "partType": "<lowercase kebab-case category from the buckets above, or ignore>", "label": "<short human name with distinguishing detail, e.g. 'Jumper wire (red)' or 'curved tweezers'>", "confidence": <number 0..1>}

Use partType "ignore" (with label "ignore") ONLY for true background: empty table surface, shadows, hands, or image captions. Do NOT use "ignore" for non-electronic objects — tools, batteries, stationery, and every other real object on the bench get named like any part.`;
  if (!query) return base;
  return `${base}

SEARCH FOCUS: the user is hunting for "${query}". Look extra hard for regions matching that description by name, type, or color (cutouts and illustrations count as real objects) and label every match. Still label the other regions.`;
}
