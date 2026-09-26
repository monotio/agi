import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { itemHandles, linePoints } from "../src/studio/editPoints.ts";
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
