import assert from "node:assert/strict";
import { test } from "node:test";
import { amigaPointerRgba, amigaPointerSize } from "../src/play/amigaPointer.ts";

// The Amiga pointer follows the screen's pixel size in each direction
// (docs/fidelity.md "Amiga screen, font and pointer"): a 640×480 screen shows
// frame pixels 2 wide and 2.4 high, so the 16×16 sprite is about 32×38 with
// its hot spot one sprite pixel in, and nothing is rounded before scaling.
test("the pointer image and hot spot scale with the screen's horizontal and vertical pixel size", () => {
  assert.deepEqual(amigaPointerSize(2, 2.4), { width: 32, height: 38, hotX: 2, hotY: 0 });
  assert.deepEqual(amigaPointerSize(3.32, 3.32), { width: 53, height: 53, hotX: 3, hotY: 0 });
  assert.deepEqual(amigaPointerSize(4, 4), { width: 64, height: 64, hotX: 4, hotY: 0 });
  assert.deepEqual(amigaPointerSize(20, 20), { width: 128, height: 128, hotX: 8, hotY: 0 });
  const rgba = amigaPointerRgba(32, 38);
  assert.equal(rgba.length, 32 * 38 * 4);
  // The tip (sprite pixel 0,0) is red at the image's top-left; the cell right
  // of the hot spot column on the top row is the black edge.
  assert.deepEqual([...rgba.subarray(0, 4)], [0xdd, 0x22, 0x22, 255]);
  assert.deepEqual([...rgba.subarray(2 * 4, 2 * 4 + 4)], [0, 0, 0, 255]);
  // Row 19 of 38 samples sprite row 8, whose 10th pixel is the black edge.
  const o = (19 * 32 + 19) * 4;
  assert.deepEqual([...rgba.subarray(o, o + 4)], [0, 0, 0, 255]);
});
