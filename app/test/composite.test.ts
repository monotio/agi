import assert from "node:assert/strict";
import { test } from "node:test";
import { compositeFrame, FRAME_HEIGHT, FRAME_WIDTH } from "../src/composite.ts";
import { EGA_PALETTE } from "../src/palette.ts";

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
