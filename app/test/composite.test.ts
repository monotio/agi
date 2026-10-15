import assert from "node:assert/strict";
import { test } from "node:test";
import { compositeFrame, FRAME_HEIGHT, FRAME_WIDTH } from "../src/render/composite.ts";
import { EGA_PALETTE } from "../src/render/palette.ts";
import { TextSurface, attr, drawWindow } from "../../src/runtime/textSurface.ts";

function fixture(): { visual: Uint8Array; priority: Uint8Array; text: Uint8Array; picRow: number } {
  const visual = new Uint8Array(160 * 168).fill(15);
  const priority = new Uint8Array(160 * 168).fill(9);
  // A control line across row 100 and a high-priority pixel at (10, 20).
  priority.fill(2, 100 * 160, 100 * 160 + 160);
  priority[20 * 160 + 10] = 15;
  return { visual, priority, text: new Uint8Array(40 * 25 * 2), picRow: 1 };
}

function pixelAt(out: Uint8Array, frameX: number, frameY: number): [number, number, number] {
  const o = (frameY * FRAME_WIDTH + frameX) * 4;
  return [out[o]!, out[o + 1]!, out[o + 2]!];
}

test("visual mode ignores the priority buffer", () => {
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame(fixture(), out);
  // Logical (0,0) → displayed (0, picRow*8) = (0, 8).
  assert.deepEqual(pixelAt(out, 0, 8), EGA_PALETTE[15]);
});

test("priority mode shows priority values through the EGA palette", () => {
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame(fixture(), out, "priority");
  assert.deepEqual(pixelAt(out, 0, 8), EGA_PALETTE[9], "background band 9");
  assert.deepEqual(pixelAt(out, 0, 8 + 100), EGA_PALETTE[2], "control line pixel");
  assert.deepEqual(pixelAt(out, 20, 8 + 20), EGA_PALETTE[15], "priority 15 pixel");
});

test("missing priority buffer falls back to band 15 in debug modes", () => {
  const { priority: _drop, ...input } = fixture();
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame(input, out, "priority");
  assert.deepEqual(pixelAt(out, 0, 8 + 100), EGA_PALETTE[15]);
});

test("split wipes priority in from the divider column", () => {
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame(fixture(), out, "split", 0.5);
  const y = 8 + 100;
  assert.deepEqual(pixelAt(out, 0, y), EGA_PALETTE[15], "left of divider stays visual");
  assert.deepEqual(pixelAt(out, 160, y), [255, 255, 255], "divider line");
  assert.deepEqual(pixelAt(out, 164, y), EGA_PALETTE[2], "right of divider is priority");
});

test("blend tints depth bands and hatches control lines", () => {
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame(fixture(), out, "blend");
  // Band 15 tint (0xff,0x90,0x30) over white at a=0.34.
  assert.deepEqual(pixelAt(out, 20, 8 + 20), [255, 217, 185]);
  // Control line (pri 2, tint 0x40,0xe0,0x60) over white: parity hatch gives
  // a=0.80 on even px+py, 0.55 on odd. Row 100 even, col 0 → 0.8.
  assert.deepEqual(pixelAt(out, 0, 8 + 100), [102, 230, 128]);
  assert.deepEqual(pixelAt(out, 2, 8 + 100), [150, 238, 168]);
});

test("a character the font does not draw is reported once, not left silently blank", (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  const input = fixture();
  // "A", then code 0x82 (é in the PC code page) twice.
  input.text.set([0x41, 0x0f, 0x82, 0x0f, 0x82, 0x0f]);
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame(input, out);
  compositeFrame(input, out);
  // The é cell is blank background, not one of the window border glyphs.
  for (let y = 0; y < 8; y++)
    for (let x = 8; x < 16; x++) assert.deepEqual(pixelAt(out, x, y), EGA_PALETTE[0]!.slice(0, 3));
  assert.deepEqual(warnings, [
    "Game text uses character 0x82, which the 8×8 font does not draw; it shows as a blank cell.",
  ]);
});

test("the window frame renders the measured 1-pixel edge bars, inset one pixel", () => {
  // Measured on kq1 2.917 OpenWndw 0x54C8: a full-rect white fill, then four
  // solid red bars one nibble (one logical pixel) wide, inset one pixel from
  // the fill's edge. On the 4x8-pixel text cell the bars land as: top bar on
  // cell row 4, bottom bar on cell row 3, left bar in the cell's leftmost
  // logical pixel (two rendered columns), right bar in its rightmost.
  const surface = new TextSurface();
  drawWindow(surface, { top: 10, left: 18, rows: 3, cols: 4 }, ["Hi"], attr(0, 15), attr(4, 15));
  const input = { ...fixture(), text: surface.cells };
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame(input, out, "visual", 0.5, "only");
  const RED = EGA_PALETTE[4];
  const WHITE = EGA_PALETTE[15];

  // Left edge cell (row 11, col 18 → pixels x 144..151, y 88..95).
  assert.deepEqual(pixelAt(out, 144, 90), RED, "left bar, first logical pixel");
  assert.deepEqual(pixelAt(out, 145, 90), RED, "the nibble is two rendered columns");
  assert.deepEqual(pixelAt(out, 146, 90), WHITE, "bar is one logical pixel, not a cell band");
  assert.deepEqual(pixelAt(out, 151, 90), WHITE);
  // Right edge cell (row 11, col 21 → x 168..175).
  assert.deepEqual(pixelAt(out, 173, 90), WHITE, "inset one pixel from the fill edge");
  assert.deepEqual(pixelAt(out, 174, 90), RED, "right bar, last logical pixel");
  assert.deepEqual(pixelAt(out, 175, 90), RED);
  // Top edge cell (row 10, col 19 → y 80..87): the bar on cell row 4.
  assert.deepEqual(pixelAt(out, 154, 83), WHITE, "above the inset");
  assert.deepEqual(pixelAt(out, 154, 84), RED, "top bar, one pixel tall");
  assert.deepEqual(pixelAt(out, 154, 85), WHITE, "below the bar is fill");
  // Bottom edge cell (row 12, col 19 → y 96..103): the bar on cell row 3.
  assert.deepEqual(pixelAt(out, 154, 98), WHITE);
  assert.deepEqual(pixelAt(out, 154, 99), RED, "bottom bar, one pixel tall");
  assert.deepEqual(pixelAt(out, 154, 100), WHITE);
  // Top-left corner (row 10, col 18): bar row across, then the left bar below.
  assert.deepEqual(pixelAt(out, 144, 84), RED, "corner: top bar reaches the corner cell");
  assert.deepEqual(pixelAt(out, 151, 84), RED);
  assert.deepEqual(pixelAt(out, 144, 85), RED, "corner: left bar continues");
  assert.deepEqual(pixelAt(out, 146, 85), WHITE);
  assert.deepEqual(pixelAt(out, 144, 83), WHITE, "no pixel above the top bar");
  // Bottom-right corner (row 12, col 21).
  assert.deepEqual(pixelAt(out, 174, 96), RED, "corner: right bar above the bottom bar");
  assert.deepEqual(pixelAt(out, 168, 99), RED, "corner: bottom bar reaches the corner cell");
  assert.deepEqual(pixelAt(out, 174, 100), WHITE, "no pixel below the bottom bar");
  // Interior carries the message black on white.
  assert.deepEqual(pixelAt(out, 154, 90), WHITE, "interior fill beside the glyph");
});
