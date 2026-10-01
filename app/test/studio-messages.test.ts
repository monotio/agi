import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { applyEdit, type EditOperation } from "../../src/studio/editOperations.ts";
import { parsePictureDocument } from "../../src/studio/pictureDocument.ts";
import { insertionText, kernelDetail, plainKernelRefusal } from "../src/studio/studioMessages.ts";

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
  it("says a move would leave the picture, without coordinates", () => {
    const [technical, plain] = refusal({ type: "moveItem", itemId: "edge", dx: 0, dy: -1 });
    assert.match(technical, /moving by 0,-1 puts line 3 off the surface at 0,-1/);
    assert.equal(plain, "Part of the item would leave the picture. Move it closer to the centre.");
    assert.equal(
      refusal({ type: "moveItem", itemId: "edge", dx: -1, dy: -1 })[1],
      "Part of the item would leave the picture. Move it closer to the centre.",
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
      "The copy would leave the picture. Move it closer to the centre.",
    );
  });

  it("words points, short-step lines and locked objects plainly", () => {
    assert.equal(
      refusal({ type: "setPoint", line: 3, pointIndex: 0, x: -2, y: 0 })[1],
      "The point would leave the picture. Choose a point inside it.",
    );
    const [technical, plain] = refusal({ type: "setPoint", line: 6, pointIndex: 1, x: 90, y: 80 });
    assert.match(technical, /rel delta 1 would be 10,0, outside -7\.\.7/);
    assert.equal(
      plain,
      "The points are more than 7 pixels apart. Move them closer or add a point.",
    );
    assert.equal(
      refusal({ type: "moveItem", itemId: "held", dx: 1, dy: 0 })[1],
      "This item is locked. Unlock it first.",
    );
  });

  it("falls back to a general sentence for anything else", () => {
    assert.equal(
      refusal({ type: "reorderItem", itemId: "edge", toIndex: 9 })[1],
      "PICTURE edit: toIndex 9 is outside 0..2. Correct the source or undo your last change.",
    );
  });
});

describe("insertionText", () => {
  it("names the step new shapes follow, in 1-based steps", () => {
    assert.equal(
      insertionText(7, 303),
      "New steps go after step 7 of 303; the steps after them paint over them.",
    );
    assert.equal(
      insertionText(0, 12),
      "New steps go first, before step 1 of 12; the steps after them paint over them.",
    );
    assert.equal(insertionText(12, 12), "New steps go last, after step 12, on top of everything.");
    assert.equal(insertionText(0, 0), "New steps are the first steps.");
  });
});

describe("kernelDetail", () => {
  it("names items by their labels, never their ids", () => {
    const [technical] = refusal({ type: "moveItem", itemId: "held", dx: 1, dy: 0 });
    assert.equal(technical, "item 'held' is locked; unlock it first");
    assert.equal(kernelDetail(technical, document), '"Held" is locked; unlock it first');
    assert.equal(
      kernelDetail("line 9 belongs to locked item 'held'", document),
      'line 9 belongs to locked item "Held"',
    );
    // An id the document lacks stays as it was.
    assert.equal(kernelDetail("no item 'gone'", document), "no item 'gone'");
  });
});

describe("plainKernelRefusal of Group and Ungroup", () => {
  const combine = (itemIds: string[]): EditOperation => ({
    type: "combineItems",
    itemIds,
    id: "group",
    label: "Group",
  });
  it("asks for neighbours, and for two items", () => {
    assert.equal(
      refusal(combine(["edge", "held"]))[1],
      "Group takes neighbours in the draw order. Include the items between them.",
    );
    assert.equal(refusal(combine(["edge"]))[1], "Select two items or more to group.");
    const [technical] = refusal(combine(["edge", "held"]));
    assert.equal(
      kernelDetail(technical, document),
      '"Edge" and "Held" are not next to each other in the draw order: "Step" is drawn between them',
    );
  });
  it("explains what Ungroup needs", () => {
    assert.equal(
      refusal({ type: "ungroupItem", itemId: "edge" })[1],
      "This item has one step. Select an item with several steps to ungroup.",
    );
  });
});
