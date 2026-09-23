import assert from "node:assert/strict";
import { test } from "node:test";
import { nextViewportLayout } from "../src/viewportLayout.ts";

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
