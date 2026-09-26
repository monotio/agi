import assert from "node:assert/strict";
import { test } from "node:test";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../src/types.ts";
import type { TimelineEntry } from "../../src/studio/pictureQuery.ts";
import {
  bandGuides,
  controlLabels,
  maskBox,
  maskFillPath,
  maskOutlinePath,
  paintLayer,
  panesFor,
  spanIndexAt,
  tickFor,
} from "../src/studio/studioView.ts";
import { paneFitZoom } from "../src/studio/useStudioViewport.ts";

const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;
const at = (x: number, y: number): number => y * SCREEN_WIDTH + x;
const rgb = (out: Uint8ClampedArray, x: number, y: number): number[] => {
  const o = at(x, y) * 4;
  return [out[o]!, out[o + 1]!, out[o + 2]!, out[o + 3]!];
};

function planes(): { visual: Uint8Array; priority: Uint8Array; out: Uint8ClampedArray } {
  return {
    visual: new Uint8Array(CELLS).fill(15),
    priority: new Uint8Array(CELLS).fill(4),
    out: new Uint8ClampedArray(CELLS * 4),
  };
}

test("the Art pane is the visual plane in EGA colours", () => {
  const { visual, priority, out } = planes();
  visual[at(3, 2)] = 6;
  priority[at(3, 2)] = 10;
  paintLayer("art", visual, priority, out);
  assert.deepEqual(rgb(out, 3, 2), [0xaa, 0x55, 0x00, 255]);
  assert.deepEqual(rgb(out, 0, 0), [0xff, 0xff, 0xff, 255]);
});

test("Depth blends priority 5-15 half over the art and leaves background 4 alone", () => {
  const { visual, priority, out } = planes();
  priority[at(1, 0)] = 10; // EGA 10 is 55,ff,55; halfway from ff,ff,ff is aa,ff,aa
  paintLayer("depth", visual, priority, out);
  assert.deepEqual(rgb(out, 1, 0), [170, 255, 170, 255]);
  assert.deepEqual(rgb(out, 0, 0), [255, 255, 255, 255]);

  paintLayer("depth-only", visual, priority, out);
  assert.deepEqual(rgb(out, 1, 0), [0x55, 0xff, 0x55, 255]);
  assert.deepEqual(rgb(out, 0, 0), [0, 0, 0, 255]);
});

test("Walk dims the art and paints control values in their colour and pattern", () => {
  const { visual, priority, out } = planes();
  priority[at(0, 0)] = 0; // barrier: solid EGA 12
  priority[at(1, 0)] = 1; // conditional: dashed, (1+0)%2 is off, EGA 14 faded 0.55 to black
  priority[at(2, 0)] = 1; // (2+0)%2 is on
  paintLayer("walk", visual, priority, out);
  assert.deepEqual(rgb(out, 0, 0), [0xff, 0x55, 0x55, 255]);
  assert.deepEqual(rgb(out, 1, 0), [115, 115, 38, 255]);
  assert.deepEqual(rgb(out, 2, 0), [0xff, 0xff, 0x55, 255]);
  // Art white faded 0.7 toward black: 255 * 0.3 = 76.5, rounded up.
  assert.deepEqual(rgb(out, 5, 5), [77, 77, 77, 255]);
});

test("panes follow the lens and view mode", () => {
  assert.deepEqual(panesFor("art", "split"), ["art"]);
  assert.deepEqual(panesFor("depth", "blend"), ["depth"]);
  assert.deepEqual(panesFor("depth", "split"), ["art", "depth-only"]);
  assert.deepEqual(panesFor("walk", "priority"), ["walk-only"]);
});

test("mask geometry: box, row runs and the traced outline", () => {
  const mask = new Uint8Array(CELLS);
  mask[at(2, 3)] = 1;
  mask[at(3, 3)] = 1;
  mask[at(3, 4)] = 1;
  assert.deepEqual(maskBox(mask), { x: 2, y: 3, width: 2, height: 2 });
  assert.equal(maskFillPath(mask), "M2 3h2v1h-2zM3 4h1v1h-1z");
  assert.equal(maskOutlinePath(mask), "M2 3h2M2 4h1M3 5h1M2 3v1M3 4v1M4 3v2");
  assert.equal(maskBox(new Uint8Array(CELLS)), null);
});

test("band guides start each baseline priority band", () => {
  assert.deepEqual(
    bandGuides(),
    [48, 60, 72, 84, 96, 108, 120, 132, 144, 156].map((y, i) => ({ y, band: 5 + i })),
  );
  // Base 60: band 6 starts where (y - 60) * 10 / 108 reaches 1, at y 70.8 -> 71.
  assert.deepEqual(bandGuides(60).slice(0, 2), [
    { y: 60, band: 5 },
    { y: 71, band: 6 },
  ]);
});

test("ticks: state lines short and neutral, fills tall, colour from the drawing state", () => {
  const entry = (op: string, visual: number | null, priority: number | null): TimelineEntry => ({
    line: 1,
    op,
    visual,
    priority,
  });
  assert.deepEqual(tickFor(entry("vis", 6, null)), { kind: "state", colour: null });
  assert.deepEqual(tickFor(entry("end", 6, null)), { kind: "state", colour: null });
  assert.deepEqual(tickFor(entry("fill", 6, 10)), { kind: "fill", colour: 6 });
  assert.deepEqual(tickFor(entry("line", null, 10)), { kind: "draw", colour: 10 });
  // A barrier line takes the Walk lens barrier colour, EGA 12.
  assert.deepEqual(tickFor(entry("line", null, 0)), { kind: "draw", colour: 12 });
});

test("control labels: one per run of at least four cells, at the run's middle cell", () => {
  const priority = new Uint8Array(CELLS).fill(4);
  for (let x = 10; x <= 14; x++) priority[at(x, 10)] = 0;
  for (let x = 30; x <= 32; x++) priority[at(x, 20)] = 2;
  assert.deepEqual(controlLabels(priority), [{ value: 0, x: 12, y: 10, cells: 5 }]);
});

test("spanIndexAt finds the span holding a byte offset", () => {
  const spans = [
    { line: 1, start: 0, end: 2 },
    { line: 2, start: 2, end: 7 },
    { line: 4, start: 7, end: 8 },
  ];
  assert.equal(spanIndexAt(spans, 0), 0);
  assert.equal(spanIndexAt(spans, 6), 1);
  assert.equal(spanIndexAt(spans, 7), 2);
  assert.equal(spanIndexAt(spans, 8), -1);
});

test("the fit zoom is the largest integer zoom at which every pane fits the stage", () => {
  // 884x728 stage less a 24px inset: min(floor(836 / 320), floor(680 / 168)) = 2.
  assert.equal(paneFitZoom(884, 728, 1), 2);
  // Split: (836 - 16) / 2 = 410 wide per pane -> 1.
  assert.equal(paneFitZoom(884, 728, 2), 1);
  // 1000 - 48 = 952 wide: 2, where ignoring the inset would give 3.
  assert.equal(paneFitZoom(1000, 728, 1), 2);
  // (1328 - 48 - 16) / 2 = 632 per pane: 1, where ignoring the gap would give 640 -> 2.
  assert.equal(paneFitZoom(1328, 728, 2), 1);
  assert.equal(paneFitZoom(1968, 1100, 1), 6);
  assert.equal(paneFitZoom(0, 0, 1), 1);
});
