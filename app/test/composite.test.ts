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
import { appearanceForProfile, loadAppearance } from "../src/render/appearance.ts";
import { AMIGA_FONT } from "../src/render/fontAmiga.ts";
import { AMIGA_PALETTE, AMIGA_PALETTE_2_082, AMIGA_PALETTE_2_31X } from "../src/render/palette.ts";

const amiga = await loadAppearance("amiga-2.202");
await loadAppearance("iigs-1.014");

test("the Amiga profiles draw the picture through their own colour tables", async () => {
  const input = fixture();
  input.visual.fill(13); // SQ2's purple building
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame({ ...input, appearance: amiga }, out);
  assert.deepEqual(pixelAt(out, 0, 8), [0xdd, 0x00, 0xff], "SQ2 2.202 colour 13 is $d0f");
  compositeFrame({ ...input, appearance: await loadAppearance("amiga-2.082") }, out);
  assert.deepEqual(pixelAt(out, 0, 8), [0xff, 0x77, 0x00], "SQ1 2.082 colour 13 is $f70");
  compositeFrame({ ...input, appearance: await loadAppearance("amiga-2.316") }, out);
  assert.deepEqual(pixelAt(out, 0, 8), [0xff, 0x00, 0xff], "Gold Rush! 2.316 colour 13 is $f0f");
  assert.equal(AMIGA_PALETTE[1]!.join(), "0,0,255");
  assert.equal(AMIGA_PALETTE_2_082[13]!.join(), "255,119,0");
  assert.equal(AMIGA_PALETTE_2_31X[6]!.join(), "204,119,0");
  compositeFrame({ ...input, appearance: appearanceForProfile("2.936") }, out);
  assert.deepEqual(pixelAt(out, 0, 8), EGA_PALETTE[13], "the PC keeps EGA");
  // Before the Amiga look has loaded the synchronous lookup answers the PC look.
  assert.equal(appearanceForProfile("amiga-2.202"), amiga, "loaded looks answer synchronously");
});

