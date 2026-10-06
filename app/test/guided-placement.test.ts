import { test } from "node:test";
import assert from "node:assert/strict";
import { dockPicturePoint } from "../src/play/guidedPlacement.ts";

test("dock placement uses doubled picture pixels and the frame's text row", () => {
  assert.deepEqual(dockPicturePoint(260, 296, { left: 100, top: 80, width: 640, height: 400 }, 1), {
    x: 40,
    y: 100,
  });
  assert.deepEqual(dockPicturePoint(260, 328, { left: 100, top: 80, width: 640, height: 480 }, 3), {
    x: 40,
    y: 79,
  });
  assert.deepEqual(dockPicturePoint(-100, 900, { left: 0, top: 0, width: 320, height: 200 }, 1), {
    x: 0,
    y: 167,
  });
});
