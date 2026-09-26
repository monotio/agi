import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitZoom, toLogical, toScreen, type Viewport } from "../src/studio/viewport.ts";

// One logical pixel is 2*3 = 6 screen pixels wide and 3 tall, logical 0,0 at 10,5.
const view: Viewport = { zoom: 3, pixelAspect: 2, offsetX: 10, offsetY: 5 };

describe("studio viewport", () => {
  it("maps logical cells to their top-left screen pixel", () => {
    assert.deepEqual(toScreen(view, 0, 0), { x: 10, y: 5 });
    assert.deepEqual(toScreen(view, 159, 167), { x: 10 + 159 * 6, y: 5 + 167 * 3 });
    assert.deepEqual(toScreen(view, 1.7, 2.2), { x: 16, y: 11 });
    assert.equal(toScreen(view, 160, 0), null);
    assert.equal(toScreen(view, 0, 168), null);
    assert.equal(toScreen(view, -0.5, 0), null);
  });

  it("maps screen points to the logical cell under them", () => {
    assert.deepEqual(toLogical(view, 10, 5), { x: 0, y: 0 });
    assert.deepEqual(toLogical(view, 15, 7), { x: 0, y: 0 });
    assert.deepEqual(toLogical(view, 16, 8), { x: 1, y: 1 });
    // Last screen pixel of cell 159,167: 964+5, 506+2.
    assert.deepEqual(toLogical(view, 969, 508), { x: 159, y: 167 });
    assert.equal(toLogical(view, 970, 508), null);
    assert.equal(toLogical(view, 969, 509), null);
    assert.equal(toLogical(view, 9, 5), null);
    assert.equal(toLogical(view, 10, 4), null);
  });

  it("clamps off-surface points to the nearest edge cell on request", () => {
    assert.deepEqual(toLogical(view, 970, 600, { clamp: true }), { x: 159, y: 167 });
    assert.deepEqual(toLogical(view, 0, 0, { clamp: true }), { x: 0, y: 0 });
    assert.deepEqual(toLogical(view, 40, -30, { clamp: true }), { x: 5, y: 0 });
  });

  it("fits the largest integer zoom, never below 1", () => {
    assert.equal(fitZoom(320, 168), 1);
    assert.equal(fitZoom(959, 503), 2);
    assert.equal(fitZoom(960, 504), 3);
    assert.equal(fitZoom(1000, 200), 1);
    assert.equal(fitZoom(100, 100), 1);
  });
});
