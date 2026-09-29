import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compilePictureSource } from "../src/picture/source.ts";
import {
  applyEdit,
  applyEdits,
  limitMove,
  type EditOperation,
} from "../src/studio/editOperations.ts";
import {
  parsePictureDocument,
  serializePictureDocument,
  type PictureDocument,
} from "../src/studio/pictureDocument.ts";

function doc(...lines: string[]): PictureDocument {
  const { document, diagnostics } = parsePictureDocument(lines.join("\n"));
  assert.deepEqual(diagnostics, []);
  return document;
}

/** Apply `op`, expecting success; the new source lines and the changed line numbers. */
function edit(document: PictureDocument, op: EditOperation): [string[], readonly number[]] {
  const result = applyEdit(document, op);
  if ("error" in result) assert.fail(result.error);
  return [serializePictureDocument(result.document).split("\n"), result.changedLines];
}

function refused(document: PictureDocument, op: EditOperation, pattern: RegExp): void {
  const result = applyEdit(document, op);
  assert.ok("error" in result, "expected a refusal");
  assert.match(result.error, pattern);
}

describe("applyEdit moveItem", () => {
  const shapes = doc(
    '# @item a "A" art', //       1
    "vis 1", //                   2
    "line 10,10 20,10  # top", // 3
    "rel 30,30 2,-1 -3,4", //     4
    "xcorner 40,40 45 50 42", //  5
    "ycorner 60,60 65 62", //     6
    "fill 12,12 13,13", //        7
    "pen 1 stipple", //           8
    "plot 17 5,5 6,6", //         9
    "# @end", //                  10
    "end", //                     11
  );

  it("moves absolute coordinates, rel starts and corner steps on their own axis", () => {
    const before = serializePictureDocument(shapes);
    assert.deepEqual(edit(shapes, { type: "moveItem", itemId: "a", dx: 5, dy: -2 }), [
      [
        '# @item a "A" art',
        "vis 1",
        "line 15,8 25,8  # top",
        "rel 35,28 2,-1 -3,4",
        "xcorner 45,38 50 48 47",
        "ycorner 65,58 63 67",
        "fill 17,10 18,11",
        "pen 1 stipple",
        "plot 17 10,3 11,4",
        "# @end",
        "end",
      ],
      [3, 4, 5, 6, 7, 9],
    ]);
    assert.equal(serializePictureDocument(shapes), before, "the input is not mutated");
  });

  it("refuses a move off the surface instead of clamping", () => {
    refused(shapes, { type: "moveItem", itemId: "a", dx: 140, dy: 0 }, /off the surface at 160,10/);
    // A rel start that stays on the surface still refuses when a vertex its deltas reach leaves it.
    const rel = doc('# @item r "R" art', "vis 1", "rel 150,10 7,0", "# @end");
    refused(rel, { type: "moveItem", itemId: "r", dx: 3, dy: 0 }, /off the surface at 160,10/);
    refused(shapes, { type: "moveItem", itemId: "a", dx: -6, dy: 0 }, /off the surface at -1,5/);
  });

  it("refuses items holding raw or copy lines, and items another copy reads", () => {
    const raw = doc('# @item r "R" art', "vis 1", "rel 10,10", "raw 8 17", "# @end");
    refused(raw, { type: "moveItem", itemId: "r", dx: 1, dy: 0 }, /line 4 is raw bytes/);
    const copied = doc(
      '# @item a "A" art',
      "vis 1",
      "line 10,10 12,10",
      "# @end",
      '# @item b "B" art',
      "copy 3-3 0,5",
      "# @end",
    );
    refused(copied, { type: "moveItem", itemId: "b", dx: 1, dy: 0 }, /line 6 is a copy/);
    refused(copied, { type: "moveItem", itemId: "a", dx: 1, dy: 0 }, /line 6 copies lines of/);
  });

  it("refuses locked items and unknown ids", () => {
    const locked = doc('# @item a "A" art locked', "vis 1", "line 1,1 2,2", "# @end");
    refused(locked, { type: "moveItem", itemId: "a", dx: 1, dy: 0 }, /locked/);
    refused(locked, { type: "moveItem", itemId: "zz", dx: 1, dy: 0 }, /no item 'zz'/);
  });
});

