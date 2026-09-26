import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { applyEdit, type EditOperation } from "../../src/studio/editOperations.ts";
import { compileEditDocument } from "../../src/studio/editValidation.ts";
import { parsePictureDocument } from "../../src/studio/pictureDocument.ts";
import {
  checkStudioEdit,
  NO_UNLOCKS,
  refusalText,
  type LensUnlocks,
  type StudioCheck,
} from "../src/studio/studioLocks.ts";
import type { StudioLens } from "../src/studio/studioView.ts";
import { editedItems } from "../src/studio/useStudioDraft.ts";

const profile = DEFAULT_V2_PROFILE;
const at = (x: number, y: number): number => y * 160 + x;

/** The edit, compiled before and after, and the Studio's verdict on it. */
function check(
  lines: readonly string[],
  op: EditOperation,
  lens: StudioLens,
  unlocks: LensUnlocks = NO_UNLOCKS,
) {
  const { document, diagnostics } = parsePictureDocument(lines.join("\n"));
  assert.deepEqual(diagnostics, []);
  const result = applyEdit(document, op, { profile });
  if ("error" in result) assert.fail(result.error);
  const before = compileEditDocument(document, profile);
  const after = compileEditDocument(result.document, profile);
  const edited = [...new Set([...editedItems(document, op), ...editedItems(result.document, op)])];
  return { before, after, verdict: checkStudioEdit(before, after, edited, lens, unlocks) };
}

const messages = (verdict: StudioCheck): string[] => verdict.violations.map((v) => v.message);

/** The art frame every scene below is drawn in: a black outline, no depth. */
const FRAME = ['# @item frame "Frame" art', "vis 0", "pri off", "rect 10,10 60,60", "# @end"];
/** The frame's inside, 11..59 on both axes. */
const INSIDE = 49 * 49;

describe("an edit may not change another object's output", () => {
  // QA repro: a mixed floor fill (art 6, depth 9) and an art patch filling
  // the same white area after it, which draws nothing.
  const floorAndPatch = [
    ...FRAME,
    '# @item room "Room floor" mixed', //   6
    "vis 6",
    "pri 9",
    "fill 30,30",
    "# @end",
    '# @item patch "Patch" art', //         11
    "vis 6",
    "pri off",
    "fill 30,30",
    "# @end",
    "end",
  ];

  it("refuses moving an art fill before a mixed fill it pre-empts (Walk and Depth)", () => {
    const op = { type: "reorderItem", itemId: "patch", toIndex: 1 } as const;
    for (const lens of ["walk", "depth"] as const) {
      const { before, after, verdict } = check(floorAndPatch, op, lens);
      // The art is identical; the floor's depth is gone.
      assert.deepEqual(after.visual, before.visual);
      assert.deepEqual([before.priority[at(30, 30)], after.priority[at(30, 30)]], [9, 4]);
      assert.equal(verdict.ok, false, lens);
      assert.equal(messages(verdict)[0], "This would change another object's depth.");
      assert.equal(verdict.violations[0]!.count, INSIDE);
      assert.equal(verdict.violations[0]!.mask[at(30, 30)], 1);
    }
  });

  it("refuses inserting an art fill that pre-empts a mixed fill (Walk)", () => {
    const { verdict } = check(
      floorAndPatch,
      {
        type: "insertFill",
        atLine: 6,
        x: 30,
        y: 30,
        visual: 6,
        priority: null,
        id: "pre",
        label: "Pre",
      },
      "walk",
    );
    assert.equal(verdict.ok, false);
    assert.equal(messages(verdict)[0], "This would change another object's depth.");
  });

  // Fuzz counterexamples kq1 PIC 1, kq1 PIC 37 and gr1 PIC 50, reduced: an
  // art line drawn after a mixed fill, moved before it, keeps the fill (and
  // its depth) off the line's cells.
  const floorAndCrack = [
    ...FRAME,
    '# @item floor "Floor" mixed', //       6
    "vis 6",
    "pri 13",
    "fill 30,30",
    "# @end",
    '# @item crack "Crack" art', //         11
    "vis 8",
    "pri off",
    "line 20,40 30,40",
    "# @end",
    "end",
  ];

  it("refuses moving an art line in front of a mixed fill in every lens", () => {
    const op = { type: "reorderItem", itemId: "crack", toIndex: 1 } as const;
    for (const lens of ["walk", "depth", "art"] as const) {
      const unlocks = lens === "art" ? { ...NO_UNLOCKS, priority: true } : NO_UNLOCKS;
      const { before, after, verdict } = check(floorAndCrack, op, lens, unlocks);
      assert.deepEqual(after.visual, before.visual);
      assert.deepEqual([before.priority[at(25, 40)], after.priority[at(25, 40)]], [13, 4]);
      assert.equal(verdict.ok, false, lens);
      assert.equal(messages(verdict)[0], "This would change another object's depth.");
      assert.equal(verdict.violations[0]!.count, 11, "the line's 11 cells");
    }
  });

  it("refuses deleting an outline a later mixed fill stopped at (Art, depth unlocked)", () => {
    const outlined = [
      ...FRAME,
      '# @item wall "Wall" art', //          6
      "vis 8",
      "pri off",
      "line 11,40 59,40",
      "# @end",
      '# @item floor "Floor" mixed', //      11
      "vis 6",
      "pri 13",
      "fill 30,30",
      "# @end",
      "end",
    ];
    const unlocked = { ...NO_UNLOCKS, priority: true };
    const { verdict } = check(outlined, { type: "deleteItem", itemId: "wall" }, "art", unlocked);
    assert.equal(verdict.ok, false);
    // The floor now floods the wall's cells and the room below it.
    assert.deepEqual(messages(verdict), [
      "This would change another object's art.",
      "This would change another object's depth.",
    ]);
  });

  // Fuzz counterexample gr1 PIC 38, reduced: an inserted art fill pre-empts
  // a mixed fill, uncovering the depth an earlier depth fill left there.
  it("refuses an art fill that uncovers another object's depth value (Walk)", () => {
    const shaded = [
      '# @item frame "Frame" mixed',
      "vis 0",
      "pri 0",
      "rect 10,10 60,60",
      "# @end",
      '# @item shade "Shade" depth', //      6
      "vis off",
      "pri 14",
      "fill 30,30",
      "# @end",
      '# @item floor "Floor" mixed', //      11
      "vis 6",
      "pri 9",
      "fill 30,30",
      "# @end",
      "end",
    ];
    const { before, after, verdict } = check(
      shaded,
      {
        type: "insertFill",
        atLine: 11,
        x: 30,
        y: 30,
        visual: 6,
        priority: null,
        id: "pre",
        label: "Pre",
      },
      "walk",
    );
    // The same art, now drawn by the new fill; the floor's depth 9 is gone.
    assert.deepEqual(after.visual, before.visual);
    assert.deepEqual([before.priority[at(30, 30)], after.priority[at(30, 30)]], [9, 14]);
    assert.equal(verdict.ok, false);
    assert.equal(messages(verdict)[0], "This would change another object's depth.");
    assert.equal(verdict.violations[0]!.count, INSIDE);
  });
});

