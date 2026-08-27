// Clicking a part name only helps if the right words become clickable and the
// wrong ones do not.
import test from "node:test";
import assert from "node:assert/strict";
import { PART_LOOKS, linkifyParts, partLook } from "../lib/parts/gallery.ts";
import { specById } from "../lib/devices/catalog.ts";
import { autoPlace, connectionEnds, layoutProject } from "../lib/devices/layout.ts";

const layout = layoutProject(autoPlace(["bb-400", "uno-r3"], specById), specById);

test("every part look carries a recognise line and at least one alias", () => {
  for (const look of PART_LOOKS) {
    assert.ok(look.recognise.length > 20, `${look.id} needs a real description`);
    assert.ok(look.aliases.length > 0);
  }
});

test("Creative Commons photos ship with credit and licence", () => {
  for (const look of PART_LOOKS) {
    if (!look.photo) continue;
    assert.ok(look.photo.credit.length > 0, `${look.id} photo needs a credit`);
    assert.ok(look.photo.licence.length > 0, `${look.id} photo needs a licence`);
    assert.match(look.photo.src, /^\/api\/images\//);
  }
});

test("a part named in an instruction becomes a clickable run of text", () => {
  const segs = linkifyParts("Push the LED into row 5 hole f.");
  const led = segs.find((s) => s.partId === "led");
  assert.equal(led.text, "the LED", "the article is part of the alias, so the chip reads naturally");
  assert.equal(segs.map((s) => s.text).join(""), "Push the LED into row 5 hole f.");
});

test("the longest name wins, so one chip covers the whole phrase", () => {
  const segs = linkifyParts("Take a black jumper wire.");
  assert.ok(segs.some((s) => s.partId === "wire-black" && s.text === "black jumper"));
  // "wire" alone must not become a second chip inside the same phrase.
  assert.equal(segs.filter((s) => s.partId !== undefined).length, 1);
});

test("a part name inside a longer word is not a part", () => {
  const segs = linkifyParts("The buttonhole is not a component.");
  assert.equal(segs.filter((s) => s.partId !== undefined).length, 0);
});

test("linkify never loses or reorders a character", () => {
  const text = "Wire the Arduino Uno GND pin to the breadboard ground rail with a black wire.";
  assert.equal(linkifyParts(text).map((s) => s.text).join(""), text);
});

test("partLook is keyed by the same ids the step list uses", () => {
  for (const id of ["uno", "breadboard", "led", "resistor", "button", "wire-black", "usb"]) {
    assert.ok(partLook(id), `${id} must have a look`);
  }
});

test("both ends of a connection are named to device and hole", () => {
  const ends = connectionEnds(layout, "UNO:D13", "BB:5:h");
  assert.match(ends.from.device, /Arduino UNO Rev3/);
  assert.equal(ends.from.where, "D13 pin");
  assert.match(ends.to.device, /400-point/);
  assert.equal(ends.to.where, "row 5, hole h");
  assert.equal(ends.to.anyHoleOnLine, false);
});

test("a rail end says any hole on the line will do", () => {
  const ends = connectionEnds(layout, "UNO:GND", "BB:RAIL:GND");
  assert.equal(ends.to.anyHoleOnLine, true);
  assert.match(ends.to.where, /ground/);
});

test("an end the devices cannot hold is reported as missing, not invented", () => {
  const mini = layoutProject(autoPlace(["bb-170"], specById), specById);
  const ends = connectionEnds(mini, "BB:1:a", "BB:RAIL:GND");
  assert.ok(ends.from);
  assert.equal(ends.to, null);
});
