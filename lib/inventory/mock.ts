import type { Inventory, PartDetection } from "@/lib/types";

/**
 * Deterministic mock inventory for the keyless demo path.
 *
 * The pixel rects below mirror the shapes drawn in public/sample-parts.svg
 * (1200x800 canvas). KEEP THE TWO FILES IN SYNC: if a shape moves in the SVG,
 * update its rect here so highlights land on the right shape.
 */
const SVG_W = 1200;
const SVG_H = 800;

function nb(
  x: number,
  y: number,
  w: number,
  h: number,
): [number, number, number, number] {
  return [x / SVG_W, y / SVG_H, w / SVG_W, h / SVG_H];
}

const MOCK_PARTS: readonly PartDetection[] = [
  {
    id: "p1",
    partType: "microcontroller",
    label: "ESP32 DevKit",
    confidence: 0.97,
    bbox: nb(60, 70, 200, 300),
  },
  {
    id: "p2",
    partType: "breadboard",
    label: "Half-size breadboard",
    confidence: 0.96,
    bbox: nb(320, 70, 440, 220),
  },
  {
    id: "p3",
    partType: "sensor",
    label: "DHT11 temperature/humidity sensor",
    confidence: 0.94,
    bbox: nb(820, 70, 130, 170),
  },
  {
    id: "p4",
    partType: "pushbutton",
    label: "Pushbutton",
    confidence: 0.93,
    bbox: nb(1010, 70, 120, 120),
  },
  {
    id: "p5",
    partType: "led",
    label: "LED (red)",
    confidence: 0.95,
    bbox: nb(1010, 250, 110, 160),
  },
  {
    id: "p6",
    partType: "jumper-wire",
    label: "Jumper wire (red)",
    confidence: 0.92,
    bbox: nb(320, 330, 440, 50),
  },
  {
    id: "p7",
    partType: "jumper-wire",
    label: "Jumper wire (blue)",
    confidence: 0.92,
    bbox: nb(320, 390, 440, 50),
  },
  {
    id: "p8",
    partType: "jumper-wire",
    label: "Jumper wire (yellow)",
    confidence: 0.91,
    bbox: nb(320, 450, 440, 50),
  },
  {
    id: "p9",
    partType: "jumper-wire",
    label: "Jumper wire (green)",
    confidence: 0.92,
    bbox: nb(320, 510, 440, 50),
  },
  {
    id: "p10",
    partType: "resistor",
    label: "220Ω resistor",
    confidence: 0.9,
    bbox: nb(820, 460, 320, 40),
  },
  {
    id: "p11",
    partType: "resistor",
    label: "220Ω resistor",
    confidence: 0.9,
    bbox: nb(820, 540, 320, 40),
  },
  {
    id: "p12",
    partType: "resistor",
    label: "10kΩ resistor",
    confidence: 0.89,
    bbox: nb(820, 620, 320, 40),
  },
];

export function buildMockInventory(): Inventory {
  return {
    parts: MOCK_PARTS.map((p) => ({
      ...p,
      bbox: [p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3]],
    })),
    capturedAt: new Date().toISOString(),
    source: "mock",
  };
}
