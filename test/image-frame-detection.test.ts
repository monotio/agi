import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectImageBackground,
  scaleImageFrame,
  suggestImageFrames,
  prepareImageCels,
} from "../src/creative/imageOperations.ts";
import {
  resizeLinkedFrameBoxes,
  toggleFrameLink,
  type FrameBox,
} from "../src/creative/imageFrameGeometry.ts";
import { PROFILES } from "../src/runtime/profile.ts";

function sheet(transparent = false) {
  const width = 100,
    height = 60;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([255, 255, 255, transparent ? 0 : 255], i * 4);
  const regions = [
    { x: 3, y: 5, width: 6, height: 24 },
    { x: 22, y: 7, width: 8, height: 24 },
    { x: 49, y: 3, width: 6, height: 24 },
    { x: 85, y: 10, width: 8, height: 24 },
  ];
  for (const r of regions)
    for (let y = r.y; y < r.y + r.height; y++)
      for (let x = r.x; x < r.x + r.width; x++) rgba.set([170, 0, 0, 255], (y * width + x) * 4);
  return {
    title: "Walk",
    mime: "image/png",
    encoded: new Uint8Array([1]),
    width,
    height,
    rgba,
    regions,
  };
}
for (const transparent of [false, true]) {
  test(`${transparent ? "transparent" : "white"} sheets find tight figures across uneven gaps`, () => {
    const image = sheet(transparent);
    assert.deepEqual(detectImageBackground(image), transparent ? null : [255, 255, 255]);
    assert.deepEqual(
      suggestImageFrames(image).map((f) => f.region),
      image.regions,
    );
  });
}
test("row gaps separate figures and one figure keeps its tight box", () => {
  const image = sheet();
  image.rgba.fill(255);
  for (const y of [4, 35])
    for (let dy = 0; dy < 12; dy++)
      for (let x = 10; x < 18; x++) image.rgba.set([0, 170, 0, 255], ((y + dy) * 100 + x) * 4);
  assert.deepEqual(
    suggestImageFrames(image).map((f) => f.region),
    [4, 35].map((y) => ({ x: 10, y, width: 8, height: 12 })),
  );
  image.rgba.fill(255, 35 * 100 * 4);
  assert.deepEqual(
    suggestImageFrames(image).map((f) => f.region),
    [{ x: 10, y: 4, width: 8, height: 12 }],
  );
});
test("scale follows the figure aspect and the native VIEW limits", () => {
  assert.deepEqual(scaleImageFrame({ x: 0, y: 0, width: 120, height: 480 }, 24), {
    width: 6,
    height: 24,
  });
  assert.deepEqual(scaleImageFrame({ x: 0, y: 0, width: 480, height: 120 }, 100), {
    width: 160,
    height: 40,
  });
  const image = sheet();
  const frames = suggestImageFrames(image).map((f) => ({ ...f, ...scaleImageFrame(f.region, 24) }));
  const cels = prepareImageCels(image, frames, PROFILES["2.936"]).input.loops[0]!.cels!;
  assert.deepEqual(
    cels.map((c) => [c.width, c.height, c.transparentColor]),
    [
      [6, 24, 15],
      [8, 24, 15],
      [6, 24, 15],
      [8, 24, 15],
    ],
  );
  assert.deepEqual(Array.from(cels[0]!.pixels), new Array(144).fill(4));
});
test("linked edges keep each figure offset, unlink separately and relink to shared size", () => {
  const boxes: FrameBox[] = [3, 22, 49, 85].map((x, i) => ({
    id: String(i),
    edited: false,
    linked: true,
    region: { x, y: 5, width: 6, height: 24 },
    width: 6,
    height: 24,
    loop: 0,
  }));
  const resized = resizeLinkedFrameBoxes(boxes, "0", "nw", -2, -1, sheet());
  assert.deepEqual(
    resized.map((f) => f.region),
    [3, 22, 49, 85].map((x) => ({ x: x - 2, y: 4, width: 8, height: 25 })),
  );
  const separate = toggleFrameLink(resized, "1", sheet());
  const next = resizeLinkedFrameBoxes(separate, "0", "e", 2, 0, sheet());
  assert.deepEqual(
    next.map((f) => f.region.width),
    [10, 8, 10, 10],
  );
  const alone = resizeLinkedFrameBoxes(next, "1", "s", 0, 2, sheet());
  assert.deepEqual(
    alone.map((f) => f.region.height),
    [25, 27, 25, 25],
  );
  const joined = toggleFrameLink(alone, "1", sheet());
  assert.deepEqual(
    joined.map((f) => [f.region.width, f.region.height, f.linked]),
    Array.from({ length: 4 }, () => [10, 25, true]),
  );
  // The rightmost box limits the whole set; no individual crop silently shifts or shrinks.
  const bounded = resizeLinkedFrameBoxes(joined, "0", "e", 99, 0, sheet());
  assert.deepEqual(
    bounded.map((f) => f.region.width),
    [17, 17, 17, 17],
  );
  assert.deepEqual(
    bounded.map((f) => f.region.x),
    [1, 20, 47, 83],
  );
});

test("connected figures stay separate when their row and column projections overlap", () => {
  const image = { width: 12, height: 12, rgba: new Uint8Array(12 * 12 * 4).fill(255) };
  const paint = (x: number, y: number) => image.rgba.set([170, 0, 0, 255], (y * 12 + x) * 4);
  for (let i = 2; i <= 8; i++) {
    paint(i, 2);
    paint(2, i);
  }
  for (let i = 5; i <= 10; i++) {
    paint(10, i);
    paint(i, 10);
  }
  assert.deepEqual(
    suggestImageFrames(image).map((f) => f.region),
    [
      { x: 2, y: 2, width: 7, height: 7 },
      { x: 5, y: 5, width: 6, height: 6 },
    ],
  );
});
