import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { applyEdit, type EditOperation } from "../../src/studio/editOperations.ts";
import { parsePictureDocument } from "../../src/studio/pictureDocument.ts";
import { insertionText, plainKernelRefusal } from "../src/studio/studioMessages.ts";

const { document } = parsePictureDocument(
  [
    '# @item edge "Edge" art', //    1
    "vis 1", //                      2
    "line 0,0 20,0", //              3
    "# @end", //                     4
    '# @item step "Step" art', //    5
    "rel 80,80 7,0", //              6
    "# @end", //                     7
    '# @item held "Held" art locked',
    "line 40,40 50,50",
    "# @end",
    "end",
  ].join("\n"),
);

/** The kernel's own refusal of `op`, and the Studio's sentence for it. */
function refusal(op: EditOperation): [technical: string, plain: string] {
  const result = applyEdit(document, op, { profile: DEFAULT_V2_PROFILE });
  assert.ok("error" in result, `${op.type} should be refused`);
  return [result.error, plainKernelRefusal(op, result.error)];
}

describe("plainKernelRefusal", () => {
  it("says which way a move would leave the picture, without coordinates", () => {
    const [technical, plain] = refusal({ type: "moveItem", itemId: "edge", dx: 0, dy: -1 });
    assert.match(technical, /moving by 0,-1 puts line 3 off the surface at 0,-1/);
    assert.equal(plain, "Can't move it further up — it would leave the picture.");
    assert.equal(
      refusal({ type: "moveItem", itemId: "edge", dx: -1, dy: 0 })[1],
      "Can't move it further left — it would leave the picture.",
    );
    assert.equal(
      refusal({ type: "moveItem", itemId: "edge", dx: -1, dy: -1 })[1],
      "Can't move it there — it would leave the picture.",
    );
    assert.equal(
      refusal({
        type: "duplicateItem",
        itemId: "edge",
        dx: 0,
        dy: -4,
        newId: "copy",
        newLabel: "Copy",
      })[1],
      "The copy can't go there — it would leave the picture.",
    );
  });

  it("words points, short-step lines and locked objects plainly", () => {
    assert.equal(
      refusal({ type: "setPoint", line: 3, pointIndex: 0, x: -2, y: 0 })[1],
      "Can't put the point there — it would leave the picture.",
    );
    const [technical, plain] = refusal({ type: "setPoint", line: 6, pointIndex: 1, x: 90, y: 80 });
    assert.match(technical, /rel delta 1 would be 10,0, outside -7\.\.7/);
    assert.equal(
      plain,
      "That point is too far from its neighbour for this kind of line (7 pixels at most).",
    );
    assert.equal(
      refusal({ type: "moveItem", itemId: "held", dx: 1, dy: 0 })[1],
      "This object is locked. Unlock it first.",
    );
  });

  it("falls back to a general sentence for anything else", () => {
    assert.equal(
      refusal({ type: "reorderItem", itemId: "edge", toIndex: 9 })[1],
      "The picture can't be changed that way.",
    );
  });
});

describe("insertionText", () => {
  it("names the step new shapes follow, in 1-based steps", () => {
    assert.equal(
      insertionText(7, 303),
      "New shapes are drawn after step 7 of 303 (use the draw order to change where).",
    );
    assert.equal(
      insertionText(0, 12),
      "New shapes are drawn first, before step 1 of 12 (use the draw order to change where).",
    );
    assert.equal(insertionText(12, 12), "New shapes are drawn last, after step 12.");
    assert.equal(insertionText(0, 0), "New shapes are drawn first.");
  });
});
