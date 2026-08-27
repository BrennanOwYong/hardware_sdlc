// What a part looks like, for someone who has never held one.
//
// "Take the 220-ohm resistor" assumes you can pick a resistor out of a tray.
// A first-timer cannot, and a step that names a part without showing it is a
// step they have to leave the app to follow. Every part named in a step is
// therefore clickable: a drawn likeness (which shows the thing that matters —
// which leg is long, which way the bands read) next to a real photograph
// (which shows what it looks like on a desk under real light).
//
// Photos come from the curated practice set in data/images/practice, served
// by /api/images. They are Creative Commons and MUST carry their credit and
// licence wherever they are shown; the fields below make that automatic.
//
// Pure module: no runtime imports, so `node --test` can load it.

export type PartGlyph =
  | "led"
  | "resistor"
  | "button"
  | "wire"
  | "board"
  | "breadboard"
  | "usb";

export interface PartPhoto {
  /** Path under /api/images. */
  src: string;
  title: string;
  credit: string;
  licence: string;
  sourceUrl: string;
}

export interface PartLook {
  id: string;
  name: string;
  glyph: PartGlyph;
  colour: string;
  /** How to recognise it in a pile of parts. */
  recognise: string;
  /** What it does, in one line. */
  does: string;
  /** The mistake people make with this part. */
  watchFor?: string;
  photo?: PartPhoto;
  /** Lowercase phrases that mean this part when they appear in step text. */
  aliases: string[];
}

const UNO_PHOTO: PartPhoto = {
  src: "/api/images/practice/uno-closeup.jpg",
  title: "Arduino Uno close-up with readable pin labels",
  credit: "Dllu",
  licence: "CC BY-SA 4.0",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Arduino_Uno_dllu.jpg",
};

const BREADBOARD_PHOTO: PartPhoto = {
  src: "/api/images/practice/breadboard-mid-build-1.jpg",
  title: "Arduino Uno and breadboard mounted on a project plate",
  credit: "TreyDanger",
  licence: "CC BY 2.0",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Arduino_%26_breadboard,_mounted.jpg",
};

const PARTS_PHOTO: PartPhoto = {
  src: "/api/images/practice/parts-spread-1.jpg",
  title: "Arduino experimentation kit, parts laid out",
  credit: "oomlout",
  licence: "CC BY-SA 2.0",
  sourceUrl:
    "https://commons.wikimedia.org/wiki/File:ARDX_-_Arduino_Experimentation_Kit_(Inside_the_box).jpg",
};

const WIRES_PHOTO: PartPhoto = {
  src: "/api/images/practice/breadboard-lcd.jpg",
  title: "Jumper wires running between an Uno and a breadboard",
  credit: "Lukaststanley",
  licence: "CC BY-SA 3.0",
  sourceUrl:
    "https://commons.wikimedia.org/wiki/File:Arduino_Breadboard_LCD_Trial_One.jpg",
};

const LED_PHOTO: PartPhoto = {
  src: "/api/images/practice/workbench-led-test.jpg",
  title: "An LED lit on a breadboard during a bench test",
  credit: "practice set",
  licence: "CC BY 2.0",
  sourceUrl: "https://commons.wikimedia.org/wiki/Category:Light-emitting_diodes",
};

