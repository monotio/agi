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
  studioSideEffects,
  type LensUnlocks,
  type StudioCheck,
} from "../src/studio/studioLocks.ts";
import type { StudioLens } from "../src/studio/studioView.ts";
import { editedItems } from "../src/studio/useStudioDraft.ts";
import { ISLAND_MOVE, ISLAND_SOURCE } from "../../test/studioAssistFixtures.ts";

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

describe("an edit that changes another object's output reports it as a side effect", () => {
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

  it("moves an outline another item's fill pours around, naming that fill (Art)", () => {
    // Refused before: the island moved 8 right re-pours the grass.
    const lines = ISLAND_SOURCE.trimEnd().split("\n");
    const op = { type: "moveItem", itemId: "island", dx: ISLAND_MOVE.dx, dy: 0 } as const;
    const { before, after, verdict } = check(lines, op, "art");
    assert.deepEqual(verdict, { ok: true, violations: [] });
    const report = studioSideEffects(before, after, ["island"]);
    assert.deepEqual(report?.items, [
      { itemId: "grass", label: "Grass", cells: ISLAND_MOVE.cells, fill: true },
    ]);
    assert.deepEqual(
      report?.effects.map((e) => [e.itemId, e.plane, e.count, e.bbox]),
      [["grass", "art", ISLAND_MOVE.cells, ISLAND_MOVE.bbox]],
    );
    assert.equal(report?.mask[at(24, 50)], 1, "the grass poured into the island's old inside");
    assert.equal(report?.mask[at(44, 50)], 1, "and out of its new inside");
    assert.equal(report?.mask[at(20, 50)], 0, "the island's own outline is no side effect");
  });

  it("reports an art fill moved before a mixed fill it pre-empts (Depth); Walk keeps the depth", () => {
    const op = { type: "reorderItem", itemId: "patch", toIndex: 1 } as const;
    const depth = check(floorAndPatch, op, "depth");
    // The art is identical; the floor's depth is gone.
    assert.deepEqual(depth.after.visual, depth.before.visual);
    assert.deepEqual([depth.before.priority[at(30, 30)], depth.after.priority[at(30, 30)]], [9, 4]);
    assert.equal(depth.verdict.ok, true);
    assert.deepEqual(
      studioSideEffects(depth.before, depth.after, ["patch"])?.effects.map((e) => [
        e.label,
        e.plane,
        e.count,
        e.bbox,
        e.fill,
      ]),
      [["Room floor", "depth", INSIDE, { x0: 11, y0: 11, x1: 59, y1: 59 }, true]],
    );
    // The Walk lens keeps depth values 4–15, however they change.
    const walk = check(floorAndPatch, op, "walk").verdict;
    assert.deepEqual(messages(walk), ["The Walk lens draws walk lines 0–3 only."]);
    assert.equal(walk.violations[0]!.count, INSIDE);
    assert.equal(walk.violations[0]!.mask[at(30, 30)], 1);
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

  it("reports an art line moved in front of a mixed fill, in the lenses that allow depth", () => {
    const op = { type: "reorderItem", itemId: "crack", toIndex: 1 } as const;
    for (const lens of ["depth", "art"] as const) {
      const unlocks = lens === "art" ? { ...NO_UNLOCKS, priority: true } : NO_UNLOCKS;
      const { before, after, verdict } = check(floorAndCrack, op, lens, unlocks);
      assert.deepEqual(after.visual, before.visual);
      assert.deepEqual([before.priority[at(25, 40)], after.priority[at(25, 40)]], [13, 4]);
      assert.equal(verdict.ok, true, lens);
      assert.deepEqual(
        studioSideEffects(before, after, ["crack"])?.items,
        [{ itemId: "floor", label: "Floor", cells: 11, fill: true }],
        "the line's 11 cells",
      );
    }
    assert.equal(check(floorAndCrack, op, "walk").verdict.ok, false);
  });

  it("reports deleting an outline a later mixed fill stopped at, on both planes (Art, depth unlocked)", () => {
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
    const deleted = { type: "deleteItem", itemId: "wall" } as const;
    const { before, after, verdict } = check(outlined, deleted, "art", unlocked);
    assert.equal(verdict.ok, true);
    // The floor now floods the room below the wall, rows 41..59 (19 x 49 =
    // 931). The wall's own row was its art (a footprint), not its depth: it
    // drew none, so the floor's depth there (49 more) is a side effect too.
    const report = studioSideEffects(before, after, ["wall"]);
    assert.deepEqual(
      report?.effects.map((e) => [e.label, e.plane, e.count, e.bbox]),
      [
        ["Floor", "art", 931, { x0: 11, y0: 41, x1: 59, y1: 59 }],
        ["Floor", "depth", 980, { x0: 11, y0: 40, x1: 59, y1: 59 }],
      ],
    );
    assert.deepEqual(report?.items, [{ itemId: "floor", label: "Floor", cells: 980, fill: true }]);
    assert.equal(report?.cells, 980, "a cell changed on both planes counts once");
  });

  // Fuzz counterexample gr1 PIC 38, reduced: an inserted art fill pre-empts
  // a mixed fill, uncovering the depth an earlier depth fill left there.
  it("still refuses, in the Walk lens, an art fill that uncovers another object's depth value", () => {
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
    assert.deepEqual(messages(verdict), ["The Walk lens draws walk lines 0–3 only."]);
    assert.equal(verdict.violations[0]!.count, INSIDE);
  });

  it("reports nothing for an edit that stays within its own items", () => {
    const { before, after } = check(
      floorAndPatch,
      { type: "moveItem", itemId: "frame", dx: 0, dy: 0 },
      "art",
    );
    assert.equal(studioSideEffects(before, after, ["frame"]), null);
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
    assert.deepEqual(messages(painted), ["The Walk lens draws walk lines 0–3 only."]);
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
    // Walk: the floor's depth goes, which the Walk lens depth rule refuses.
    const walk = check(scene, { type: "reorderItem", itemId: "patch", toIndex: 1 }, "walk");
    assert.deepEqual(
      walk.verdict.violations.map((v) => v.rule),
      ["walk-depth"],
    );
    assert.deepEqual(refusalText(walk.verdict), {
      message: "The Walk lens draws walk lines 0–3 only.",
      detail:
        "Depth values 4–15 are locked in the Walk lens: 2401 cells at 11,11..59,59 would change.",
    });
    // Art: moving the frame moves the floor's depth, on a plane the lens locks.
    const art = check(scene, { type: "moveItem", itemId: "frame", dx: 0, dy: -1 }, "art");
    assert.deepEqual(
      art.verdict.violations.map((v) => v.rule),
      ["locked-plane"],
    );
    assert.equal(refusalText(art.verdict).message, "Priority is locked in the Visual lens.");
  });

  it("keeps the Visual lens lock: painting depth on a visual item is refused", () => {
    const painted = check(
      FRAME.concat("end"),
      { type: "setItemColor", itemId: "frame", plane: "priority", value: 9 },
      "art",
    ).verdict;
    assert.deepEqual(messages(painted), ["Priority is locked in the Visual lens."]);
    assert.equal(painted.violations[0]!.rule, "locked-plane");
    assert.equal(painted.violations[0]!.count, 200, "the frame's 200 outline cells");
  });
});
