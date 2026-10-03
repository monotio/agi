import assert from "node:assert/strict";
import { test } from "node:test";
import { CRT_GLOW_HEIGHT, CRT_GLOW_WIDTH, crtGlow } from "../src/three/crtGlow.ts";

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 200;

function frame(fill: number): Uint8Array {
  const rgba = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4).fill(fill);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return rgba;
}

function at(glow: Uint8Array, x: number, y: number): number[] {
  const i = (y * CRT_GLOW_WIDTH + x) * 4;
  return [glow[i]!, glow[i + 1]!, glow[i + 2]!, glow[i + 3]!];
}

test("the glow is a quarter-resolution image of the frame", () => {
  assert.equal(CRT_GLOW_WIDTH, 80);
  assert.equal(CRT_GLOW_HEIGHT, 50);
});

test("a uniform frame glows uniformly in linear light", () => {
  const out = new Uint8Array(CRT_GLOW_WIDTH * CRT_GLOW_HEIGHT * 4);
  crtGlow(frame(255), out);
  assert.deepEqual(at(out, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(at(out, 40, 25), [255, 255, 255, 255]);
  // sRGB 128 is linear ((128/255 + 0.055) / 1.055) ** 2.4 = 0.2159, stored as 55.
  crtGlow(frame(128), out);
  assert.deepEqual(at(out, 79, 49), [55, 55, 55, 255]);
});

test("one bright cell spreads by the binomial kernel on both axes", () => {
  const rgba = frame(0);
  // White 4x4 block: exactly glow cell (40, 25).
  for (let y = 100; y < 104; y++)
    for (let x = 160; x < 164; x++)
      rgba.fill(255, (y * FRAME_WIDTH + x) * 4, (y * FRAME_WIDTH + x) * 4 + 3);
  const out = new Uint8Array(CRT_GLOW_WIDTH * CRT_GLOW_HEIGHT * 4);
  crtGlow(rgba, out);
  // Two passes of [1 4 6 4 1]/16 make [1 8 28 56 70 56 28 8 1]/256 per axis.
  // Centre (70/256)^2 = 0.0748 -> 19; one cell over 56*70/256^2 = 0.0598 -> 15;
  // diagonal (56/256)^2 = 0.0479 -> 12; four cells over 1*70/256^2 -> 0.
  assert.deepEqual(at(out, 40, 25), [19, 19, 19, 255]);
  assert.deepEqual(at(out, 41, 25), [15, 15, 15, 255]);
  assert.deepEqual(at(out, 40, 24), [15, 15, 15, 255]);
  assert.deepEqual(at(out, 41, 26), [12, 12, 12, 255]);
  assert.deepEqual(at(out, 44, 25), [0, 0, 0, 255]);
});