describe("limitMove", () => {
  // Extents by hand: a x 3..30 y 20; b x 150..157 y 160..165; c's rel reaches
  // 10,2 12,1 9,5 and its xcorner 100,100 158,100 158,120; d's fill seed and
  // plot point 80,80 70,70 (the plot's 17 is a pattern, not a point); e sits
  // on the left edge, x 0..5 y 50.
  const near = doc(
    '# @item a "A" art',
    "vis 1",
    "line 3,20 30,20",
    "# @end",
    '# @item b "B" art',
    "rect 150,160 157,165",
    "# @end",
    '# @item c "C" mixed',
    "rel 10,2 2,-1 -3,4",
    "xcorner 100,100 158 120",
    "# @end",
    '# @item d "D" art',
    "fill 80,80",
    "pen 1 stipple",
    "plot 17 70,70",
    "# @end",
    '# @item e "E" art',
    "line 0,50 5,50",
    "# @end",
    '# @item s "State" art',
    "vis 3",
    "# @end",
    "end",
  );

  it("stops each axis where an item's coordinate reaches the edge, keeping its direction", () => {
    assert.deepEqual(limitMove(near, ["a"], -10, -30), {
      dx: -3,
      dy: -20,
      stops: [
        { itemId: "a", edge: "left" },
        { itemId: "a", edge: "top" },
      ],
    });
    assert.deepEqual(limitMove(near, ["a"], 200, 200), {
      dx: 129,
      dy: 147,
      stops: [
        { itemId: "a", edge: "right" },
        { itemId: "a", edge: "bottom" },
      ],
    });
    assert.deepEqual(limitMove(near, ["b"], 5, 5), {
      dx: 2,
      dy: 2,
      stops: [
        { itemId: "b", edge: "right" },
        { itemId: "b", edge: "bottom" },
      ],
    });
    assert.deepEqual(limitMove(near, ["b"], -5, -5), { dx: -5, dy: -5, stops: [] });
  });

  it("counts every rel vertex and corner step, and a fill seed and plot points", () => {
    // The rel's second vertex, 12,1, is the top; the xcorner's 158 the right.
    assert.deepEqual(limitMove(near, ["c"], 3, -4), {
      dx: 1,
      dy: -1,
      stops: [
        { itemId: "c", edge: "right" },
        { itemId: "c", edge: "top" },
      ],
    });
    assert.deepEqual(limitMove(near, ["d"], -75, 100), {
      dx: -70,
      dy: 87,
      stops: [
        { itemId: "d", edge: "left" },
        { itemId: "d", edge: "bottom" },
      ],
    });
  });

  it("limits a mixed selection by whichever item is nearest each edge", () => {
    assert.deepEqual(limitMove(near, ["a", "b", "c"], -8, 8), {
      dx: -3,
      dy: 2,
      stops: [
        { itemId: "a", edge: "left" },
        { itemId: "b", edge: "bottom" },
      ],
    });
    assert.deepEqual(limitMove(near, ["a", "b", "c"], 8, -8), {
      dx: 1,
      dy: -1,
      stops: [
        { itemId: "c", edge: "right" },
        { itemId: "c", edge: "top" },
      ],
    });
  });

  it("stops dead at the edge an item already touches, while the other axis still moves", () => {
    assert.deepEqual(limitMove(near, ["e"], -4, 3), {
      dx: 0,
      dy: 3,
      stops: [{ itemId: "e", edge: "left" }],
    });
    assert.deepEqual(limitMove(near, ["e", "d"], -1, 0), {
      dx: 0,
      dy: 0,
      stops: [{ itemId: "e", edge: "left" }],
    });
  });

  it("sets no limit for state-only items or unknown ids", () => {
    assert.deepEqual(limitMove(near, ["s", "zz"], -500, 500), { dx: -500, dy: 500, stops: [] });
  });

  it("agrees with moveItem: the limit is accepted and one pixel more is refused", () => {
    const ids = ["a", "b", "c", "d"];
    for (const [dx, dy] of [
      [-50, 0],
      [50, 0],
      [0, -50],
      [0, 50],
    ] as const) {
      const limit = limitMove(near, ids, dx, dy);
      const moves = (mx: number, my: number): EditOperation[] =>
        ids.map((itemId) => ({ type: "moveItem", itemId, dx: mx, dy: my }));
      const kept = applyEdits(near, moves(limit.dx, limit.dy));
      assert.ok(!("error" in kept), `${dx},${dy} limited to ${limit.dx},${limit.dy}`);
      const further = applyEdits(near, moves(limit.dx + Math.sign(dx), limit.dy + Math.sign(dy)));
      assert.ok("error" in further && /off the surface/.test(further.error));
    }
  });
});

describe("applyEdit setPoint", () => {
  const lines = doc(
    "vis 1", //                    1
    "line 10,10 20,10  # top", //  2
    "rel 30,30 2,-1 -3,4", //      3
    "xcorner 40,40 45 50 42", //   4
    "rect 1,1 5,5", //             5
    "end", //                      6
  );

  it("sets one vertex in the command's operand order", () => {
    const at = (line: number, pointIndex: number, x: number, y: number): string =>
      edit(lines, { type: "setPoint", line, pointIndex, x, y })[0][line - 1]!;
    assert.equal(at(2, 1, 99, 9), "line 10,10 99,9  # top");
    // rel vertices 30,30 32,29 29,33: moving vertex 1 rewrites the deltas on both sides.
    assert.equal(at(3, 1, 33, 30), "rel 30,30 3,0 -4,3");
    assert.equal(at(3, 0, 31, 30), "rel 31,30 1,-1 -3,4");
    // xcorner vertices 40,40 45,40 45,50 42,50: vertex 2's y is step 2, its x step 1.
    assert.equal(at(4, 2, 47, 52), "xcorner 40,40 47 52 42");
    assert.equal(at(4, 1, 46, 41), "xcorner 40,41 46 50 42");
    assert.equal(at(5, 1, 7, 8), "rect 1,1 7,8");
  });

  it("refuses points that do not exist, deltas out of range and state lines", () => {
    const op = (line: number, pointIndex: number, x = 0, y = 0): EditOperation => ({
      type: "setPoint",
      line,
      pointIndex,
      x,
      y,
    });
    refused(lines, op(2, 2), /line 2 has 2 points; no point 2/);
    refused(lines, op(3, 1, 50, 30), /rel delta 1 would be 20,0/);
    refused(lines, op(1, 0), /has no points/);
    refused(lines, op(2, 0, 160, 0), /off the surface/);
  });
});

