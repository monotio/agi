import assert from "node:assert/strict";
import { test } from "node:test";
import { displayAspect, computeStageFit } from "../src/play/viewportLayout.ts";

test("monitor shape uses 5:6 NTSC pixels and 16:15 PAL Amiga pixels", () => {
  assert.equal(displayAspect("2.936", "ntsc", true), 4 / 3);
  assert.equal(displayAspect("iigs-1.014", "ntsc", true), 4 / 3);
  assert.equal(displayAspect("amiga-2.202", "ntsc", true), 4 / 3);
  assert.equal(displayAspect("amiga-2.202", "pal", true), 128 / 75);
  assert.equal(displayAspect("2.936", "pal", true), 4 / 3);
  assert.equal(displayAspect("amiga-2.202", "pal", false), 8 / 5);
});

test("the phone fit reserves space for touch controls at either pixel shape", () => {
  for (const ratio of [4 / 3, 8 / 5, 128 / 75]) {
    const fit = computeStageFit(390 - 32, 844 - 340, ratio);
    assert.equal(fit.width, 358);
    assert.ok(fit.height <= 269);
    assert.ok(fit.width / fit.height >= ratio);
  }
  assert.deepEqual(computeStageFit(1000, 300, 4 / 3), { width: 400, height: 300 });
  assert.deepEqual(computeStageFit(-1, 300, 4 / 3), { width: 0, height: 0 });
});
