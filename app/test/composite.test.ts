import assert from "node:assert/strict";
import { test } from "node:test";
import { compositeFrame, FRAME_HEIGHT, FRAME_WIDTH } from "../src/render/composite.ts";
import { EGA_PALETTE } from "../src/render/palette.ts";
import { TextSurface, attr, placePrintWindow, stampWindow } from "../../src/runtime/textSurface.ts";

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

test("the window frame renders the decoded sub-cell OpenWndw fill and bars across PC, Amiga and IIgs", () => {
  // Hand-computed for print("Hi") (1 row, 2 cols) at displayBase = 1:
  // textTop = 11, textLeft = 19 -> interior text pixels x = 152..167, y = 88..95.
  // - PC ("pc"): fill x0 = 142..x1 = 177 (36px = 18 nibbles), y0 = 83..y1 = 100 (18px).
  //   Top bar y = 84, bottom bar y = 99, x = 144..175; left bar x = 144..145, right bar x = 174..175.
  const surface = new TextSurface();
  const win = placePrintWindow(["Hi"], 1, "pc");
  stampWindow(surface, win, ["Hi"], attr(0, 15));
  const input = { ...fixture(), text: surface.cells, windowOverlay: surface.overlay };
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame(input, out, "visual", 0.5, "only");
  const RED = EGA_PALETTE[4];
  const WHITE = EGA_PALETTE[15];

  // Outer fill bounds: x 142..177, y 83..100; outside stays transparent (0,0,0).
  assert.deepEqual(pixelAt(out, 141, 83), [0, 0, 0], "left of fill is transparent");
  assert.deepEqual(pixelAt(out, 142, 83), WHITE, "top-left fill corner at (142, 83)");
  assert.deepEqual(pixelAt(out, 177, 100), WHITE, "bottom-right fill corner at (177, 100)");
  assert.deepEqual(pixelAt(out, 178, 100), [0, 0, 0], "right of fill is transparent");
  // Top bar on y = 84 (y0 + 1), x = 144..175.
  assert.deepEqual(pixelAt(out, 150, 83), WHITE, "1px fill scanline above the top bar");
  assert.deepEqual(pixelAt(out, 142, 84), WHITE, "left fill nibble stays white at the bar row");
  assert.deepEqual(pixelAt(out, 143, 84), WHITE);
  assert.deepEqual(pixelAt(out, 144, 84), RED, "top bar starts at x0 + 2 = 144");
  assert.deepEqual(pixelAt(out, 150, 84), RED, "top bar, one scanline tall");
  assert.deepEqual(pixelAt(out, 175, 84), RED, "top bar ends at x1 - 2 = 175");
  assert.deepEqual(pixelAt(out, 176, 84), WHITE, "right fill nibble stays white at the bar row");
  assert.deepEqual(pixelAt(out, 150, 85), WHITE, "3px fill below the top bar (y = 85..87)");
  // Bottom bar on y = 99 (y1 - 1), fill below on y = 100.
  assert.deepEqual(pixelAt(out, 150, 98), WHITE, "3px fill above the bottom bar (y = 96..98)");
  assert.deepEqual(pixelAt(out, 150, 99), RED, "bottom bar on y = 99");
  assert.deepEqual(pixelAt(out, 144, 99), RED);
  assert.deepEqual(pixelAt(out, 175, 99), RED);
  assert.deepEqual(pixelAt(out, 150, 100), WHITE, "1px fill scanline below the bottom bar");
  // Left bar at x = 144..145 (1 logical pixel = 2 rendered columns), 6px white inside (146..151).
  assert.deepEqual(pixelAt(out, 142, 90), WHITE, "outer fill nibble left of the bar");
  assert.deepEqual(pixelAt(out, 143, 90), WHITE);
  assert.deepEqual(pixelAt(out, 144, 90), RED, "left bar col 0");
  assert.deepEqual(pixelAt(out, 145, 90), RED, "left bar col 1");
  assert.deepEqual(pixelAt(out, 146, 90), WHITE, "white margin inside the left bar (x = 146..151)");
  assert.deepEqual(pixelAt(out, 151, 90), WHITE);
  // Right bar at x = 174..175, 6px white inside (168..173).
  assert.deepEqual(
    pixelAt(out, 168, 90),
    WHITE,
    "white margin inside the right bar (x = 168..173)",
  );
  assert.deepEqual(pixelAt(out, 173, 90), WHITE);
  assert.deepEqual(pixelAt(out, 174, 90), RED, "right bar col 0");
  assert.deepEqual(pixelAt(out, 175, 90), RED, "right bar col 1");
  assert.deepEqual(pixelAt(out, 176, 90), WHITE, "outer fill nibble right of the bar");
  assert.deepEqual(pixelAt(out, 177, 90), WHITE);
  // Interior carries the message black on white.
  assert.deepEqual(pixelAt(out, 160, 90), WHITE, "interior fill beside the glyph");

  // Amiga ("amiga"): 37px wide (x 142..178), 19px tall (y 82..100), 1px bars inset 2px.
  const amigaSurface = new TextSurface();
  stampWindow(amigaSurface, placePrintWindow(["Hi"], 1, "amiga"), ["Hi"], attr(0, 15));
  const amigaOut = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame(
    { ...fixture(), text: amigaSurface.cells, windowOverlay: amigaSurface.overlay },
    amigaOut,
    "visual",
    0.5,
    "only",
  );
  assert.deepEqual(pixelAt(amigaOut, 142, 82), WHITE, "Amiga fill top-left at (142, 82)");
  assert.deepEqual(pixelAt(amigaOut, 178, 100), WHITE, "Amiga fill bottom-right at (178, 100)");
  assert.deepEqual(pixelAt(amigaOut, 144, 84), RED, "Amiga 1px top bar at y=84");
  assert.deepEqual(pixelAt(amigaOut, 144, 90), RED, "Amiga 1px left bar at x=144");
  assert.deepEqual(pixelAt(amigaOut, 145, 90), WHITE, "Amiga left bar is 1px wide");
  assert.deepEqual(pixelAt(amigaOut, 176, 90), RED, "Amiga 1px right bar at x=176");
  assert.deepEqual(pixelAt(amigaOut, 175, 90), WHITE, "Amiga right bar is 1px wide");

  // IIgs ("iigs"): 36px wide (x 142..177), 18px tall (y 83..100), 1px bars inset 2px.
  const iigsSurface = new TextSurface();
  stampWindow(iigsSurface, placePrintWindow(["Hi"], 1, "iigs"), ["Hi"], attr(0, 15));
  const iigsOut = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame(
    { ...fixture(), text: iigsSurface.cells, windowOverlay: iigsSurface.overlay },
    iigsOut,
    "visual",
    0.5,
    "only",
  );
  assert.deepEqual(pixelAt(iigsOut, 144, 85), RED, "IIgs 1px top bar at y=85 (y0+2)");
  assert.deepEqual(pixelAt(iigsOut, 144, 98), RED, "IIgs 1px bottom bar at y=98 (y1-2)");
  assert.deepEqual(pixelAt(iigsOut, 144, 90), RED, "IIgs 1px left bar at x=144");
  assert.deepEqual(pixelAt(iigsOut, 145, 90), WHITE, "IIgs left bar is 1px wide");
  assert.deepEqual(pixelAt(iigsOut, 175, 90), RED, "IIgs 1px right bar at x=175");
  assert.deepEqual(pixelAt(iigsOut, 174, 90), WHITE, "IIgs right bar is 1px wide");
});