describe("applyEdit insertPoint", () => {
  const lines = doc(
    '# @item a "A" art', //          1
    "vis 1", //                      2
    "line 10,10 20,10  # top", //    3
    "polygon 40,40 50,40 45,48", //  4
    "rel 30,30 2,-1 -3,4", //        5
    "xcorner 60,60 65 70", //        6
    "rect 1,1 5,5", //               7
    "# @end", //                     8
    '# @item b "B" art locked', //   9
    "line 0,100 9,100", //           10
    "# @end", //                     11
    "end", //                        12
  );
  const op = (line: number, pointIndex: number, x: number, y: number, itemId = "a") =>
    ({ type: "insertPoint", itemId, line, pointIndex, x, y }) as const;
  const at = (line: number, pointIndex: number, x: number, y: number): string => {
    const [after, changed] = edit(lines, op(line, pointIndex, x, y));
    assert.deepEqual(changed, [line]);
    return after[line - 1]!;
  };

  it("adds a vertex before the point at its index, or after the last", () => {
    assert.equal(at(3, 1, 15, 12), "line 10,10 15,12 20,10  # top");
    assert.equal(at(3, 0, 5, 10), "line 5,10 10,10 20,10  # top");
    assert.equal(at(3, 2, 25, 10), "line 10,10 20,10 25,10  # top");
    // A polygon's last index is its closing edge, 45,48 back to 40,40.
    assert.equal(at(4, 3, 42, 44), "polygon 40,40 50,40 45,48 42,44");
    // rel vertices 30,30 32,29 29,33: the deltas on both sides of the new one are rewritten.
    assert.equal(at(5, 2, 31, 31), "rel 30,30 2,-1 -1,2 -2,2");
    assert.equal(at(5, 0, 28, 30), "rel 28,30 2,0 2,-1 -3,4");
  });

  it("keeps the item's id and annotations, and compiles to the hand-read bytes", () => {
    const small = doc(
      '# @item a "A" art',
      "vis 1",
      "line 10,10 20,10",
      "polygon 40,40 50,40 45,48",
      "rel 30,30 2,-1",
      "# @end",
      "end",
    );
    let document = small;
    for (const next of [op(3, 1, 15, 12), op(4, 3, 42, 44), op(5, 1, 31, 30)]) {
      const result = applyEdit(document, next);
      if ("error" in result) assert.fail(result.error);
      document = result.document;
    }
    assert.deepEqual(
      document.items.map(({ id, label, kind, openLine, closeLine }) => ({
        id,
        label,
        kind,
        openLine,
        closeLine,
      })),
      [{ id: "a", label: "A", kind: "art", openLine: 1, closeLine: 6 }],
    );
    const source = serializePictureDocument(document);
    assert.deepEqual(parsePictureDocument(source).diagnostics, []);
    assert.deepEqual(
      [...compilePictureSource(source).bytes],
      [
        ...[0xf0, 1],
        // line 10,10 15,12 20,10
        ...[0xf6, 10, 10, 15, 12, 20, 10],
        // polygon 40,40 50,40 45,48 42,44, closed back to 40,40
        ...[0xf6, 40, 40, 50, 40, 45, 48, 42, 44, 40, 40],
        // rel 30,30 1,0 1,-1: 0x10 is +1,0; 0x19 is +1,-1 (0x08 the negative y sign)
        ...[0xf7, 30, 30, 0x10, 0x19],
        0xff,
      ],
    );
  });

  it("refuses the other kinds in plain words, bad indices, far deltas and foreign lines", () => {
    refused(lines, op(6, 1, 62, 60), /line 6 \('xcorner'\) takes no new point: a staircase/);
    refused(lines, op(7, 1, 3, 1), /a rect is always its two corners/);
    refused(lines, op(2, 0, 3, 1), /line 2 \('vis'\) takes no new point$/);
    refused(lines, op(3, 3, 3, 1), /line 3 has 2 points; a new point goes at 0\.\.2/);
    refused(lines, op(5, 3, 40, 33), /rel delta 3 would be 11,0, outside -7\.\.7/);
    refused(lines, op(3, 1, 160, 0), /off the surface/);
    refused(lines, op(10, 1, 5, 100), /line 10 is not in item 'a'/);
    refused(lines, op(10, 1, 5, 100, "b"), /item 'b' is locked/);
  });
});

