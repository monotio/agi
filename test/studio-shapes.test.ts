import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { polygonScanlines, sceneSource, shapeSource } from "../src/studio/shapes.ts";

describe("studio shape compiler", () => {
  it("draws on the priority plane only when color is null", () => {
    assert.deepEqual(
      shapeSource({
        kind: "polygon",
        color: null,
        priority: 10,
        filled: false,
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 0, y: 4 },
        ],
      }),
      ["vis off", "pri 10", "polygon 0,0 4,0 0,4"],
    );
  });

  it("refuses a shape that draws on neither plane", () => {
    assert.throws(
      () =>
        shapeSource({
          kind: "rect",
          color: null,
          priority: null,
          filled: false,
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 1,
        }),
      /^Error: shape draws on neither plane$/,
    );
  });

  it("scanlines a triangle with the half-open edge rule", () => {
    // Edges (4,0)->(0,4) and (0,4)->(0,0) cross rows 0..3 at x=4-y and x=0;
    // the horizontal edge (0,0)->(4,0) never crosses; row 4 is excluded.
    assert.deepEqual(
      polygonScanlines([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 0, y: 4 },
      ]),
      ["line 0,0 4,0", "line 0,1 3,1", "line 0,2 2,2", "line 0,3 1,3"],
    );
  });

  it("lowers a filled rect to per-row lines", () => {
    assert.deepEqual(
      shapeSource({
        kind: "rect",
        color: 5,
        priority: null,
        filled: true,
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 3,
      }),
      ["vis 5", "pri off", "line 1,2 3,2", "line 1,3 3,3"],
    );
  });

  it("emits the background fill for an empty scene", () => {
    assert.equal(sceneSource(2, []), "vis 2\npri off\nfill 0,0\nend\n");
  });
});