export const PART_LOOKS: PartLook[] = [
  {
    id: "uno",
    name: "Arduino Uno",
    glyph: "board",
    colour: "#0ea5e9",
    recognise:
      "A blue-green circuit board the size of a credit card, with a chunky silver USB socket on one short edge and black pin sockets down both long edges.",
    does: "Runs your code and switches its pins on and off.",
    watchFor: "Its pins are 5V. A 3.3V sensor wired straight to one can be damaged.",
    photo: UNO_PHOTO,
    aliases: ["arduino uno", "the uno", "uno", "arduino", "the board"],
  },
  {
    id: "breadboard",
    name: "Breadboard",
    glyph: "breadboard",
    colour: "#94a3b8",
    recognise:
      "A white plastic slab covered in small square holes, with a groove down the middle and coloured red/blue lines along the edges.",
    does: "Holds parts and joins them without solder. Holes in the same short row are already connected to each other.",
    watchFor:
      "The groove down the middle breaks the connection: holes on opposite sides of it are NOT joined.",
    photo: BREADBOARD_PHOTO,
    aliases: ["breadboard", "the board's holes"],
  },
  {
    id: "led",
    name: "LED",
    glyph: "led",
    colour: "#ef4444",
    recognise:
      "A small coloured plastic dome, about the size of a match head, with two bare wire legs — one clearly longer than the other.",
    does: "Lights up when current flows through it the right way.",
    watchFor:
      "The LONG leg is positive (anode). Backwards it simply will not light, and nothing tells you why.",
    photo: LED_PHOTO,
    aliases: ["led", "the led", "red led"],
  },
  {
    id: "resistor",
    name: "220Ω resistor",
    glyph: "resistor",
    colour: "#f59e0b",
    recognise:
      "A small beige barrel with coloured bands and a wire leg out of each end. 220Ω reads red-red-brown.",
    does: "Limits the current so the LED is not destroyed by the pin driving it.",
    watchFor: "It has no direction: either leg can go either way round.",
    photo: PARTS_PHOTO,
    aliases: ["resistor", "220", "220ω", "220 ohm", "220-ohm"],
  },
  {
    id: "button",
    name: "Pushbutton",
    glyph: "button",
    colour: "#22c55e",
    recognise:
      "A small black square with a coloured plunger on top and four stubby legs, one at each corner.",
    does: "Joins its two sides while you hold it down.",
    watchFor:
      "The legs are paired: the two on the same side are ALWAYS joined. Straddle the middle groove or the button does nothing.",
    photo: PARTS_PHOTO,
    aliases: ["pushbutton", "push button", "button", "the switch"],
  },
  {
    id: "wire-black",
    name: "Jumper wire (black)",
    glyph: "wire",
    colour: "#475569",
    recognise: "A short plastic-coated wire with a stiff metal pin at each end.",
    does: "Carries ground. Black is the convention for ground; nothing enforces it but everyone reading your board expects it.",
    photo: WIRES_PHOTO,
    aliases: ["black jumper", "black wire", "jumper wire (black)"],
  },
  {
    id: "wire-red",
    name: "Jumper wire (red)",
    glyph: "wire",
    colour: "#dc2626",
    recognise: "A short plastic-coated wire with a stiff metal pin at each end.",
    does: "Carries power or a driven signal. Red is the convention for positive.",
    photo: WIRES_PHOTO,
    aliases: ["red jumper", "red wire", "jumper wire (red)"],
  },
  {
    id: "wire-yellow",
    name: "Jumper wire (yellow)",
    glyph: "wire",
    colour: "#eab308",
    recognise: "A short plastic-coated wire with a stiff metal pin at each end.",
    does: "Carries a signal that is neither power nor ground — here, the button's.",
    photo: WIRES_PHOTO,
    aliases: ["yellow jumper", "yellow wire", "jumper wire (yellow)"],
  },
  {
    id: "usb",
    name: "USB cable",
    glyph: "usb",
    colour: "#a855f7",
    recognise:
      "The flat rectangular plug on one end goes to your computer; the squarer, chunkier plug goes to the Uno.",
    does: "Powers the board and carries your code onto it.",
    photo: UNO_PHOTO,
    aliases: ["usb cable", "usb"],
  },
];

export function partLook(id: string): PartLook | undefined {
  return PART_LOOKS.find((p) => p.id === id);
}

export interface TextSegment {
  text: string;
  /** Set when this run of text names a part the reader can inspect. */
  partId?: string;
}

/**
 * Split instruction text so every mention of a part becomes clickable.
 *
 * Longest aliases match first, so "black jumper wire" is one chip rather than
 * "wire" inside stray words. Matching is case-insensitive and only lands on
 * whole words, so "buttonhole" never becomes a pushbutton.
 */
export function linkifyParts(
  text: string,
  looks: readonly PartLook[] = PART_LOOKS,
): TextSegment[] {
  const pairs: { alias: string; id: string }[] = [];
  for (const look of looks) {
    for (const alias of look.aliases) pairs.push({ alias, id: look.id });
  }
  pairs.sort((a, b) => b.alias.length - a.alias.length);

  const lower = text.toLowerCase();
  const claimed: (string | undefined)[] = new Array(text.length).fill(undefined);

  for (const { alias, id } of pairs) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(alias, from);
      if (at === -1) break;
      from = at + alias.length;
      const before = at === 0 ? " " : text[at - 1] ?? " ";
      const after = text[at + alias.length] ?? " ";
      const wordBoundary = !/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after);
      if (!wordBoundary) continue;
      let free = true;
      for (let i = at; i < at + alias.length; i += 1) {
        if (claimed[i] !== undefined) {
          free = false;
          break;
        }
      }
      if (!free) continue;
      for (let i = at; i < at + alias.length; i += 1) claimed[i] = id;
    }
  }

  const segments: TextSegment[] = [];
  let i = 0;
  while (i < text.length) {
    const id = claimed[i];
    let j = i + 1;
    while (j < text.length && claimed[j] === id) j += 1;
    const chunk = text.slice(i, j);
    segments.push(id === undefined ? { text: chunk } : { text: chunk, partId: id });
    i = j;
  }
  return segments;
}