describe("applyEdit setItemColor", () => {
  it("rewrites the item's state lines and restores the state loose lines relied on", () => {
    const document = doc(
      '# @item a "A" art',
      "vis 1",
      "line 0,0 3,0",
      "# @end",
      "line 0,2 3,2",
      "end",
    );
    assert.deepEqual(
      edit(document, { type: "setItemColor", itemId: "a", plane: "visual", value: 2 }),
      [
        ['# @item a "A" art', "vis 2", "line 0,0 3,0", "vis 1", "# @end", "line 0,2 3,2", "end"],
        [2, 4],
      ],
    );
  });

  it("makes inherited state explicit at the item's start", () => {
    const document = doc("vis 1", '# @item a "A" art', "line 0,0 3,0", "# @end", "line 0,2 3,2");
    assert.deepEqual(
      edit(document, { type: "setItemColor", itemId: "a", plane: "visual", value: 4 }),
      [
        ["vis 1", '# @item a "A" art', "vis 4", "line 0,0 3,0", "vis 1", "# @end", "line 0,2 3,2"],
        [3, 5],
      ],
    );
  });

  it("adds nothing when the followers set the state themselves, and turns a plane off", () => {
    const document = doc(
      '# @item a "A" mixed',
      "vis 1",
      "pri 5",
      "line 0,0 3,0",
      "# @end",
      '# @item b "B" mixed',
      "vis 3",
      "pri 6",
      "line 0,2 3,2",
      "# @end",
    );
    assert.deepEqual(
      edit(document, { type: "setItemColor", itemId: "a", plane: "priority", value: null })[1],
      [3],
    );
    assert.equal(
      edit(document, { type: "setItemColor", itemId: "a", plane: "priority", value: null })[0][2],
      "pri off",
    );
  });

  it("refuses raw state bytes, copied items and values outside 0..15", () => {
    const raw = doc('# @item a "A" art', "raw 240 1", "line 0,0 3,0", "# @end");
    refused(raw, { type: "setItemColor", itemId: "a", plane: "visual", value: 2 }, /raw bytes/);
    refused(raw, { type: "setItemColor", itemId: "a", plane: "visual", value: 16 }, /0\.\.15/);
    const copied = doc('# @item a "A" art', "vis 1", "line 10,10 12,10", "# @end", "copy 2-3 0,5");
    refused(
      copied,
      { type: "setItemColor", itemId: "a", plane: "visual", value: 2 },
      /line 5 copies lines of item 'a'; recolouring it/,
    );
  });
});

describe("applyEdit deleteItem, duplicateItem and reorderItem", () => {
  it("deletes an item and restores the state its followers relied on", () => {
    const document = doc(
      '# @item a "A" art',
      "vis 1",
      "line 0,0 3,0",
      "# @end",
      "line 0,2 3,2",
      "end",
    );
    assert.deepEqual(edit(document, { type: "deleteItem", itemId: "a" }), [
      ["vis 1", "line 0,2 3,2", "end"],
      [1],
    ]);
  });

  it("refuses to delete the source of a copy", () => {
    const document = doc('# @item a "A" art', "vis 1", "line 0,0 3,0", "# @end", "copy 3-3 0,4");
    refused(document, { type: "deleteItem", itemId: "a" }, /line \d copies lines 3-3/);
  });

  it("duplicates an item moved, with the state it inherited", () => {
    const document = doc(
      "vis 1", //              1
      '# @item a "A" art', //  2
      "line 0,0 3,0", //       3
      "vis 3", //              4
      "line 0,1 3,1", //       5
      "# @end", //             6
      "line 0,9 3,9", //       7
      "end", //                8
    );
    const op: EditOperation = {
      type: "duplicateItem",
      itemId: "a",
      dx: 10,
      dy: 0,
      newId: "a-2",
      newLabel: "A again",
    };
    assert.deepEqual(edit(document, op), [
      [
        "vis 1",
        '# @item a "A" art',
        "line 0,0 3,0",
        "vis 3",
        "line 0,1 3,1",
        "# @end",
        '# @item a-2 "A again" art',
        "vis 1",
        "line 10,0 13,0",
        "vis 3",
        "line 10,1 13,1",
        "# @end",
        "line 0,9 3,9",
        "end",
      ],
      [7, 8, 9, 10, 11, 12],
    ]);
    refused(document, { ...op, newId: "a" }, /already used/);
    refused(document, { ...op, newId: "Bad id" }, /must match/);
  });

  it("reorders an item, restoring state at both seams", () => {
    const document = doc(
      '# @item a "A" art', //  1
      "vis 1", //              2
      "line 0,0 3,0", //       3
      "# @end", //             4
      "line 0,1 3,1", //       5 relies on vis 1
      '# @item b "B" art', //  6
      "vis 2", //              7
      "line 0,2 3,2", //       8
      "# @end", //             9
      "line 0,3 3,3", //       10 relies on vis 2
    );
    assert.deepEqual(edit(document, { type: "reorderItem", itemId: "a", toIndex: 1 }), [
      [
        "vis 1",
        "line 0,1 3,1",
        '# @item b "B" art',
        "vis 2",
        "line 0,2 3,2",
        "# @end",
        '# @item a "A" art',
        "vis 1",
        "line 0,0 3,0",
        "vis 2",
        "# @end",
        "line 0,3 3,3",
      ],
      [1, 7, 8, 9, 10, 11],
    ]);
    assert.deepEqual(edit(document, { type: "reorderItem", itemId: "a", toIndex: 0 })[1], []);
    refused(document, { type: "reorderItem", itemId: "a", toIndex: 2 }, /outside 0\.\.1/);
  });
});

