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

test("checkpoint glyph codes 0x01..0x07 keep their pre-9f506052 pixels", () => {
  // A host-image checkpoint stays at format version 1 and copies text cells
  // unchanged (src/runtime/engine.ts:3720), so a checkpoint written before
  // 9f506052 holds the OLD glyph meanings: 0x01 horizontal line, 0x02
  // vertical line, 0x03..0x06 corners, 0x07 cursor. Restoring it must render
  // the pre-9f506052 font masks (git show 9f506052~1:app/src/render/
  // font8x8.ts): thin single lines through row 3 / column 3, and the cursor
  // as the bottom two rows solid. The window frame 9f506052 added lives on
  // new codes 0x0A+; repurposing 0x01..0x07 drew a bottom-left border where
  // an old checkpoint's cursor 0x07 sat.
  const surface = new TextSurface();
  const FG_ON_BLACK = attr(15, 0);
  for (let code = 0x01; code <= 0x07; code++) surface.put(2, code, code, FG_ON_BLACK);
  const input = { ...fixture(), text: surface.cells };
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame(input, out, "visual", 0.5, "only");
  const WHITE = EGA_PALETTE[15];
  const BLACK = EGA_PALETTE[0];
  // Cell (2, c) spans pixels x 8c..8c+7, y 16..23.
  // 0x01 horizontal line: row 3 of the cell (y=19) lit across, row 4 dark.
  assert.deepEqual(pixelAt(out, 8 + 0, 19), WHITE, "0x01 line on cell row 3");
  assert.deepEqual(pixelAt(out, 8 + 7, 19), WHITE, "0x01 line spans the cell");
  assert.deepEqual(pixelAt(out, 8 + 0, 20), BLACK, "0x01 is one thin line, not a bar pair");
  // 0x02 vertical line: column 3 (x=19) lit top to bottom, column 4 dark.
  assert.deepEqual(pixelAt(out, 16 + 3, 16), WHITE, "0x02 line reaches the cell top");
  assert.deepEqual(pixelAt(out, 16 + 3, 23), WHITE, "0x02 line reaches the cell bottom");
  assert.deepEqual(pixelAt(out, 16 + 4, 20), BLACK, "0x02 is one thin column");
  // 0x03 top-left corner: the junction at (column 3, row 3), arms right and down.
  assert.deepEqual(pixelAt(out, 24 + 3, 19), WHITE, "0x03 junction");
  assert.deepEqual(pixelAt(out, 24 + 7, 19), WHITE, "0x03 arm runs right");
  assert.deepEqual(pixelAt(out, 24 + 3, 23), WHITE, "0x03 arm runs down");
  assert.deepEqual(pixelAt(out, 24 + 0, 19), BLACK, "0x03 has no left arm");
  assert.deepEqual(pixelAt(out, 24 + 3, 18), BLACK, "0x03 has no upward arm");
  // 0x04 top-right corner: arms left and down from the junction.
  assert.deepEqual(pixelAt(out, 32 + 0, 19), WHITE, "0x04 arm runs left");
  assert.deepEqual(pixelAt(out, 32 + 3, 23), WHITE, "0x04 arm runs down");
  assert.deepEqual(pixelAt(out, 32 + 4, 19), BLACK, "0x04 has no right arm");
  // 0x05 bottom-left corner: arms up and right.
  assert.deepEqual(pixelAt(out, 40 + 3, 16), WHITE, "0x05 arm runs up");
  assert.deepEqual(pixelAt(out, 40 + 7, 19), WHITE, "0x05 arm runs right");
  assert.deepEqual(pixelAt(out, 40 + 3, 20), BLACK, "0x05 stops at the junction");
  // 0x06 bottom-right corner: arms up and left.
  assert.deepEqual(pixelAt(out, 48 + 3, 16), WHITE, "0x06 arm runs up");
  assert.deepEqual(pixelAt(out, 48 + 0, 19), WHITE, "0x06 arm runs left");
  assert.deepEqual(pixelAt(out, 48 + 4, 19), BLACK, "0x06 has no right arm");
  // 0x07 cursor: the bottom two cell rows solid, everything above dark.
  assert.deepEqual(pixelAt(out, 56 + 0, 22), WHITE, "0x07 cursor row 6");
  assert.deepEqual(pixelAt(out, 56 + 7, 23), WHITE, "0x07 cursor row 7");
  assert.deepEqual(pixelAt(out, 56 + 3, 21), BLACK, "0x07 is a cursor, not a corner");
});

