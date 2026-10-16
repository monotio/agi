import assert from "node:assert/strict";
import { test } from "node:test";
import { appearanceForProfile, pcDisplayChoices } from "../src/render/appearance.ts";
import { compositeFrame } from "../src/render/composite.ts";

test("adapter choices follow the build's shipped graphics drivers", () => {
  assert.ok(pcDisplayChoices("2.089").includes("cga-rgb"));
  assert.ok(!pcDisplayChoices("2.411").includes("mcga"));
  assert.ok(pcDisplayChoices("2.936").includes("mcga"));
  assert.deepEqual(pcDisplayChoices("amiga-2.202"), []);
});

test("CGA RGB paints the binary's two-pixel colour patterns and text colours", () => {
  const visual = new Uint8Array(160 * 168).fill(1);
  visual[1] = 2;
  visual[2] = 6;
  visual[160 + 2] = 6;
  const text = new Uint8Array(40 * 25 * 2);
  text[0] = 32;
  text[1] = 0xf0;
  const out = new Uint8Array(320 * 200 * 4);
  compositeFrame(
    { visual, text, picRow: 1, appearance: appearanceForProfile("2.936", null, "cga-rgb") },
    out,
  );
  const pixel = (x: number, y: number) => [
    ...out.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 4),
  ];
  assert.deepEqual(pixel(0, 8), [0, 0, 170, 255]);
  assert.deepEqual(pixel(1, 8), [0, 0, 170, 255]);
  assert.deepEqual(pixel(2, 8), [0, 170, 0, 255]);
  assert.deepEqual(pixel(3, 8), [0, 170, 0, 255]);
  assert.deepEqual(pixel(4, 8), [170, 85, 0, 255]);
  assert.deepEqual(pixel(5, 8), [170, 0, 0, 255]);
  assert.deepEqual(pixel(0, 0), [170, 85, 0, 255]);
  assert.deepEqual(pixel(4, 9), [170, 0, 0, 255]);
  assert.deepEqual(pixel(5, 9), [170, 85, 0, 255]);
  const ownership = new Uint16Array(160 * 168);
  ownership[1] = 1;
  compositeFrame(
    {
      visual,
      text,
      ownership,
      picRow: 1,
      appearance: appearanceForProfile("2.936", null, "cga-rgb"),
    },
    out,
  );
  assert.deepEqual(pixel(2, 8), [170, 85, 0, 255]);
  assert.deepEqual(pixel(3, 8), [0, 0, 170, 255]);
});

test("unavailable adapters fall back to the build's EGA display", () => {
  assert.equal(appearanceForProfile("2.089", null, "mcga"), appearanceForProfile("2.089"));
  assert.equal(appearanceForProfile("iigs-1.014", null, "cga-rgb").layout, "iigs");
});