describe("applyEdit inserts", () => {
  it("inserts a shape at a line boundary and restores the state after it", () => {
    const document = doc("vis 1", "line 0,0 3,0", "line 0,1 3,1", "end");
    const op: EditOperation = {
      type: "insertShape",
      atLine: 3,
      shape: {
        kind: "rect",
        color: 4,
        priority: null,
        filled: false,
        x1: 10,
        y1: 10,
        x2: 12,
        y2: 12,
      },
      id: "box",
      label: "Box",
      kind: "art",
    };
    assert.deepEqual(edit(document, op), [
      [
        "vis 1",
        "line 0,0 3,0",
        '# @item box "Box" art',
        "vis 4",
        "pri off",
        "rect 10,10 12,12",
        "vis 1",
        "# @end",
        "line 0,1 3,1",
        "end",
      ],
      [3, 4, 5, 6, 7, 8],
    ]);
    const boxed = doc('# @item a "A" art', "vis 1", "line 0,0 3,0", "# @end");
    refused(boxed, { ...op, atLine: 3 }, /line 3 is inside item 'a'/);
    refused(boxed, { ...op, atLine: 4 }, /inside item 'a'/);
    refused(
      document,
      { ...op, shape: { ...op.shape, color: null, priority: null } },
      /draws on neither plane/,
    );
    refused(
      document,
      {
        ...op,
        shape: {
          kind: "rect",
          color: 4,
          priority: null,
          filled: false,
          x1: 0,
          y1: 0,
          x2: 170,
          y2: 2,
        },
      },
      /does not compile/,
    );
  });

  it("refuses a self-intersecting or degenerate polygon, filled or not", () => {
    const document = doc("vis 1", "line 0,0 3,0", "end");
    const bowtie = [
      { x: 10, y: 10 },
      { x: 40, y: 30 },
      { x: 40, y: 10 },
      { x: 10, y: 20 },
    ];
    for (const filled of [false, true]) {
      refused(
        document,
        {
          type: "insertShape",
          atLine: 3,
          shape: { kind: "polygon", color: 2, priority: null, filled, points: bowtie },
          id: "bow",
          label: "Bow",
          kind: "art",
        },
        /the shape cannot be drawn: the polygon self-intersects between edges 0 and 2/,
      );
    }
    refused(
      document,
      {
        type: "insertShape",
        atLine: 3,
        shape: {
          kind: "polygon",
          color: 2,
          priority: null,
          filled: false,
          points: [
            { x: 1, y: 1 },
            { x: 5, y: 5 },
            { x: 9, y: 9 },
          ],
        },
        id: "flat",
        label: "Flat",
        kind: "art",
      },
      /the polygon has zero area/,
    );
  });

  it("inserts a fill as an item whose kind follows its planes", () => {
    const document = doc("vis 0", "rect 0,0 10,10", "end");
    assert.deepEqual(
      edit(document, {
        type: "insertFill",
        atLine: 3,
        x: 5,
        y: 5,
        visual: null,
        priority: 2,
        id: "trigger",
        label: "Trigger",
      }),
      [
        [
          "vis 0",
          "rect 0,0 10,10",
          '# @item trigger "Trigger" walk',
          "vis off",
          "pri 2",
          "fill 5,5",
          "# @end",
          "end",
        ],
        [3, 4, 5, 6, 7],
      ],
    );
  });

  it("inserts a stippled plot and restores the pen the following plot reads", () => {
    const document = doc("pen 1", "vis 1", "plot 20,20", "end");
    const op: EditOperation = {
      type: "insertPlot",
      atLine: 3,
      pen: { radius: 2, stipple: true },
      points: [
        { x: 5, y: 5 },
        { x: 9, y: 9 },
      ],
      seed: 17,
      visual: 6,
      priority: null,
      id: "bush",
      label: "Bush",
    };
    assert.deepEqual(edit(document, op)[0], [
      "pen 1",
      "vis 1",
      '# @item bush "Bush" art',
      "vis 6",
      "pri off",
      "pen 2 stipple",
      "plot 17 5,5 9,9",
      "vis 1",
      "pen 1",
      "# @end",
      "plot 20,20",
      "end",
    ]);
    const { seed: _seed, ...unseeded } = op;
    refused(document, unseeded, /needs a seed/);
    refused(document, { ...op, points: [{ x: 160, y: 0 }] }, /off the surface/);
  });

  it("renumbers copy ranges and refuses to split a command from its raw continuation", () => {
    const copying = doc("vis 1", "line 10,10 12,10", "copy 2-2 0,5", "end");
    const [lines, changed] = edit(copying, {
      type: "insertShape",
      atLine: 1,
      shape: { kind: "line", color: 2, priority: null, filled: false, points: [{ x: 0, y: 0 }] },
      id: "dot",
      label: "Dot",
      kind: "art",
    });
    assert.deepEqual(lines, [
      '# @item dot "Dot" art',
      "vis 2",
      "pri off",
      "line 0,0",
      "# @end",
      "vis 1",
      "line 10,10 12,10",
      "copy 7-7 0,5",
      "end",
    ]);
    assert.deepEqual(changed, [1, 2, 3, 4, 5, 8]);
    const continued = doc("vis 1", "rel 10,10", "raw 8 17", "end");
    refused(
      continued,
      { type: "insertFill", atLine: 3, x: 1, y: 1, visual: 2, priority: null, id: "f", label: "F" },
      /line 3 continues the command on line 2/,
    );
  });
});