// Amiga look (docs/fidelity.md "Amiga screen, font and pointer"): the
// build's own colour table, the status line as the 11 px screen title bar
// with the depth gadgets, and gadget labels at the original's off-grid
// position. Expected pixels are hand-computed from the recorded geometry.
import { appearanceForProfile } from "../src/render/appearance.ts";
import { AMIGA_FONT } from "../src/render/fontAmiga.ts";
import { AMIGA_PALETTE, AMIGA_PALETTE_2_082, AMIGA_PALETTE_2_31X } from "../src/render/palette.ts";

const amiga = appearanceForProfile("amiga-2.202");

test("the Amiga profiles draw the picture through their own colour tables", () => {
  const input = fixture();
  input.visual.fill(13); // SQ2's purple building
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame({ ...input, appearance: amiga }, out);
  assert.deepEqual(pixelAt(out, 0, 8), [0xdd, 0x00, 0xff], "SQ2 2.202 colour 13 is $d0f");
  compositeFrame({ ...input, appearance: appearanceForProfile("amiga-2.082") }, out);
  assert.deepEqual(pixelAt(out, 0, 8), [0xff, 0x77, 0x00], "SQ1 2.082 colour 13 is $f70");
  compositeFrame({ ...input, appearance: appearanceForProfile("amiga-2.316") }, out);
  assert.deepEqual(pixelAt(out, 0, 8), [0xff, 0x00, 0xff], "Gold Rush! 2.316 colour 13 is $f0f");
  assert.equal(AMIGA_PALETTE[1]!.join(), "0,0,255");
  assert.equal(AMIGA_PALETTE_2_082[13]!.join(), "255,119,0");
  assert.equal(AMIGA_PALETTE_2_31X[6]!.join(), "204,119,0");
  compositeFrame({ ...input, appearance: appearanceForProfile("2.936") }, out);
  assert.deepEqual(pixelAt(out, 0, 8), EGA_PALETTE[13], "the PC keeps EGA");
});

