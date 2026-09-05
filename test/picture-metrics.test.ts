import assert from "node:assert/strict";
import { test } from "node:test";
import {
  comparePictureMetrics,
  computePictureMetrics,
  histogramDistance,
} from "../src/picture/metrics.ts";

const close = (a: number, b: number, msg?: string): void => {
  assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} expected ${b}, got ${a}`);
};

test("metrics on a hand-computed 4x3 buffer", () => {
  // Visual (4 wide, 3 tall):
  //   15 15  1  1
  //   15  2  2  1
  //    2  2  2  1
  const visual = new Uint8Array([15, 15, 1, 1, 15, 2, 2, 1, 2, 2, 2, 1]);
  // Priority: top row far (4), then 5, then a control line 0 in the corner.
  const priority = new Uint8Array([4, 4, 4, 4, 5, 5, 5, 5, 0, 5, 5, 5]);
  const m = computePictureMetrics(
    { visual, priority },
    { width: 4, height: 3, horizon: 1, commandCount: 7 },
  );

  close(m.fillCoverage, 9 / 12, "fillCoverage");
  close(m.paletteHistogram[15]!, 3 / 12);
  close(m.paletteHistogram[1]!, 4 / 12);
  close(m.paletteHistogram[2]!, 5 / 12);
  assert.equal(m.distinctColors, 3);
  // Horizontal pairs (3 per row, 9 total): row0: 15-15 same, 15-1 diff, 1-1 same -> 1
  //   row1: 15-2 diff, 2-2 same, 2-1 diff -> 2 ; row2: 2-2, 2-2 same, 2-1 diff -> 1  => 4
  // Vertical pairs (4 per column pair of rows, 8 total): rows0-1: 15/15 s, 15/2 d, 1/2 d, 1/1 s -> 2
  //   rows1-2: 15/2 d, 2/2 s, 2/2 s, 1/1 s -> 1 => 3.  Transitions 7 of 17 pairs.
  close(m.edgeDensity, 7 / 17, "edgeDensity");
  // Regions: white top-left (3 cells connected: (0,0),(1,0),(0,1)), colour-1 strip, colour-2 blob = 3.
  assert.equal(m.regionCount, 3);
  close(m.priorityBandFraction, 11 / 12);
  assert.equal(m.priorityBands, 2); // 4 and 5
  close(m.priorityHorizonSanity, 1); // all 4 cells above horizon row 1 are band 4
  close(m.walkableFraction, 7 / 8); // 8 cells below horizon, one is control 0
  assert.equal(m.commandCount, 7);
});

test("region count separates diagonal-only touching cells", () => {
  // 1 0 / 0 1 : two colour-1 regions and two colour-0 regions (4-connectivity).
  const visual = new Uint8Array([1, 0, 0, 1]);
  const priority = new Uint8Array(4).fill(4);
  const m = computePictureMetrics({ visual, priority }, { width: 2, height: 2, horizon: 0 });
  assert.equal(m.regionCount, 4);
  close(m.priorityHorizonSanity, 1); // no cells above horizon 0 -> defined as 1
  close(m.walkableFraction, 1);
});

test("histogram distance and comparison deltas", () => {
  const a = new Array(16).fill(0);
  const b = new Array(16).fill(0);
  a[1] = 1; // all blue
  b[1] = 0.5;
  b[2] = 0.5;
  close(histogramDistance(a, b), 0.5);
  close(histogramDistance(a, a), 0);

  const ref = computePictureMetrics(
    { visual: new Uint8Array([1, 1, 1, 1]), priority: new Uint8Array([4, 4, 5, 5]) },
    { width: 2, height: 2, horizon: 1, commandCount: 10 },
  );
  const cand = computePictureMetrics(
    { visual: new Uint8Array([1, 15, 2, 15]), priority: new Uint8Array([4, 4, 4, 4]) },
    { width: 2, height: 2, horizon: 1, commandCount: 4 },
  );
  const cmp = comparePictureMetrics(ref, cand, {
    reference: { visual: new Uint8Array([1, 1, 1, 1]) },
    candidate: { visual: new Uint8Array([1, 15, 2, 15]) },
  });
  close(cmp.deltas["fillCoverage"]!, 0.5 - 1);
  assert.equal(cmp.deltas["distinctColors"], 2);
  assert.equal(cmp.deltas["commandCount"], -6);
  assert.equal(cmp.deltas["priorityBands"], -1);
  close(cmp.pixelAgreement, 1 / 4);
  // ref histogram: colour1 = 1. cand: 1 -> .25, 15 -> .5, 2 -> .25. TV = (|1-.25| + .5 + .25)/2 = .75
  close(cmp.histogramDistance, 0.75);
});