describe("applyEdit setItemMeta", () => {
  it("rewrites only the directive, keeping CRLF", () => {
    const document = doc('# @item a "A" art\r', "vis 1\r", "line 0,0 3,0\r", "# @end\r", "");
    assert.deepEqual(
      edit(document, { type: "setItemMeta", itemId: "a", label: 'The "A"', locked: true }),
      [['# @item a "The \\"A\\"" art locked\r', "vis 1\r", "line 0,0 3,0\r", "# @end\r", ""], [1]],
    );
    refused(document, { type: "setItemMeta", itemId: "a", label: "  " }, /non-empty label/);
  });

  it("refuses a document whose directives do not parse", () => {
    const { document } = parsePictureDocument('# @item a "A"\nvis 1\n');
    const result = applyEdit(document, { type: "setItemMeta", itemId: "a", locked: true });
    assert.ok("error" in result);
    assert.match(result.error, /fix line 1 before editing: item 'a' has no @end/);
  });
});

describe("applyEdits: a batch as one edit", () => {
  const scene = doc(
    '# @item bush "Bush outline" art', //    1
    "vis 2", //                              2
    "rect 10,10 30,20", //                   3
    "# @end", //                             4
    '# @item leaves "Bush leaves" art', //   5
    "vis 10", //                             6
    "fill 20,15", //                         7
    "# @end", //                             8
    '# @item rock "Rock" art locked', //     9
    "vis 8", //                              10
    "line 100,100 110,100", //               11
    "# @end", //                             12
    "end", //                                13
  );

  it("moves every member by the same offset in one result", () => {
    const result = applyEdits(scene, [
      { type: "moveItem", itemId: "bush", dx: 4, dy: -2 },
      { type: "moveItem", itemId: "leaves", dx: 4, dy: -2 },
    ]);
    if ("error" in result) assert.fail(result.error);
    const lines = serializePictureDocument(result.document).split("\n");
    assert.equal(lines[2], "rect 14,8 34,18");
    assert.equal(lines[6], "fill 24,13");
    assert.equal(lines[10], "line 100,100 110,100");
    assert.deepEqual(result.changedLines, [3, 7]);
  });

  it("refuses the whole batch when one member is refused", () => {
    const locked = applyEdits(scene, [
      { type: "moveItem", itemId: "bush", dx: 1, dy: 0 },
      { type: "moveItem", itemId: "rock", dx: 1, dy: 0 },
    ]);
    assert.ok("error" in locked);
    assert.match(locked.error, /item 'rock' is locked/);
    // The first member alone would move; the second leaving the surface stops both.
    const off = applyEdits(scene, [
      { type: "moveItem", itemId: "leaves", dx: 0, dy: -12 },
      { type: "moveItem", itemId: "bush", dx: 0, dy: -12 },
    ]);
    assert.ok("error" in off);
    assert.match(off.error, /off the surface at 10,-2/);
    const twice = applyEdits(scene, [
      { type: "moveItem", itemId: "bush", dx: 1, dy: 0 },
      { type: "moveItem", itemId: "bush", dx: 1, dy: 0 },
    ]);
    assert.ok("error" in twice);
    assert.match(twice.error, /item 'bush' is in the batch twice/);
  });

  it("deletes and duplicates several items in one result", () => {
    const deleted = applyEdits(scene, [
      { type: "deleteItem", itemId: "bush" },
      { type: "deleteItem", itemId: "leaves" },
    ]);
    if ("error" in deleted) assert.fail(deleted.error);
    assert.deepEqual(
      deleted.document.items.map((item) => item.id),
      ["rock"],
    );
    const copied = applyEdits(scene, [
      { type: "duplicateItem", itemId: "bush", dx: 4, dy: 4, newId: "bush-copy", newLabel: "B" },
      {
        type: "duplicateItem",
        itemId: "leaves",
        dx: 4,
        dy: 4,
        newId: "leaves-copy",
        newLabel: "L",
      },
    ]);
    if ("error" in copied) assert.fail(copied.error);
    assert.deepEqual(
      copied.document.items.map((item) => item.id),
      ["bush", "bush-copy", "leaves", "leaves-copy", "rock"],
    );
    assert.deepEqual(applyEdits(scene, []), { document: scene, changedLines: [] });
  });
});

