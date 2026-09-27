import assert from "node:assert/strict";
import { test } from "node:test";
import { nextViewportLayout, stageScreenWidth } from "../src/play/viewportLayout.ts";

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
  // Width can bind too: a 1000 px column holds 3× (960), which fills 92% of
  // the 1000 px fit's area, not 3.125×.
  assert.equal(stageScreenWidth(1000, 800, 1.6), 960);
  // Create's 706×668 centre column at 1366×768: 2× fills (640/706)² = 82%.
  assert.equal(stageScreenWidth(706, 668, 1.6), 640);
});

test("a whole step that leaves most of the stage empty gives way to the largest fit", () => {
  // Create's centre column at 1440×900 is 780×800: 2× (640) would fill only
  // (640/780)² = 67% of what fits, so the screen takes the column's width.
  assert.equal(stageScreenWidth(780, 800, 1.6), 780);
  // 1600×900 (940×800) and 1920×1080 (1260×980) likewise.
  assert.equal(stageScreenWidth(940, 800, 1.6), 940);
  assert.equal(stageScreenWidth(1260, 980, 1.6), 1260);
  // One row short of 4×: 3× would fill (960/1278)² = 56%, so 1278 wide.
  assert.equal(stageScreenWidth(1440, 799, 1.6), 1278);
  // 800×600 leaves 800×500: 800, not 2× (640).
  assert.equal(stageScreenWidth(800, 500, 1.6), 800);
});

test("Original 4:3 keeps the width a whole multiple and needs 240 rows per step", () => {
  // 4× at 4:3 is 1280×960; 800 rows hold 3× (960×720), which fills
  // (960/1066)² = 81% of the 1066-wide fit.
  assert.equal(stageScreenWidth(1440, 800, 4 / 3), 960);
  assert.equal(stageScreenWidth(1440, 960, 4 / 3), 1280);
  // Create's 780×800 column: 2× (640) fills 67% of the 780-wide fit.
  assert.equal(stageScreenWidth(780, 800, 4 / 3), 780);
});

test("a stage too small for 2× fits fluidly instead of shrinking to 1×", () => {
  assert.equal(stageScreenWidth(600, 800, 1.6), 600);
  assert.equal(stageScreenWidth(900, 300, 1.6), 480);
  assert.equal(stageScreenWidth(-10, 400, 1.6), 0);
  assert.equal(stageScreenWidth(400, -10, 1.6), 0);
});
