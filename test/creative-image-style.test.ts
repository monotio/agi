import { test } from "node:test";
import assert from "node:assert/strict";
import {
  imageStylePrompt,
  SIERRA_IMAGE_STYLE,
  scoreImageStyle,
  snapImageToEga,
} from "../src/creative/imageStyle.ts";
test("PICTURE and VIEW prompts wrap intent in their Sierra EGA instructions", () => {
  assert.equal(
    imageStylePrompt("picture", "A forest"),
    `${SIERRA_IMAGE_STYLE.picture}\n\nDraw this: A forest`,
  );
  assert.equal(imageStylePrompt("view", "A fox", false), "A fox");
  assert.match(SIERRA_IMAGE_STYLE.view, /transparent/);
});
test("cheap image scores distinguish clean flat EGA shapes from off-palette speckles", () => {
  const flat = new Uint8Array(4 * 4 * 4);
  for (let p = 0; p < 16; p++) flat.set([170, 0, 0, 255], p * 4);
  const clean = scoreImageStyle(4, 4, flat);
  assert.equal(clean.egaDistance, 0);
  assert.equal(clean.flatRegions, 1);
  assert.equal(clean.traceCleanliness, 1);
  flat.set([0, 0, 150, 255], 5 * 4);
  const noisy = scoreImageStyle(4, 4, flat);
  assert.ok(noisy.egaDistance > 0);
  assert.equal(noisy.flatRegions, 2);
  assert.ok(noisy.traceCleanliness < clean.traceCleanliness);
});

test("tracing snaps colours to EGA while preserving the original and transparency", () => {
  const original = Uint8Array.of(255, 0, 0, 255, 13, 27, 39, 0);
  assert.deepEqual(snapImageToEga(original), Uint8Array.of(170, 0, 0, 255, 13, 27, 39, 0));
  assert.deepEqual(original, Uint8Array.of(255, 0, 0, 255, 13, 27, 39, 0));
});
