import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { itemHandles, linePoints, nearestInsertion } from "../src/studio/editPoints.ts";
import { setLinePoint } from "../src/studio/editSource.ts";
import { parsePictureDocument } from "../src/studio/pictureDocument.ts";

/** Hand-read vertices of each command, in operand order. */
const CASES: readonly [string, readonly [number, number][]][] = [
  [
    "line 10,10 20,10  # top",
    [
      [10, 10],
      [20, 10],
    ],
  ],
  [
    "polygon 1,2 3,4 5,6",
    [
      [1, 2],
      [3, 4],
      [5, 6],
    ],
  ],
  [
    "rect 40,90 119,105",
    [
      [40, 90],
      [119, 105],
    ],
  ],
  [
    "rel 30,30 2,-1 -3,4",
    [
      [30, 30],
      [32, 29],
      [29, 33],
    ],
  ],
  [
    "xcorner 40,40 45 50 42",
    [
      [40, 40],
      [45, 40],
      [45, 50],
      [42, 50],
    ],
  ],
  [
    "ycorner 60,60 65 62",
    [
      [60, 60],
      [60, 65],
      [62, 65],
    ],
  ],
  [
    "fill 12,12 13,13",
    [
      [12, 12],
      [13, 13],
    ],
  ],
  [
    "plot 17 5,5 6,6",
    [
      [5, 5],
      [6, 6],
    ],
  ],
];

describe("linePoints", () => {
  it("reads every vertex in operand order", () => {
    for (const [line, expected] of CASES)
      assert.deepEqual(
        linePoints(line),
        expected.map(([x, y]) => ({ x, y })),
        line,
      );
  });

  it("numbers points as setLinePoint does: moving point k moves exactly point k there", () => {
    for (const [line] of CASES) {
      const points = linePoints(line);
      points.forEach((point, k) => {
        assert.equal(setLinePoint(line, 1, k, point.x, point.y), line, `${line} #${k} in place`);
        const target = { x: point.x + 1, y: point.y + 1 };
        const moved = linePoints(setLinePoint(line, 1, k, target.x, target.y));
        assert.deepEqual(moved[k], target, `${line} #${k}`);
      });
    }
  });

  it("has no points for state, copy and raw lines", () => {
    for (const line of ["vis 4", "pri off", "pen 1", "copy 2-4", "raw 250 1 2", "# note", "end"])
      assert.deepEqual(linePoints(line), [], line);
  });
});

describe("itemHandles", () => {
  it("lists an item's points with their line, index and kind", () => {
    const { document } = parsePictureDocument(
      [
        "vis 2", //                     1
        '# @item a "A" depth', //      2
        "pri 10", //                    3
        "polygon 40,90 60,90 50,99", // 4
        "fill 50,94", //                5
        "# @end", //                    6
        "end", //                       7
      ].join("\n"),
    );
    assert.deepEqual(itemHandles(document, "a"), [
      { x: 40, y: 90, line: 4, index: 0, kind: "vertex" },
      { x: 60, y: 90, line: 4, index: 1, kind: "vertex" },
      { x: 50, y: 99, line: 4, index: 2, kind: "vertex" },
      { x: 50, y: 94, line: 5, index: 0, kind: "seed" },
    ]);
    assert.deepEqual(itemHandles(document, "missing"), []);
  });
});

describe("nearestInsertion", () => {
  const { document } = parsePictureDocument(
    [
      '# @item a "A" depth', //       1
      "pri 10", //                    2
      "polygon 40,90 60,90 50,99", // 3
      "fill 50,94", //                4
      "# @end", //                    5
      '# @item s "S" art', //         6
      "vis 1", //                     7
      "line 10,10 11,11", //          8
      "xcorner 20,20 30 30", //       9
      "# @end", //                    10
    ].join("\n"),
  );

  it("puts the point on the nearest segment, measured with pixels twice as wide as tall", () => {
    // 50,88 over the top edge 40,90-60,90: halfway along it, 2 rows away.
    assert.deepEqual(nearestInsertion(document, "a", { x: 50, y: 88 }), {
      line: 3,
      pointIndex: 1,
      x: 50,
      y: 90,
      distance: 2,
    });
    // 44,95 by the closing edge 50,99-40,90: t = (6*10*4 + 4*9) / (100*4 + 81) = 276/481,
    // so 44.262,93.836, rounded 44,94; 1.277 rows off it (the top edge is 5 away).
    const closing = nearestInsertion(document, "a", { x: 44, y: 95 })!;
    assert.deepEqual(
      { ...closing, distance: 0 },
      { line: 3, pointIndex: 3, x: 44, y: 94, distance: 0 },
    );
    assert.ok(Math.abs(closing.distance - 1.27669) < 1e-4, String(closing.distance));
  });

  it("never lands on a vertex, and skips segments with no pixel between their ends", () => {
    // On vertex 40,90 the top edge offers its first inner pixel, 41,90, 2 rows off
    // (the closing edge's last inner point, 41,90.9, is 2.19 off).
    assert.deepEqual(nearestInsertion(document, "a", { x: 40, y: 90 }), {
      line: 3,
      pointIndex: 1,
      x: 41,
      y: 90,
      distance: 2,
    });
    // A 1-step line and a staircase take no point; a fill is no line.
    assert.equal(nearestInsertion(document, "s", { x: 10, y: 10 }), undefined);
    assert.equal(nearestInsertion(document, "missing", { x: 0, y: 0 }), undefined);
  });
});
