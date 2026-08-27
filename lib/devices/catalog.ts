// The device catalog: what a specific piece of hardware physically is.
//
// The old board view hardcoded one breadboard (30 rows, columns a..j) and one
// Arduino Uno silhouette. That drawing is a cartoon of a category, not a
// picture of the thing on your desk. A 170-point mini breadboard has 17 rows
// and no power rails; an 830-point full-size board has 63 rows and four rails.
// Wiring instructions drawn on the wrong body are wrong instructions.
//
// So every device here is a PARAMETRIC SPEC, not a drawing. Row counts,
// columns per half, rail sides, pin names and real millimetre dimensions are
// data. lib/devices/layout.ts turns any spec into hole coordinates, and the
// wireframe renders whatever comes out. Adding a board means adding a record
// here; no drawing code changes.
//
// `verified` marks whether the numbers came from the vendor's own published
// spec (linked in `source`) or from a general pattern for that class of part.
// Nothing in the UI claims a model name with more confidence than that flag.
//
// Pure module: NO runtime imports at all, so `node --test` loads it directly
// under Node's type stripping. Geometry constants and the functions that use
// them live in lib/devices/layout.ts, which imports this file type-only —
// data has no idea how it gets drawn, which is the dependency direction that
// lets a new board be added without touching geometry.

export type DeviceKind = "breadboard" | "board";

interface SpecBase {
  id: string;
  /** The model as printed on the part, shown verbatim in the UI. */
  model: string;
  brand: string;
  /** Lowercase substrings that identify this model in a detection label. */
  aka: string[];
  /** True when every number below came from the vendor's published spec. */
  verified: boolean;
  source?: string;
  note: string;
}

export interface RailSideSpec {
  side: "top" | "bottom";
  /** Order top-to-bottom on that side; "+" is the red line, "-" the blue. */
  lines: ("+" | "-")[];
}

export interface BreadboardSpec extends SpecBase {
  kind: "breadboard";
  tiePoints: number;
  /** Numbered rows across the long axis. */
  rows: number;
  /** Receptacles per row per half: the a..e / f..j count. 5 is standard. */
  columnsPerHalf: number;
  /** 2 for a normal board split by the DIP channel, 1 for a single strip. */
  halves: 1 | 2;
  rails: RailSideSpec[];
  /** Rail holes come in groups with a gap between; 5 on almost every board. */
  railGroup: number;
}

/** One physical pin header. `pins` is in order along the edge; null is a gap. */
export interface HeaderSpec {
  id: string;
  side: "top" | "bottom";
  pins: (string | null)[];
  /** Distance from the board's left edge to the first pin centre. */
  startMm: number;
}

export interface BoardSpec extends SpecBase {
  kind: "board";
  mcu: string;
  clockMhz: number;
  flashKb: number;
  ramKb: number;
  /** Logic level in volts. Wiring a 5V part to a 3.3V pin is a real mistake. */
  logicV: number;
  widthMm: number;
  heightMm: number;
  usb: "type-b" | "mini-b" | "micro-b" | "usb-c";
  headers: HeaderSpec[];
}

export type DeviceSpec = BreadboardSpec | BoardSpec;

// --- breadboards -------------------------------------------------------------

const BB_830: BreadboardSpec = {
  kind: "breadboard",
  id: "bb-830",
  model: "830-point solderless breadboard (MB-102)",
  brand: "generic",
  aka: ["830", "mb-102", "mb102", "full-size breadboard", "full size breadboard"],
  verified: false,
  note: "63 numbered rows, columns a-j, four distribution rails. The layout is a de-facto standard across MB-102 clones.",
  tiePoints: 830,
  rows: 63,
  columnsPerHalf: 5,
  halves: 2,
  rails: [
    { side: "top", lines: ["+", "-"] },
    { side: "bottom", lines: ["+", "-"] },
  ],
  railGroup: 5,
};

const BB_400: BreadboardSpec = {
  kind: "breadboard",
  id: "bb-400",
  model: "400-point half-size breadboard",
  brand: "generic",
  aka: ["400", "half-size breadboard", "half size breadboard", "breadboard"],
  verified: false,
  note: "30 numbered rows, columns a-j, one + and one - rail on each long side.",
  tiePoints: 400,
  rows: 30,
  columnsPerHalf: 5,
  halves: 2,
  rails: [
    { side: "top", lines: ["+", "-"] },
    { side: "bottom", lines: ["+", "-"] },
  ],
  railGroup: 5,
};