describe("applyEdit combineItems", () => {
  const parts = doc(
    '# @item el-1 "Element 1" art', //    1
    "vis 2", //                           2
    "rect 10,10 30,20", //                3
    "# @end", //                          4
    "", //                                5
    '# @item el-2 "Element 2" art', //    6
    "vis 10", //                          7
    "fill 20,15", //                      8
    "# @end", //                          9
    '# @item el-3 "Element 3" depth', //  10
    "pri 9", //                           11
    "line 10,21 30,21", //                12
    "# @end", //                          13
    "line 0,0 5,0", //                    14
    '# @item el-4 "Element 4" art', //    15
    "vis 1", //                           16
    "line 50,50 60,50", //                17
    "# @end", //                          18
    "end", //                             19
  );
  const combine = (itemIds: string[], id = "bush", label = "Bush"): EditOperation => ({
    type: "combineItems",
    itemIds,
    id,
    label,
  });

  it("wraps a run of neighbours in one item, commands in draw order, bytes unchanged", () => {
    const [lines, changed] = edit(parts, combine(["el-2", "el-1", "el-3"]));
    // Each member's own item stays as plain comments, so Ungroup can restore it.
    assert.deepEqual(lines, [
      '# @item bush "Bush" mixed',
      '# part el-1 "Element 1" art',
      "vis 2",
      "rect 10,10 30,20",
      "# end part",
      "",
      '# part el-2 "Element 2" art',
      "vis 10",
      "fill 20,15",
      "# end part",
      '# part el-3 "Element 3" depth',
      "pri 9",
      "line 10,21 30,21",
      "# end part",
      "# @end",
      "line 0,0 5,0",
      '# @item el-4 "Element 4" art',
      "vis 1",
      "line 50,50 60,50",
      "# @end",
      "end",
    ]);
    assert.deepEqual(changed, [1, 2, 5, 7, 10, 11, 14, 15]);
    const before = compilePictureSource(serializePictureDocument(parts)).bytes;
    const after = compilePictureSource(lines.join("\n")).bytes;
    assert.deepEqual(after, before);
    // The annotation survives a round trip through text: one item, every member's commands.
    const { document, diagnostics } = parsePictureDocument(lines.join("\n"));
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      document.items.map(({ id, label, kind, locked, commandLines }) => ({
        id,
        label,
        kind,
        locked,
        commandLines,
      })),
      [
        {
          id: "bush",
          label: "Bush",
          kind: "mixed",
          locked: false,
          commandLines: [3, 4, 8, 9, 12, 13],
        },
        { id: "el-4", label: "Element 4", kind: "art", locked: false, commandLines: [18, 19] },
      ],
    );
  });

  it("keeps one shared kind and CRLF line ends", () => {
    const crlf = doc(
      '# @item el-1 "Element 1" art\r',
      "vis 2\r",
      "line 0,0 3,0\r",
      "# @end\r",
      '# @item el-2 "Element 2" art\r',
      "line 0,2 3,2\r",
      "# @end\r",
      "",
    );
    assert.deepEqual(edit(crlf, combine(["el-1", "el-2"], "pair", "Pair")), [
      [
        '# @item pair "Pair" art\r',
        '# part el-1 "Element 1" art\r',
        "vis 2\r",
        "line 0,0 3,0\r",
        "# end part\r",
        '# part el-2 "Element 2" art\r',
        "line 0,2 3,2\r",
        "# end part\r",
        "# @end\r",
        "",
      ],
      [1, 2, 5, 6, 8, 9],
    ]);
  });

  it("refuses items that are not neighbours in the draw order, naming what lies between", () => {
    refused(
      parts,
      combine(["el-1", "el-3"]),
      /'el-1' and 'el-3' are not next to each other in the draw order: 'el-2' is drawn between them/,
    );
    refused(
      parts,
      combine(["el-3", "el-4"]),
      /line 14 draws between 'el-3' and 'el-4' outside any item/,
    );
  });

  it("refuses locked members, one item, unknown ids and a taken or bad id", () => {
    const locked = doc(
      '# @item a "A" art locked',
      "line 0,0 3,0",
      "# @end",
      '# @item b "B" art',
      "line 0,2 3,2",
      "# @end",
    );
    refused(locked, combine(["a", "b"]), /item 'a' is locked; unlock it first/);
    refused(parts, combine(["el-1"]), /at least two items/);
    refused(parts, combine(["el-1", "nope"]), /no item 'nope'/);
    refused(parts, combine(["el-1", "el-2"], "el-4"), /item id 'el-4' is already used/);
    refused(parts, combine(["el-1", "el-2"], "Bad id"), /must match/);
    refused(parts, combine(["el-1", "el-2"], "bush", " "), /non-empty label/);
    // A member's own id may name the combined item.
    const [lines] = edit(parts, combine(["el-1", "el-2"], "el-1", "Bush"));
    assert.equal(lines[0], '# @item el-1 "Bush" art');
  });
});

