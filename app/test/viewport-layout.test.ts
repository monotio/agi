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

test("the desktop stage fills the available width or height at the selected aspect", () => {
  assert.equal(stageScreenWidth(1440, 800, 1.6), 1280);
  assert.equal(stageScreenWidth(1000, 800, 1.6), 1000);
  assert.equal(stageScreenWidth(706, 668, 1.6), 706);
  assert.equal(stageScreenWidth(780, 800, 1.6), 780);
  assert.equal(stageScreenWidth(1440, 799, 1.6), 1278);
  assert.equal(stageScreenWidth(1440, 800, 4 / 3), 1066);
  assert.equal(stageScreenWidth(1440, 960, 4 / 3), 1280);
  assert.equal(stageScreenWidth(780, 800, 4 / 3), 780);
});

test("a stage too small for 2× fits fluidly instead of shrinking to 1×", () => {
  assert.equal(stageScreenWidth(600, 800, 1.6), 600);
  assert.equal(stageScreenWidth(900, 300, 1.6), 480);
  assert.equal(stageScreenWidth(-10, 400, 1.6), 0);
  assert.equal(stageScreenWidth(400, -10, 1.6), 0);
});