const BB_170: BreadboardSpec = {
  kind: "breadboard",
  id: "bb-170",
  model: "SYB-170 mini breadboard (170 points)",
  brand: "generic",
  aka: ["170", "syb-170", "syb170", "mini breadboard"],
  verified: false,
  note: "17 rows, columns a-j, NO power rails. Wiring that assumes a + rail cannot be built on this board.",
  tiePoints: 170,
  rows: 17,
  columnsPerHalf: 5,
  halves: 2,
  rails: [],
  railGroup: 5,
};

const BB_3COL: BreadboardSpec = {
  kind: "breadboard",
  id: "bb-3col",
  model: "3-column trainer strip",
  brand: "generic",
  aka: ["3-column", "3 column", "trainer strip", "three column"],
  verified: false,
  note: "Three receptacles per half instead of five. Included to prove the wireframe follows the model rather than a fixed drawing: a hole at row 12 column d does not exist here.",
  tiePoints: 276,
  rows: 46,
  columnsPerHalf: 3,
  halves: 2,
  rails: [{ side: "bottom", lines: ["+", "-"] }],
  railGroup: 5,
};

const BB_BUS: BreadboardSpec = {
  kind: "breadboard",
  id: "bb-bus",
  model: "Distribution strip (bus only)",
  brand: "generic",
  aka: ["distribution strip", "bus strip", "power strip breadboard"],
  verified: false,
  note: "Rails only, no terminal rows. Used to extend power beside a larger board.",
  tiePoints: 100,
  rows: 50,
  columnsPerHalf: 0,
  halves: 1,
  rails: [{ side: "top", lines: ["+", "-"] }],
  railGroup: 5,
};

// --- microcontroller boards --------------------------------------------------

/** The Uno's headers are not evenly spaced: a 4 mm jog sits between D7 and D8. */
const UNO_DIGITAL: HeaderSpec = {
  id: "digital",
  side: "top",
  pins: [
    "SCL", "SDA", "AREF", "GND", "D13", "D12", "D11", "D10", "D9", "D8",
    null,
    "D7", "D6", "D5", "D4", "D3", "D2", "D1", "D0",
  ],
  startMm: 17.5,
};

// The Uno has three physical GND pins. Only the one beside D13 answers to the
// bare ref "UNO:GND", because that is the pin every existing instruction and
// netlist means; the power header's pair are GND2 and GND3. Two holes sharing
// a ref would put a step's target ring on both.
const UNO_POWER: HeaderSpec = {
  id: "power",
  side: "bottom",
  pins: [null, "IOREF", "RESET", "3V3", "5V", "GND2", "GND3", "VIN"],
  startMm: 15.2,
};

const UNO_ANALOG: HeaderSpec = {
  id: "analog",
  side: "bottom",
  pins: ["A0", "A1", "A2", "A3", "A4", "A5"],
  startMm: 43.2,
};

const UNO: BoardSpec = {
  kind: "board",
  id: "uno-r3",
  model: "Arduino UNO Rev3",
  brand: "Arduino",
  aka: ["uno", "arduino uno", "uno r3", "atmega328"],
  verified: true,
  source: "https://store.arduino.cc/products/arduino-uno-rev3",
  note: "14 digital pins (6 PWM), 6 analog inputs, 5V logic. 32 KB flash of which 0.5 KB is the bootloader.",
  mcu: "ATmega328P",
  clockMhz: 16,
  flashKb: 32,
  ramKb: 2,
  logicV: 5,
  widthMm: 68.6,
  heightMm: 53.4,
  usb: "type-b",
  headers: [UNO_DIGITAL, UNO_POWER, UNO_ANALOG],
};