test("the Amiga status line is the screen title bar: 10 white rows, text at (2,1), a black line on row 10", () => {
  const input = fixture();
  // "S" at column 0, black on white, as the engine writes the Amiga title.
  input.text.set([0x53, 0xf0]);
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame({ ...input, appearance: amiga, statusBar: true }, out);
  for (const y of [0, 8, 9])
    assert.deepEqual(pixelAt(out, 100, y), AMIGA_PALETTE[15], `bar row ${y} is white`);
  assert.deepEqual(pixelAt(out, 100, 10), AMIGA_PALETTE[0], "row 10 is the bar's bottom line");
  assert.deepEqual(pixelAt(out, 100, 11), AMIGA_PALETTE[15], "picture row 3 shows below the bar");
  // The glyph's top row sits on bar row 1, two pixels in: its first lit
  // column is at x = 2 + (leading blank columns of "S").
  const top = AMIGA_FONT[0x53 * 8]!;
  const lead = Math.clz32(top) - 24;
  assert.deepEqual(pixelAt(out, 2 + lead, 1), AMIGA_PALETTE[0], "title text starts at (2, 1)");
  assert.deepEqual(pixelAt(out, 2 + lead, 0), AMIGA_PALETTE[15], "nothing on bar row 0");
  // The depth gadgets fill the bar's last 34 columns, on a 2 px pen 0 border.
  assert.deepEqual(pixelAt(out, 286, 0), AMIGA_PALETTE[0], "back gadget border");
  assert.deepEqual(pixelAt(out, 303, 5), AMIGA_PALETTE[0], "front gadget border");
  assert.deepEqual(pixelAt(out, 288, 0), AMIGA_PALETTE[1], "gadget ground is pen 1");
  // With the status line off, row 0 is an ordinary text row again.
  compositeFrame({ ...input, appearance: amiga, statusBar: false }, out);
  assert.deepEqual(pixelAt(out, 2 + lead, 0), AMIGA_PALETTE[0], "cell glyph at (lead, 0)");
  assert.deepEqual(pixelAt(out, 100, 9), AMIGA_PALETTE[15], "picture row 1 shows");
  assert.deepEqual(pixelAt(out, 100, 10), AMIGA_PALETTE[15], "no bar line");
});

test("Amiga gadget labels draw four pixels in and two down from the fill's corner", () => {
  const input = fixture();
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  // The restart prompt's Restart gadget: pen 2, label "I" (a 6-wide glyph
  // whose top row is lit from column 1).
  const gadget = { x0: 100, y0: 120, x1: 163, y1: 131, pen: 2, text: "I", textX: 104, textY: 122 };
  compositeFrame({ ...input, appearance: amiga, gadgets: [gadget] }, out);
  assert.deepEqual(pixelAt(out, 100, 120), AMIGA_PALETTE[2], "fill corner");
  assert.deepEqual(pixelAt(out, 163, 131), AMIGA_PALETTE[2], "fill far corner");
  assert.deepEqual(pixelAt(out, 164, 131), AMIGA_PALETTE[15], "picture past the fill");
  const top = AMIGA_FONT[0x49 * 8]!;
  const lead = Math.clz32(top) - 24;
  assert.deepEqual(
    pixelAt(out, 104 + lead, 122),
    AMIGA_PALETTE[15],
    "label pen 15 at (x0+4, y0+2)",
  );
  assert.deepEqual(pixelAt(out, 104 + lead, 121), AMIGA_PALETTE[2], "nothing above the label");
  // The PC look ignores gadget descriptors: its labels are the cells.
  compositeFrame({ ...input, gadgets: [gadget] }, out);
  assert.deepEqual(pixelAt(out, 100, 120), EGA_PALETTE[15]);
});
