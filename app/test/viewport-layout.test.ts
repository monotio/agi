import assert from "node:assert/strict";
import { test } from "node:test";
import { nextViewportLayout, stageScreenWidth } from "../src/viewportLayout.ts";

test("a keyboard shrinks the visible height but not the layout height", () => {
  const open = nextViewportLayout(nextViewportLayout(null, 390, 844), 390, 480);
  assert.deepEqual(open, { width: 390, height: 844, keyboard: true });
  const closed = nextViewportLayout(open, 390, 844);
  assert.deepEqual(closed, { width: 390, height: 844, keyboard: false });
});

test("browser chrome settling is not a keyboard, and the taller height wins", () => {
  const collapsed = nextViewportLayout(nextViewportLayout(null, 390, 780), 390, 844);
  assert.deepEqual(collapsed, { width: 390, height: 844, keyboard: false });
  assert.equal(nextViewportLayout(collapsed, 390, 790).keyboard, false);
});

test("a width change (rotation) starts over from the visible height", () => {
  const portrait = nextViewportLayout(null, 390, 844);
  assert.deepEqual(nextViewportLayout(portrait, 844, 390), {
    width: 844,
    height: 390,
    keyboard: false,
  });
});

test("the desktop stage takes the largest whole multiple of the 320-pixel frame", () => {
  // 1440×900 less a 52 px bar and a 48 px strip leaves 1440×800: exactly 4×.
  assert.equal(stageScreenWidth(1440, 800, 1.6), 1280);
  // One pixel short of 800 rows drops to 3×, never a fractional 3.99×.
  assert.equal(stageScreenWidth(1440, 799, 1.6), 960);
  // Width can bind too: a 1000 px column holds 3× (960), not 3.125×.
  assert.equal(stageScreenWidth(1000, 800, 1.6), 960);
});

test("Original 4:3 keeps the width a whole multiple and needs 240 rows per step", () => {
  // 4× at 4:3 is 1280×960; 800 rows hold 3× (960×720).
  assert.equal(stageScreenWidth(1440, 800, 4 / 3), 960);
  assert.equal(stageScreenWidth(1440, 960, 4 / 3), 1280);
});

test("a stage too small for 2× fits fluidly instead of shrinking to 1×", () => {
  assert.equal(stageScreenWidth(600, 800, 1.6), 600);
  assert.equal(stageScreenWidth(900, 300, 1.6), 480);
  assert.equal(stageScreenWidth(-10, 400, 1.6), 0);
});