describe("applyEdit ungroupItem", () => {
  const parts = doc(
    '# @item el-1 "Element 1" art', //    1
    "vis 2", //                           2
    "rect 10,10 30,20", //                3
    "# @end", //                          4
    "", //                                5
    '# @item el-2 "Element 2" art', //    6
    "vis 10", //                          7
    "fill 20,15", //                      8
    "# @end", //                          9
    '# @item el-3 "Element 3" depth', //  10
    "pri 9", //                           11
    "line 10,21 30,21", //                12
    "# @end", //                          13
    "end", //                             14
  );
  const ungroup = (itemId: string): EditOperation => ({ type: "ungroupItem", itemId });
  const bytesOf = (lines: readonly string[]) => compilePictureSource(lines.join("\n")).bytes;

  it("restores a group's members exactly as they were, bytes unchanged", () => {
    const group: EditOperation = {
      type: "combineItems",
      itemIds: ["el-1", "el-2", "el-3"],
      id: "bush",
      label: "Bush",
    };
    const grouped = applyEdit(parts, group);
    if ("error" in grouped) assert.fail(grouped.error);
    const [lines] = edit(grouped.document, ungroup("bush"));
    assert.deepEqual(lines, serializePictureDocument(parts).split("\n"));
    assert.deepEqual(bytesOf(lines), bytesOf(parts.lines));
  });

  it("restores a group whose id is one of its members'", () => {
    const grouped = applyEdit(parts, {
      type: "combineItems",
      itemIds: ["el-1", "el-2"],
      id: "el-1",
      label: "Bush",
    });
    if ("error" in grouped) assert.fail(grouped.error);
    const [lines] = edit(grouped.document, ungroup("el-1"));
    assert.deepEqual(lines, serializePictureDocument(parts).split("\n"));
  });

  it("splits an item written as one per drawing element, named as inferred elements are", () => {
    const written = doc(
      '# @item scene "Scene" mixed', // 1
      "vis 2", //                       2
      "rect 10,10 30,20", //            3
      "vis 4", //                       4
      "line 80,80 90,80", //            5
      "pri 9", //                       6
      "line 100,120 110,120", //        7
      "# @end", //                      8
      "end", //                         9
    );
    const [lines] = edit(written, ungroup("scene"));
    assert.deepEqual(lines, [
      '# @item el-1 "Element 1" art',
      "vis 2",
      "rect 10,10 30,20",
      "# @end",
      '# @item el-2 "Element 2" art',
      "vis 4",
      "line 80,80 90,80",
      "# @end",
      '# @item el-3 "Element 3" mixed',
      "pri 9",
      "line 100,120 110,120",
      "# @end",
      "end",
    ]);
    assert.deepEqual(bytesOf(lines), bytesOf(written.lines));
  });

  it("splits by element when the parts can't be restored exactly", () => {
    // A part's id is taken by another item: the markers can't come back as they were.
    const clash = doc(
      '# @item bush "Bush" art', //       1
      '# part el-9 "Leaf" art', //        2
      "vis 2", //                         3
      "rect 10,10 30,20", //              4
      "# end part", //                    5
      '# part el-8 "Twig" art', //        6
      "vis 4", //                         7
      "line 80,80 90,80", //              8
      "# end part", //                    9
      "# @end", //                        10
      '# @item el-9 "Other" art', //      11
      "line 0,150 5,150", //              12
      "# @end", //                        13
    );
    const [lines] = edit(clash, ungroup("bush"));
    assert.deepEqual(lines.slice(0, 8), [
      '# @item el-1 "Element 1" art',
      "vis 2",
      "rect 10,10 30,20",
      "# @end",
      '# @item el-2 "Element 2" art',
      "vis 4",
      "line 80,80 90,80",
      "# @end",
    ]);
    assert.deepEqual(bytesOf(lines), bytesOf(clash.lines));
  });

  it("refuses one drawing element, a locked item and an unknown one", () => {
    refused(parts, ungroup("el-1"), /'el-1' is one drawing element: there is nothing to ungroup/);
    const locked = doc('# @item a "A" art locked', "rect 0,0 3,3", "line 50,50 60,50", "# @end");
    refused(locked, ungroup("a"), /item 'a' is locked; unlock it first/);
    refused(parts, ungroup("nope"), /no item 'nope'/);
  });
});