test("the Amiga status line is the screen title bar: 10 white rows, text at (2,1), a black line on row 10", () => {
  const input = fixture();
  // A game text cell on row 0 lies under the bar; the title comes from the frame.
  input.text.set([0x41, 0x0f]);
  const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame({ ...input, appearance: amiga, statusBar: "S" }, out);
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
  assert.deepEqual(pixelAt(out, 100, 1), AMIGA_PALETTE[15], "the row 0 cell is under the bar");
  // With the status line off, row 0 is an ordinary text row again.
  compositeFrame({ ...input, appearance: amiga, statusBar: null }, out);
  assert.deepEqual(pixelAt(out, 8, 0), AMIGA_PALETTE[0], "the cell's background shows at (8, 0)");
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

test("a supplied platform appearance colours pictures, glyphs and window pixels", () => {
  const input = fixture();
  input.visual.fill(1);
  input.text[0] = 65;
  input.text[1] = 0x21;
  const palette = Array.from({ length: 16 }, () => [0, 0, 0] as [number, number, number]);
  palette[1] = [0, 0, 255];
  palette[2] = [0, 136, 0];
  palette[4] = [204, 0, 0];
  const font = new Uint8Array(256 * 8);
  font[65 * 8] = 0x40; // Synthetic glyph: only column 1 of row 0 is lit.
  const windowOverlay = new Uint8Array(320 * 200);
  windowOverlay[319] = 5;
  const out = new Uint8Array(320 * 200 * 4);
  const platformInput = {
    ...input,
    windowOverlay,
    appearance: { palette, font, hasGlyph: new Uint8Array(256).fill(1), layout: "iigs" as const },
  };
  compositeFrame(platformInput, out);
  assert.deepEqual(pixelAt(out, 0, 8), [0, 0, 255], "picture index 1");
  assert.deepEqual(pixelAt(out, 1, 0), [0, 0, 255], "supplied glyph foreground");
  assert.deepEqual(pixelAt(out, 0, 0), [0, 136, 0], "glyph background");
  assert.deepEqual(pixelAt(out, 319, 0), [204, 0, 0], "window border index 4");
  compositeFrame(platformInput, out, "visual", 0.5, "only");
  assert.deepEqual(pixelAt(out, 1, 0), [0, 0, 255], "exploded text uses the font");
  assert.equal(out[8 * 320 * 4 + 3], 0, "text plane leaves picture transparent");
});

test("platform fonts preserve the engine's private frame and cursor glyphs", () => {
  const input = fixture();
  input.text[0] = 1; // Private horizontal frame stroke: full row 3.
  input.text[1] = 0x0f;
  input.text[2] = 7; // Private cursor: full rows 6 and 7.
  input.text[3] = 0x0f;
  const out = new Uint8Array(320 * 200 * 4);
  compositeFrame(
    {
      ...input,
      appearance: {
        palette: EGA_PALETTE,
        font: new Uint8Array(2048),
        hasGlyph: new Uint8Array(256).fill(1),
        layout: "iigs",
      },
    },
    out,
  );
  assert.deepEqual(pixelAt(out, 0, 3), [255, 255, 255]);
  assert.deepEqual(pixelAt(out, 7, 3), [255, 255, 255]);
  assert.deepEqual(pixelAt(out, 0, 2), [0, 0, 0]);
  assert.deepEqual(pixelAt(out, 8, 6), [255, 255, 255]);
  assert.deepEqual(pixelAt(out, 15, 7), [255, 255, 255]);
});

test("IIgs cells keep an eight-pixel advance, baseline seven and exact foreground/background", () => {
  const input = fixture();
  input.text[0] = 65;
  input.text[1] = 0x21;
  input.text[2] = 103;
  input.text[3] = 0x4f;
  input.text[4] = 59;
  input.text[5] = 0x21;
  input.text[6] = 65;
  input.text[7] = 0x21;
  const out = new Uint8Array(320 * 200 * 4);
  compositeFrame({ ...input, appearance: appearanceForProfile("iigs-1.014") }, out);
  // Hand-drawn A at x=0 and x=24; the semicolon cannot advance the next cell by 9.
  const rows = [0x38, 0x44, 0x44, 0x7c, 0x44, 0x44, 0x44, 0];
  for (const left of [0, 24]) {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        assert.deepEqual(
          pixelAt(out, left + x, y),
          rows[y]! & (128 >> x) ? [0, 0, 255] : [0, 136, 0],
        );
      }
    }
  }
  assert.deepEqual(pixelAt(out, 10, 7), [255, 255, 255], "g descender occupies row 7");
  assert.deepEqual(pixelAt(out, 8, 7), [204, 0, 0], "descender row background");
  assert.deepEqual(pixelAt(out, 10, 8), [255, 255, 255], "cell ends before the next row");
});

test("Amiga status off erases all title pixels while retaining the text below row 10", async () => {
  const { Engine } = await import("../../src/runtime/engine.ts");
  const { createContainer } = await import("../../src/container/container.ts");
  const { assembleLogic } = await import("../../src/logic/assembler.ts");
  const appearance = await loadAppearance("amiga-2.202");
  const { PROFILES } = await import("../../src/runtime/profile.ts");
  for (const top of [1, 2]) {
    const make = (off: boolean) => {
      const container = createContainer();
      container.putResource(
        "logic",
        0,
        assembleLogic(
          `configure.screen(${top},22,2); set.text.attribute(15,4); display(1,0,"MMMM"); ${off ? "status.line.on(); status.line.off();" : ""} return;`,
          { dictionary: new Map(), profile: PROFILES["amiga-2.202"] },
        ).payload,
      );
      const engine = new Engine(
        container,
        {
          print() {},
          displayAt() {},
          statusLine() {},
          takeInputLine: () => null,
          takeKeys: () => [],
        },
        new Map(),
        { profile: "amiga-2.202" },
      );
      engine.tick();
      const pixels = new Uint8Array(320 * 200 * 4);
      compositeFrame({ ...engine.getPresentation(), picRow: top, appearance }, pixels);
      return pixels;
    };
    const before = make(false);
    const after = make(true);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 32; x++) {
        assert.deepEqual(
          pixelAt(after, x, y),
          y <= 10 ? [0, 0, 0] : pixelAt(before, x, y),
          `top ${top} pixel ${x},${y}`,
        );
      }
  }
});