describe("the Walk lens keeps depth values 4–15", () => {
  const scene = [
    '# @item deep "Deep" depth',
    "vis off",
    "pri 9",
    "rect 20,20 40,40",
    "# @end",
    '# @item edge "Edge" walk',
    "vis off",
    "pri 1",
    "line 10,30 50,30",
    "# @end",
    "end",
  ];

  it("lets a barrier move over depth and uncover what it covered", () => {
    const { before, after, verdict } = check(
      scene,
      { type: "moveItem", itemId: "edge", dx: 0, dy: 1 },
      "walk",
    );
    // 9 under the old line comes back; the new line covers 9 and 4.
    assert.deepEqual([before.priority[at(20, 30)], after.priority[at(20, 30)]], [1, 9]);
    assert.deepEqual([before.priority[at(20, 31)], after.priority[at(20, 31)]], [9, 1]);
    assert.deepEqual(verdict.violations, []);
  });

  it("refuses a barrier that takes a depth value, and a depth item that moves", () => {
    const painted = check(
      scene,
      { type: "setItemColor", itemId: "edge", plane: "priority", value: 12 },
      "walk",
    ).verdict;
    assert.deepEqual(messages(painted), [
      "This would change depth values 4–15, which are locked in the Walk lens.",
    ]);
    assert.match(painted.violations[0]!.detail, /^Depth values 4–15 are locked in the Walk lens/);
    const moved = check(scene, { type: "moveItem", itemId: "deep", dx: 1, dy: 0 }, "walk").verdict;
    assert.equal(moved.ok, false);
    const allowed = check(scene, { type: "moveItem", itemId: "deep", dx: 1, dy: 0 }, "walk", {
      ...NO_UNLOCKS,
      depthInWalk: true,
    }).verdict;
    assert.equal(allowed.ok, true);
  });
});

describe("refusalText", () => {
  it("says one plain reason per plane and keeps every technical account as the detail", () => {
    const scene = [
      ...FRAME,
      '# @item room "Room floor" mixed',
      "vis 6",
      "pri 9",
      "fill 30,30",
      "# @end",
      '# @item patch "Patch" art',
      "vis 6",
      "pri off",
      "fill 30,30",
      "# @end",
      "end",
    ];
    // Walk: the floor's depth goes, which both the footprint and the depth rule report.
    const walk = check(scene, { type: "reorderItem", itemId: "patch", toIndex: 1 }, "walk");
    assert.deepEqual(
      walk.verdict.violations.map((v) => v.rule),
      ["outside-mask", "walk-depth"],
    );
    assert.deepEqual(refusalText(walk.verdict), {
      message: "This would change another object's depth.",
      detail: [
        "The edit reaches outside the edited item: 2401 cells at 11,11..59,59 of other items' depth would change.",
        "Depth values 4–15 are locked in the Walk lens: 2401 cells at 11,11..59,59 would change.",
      ].join("\n"),
    });
    // Art: moving the frame moves the floor's depth, on a plane the lens locks.
    const art = check(scene, { type: "moveItem", itemId: "frame", dx: 0, dy: -1 }, "art");
    assert.deepEqual(
      art.verdict.violations.map((v) => v.rule),
      ["locked-plane", "outside-mask"],
    );
    assert.equal(
      refusalText(art.verdict).message,
      "This would change the depth, which is locked in the Art lens.",
    );
  });
});