test("the window frame renders the decoded OpenWndw bars, inset one pixel", () => {
  // Decode (kq1 2.917 descrambled AGI, SHA-256
  // bf53a4f98e32a7feec127b153100b66678c48715fec1ae2e823b947c0b5aef04):
  // WindowNoWait 0x1E4B..0x1E66 sets winDim h = 8*rows + 10 scanlines and
  // w = 4*cols + 10 nibbles (rows/cols = TEXT extents — executing the
  // original formatter under Unicorn for print("Hi") yields winRows=1,
  // winCols=2, winDim 0x1212 = 18x18); 0x1ECC..0x1EED sets winPos
  // x = 4*winLeft - 5 nibbles, y = 8*(winBot+1-picTop) + 4 scanlines.
  // OpenWndw 0x54C8..0x553D issues five DrawWndw calls (captured under
  // Unicorn): fill (x, y, h, w) white; then red bars (x+1, y-1, 1, w-2),
  // (x+w-2, y-2, h-4, 1), (x+1, y-h+2, 1, w-2), (x+1, y-2, h-4, 1).
  // DrawWndw anchors at the bottom line and paints upward (covers
  // y-h+1..y): the only reading under which the h-4 verticals (y-h+3..y-2)
  // meet both horizontal bars (y-h+2 and y-1) with no gap, leaving 5
  // nibbles/scanlines of fill on every side of the text. So each bar is one
  // logical pixel, inset ONE pixel from the fill edge — 1 nibble/scanline
  // of white outside it, 3 between it and the text.
  //
  // Cell mapping (the 8x8-cell model cannot express the fill exactly:
  // 18 nibbles = 4.5 cells, 18 scanlines = 2.25 cells; the fill stays
  // text+2 cols by lines+2 rows of whole cells, 2 nibbles narrower and 6
  // scanlines taller than the original). The glyph masks carry the decoded
  // INSET structure: side bars at the second logical column of each edge
  // cell, the top bar on cell row 1, the bottom bar on cell row 6, and the
  // horizontal bars stopping at the side-bar columns in the corner cells.
  //
  // Hand-computed for {top:10, left:18, rows:3, cols:4} ("Hi" at row 11,
  // col 19): fill pixels x 144..175, y 80..103; top bar y=81, x 146..173;
  // bottom bar y=102, x 146..173; left bar x 146..147, y 82..101; right bar
  // x 172..173, y 82..101 (one logical pixel = two rendered columns).
  const surface = new TextSurface();
  drawWindow(surface, { top: 10, left: 18, rows: 3, cols: 4 }, ["Hi"], attr(0, 15), attr(4, 15));
  const input = { ...fixture(), text: surface.cells };
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame(input, out, "visual", 0.5, "only");
  const RED = EGA_PALETTE[4];
  const WHITE = EGA_PALETTE[15];

  // Top bar on cell row 1 (y=81): one fill scanline above it (y=80),
  // spanning x 146..173 with the fill-edge columns staying white.
  assert.deepEqual(pixelAt(out, 150, 80), WHITE, "fill scanline above the top bar");
  assert.deepEqual(pixelAt(out, 144, 81), WHITE, "left fill edge stays white at the bar row");
  assert.deepEqual(pixelAt(out, 145, 81), WHITE);
  assert.deepEqual(pixelAt(out, 146, 81), RED, "top bar starts at the side-bar column");
  assert.deepEqual(pixelAt(out, 150, 81), RED, "top bar, one scanline tall");
  assert.deepEqual(pixelAt(out, 173, 81), RED, "top bar ends at the right side-bar column");
  assert.deepEqual(pixelAt(out, 174, 81), WHITE, "right fill edge stays white at the bar row");
  assert.deepEqual(pixelAt(out, 150, 82), WHITE, "below the top bar is fill");
  // Bottom bar on cell row 6 of the bottom edge (y=102): fill below (y=103).
  assert.deepEqual(pixelAt(out, 150, 101), WHITE, "above the bottom bar is fill");
  assert.deepEqual(pixelAt(out, 150, 102), RED, "bottom bar, one scanline tall");
  assert.deepEqual(pixelAt(out, 146, 102), RED, "bottom bar reaches the side-bar column");
  assert.deepEqual(pixelAt(out, 173, 102), RED);
  assert.deepEqual(pixelAt(out, 150, 103), WHITE, "fill scanline below the bottom bar");
  // Left bar at the edge cell's second logical column (x 146..147), one
  // white logical pixel (x 144..145) outside it, fill inside (x 148+).
  assert.deepEqual(pixelAt(out, 144, 90), WHITE, "outer fill nibble left of the bar");
  assert.deepEqual(pixelAt(out, 145, 90), WHITE);
  assert.deepEqual(pixelAt(out, 146, 90), RED, "left bar, inset one logical pixel");
  assert.deepEqual(pixelAt(out, 147, 90), RED, "the nibble is two rendered columns");
  assert.deepEqual(pixelAt(out, 148, 90), WHITE, "bar is one logical pixel, not a cell band");
  // Right bar at the edge cell's third logical column (x 172..173).
  assert.deepEqual(pixelAt(out, 171, 90), WHITE, "fill inside the right bar");
  assert.deepEqual(pixelAt(out, 172, 90), RED, "right bar, inset one logical pixel");
  assert.deepEqual(pixelAt(out, 173, 90), RED);
  assert.deepEqual(pixelAt(out, 174, 90), WHITE, "outer fill nibble right of the bar");
  assert.deepEqual(pixelAt(out, 175, 90), WHITE);
  // Corners connect the bars: the top-left corner cell carries the top bar
  // from its second column on, then the left bar below it.
  assert.deepEqual(pixelAt(out, 151, 81), RED, "corner: top bar crosses the corner cell");
  assert.deepEqual(pixelAt(out, 146, 82), RED, "corner: left bar continues below the top bar");
  assert.deepEqual(pixelAt(out, 146, 80), WHITE, "no pixel above the top bar");
  assert.deepEqual(pixelAt(out, 144, 82), WHITE, "no bar pixel on the fill edge column");
  // Bottom-right corner: right bar above, bottom bar across.
  assert.deepEqual(pixelAt(out, 172, 101), RED, "corner: right bar reaches the bottom bar");
  assert.deepEqual(pixelAt(out, 168, 102), RED, "corner: bottom bar crosses the corner cell");
  assert.deepEqual(pixelAt(out, 172, 103), WHITE, "no pixel below the bottom bar");
  // Interior carries the message black on white.
  assert.deepEqual(pixelAt(out, 160, 90), WHITE, "interior fill beside the glyph");
});
