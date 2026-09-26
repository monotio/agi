import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEdit, type EditOperation } from "../src/studio/editOperations.ts";
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
