// Scripted demo timeline for the button-to-LED build. Plays the whole
// 7-step assembly, including the demo beat on step 4: the wire lands one
// row off (BB:4:h instead of BB:5:h), the app flags it, and the build only
// continues after the correction.
//
// Edge ids and refs must match lib/assembly/circuits.ts (e1..e7).
// The page auto-dispatches "reset" ~1.5s after an error while in demo mode,
// which is why the corrected tip-at on step 4 waits until 10300ms.

import type { MockScriptEntry } from "@/lib/types";

export const demoScript: MockScriptEntry[] = [
  {
    atMs: 300,
    event: {
      type: "detections",
      atMs: 300,
      parts: [
        {
          id: "p1",
          partType: "breadboard",
          label: "Half-size breadboard",
          confidence: 0.97,
          bbox: [0.02, 0.02, 0.94, 0.42],
        },
        {
          id: "p2",
          partType: "arduino-uno",
          label: "Arduino Uno R3",
          confidence: 0.94,
          bbox: [0.14, 0.52, 0.72, 0.44],
        },
        {
          id: "p3",
          partType: "led",
          label: "Red LED",
          confidence: 0.88,
          bbox: [0.42, 0.1, 0.05, 0.08],
        },
      ],
    },
  },

  // Step 1: UNO:GND -> BB:RAIL:GND
  { atMs: 800, event: { type: "tip-at", atMs: 800, ref: "UNO:GND" } },
  { atMs: 1600, event: { type: "seated", atMs: 1600, edgeId: "e1" } },
  // UI auto-advances ~2400

  // Step 2: LED across BB:5:f / BB:6:f
  { atMs: 2800, event: { type: "tip-at", atMs: 2800, ref: "BB:5:f" } },
  { atMs: 3600, event: { type: "seated", atMs: 3600, edgeId: "e2" } },

  // Step 3: resistor BB:6:h -> BB:RAIL:GND
  { atMs: 4800, event: { type: "tip-at", atMs: 4800, ref: "BB:6:h" } },
  { atMs: 5600, event: { type: "seated", atMs: 5600, edgeId: "e3" } },

  // Step 4: wire UNO:D13 -> BB:5:h — the deliberate mistake.
  // Tip drifts to BB:4:h (near-miss note), then the wire seats in the wrong
  // hole and perception reports a misplacement: the app blocks the build.
  { atMs: 6800, event: { type: "tip-at", atMs: 6800, ref: "BB:4:h" } },
  {
    atMs: 7800,
    event: {
      type: "misplaced",
      atMs: 7800,
      edgeId: "e4",
      expected: ["UNO:D13", "BB:5:h"],
      observed: "wire seated in row 4 hole h, one row above the LED",
    },
  },
  // Demo mode auto-resets ~9300; then the correction lands.
  { atMs: 10300, event: { type: "tip-at", atMs: 10300, ref: "BB:5:h" } },
  { atMs: 11100, event: { type: "seated", atMs: 11100, edgeId: "e4" } },

  // Step 5: pushbutton straddling BB:15:e / BB:17:e
  { atMs: 12300, event: { type: "tip-at", atMs: 12300, ref: "BB:15:e" } },
  { atMs: 13100, event: { type: "seated", atMs: 13100, edgeId: "e5" } },

  // Step 6: wire UNO:D2 -> BB:15:a
  { atMs: 14300, event: { type: "tip-at", atMs: 14300, ref: "UNO:D2" } },
  { atMs: 15100, event: { type: "seated", atMs: 15100, edgeId: "e6" } },

  // Step 7: wire BB:17:a -> BB:RAIL:GND
  { atMs: 16300, event: { type: "tip-at", atMs: 16300, ref: "BB:17:a" } },
  { atMs: 17100, event: { type: "seated", atMs: 17100, edgeId: "e7" } },
];
