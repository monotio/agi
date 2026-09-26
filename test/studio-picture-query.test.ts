import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import { parsePictureDocument } from "../src/studio/pictureDocument.ts";
import {
  commandTimeline,
  compileDocument,
  itemAt,
  itemMask,
  renderUpTo,
  whyNotFilled,
} from "../src/studio/pictureQuery.ts";

const profile = DEFAULT_V2_PROFILE;
const at = (x: number, y: number): number => y * 160 + x;

function doc(...lines: string[]) {
  const { document, diagnostics } = parsePictureDocument(lines.join("\n"));
  assert.deepEqual(diagnostics, []);
  return document;
}

/** Indices of the set cells of a mask or the cells differing from `blank`. */
function cells(values: Uint8Array, blank = 0): number[] {
  const out: number[] = [];
  values.forEach((v, i) => {
    if (v !== blank) out.push(i);
  });
  return out;
}

describe("picture queries", () => {
  // Bytes: 0 f0 1 | 2 f6 0 0 3 0 | 7 f0 2 | 9 f2 9 | 11 f6 2 0 2 1 | 16 ff
  const overlap = doc(
    '# @item a "A" art', //   1
    "vis 1", //               2
    "line 0,0 3,0", //        3
    "# @end", //              4
    '# @item b "B" mixed', // 5
    "vis 2", //               6
    "pri 9", //               7
    "line 2,0 2,1", //        8
    "# @end", //              9
    "end", //                 10
  );

  it("compiles once with owner buffers and the final surface", () => {
    const compiled = compileDocument(overlap, profile);
    assert.deepEqual(
      Array.from(compiled.bytes),
      [0xf0, 1, 0xf6, 0, 0, 3, 0, 0xf0, 2, 0xf2, 9, 0xf6, 2, 0, 2, 1, 0xff],
    );
    assert.deepEqual(
      [at(0, 0), at(1, 0), at(2, 0), at(3, 0), at(2, 1)].map((i) => [
        compiled.visual[i],
        compiled.priority[i],
        compiled.owners.visual[i],
        compiled.owners.priority[i],
      ]),
      [
        [1, 4, 2, -1],
        [1, 4, 2, -1],
        [2, 9, 11, 11],
        [1, 4, 2, -1],
        [2, 9, 11, 11],
      ],
    );
  });

  it("finds the item that owns a pixel where B overwrites A", () => {
    const compiled = compileDocument(overlap, profile);
    const id = (x: number, y: number, plane: "visual" | "priority") =>
      itemAt(compiled, overlap, x, y, plane)?.id;
    assert.equal(id(0, 0, "visual"), "a");
    assert.equal(id(3, 0, "visual"), "a");
    assert.equal(id(2, 0, "visual"), "b");
    assert.equal(id(2, 1, "visual"), "b");
    assert.equal(id(5, 5, "visual"), undefined);
    assert.equal(id(0, 0, "priority"), undefined);
    assert.equal(id(2, 0, "priority"), "b");
    assert.equal(id(160, 0, "visual"), undefined);
    assert.equal(id(0, -1, "visual"), undefined);
  });

  it("masks exactly the final pixels an item owns", () => {
    const compiled = compileDocument(overlap, profile);
    assert.deepEqual(cells(itemMask(compiled, overlap, "a", "visual")), [0, 1, 3]);
    assert.deepEqual(cells(itemMask(compiled, overlap, "b", "visual")), [2, 162]);
    assert.deepEqual(cells(itemMask(compiled, overlap, "b", "priority")), [2, 162]);
    assert.deepEqual(cells(itemMask(compiled, overlap, "a", "priority")), []);
    assert.deepEqual(cells(itemMask(compiled, overlap, "nope", "visual")), []);
    assert.equal(itemMask(compiled, overlap, "a", "visual").length, 160 * 168);
  });

  it("reports the drawing state in effect as each command starts", () => {
    const document = doc(
      "vis 3", //                          1
      "pri 5", //                          2
      "line 0,0 1,0", //                   3
      '# @item floor "Floor" depth', //    4
      "vis off", //                        5
      "line 0,2 1,2   # priority only", // 6
      "", //                               7
      "# @end", //                         8
      "pri off", //                        9
      "VIS 4", //                          10
      "line 0,4 1,4", //                   11
      "end", //                            12
    );
    assert.deepEqual(commandTimeline(document, profile), [
      { line: 1, op: "vis", visual: null, priority: null },
      { line: 2, op: "pri", visual: 3, priority: null },
      { line: 3, op: "line", visual: 3, priority: 5 },
      { line: 5, op: "vis", visual: 3, priority: 5, itemId: "floor" },
      { line: 6, op: "line", visual: null, priority: 5, itemId: "floor" },
      { line: 9, op: "pri", visual: null, priority: 5 },
      { line: 10, op: "vis", visual: null, priority: null },
      { line: 11, op: "line", visual: 4, priority: null },
      { line: 12, op: "end", visual: 4, priority: null },
    ]);
  });

  it("renders only the first N commands", () => {
    // Bytes: 0 f0 1 | 2 f6 0 0 2 0 | 7 f6 0 1 1 1 | 12 ff (implied)
    const compiled = compileDocument(doc("vis 1", "line 0,0 2,0", "line 0,1 1,1"), profile);
    assert.deepEqual(
      compiled.spans.map((s) => [s.line, s.start, s.end]),
      [
        [1, 0, 2],
        [2, 2, 7],
        [3, 7, 12],
      ],
    );
    const visual = (n: number) => cells(renderUpTo(compiled, n, profile).visual, 15);
    assert.deepEqual(visual(0), []);
    assert.deepEqual(visual(1), []);
    assert.deepEqual(visual(2), [0, 1, 2]);
    assert.deepEqual(visual(3), [0, 1, 2, 160, 161]);
    assert.deepEqual(visual(99), [0, 1, 2, 160, 161]);
    assert.deepEqual(renderUpTo(compiled, 2, profile).visual[1], 1);
    assert.deepEqual(cells(renderUpTo(compiled, 3, profile).priority, 4), []);
  });

  it("explains why a fill does not reach a cell", () => {
    const compiled = compileDocument(
      doc("vis 0", "rect 0,0 4,4", "vis off", "pri 1", "line 10,10 12,10"),
      profile,
    );
    assert.deepEqual(whyNotFilled(compiled, 0, 0, "visual"), {
      plane: "visual",
      x: 0,
      y: 0,
      value: 0,
      target: 15,
      line: 2,
      fillable: false,
      message:
        "Line 2 last wrote this cell; it holds visual 0. A visual fill floods only 4-connected cells holding 15. It no longer holds 15, so a later fill stops at it.",
    });
    assert.deepEqual(whyNotFilled(compiled, 2, 2, "visual"), {
      plane: "visual",
      x: 2,
      y: 2,
      value: 15,
      target: 15,
      line: null,
      fillable: true,
      message:
        "No command wrote this cell; it holds its initial visual 15. A visual fill floods only 4-connected cells holding 15. It still holds the target, so a visual fill seeded in its region reaches it.",
    });
    const priority = whyNotFilled(compiled, 11, 10, "priority");
    assert.deepEqual(
      [priority?.value, priority?.target, priority?.line, priority?.fillable],
      [1, 4, 5, false],
    );
    assert.match(priority!.message, /runs only while visual drawing is off/);
    assert.equal(whyNotFilled(compiled, 160, 0, "visual"), undefined);
  });
});
