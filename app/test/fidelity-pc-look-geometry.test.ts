import assert from "node:assert/strict";
import { test } from "node:test";
import { displayAspect } from "../src/play/viewportLayout.ts";

test("monitor shape uses 5:6 NTSC pixels and 16:15 PAL Amiga pixels", () => {
  assert.equal(displayAspect("2.936", "ntsc", true), 4 / 3);
  assert.equal(displayAspect("iigs-1.014", "ntsc", true), 4 / 3);
  assert.equal(displayAspect("amiga-2.202", "ntsc", true), 4 / 3);
  assert.equal(displayAspect("amiga-2.202", "pal", true), 128 / 75);
  assert.equal(displayAspect("2.936", "pal", true), 4 / 3);
  assert.equal(displayAspect("amiga-2.202", "pal", false), 8 / 5);
});