test("Amiga status state table across all six profiles: cold start, configure.screen, on/off, windows, save/restore and restart", async (t) => {
  const { Engine } = await import("../../src/runtime/engine.ts");
  const { createContainer } = await import("../../src/container/container.ts");
  const { assembleLogic } = await import("../../src/logic/assembler.ts");
  const { PROFILES } = await import("../../src/runtime/profile.ts");
  const { decodeHostImage, encodeHostImage } = await import("../../src/runtime/persistence.ts");
  const { buildView } = await import("../../src/view/view.ts");
  const amigaProfiles = Object.values(PROFILES).filter((p) => p.presentation === "amiga");
  assert.equal(amigaProfiles.length, 6);

  const expectedTitle = "Score:5 of 42  " + " ".repeat(11) + "Sound:on " + " ".repeat(4);
  const onePixelBlueView = buildView({
    loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }],
  });

  for (const profile of amigaProfiles) {
    const gatedAtPicTop0 = profile.id !== "amiga-2.082";
    const offChecksEnabled =
      profile.id === "amiga-2.310" || profile.id === "amiga-2.316" || profile.id === "amiga-2.333";
    const appearance = await loadAppearance(profile.id);
    const blueRgb = [...appearance.palette[1]!];
    const greenRgb = [...appearance.palette[2]!];
    const redPriRgb = [...appearance.palette[4]!];
    const logicSource = `
      if (!isset(f200)) {
        set(f200);
        assignn(v3, 5);
        assignn(v7, 42);
        assignn(v1, 1);
        set(f9);
        load.pic(v0);
        load.pic(v1);
        draw.pic(v0);
        show.pic();
        set.text.attribute(15, 4);
        display(1, 0, "MMMM");
        display(2, 0, "KEEP");
      }
      if (isset(f201)) { reset(f201); status.line.on(); status.line.off(); }
      if (isset(f202)) { reset(f202); configure.screen(0, 22, 2); status.line.on(); status.line.off(); }
      if (isset(f203)) { reset(f203); configure.screen(2, 22, 2); set.text.attribute(15, 4); display(1, 0, "MMMM"); status.line.on(); }
      if (isset(f204)) { reset(f204); configure.screen(0, 22, 2); }
      if (isset(f205)) { reset(f205); configure.screen(2, 22, 2); }
      if (isset(f206)) { reset(f206); set.text.attribute(15, 4); display(1, 0, "MMMM"); display(2, 0, "KEEP"); status.line.off(); }
      if (isset(f207)) { reset(f207); print("Hi"); }
      if (isset(f208)) { reset(f208); set(f15); print("Hi"); }
      if (isset(f209)) { reset(f209); ${profile.maxAction >= 0xa9 ? "close.window();" : 'reset(f15); print("Hi");'} }
      if (isset(f210)) { reset(f210); restart.game(); }
      if (isset(f211)) { reset(f211); configure.screen(1, 22, 2); status.line.on(); status.line.off(); show.pic(); }
      if (isset(f212)) { reset(f212); configure.screen(2, 22, 2); status.line.on(); status.line.off(); configure.screen(0, 22, 2); }
      if (isset(f213)) { reset(f213); show.pic(); }
      if (isset(f214)) { reset(f214); configure.screen(1, 22, 2); status.line.on(); status.line.off(); load.view(0); add.to.pic(0, 0, 0, 0, 0, 15, 4); }
      if (isset(f215)) { reset(f215); animate.obj(o0); load.view(0); set.view(o0, 0); set.priority(o0, 15); ignore.horizon(o0); position(o0, 2, 0); draw(o0); }
      if (isset(f216)) { reset(f216); erase(o0); }
      if (isset(f217)) { reset(f217); draw.pic(v0); show.pic(); configure.screen(1, 22, 2); set.text.attribute(15, 4); display(1, 0, "MMMM"); status.line.on(); status.line.off(); overlay.pic(v1); }
      if (isset(f218)) { reset(f218); draw.pic(v0); show.pic(); configure.screen(1, 22, 2); set.text.attribute(15, 4); display(1, 0, "MMMM"); status.line.on(); status.line.off(); draw.pic(v0); }
      if (isset(f219)) { reset(f219); draw.pic(v0); show.pic(); configure.screen(1, 22, 2); set.text.attribute(15, 4); display(1, 0, "MMMM"); status.line.on(); status.line.off(); show.pri.screen(); }
      if (isset(f220)) { reset(f220); draw.pic(v0); show.pic(); configure.screen(1, 22, 2); status.line.on(); status.line.off(); show.pic(); status.line.off(); }
      return;
    `;
    const container = createContainer();
    container.putResource("picture", 0, Uint8Array.of(0xf0, 15, 0xf8, 0, 0, 0xff));
    container.putResource("picture", 1, Uint8Array.of(0xf0, 2, 0xf6, 0, 0, 10, 0, 0xff));
    container.putResource("view", 0, onePixelBlueView);
    container.putResource(
      "logic",
      0,
      assembleLogic(logicSource, { dictionary: new Map(), profile }).payload,
    );

    const makeEngine = (keys: number[] = []) =>
      new Engine(
        container,
        {
          print() {},
          displayAt() {},
          statusLine() {},
          takeInputLine: () => null,
          takeKeys: () => keys.splice(0, keys.length),
          waitKey: () => 0x0d,
        },
        new Map(),
        { profile },
      );

    const composeEngine = (eng: InstanceType<typeof Engine>): Uint8Array => {
      const pres = eng.getPresentation();
      const out = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
      compositeFrame({ ...pres, picRow: eng.displayBase, appearance }, out);
      return out;
    };

    const cloneViaAutosave = (eng: InstanceType<typeof Engine>): InstanceType<typeof Engine> => {
      const bytes = eng.autosaveImage();
      assert.ok(bytes, `${profile.id}: autosaveImage produced`);
      const restored = makeEngine(keys);
      restored.restoreImage(bytes);
      return restored;
    };

    const cloneViaRecording = (eng: InstanceType<typeof Engine>): InstanceType<typeof Engine> => {
      const bytes = eng.recordingImage();
      assert.ok(bytes, `${profile.id}: recordingImage produced`);
      const replay = eng.captureReplayState();
      const restored = makeEngine(keys);
      restored.restoreImage(bytes);
      restored.restoreReplayState(replay);
      return restored;
    };

    // Reference frames for row 1 glyphs ("MMMM" at row 1, cols 0..3) and title bar.
    const refSurface = new TextSurface();
    refSurface.write(1, 0, "MMMM", attr(15, 4));
    const glyphRefFor = (picRow: number): Uint8Array => {
      const ref = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
      compositeFrame(
        {
          visual: new Uint8Array(160 * 168).fill(15),
          priority: new Uint8Array(160 * 168),
          text: refSurface.cells,
          picRow,
          statusBar: null,
          appearance,
        },
        ref,
      );
      return ref;
    };
    const titleRef = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
    compositeFrame(
      {
        visual: new Uint8Array(160 * 168).fill(15),
        priority: new Uint8Array(160 * 168),
        text: refSurface.cells,
        picRow: 2,
        statusBar: expectedTitle,
        appearance,
      },
      titleRef,
    );

    const keys: number[] = [];
    let engine = makeEngine(keys);
    let savedOn: Uint8Array | null = null;

    type RowsMode =
      | "unfilled"
      | "title"
      | "black"
      | "white"
      | "showPicTop1"
      | "overlayGreenLine0to10"
      | "priScreenTop1"
      | "addToPicBlue00"
      | "spriteBlue20";
    const expectedPixelFor = (
      mode: RowsMode,
      x: number,
      y: number,
      glyphRef: Uint8Array,
    ): number[] => {
      switch (mode) {
        case "black":
          return [0, 0, 0];
        case "white":
          return [255, 255, 255];
        case "title":
          return pixelAt(titleRef, x, y);
        case "unfilled":
          return pixelAt(glyphRef, x, y);
        case "showPicTop1":
          return y < 8 ? [0, 0, 0] : [255, 255, 255];
        case "overlayGreenLine0to10":
          return y === 8 && x < 22 ? greenRgb : [0, 0, 0];
        case "priScreenTop1":
          return y < 8 ? [0, 0, 0] : redPriRgb;
        case "addToPicBlue00":
          return y === 8 && (x === 0 || x === 1) ? blueRgb : [0, 0, 0];
        case "spriteBlue20":
          return y === 8 && (x === 0 || x === 1 || x === 4 || x === 5) ? blueRgb : [0, 0, 0];
      }
    };

    const assertRows0to10 = (
      out: Uint8Array,
      mode: RowsMode,
      glyphRef: Uint8Array,
      label: string,
      reference?: Uint8Array,
    ) => {
      for (let y = 0; y <= 10; y++) {
        for (let x = 0; x < FRAME_WIDTH; x++) {
          if (reference) {
            assert.deepEqual(
              pixelAt(out, x, y),
              pixelAt(reference, x, y),
              `${profile.id} [${label} vs uninterrupted]: pixel (${x}, ${y})`,
            );
          }
          assert.deepEqual(
            pixelAt(out, x, y),
            expectedPixelFor(mode, x, y, glyphRef),
            `${profile.id} [${label}]: pixel (${x}, ${y})`,
          );
        }
      }
    };

    const steps: {
      name: string;
      act: () => void;
      statusBar: string | null;
      rows0to10: RowsMode;
      checkRow1Bottom: boolean;
      compareCheckpoints?: boolean;
    }[] = [
      {
        name: "cold start: displayBase is 0 and status.line.on/off follow profile gate",
        act: () => {
          engine.tick();
          assert.equal(engine.displayBase, 0, `${profile.id}: cold start displayBase`);
          engine.flags[201] = 1;
          engine.tick();
        },
        statusBar: null,
        rows0to10: gatedAtPicTop0 ? "unfilled" : "black",
        checkRow1Bottom: true,
      },
      {
        name: "configure.screen(0, 22, 2): status.line.on/off follow profile gate at picTop 0",
        act: () => {
          engine.flags[202] = 1;
          engine.tick();
          assert.equal(engine.displayBase, 0, `${profile.id}: configure.screen 0 displayBase`);
        },
        statusBar: null,
        rows0to10: gatedAtPicTop0 ? "unfilled" : "black",
        checkRow1Bottom: true,
      },
      {
        name: "configure.screen(2, 22, 2) + status.line.on: title bar renders on rows 0..10",
        act: () => {
          engine.flags[203] = 1;
          engine.tick();
          assert.equal(engine.displayBase, 2, `${profile.id}: configure.screen 2 displayBase`);
        },
        statusBar: expectedTitle,
        rows0to10: "title",
        checkRow1Bottom: true,
      },
      {
        name: "configure.screen(0, 22, 2): title visibility at picTop 0 follows profile gate",
        act: () => {
          engine.flags[204] = 1;
          engine.tick();
        },
        statusBar: gatedAtPicTop0 ? null : expectedTitle,
        rows0to10: gatedAtPicTop0 ? "unfilled" : "title",
        checkRow1Bottom: true,
      },
      {
        name: "configure.screen(2, 22, 2): statusBar returns when picTop is nonzero",
        act: () => {
          engine.flags[205] = 1;
          engine.tick();
          savedOn = engine.serialize();
        },
        statusBar: expectedTitle,
        rows0to10: "title",
        checkRow1Bottom: true,
      },
      {
        name: "status.line.off: blacks rows 0..10 while keeping row 1 bottom and status row 2",
        act: () => {
          engine.flags[206] = 1;
          engine.tick();
          assert.equal(
            engine.textRow(2).slice(0, 4),
            "KEEP",
            `${profile.id}: status row untouched`,
          );
        },
        statusBar: null,
        rows0to10: "black",
        checkRow1Bottom: true,
      },
      {
        name: "modal print open and close: closing modal keeps rows 0..10 black",
        act: () => {
          engine.flags[207] = 1;
          engine.tick();
          assert.equal(engine.modalKind, "print", `${profile.id}: print modal opened`);
          engine.ackPrint();
          assert.equal(engine.modalKind, null, `${profile.id}: print modal closed`);
        },
        statusBar: null,
        rows0to10: "black",
        checkRow1Bottom: true,
      },
      {
        name: "persistent window open and close: close.window keeps rows 0..10 black",
        act: () => {
          engine.flags[208] = 1;
          engine.tick();
          engine.flags[209] = 1;
          engine.tick();
          if (engine.modalKind === "print") engine.ackPrint();
        },
        statusBar: null,
        rows0to10: "black",
        checkRow1Bottom: true,
      },
      {
        name: "autosaveImage + restoreImage: preserves erased rows 0..10 and row 1 bottom",
        act: () => {
          const autosave = engine.autosaveImage();
          assert.ok(autosave, `${profile.id}: autosaveImage produced`);
          const decoded = decodeHostImage(autosave);
          const { titleFill: _dropFill, ...legacyPresentation } = decoded.presentation!;
          const legacyBytes = encodeHostImage(
            decoded.image,
            decoded.screen ?? [],
            legacyPresentation,
            decoded.continuation,
            decoded.amigaRegion,
          );
          const legacyEngine = makeEngine(keys);
          legacyEngine.restoreImage(legacyBytes);
          assert.equal(legacyEngine.getPresentation().statusBar, null);
          engine = makeEngine(keys);
          engine.restoreImage(autosave);
        },
        statusBar: null,
        rows0to10: "black",
        checkRow1Bottom: true,
      },
      {
        name: "recordingImage + restoreImage + restoreReplayState: preserves erased rows 0..10",
        act: () => {
          const rec = engine.recordingImage();
          assert.ok(rec, `${profile.id}: recordingImage produced`);
          const replay = engine.captureReplayState();
          engine = makeEngine(keys);
          engine.restoreImage(rec);
          engine.restoreReplayState(replay);
        },
        statusBar: null,
        rows0to10: "black",
        checkRow1Bottom: true,
      },
      {
        name: "overlay.pic green line (0,0)..(10,0) after display(1,0,MMMM) + status.line.off: paints green without resurrecting text, preserving y=11..15",
        act: () => {
          engine.flags[217] = 1;
          engine.tick();
        },
        statusBar: null,
        rows0to10: "overlayGreenLine0to10",
        checkRow1Bottom: true,
        compareCheckpoints: true,
      },
      {
        name: "draw.pic white picture after display(1,0,MMMM) + status.line.off: paints y=8..10 white without resurrecting text, preserving y=11..15",
        act: () => {
          engine.flags[218] = 1;
          engine.tick();
        },
        statusBar: null,
        rows0to10: "showPicTop1",
        checkRow1Bottom: true,
        compareCheckpoints: true,
      },
      {
        name: "show.pri.screen after display(1,0,MMMM) + status.line.off: paints y=8..10 priority without resurrecting text, preserving y=11..15",
        act: () => {
          engine.flags[219] = 1;
          engine.tick();
          assert.equal(engine.modalKind, "showPri", `${profile.id}: showPri modal open`);
          try {
            const priOut = composeEngine(engine);
            const glyphRef = glyphRefFor(engine.displayBase);
            assertRows0to10(priOut, "priScreenTop1", glyphRef, "show.pri.screen modal");
            for (let y = 11; y <= 15; y++) {
              for (let x = 0; x < 32; x++) {
                assert.deepEqual(
                  pixelAt(priOut, x, y),
                  pixelAt(glyphRef, x, y),
                  `${profile.id} [show.pri.screen modal]: row 1 bottom pixel (${x}, ${y})`,
                );
              }
            }
            const recBytes = engine.recordingImage(true);
            assert.ok(recBytes, `${profile.id}: recordingImage during showPri`);
            const replay = engine.captureReplayState();
            const restored = makeEngine(keys);
            restored.restoreImage(recBytes);
            restored.restoreReplayState(replay);
            assertRows0to10(
              composeEngine(restored),
              "priScreenTop1",
              glyphRef,
              "show.pri.screen recording restore",
              priOut,
            );
          } finally {
            engine.ackPrint();
          }
          assert.equal(engine.modalKind, null, `${profile.id}: showPri modal closed`);
        },
        statusBar: null,
        rows0to10: "showPicTop1",
        checkRow1Bottom: true,
        compareCheckpoints: true,
      },
      {
        name: "repeated status.line.off after show.pic: 2.31x returns early when already off; 2.082/2.176/2.202 repaint black",
        act: () => {
          engine.flags[220] = 1;
          engine.tick();
        },
        statusBar: null,
        rows0to10: offChecksEnabled ? "showPicTop1" : "black",
        checkRow1Bottom: false,
        compareCheckpoints: true,
      },
      {
        name: "show.pic after fill (picTop 1, white pic): supersedes y=8..10 while y=0..7 stays black, directly and after checkpoint restore",
        act: () => {
          engine.flags[211] = 1;
          engine.tick();
        },
        statusBar: null,
        rows0to10: "showPicTop1",
        checkRow1Bottom: false,
        compareCheckpoints: true,
      },
      {
        name: "configure.screen 2 then 0 around fill: rows 0..10 stay black before show.pic, directly and after checkpoint restore",
        act: () => {
          engine.flags[212] = 1;
          engine.tick();
        },
        statusBar: null,
        rows0to10: "black",
        checkRow1Bottom: false,
        compareCheckpoints: true,
      },
      {
        name: "configure.screen 2 then 0 around fill, then show.pic: uninterrupted and checkpoint-restored both paint rows 0..10 white",
        act: () => {
          const fromAutosave = cloneViaAutosave(engine);
          const fromRecording = cloneViaRecording(engine);
          engine.flags[213] = 1;
          engine.tick();
          fromAutosave.flags[213] = 1;
          fromAutosave.tick();
          fromRecording.flags[213] = 1;
          fromRecording.tick();
          const uninterruptedOut = composeEngine(engine);
          const glyphRef = glyphRefFor(engine.displayBase);
          assertRows0to10(
            composeEngine(fromAutosave),
            "white",
            glyphRef,
            "configure 2->0 autosave then show.pic",
            uninterruptedOut,
          );
          assertRows0to10(
            composeEngine(fromRecording),
            "white",
            glyphRef,
            "configure 2->0 recording then show.pic",
            uninterruptedOut,
          );
        },
        statusBar: null,
        rows0to10: "white",
        checkRow1Bottom: false,
        compareCheckpoints: true,
      },
      {
        name: "add.to.pic 1px blue cel at (0,0) after fill: paints (0,8)..(1,8) blue over fill, directly and after checkpoint restore",
        act: () => {
          engine.flags[214] = 1;
          engine.tick();
        },
        statusBar: null,
        rows0to10: "addToPicBlue00",
        checkRow1Bottom: false,
        compareCheckpoints: true,
      },
      {
        name: "further sprite draw and erase after checkpoint restore over add.to.pic and fill",
        act: () => {
          const fromAutosave = cloneViaAutosave(engine);
          const fromRecording = cloneViaRecording(engine);
          for (const eng of [engine, fromAutosave, fromRecording]) {
            eng.flags[215] = 1;
            eng.tick();
          }
          const drawnRef = composeEngine(engine);
          const glyphRef = glyphRefFor(engine.displayBase);
          assertRows0to10(drawnRef, "spriteBlue20", glyphRef, "sprite drawn uninterrupted");
          assertRows0to10(
            composeEngine(fromAutosave),
            "spriteBlue20",
            glyphRef,
            "sprite drawn after autosave restore",
            drawnRef,
          );
          assertRows0to10(
            composeEngine(fromRecording),
            "spriteBlue20",
            glyphRef,
            "sprite drawn after recording restore",
            drawnRef,
          );
          for (const eng of [engine, fromAutosave, fromRecording]) {
            eng.flags[216] = 1;
            eng.tick();
          }
          const erasedRef = composeEngine(engine);
          assertRows0to10(
            composeEngine(fromAutosave),
            "addToPicBlue00",
            glyphRef,
            "sprite erased after autosave restore",
            erasedRef,
          );
          assertRows0to10(
            composeEngine(fromRecording),
            "addToPicBlue00",
            glyphRef,
            "sprite erased after recording restore",
            erasedRef,
          );
        },
        statusBar: null,
        rows0to10: "addToPicBlue00",
        checkRow1Bottom: false,
        compareCheckpoints: true,
      },
      {
        name: "serialize + restoreImage (status off): statusBar stays null and rows 0..10 black",
        act: () => {
          engine.flags[203] = 1;
          engine.tick();
          engine.flags[206] = 1;
          engine.tick();
          const savedOff = engine.serialize();
          engine = makeEngine(keys);
          engine.restoreImage(savedOff);
        },
        statusBar: null,
        rows0to10: "black",
        checkRow1Bottom: false,
      },
      {
        name: "serialize + restoreImage (status on): restores title bar from saved picTop",
        act: () => {
          engine = makeEngine(keys);
          engine.restoreImage(savedOn!);
        },
        statusBar: expectedTitle,
        rows0to10: "title",
        checkRow1Bottom: false,
      },
      {
        name: "status.line.off after restoring status-on save: blacks rows 0..10",
        act: () => {
          engine.flags[206] = 1;
          engine.tick();
        },
        statusBar: null,
        rows0to10: "black",
        checkRow1Bottom: true,
      },
      {
        name: "restart.game: resets displayBaseRow to 0 and status.line.on/off follow profile gate",
        act: () => {
          keys.push(0x0d);
          engine.flags[210] = 1;
          engine.tick();
          assert.equal(engine.displayBase, 0, `${profile.id}: restart displayBase is 0`);
          engine.flags[201] = 1;
          engine.tick();
        },
        statusBar: null,
        rows0to10: gatedAtPicTop0 ? "unfilled" : "black",
        checkRow1Bottom: true,
      },
    ];

    for (const step of steps) {
      await t.test(`${profile.id}: ${step.name}`, () => {
        step.act();
        const pres = engine.getPresentation();
        assert.equal(pres.statusBar, step.statusBar, `${profile.id} [${step.name}]: statusBar`);
        const out = composeEngine(engine);
        const glyphRef = glyphRefFor(engine.displayBase);
        assertRows0to10(out, step.rows0to10, glyphRef, step.name);
        if (step.compareCheckpoints) {
          const autoOut = composeEngine(cloneViaAutosave(engine));
          const recOut = composeEngine(cloneViaRecording(engine));
          assertRows0to10(autoOut, step.rows0to10, glyphRef, `${step.name} (autosave)`, out);
          assertRows0to10(recOut, step.rows0to10, glyphRef, `${step.name} (recording)`, out);
        }
        if (step.checkRow1Bottom) {
          for (let y = 11; y <= 15; y++) {
            for (let x = 0; x < 32; x++) {
              assert.deepEqual(
                pixelAt(out, x, y),
                pixelAt(glyphRef, x, y),
                `${profile.id} [${step.name}]: row 1 bottom pixel (${x}, ${y})`,
              );
            }
          }
        }
      });
    }
  }
});