const NANO: BoardSpec = {
  kind: "board",
  id: "nano",
  model: "Arduino Nano",
  brand: "Arduino",
  aka: ["nano", "arduino nano"],
  verified: false,
  source: "https://docs.arduino.cc/hardware/nano/",
  note: "45 x 18 mm is from Arduino's own page; the pin order below follows the classic Nano pinout. Straddles a breadboard channel, so it sits ON the board rather than beside it.",
  mcu: "ATmega328P",
  clockMhz: 16,
  flashKb: 32,
  ramKb: 2,
  logicV: 5,
  widthMm: 45,
  heightMm: 18,
  usb: "mini-b",
  headers: [
    {
      id: "left",
      side: "top",
      pins: ["D13", "3V3", "AREF", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "5V", "RESET", "GND", "VIN"],
      startMm: 3.8,
    },
    {
      id: "right",
      side: "bottom",
      pins: ["D12", "D11", "D10", "D9", "D8", "D7", "D6", "D5", "D4", "D3", "D2", "GND", "RESET2", "D0", "D1"],
      startMm: 3.8,
    },
  ],
};

const ESP32: BoardSpec = {
  kind: "board",
  id: "esp32-devkit-v1",
  model: "DOIT ESP32 DEVKIT V1 (30-pin)",
  brand: "DOIT",
  aka: ["esp32", "devkit", "doit esp32", "esp-32"],
  verified: false,
  source: "https://www.espboards.dev/esp32/esp32doit-devkit-v1/",
  note: "3.3V logic. Wiring a 5V sensor straight to a GPIO here damages the pin, which is why logic level is part of the spec and not a footnote.",
  mcu: "ESP32-WROOM-32",
  clockMhz: 240,
  flashKb: 4096,
  ramKb: 520,
  logicV: 3.3,
  widthMm: 51.4,
  heightMm: 28.3,
  usb: "micro-b",
  headers: [
    {
      id: "left",
      side: "top",
      pins: ["VIN", "GND", "D13", "D12", "D14", "D27", "D26", "D25", "D33", "D32", "D35", "D34", "VN", "VP", "EN"],
      startMm: 3.5,
    },
    {
      id: "right",
      side: "bottom",
      pins: ["D23", "D22", "TX0", "RX0", "D21", "GND2", "D19", "D18", "D5", "TX2", "RX2", "D4", "D2", "D15", "3V3"],
      startMm: 3.5,
    },
  ],
};

const MEGA: BoardSpec = {
  kind: "board",
  id: "mega-2560",
  model: "Arduino MEGA 2560 Rev3",
  brand: "Arduino",
  aka: ["mega", "mega2560", "arduino mega"],
  verified: true,
  source: "https://store.arduino.cc/products/arduino-mega-2560-rev3",
  note: "54 digital pins and 16 analog inputs. Only the first 22 digital pins are drawn on the near header; the rest live on the double header at the far end.",
  mcu: "ATmega2560",
  clockMhz: 16,
  flashKb: 256,
  ramKb: 8,
  logicV: 5,
  widthMm: 101.52,
  heightMm: 53.3,
  usb: "type-b",
  headers: [
    {
      id: "digital",
      side: "top",
      pins: [
        "SCL", "SDA", "AREF", "GND", "D13", "D12", "D11", "D10", "D9", "D8",
        null,
        "D7", "D6", "D5", "D4", "D3", "D2", "D1", "D0",
      ],
      startMm: 17.5,
    },
    {
      id: "power",
      side: "bottom",
      pins: [null, "IOREF", "RESET", "3V3", "5V", "GND2", "GND3", "VIN"],
      startMm: 15.2,
    },
    {
      id: "analog",
      side: "bottom",
      pins: ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A12", "A13", "A14", "A15"],
      startMm: 43.2,
    },
  ],
};

export const CATALOG: DeviceSpec[] = [
  UNO,
  NANO,
  ESP32,
  MEGA,
  BB_830,
  BB_400,
  BB_170,
  BB_3COL,
  BB_BUS,
];

export function specById(id: string): DeviceSpec | undefined {
  return CATALOG.find((s) => s.id === id);
}

export function breadboards(): BreadboardSpec[] {
  return CATALOG.filter((s): s is BreadboardSpec => s.kind === "breadboard");
}

export function boards(): BoardSpec[] {
  return CATALOG.filter((s): s is BoardSpec => s.kind === "board");
}