test("accepted restart.game preserves picture top on PC 2.936 and IIgs 1.014 while resetting Amiga to 0", async () => {
  const { Engine } = await import("../../src/runtime/engine.ts");
  const { createContainer } = await import("../../src/container/container.ts");
  const { assembleLogic } = await import("../../src/logic/assembler.ts");
  const { PROFILES } = await import("../../src/runtime/profile.ts");
  for (const [profileId, expectedAfterRestart] of [
    ["2.936", 2],
    ["iigs-1.014", 2],
    ["amiga-2.202", 0],
  ] as const) {
    const profile = PROFILES[profileId]!;
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `
        if (isset(f6)) { return; }
        if (!isset(f200)) {
          set(f200);
          configure.screen(2, 22, 2);
          return;
        }
        restart.game();
        return;
        `,
        { dictionary: new Map(), profile },
      ).payload,
    );
    const keys = [0x0d];
    const engine = new Engine(
      container,
      {
        print() {},
        displayAt() {},
        statusLine() {},
        takeInputLine: () => null,
        takeKeys: () => keys.splice(0, keys.length),
        waitKey: () => 0x0d,
      },
      new Map(),
      { profile },
    );
    engine.tick();
    assert.equal(engine.displayBase, 2, `${profileId}: configured displayBase is 2`);
    engine.tick();
    assert.equal(
      engine.displayBase,
      expectedAfterRestart,
      `${profileId}: displayBase after accepted restart.game`,
    );
  }
});
