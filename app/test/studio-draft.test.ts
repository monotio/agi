import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectScope, ref } from "vue";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { testRevision } from "./identity.ts";
import { NO_UNLOCKS, type LensUnlocks } from "../src/studio/studioLocks.ts";
import type { StudioLens } from "../src/studio/studioView.ts";
import { nearestInsertion } from "../../src/studio/editPoints.ts";
import { useStudioDrag } from "../src/studio/useStudioDrag.ts";
import { useStudioEditing } from "../src/studio/useStudioEditing.ts";
import {
  changeCount,
  draftPictureEdit,
  editedItems,
  freshItemId,
  useStudioDraft,
} from "../src/studio/useStudioDraft.ts";
import { useStudioKeep } from "../src/studio/useStudioKeep.ts";
import type { PictureEdit } from "../src/project/resourceCommit.ts";
import { authoringFingerprint } from "../src/project/gameStorage.ts";

/**
 * A white room: an art box outline, the red paint filling it, a grey wall
 * item, a priority-10 occluder outline and a barrier line (priority 0).
 */
const SOURCE = [
  '# @item box "Box" art', //                1
  "vis 0", //                                2
  "rect 10,10 30,30", //                     3
  "# @end", //                               4
  '# @item paint "Paint" art', //            5
  "vis 4", //                                6
  "fill 20,20", //                           7
  "# @end", //                               8
  '# @item occ "Occluder" depth', //         9
  "vis off", //                              10
  "pri 10", //                               11
  "rect 40,90 119,105", //                   12
  "# @end", //                               13
  '# @item edge "Floor edge" walk', //       14
  "pri 0", //                                15
  "line 20,140 139,140", //                  16
  "# @end", //                               17
  "end", //                                  18
].join("\n");

function setup(lens: StudioLens = "depth", unlocks: LensUnlocks = NO_UNLOCKS) {
  const lensRef = ref(lens);
  const unlocksRef = ref(unlocks);
  const base = ref({ source: SOURCE, revision: testRevision("draft") });
  const draft = useStudioDraft({
    base,
    profile: DEFAULT_V2_PROFILE,
    lens: lensRef,
    unlocks: unlocksRef,
  });
  return { draft, lens: lensRef, unlocks: unlocksRef, base };
}

const move = (itemId: string, dx: number, dy: number) =>
  ({ type: "moveItem", itemId, dx, dy }) as const;
const line = (draft: ReturnType<typeof setup>["draft"], n: number) =>
  draft.source.value.split("\n")[n - 1];

describe("useStudioDraft", () => {
  it("records a whole drag as one undo step", () => {
    const { draft } = setup();
    draft.beginGesture("Move Occluder");
    for (const dx of [1, 2, 3]) assert.equal(draft.moveGesture(move("occ", dx, 0)).ok, true);
    assert.match(draft.preview.value!.source, /rect 43,90 122,105/);
    // The draft itself does not move until the gesture ends.
    assert.equal(line(draft, 12), "rect 40,90 119,105");
    assert.equal(draft.endGesture(move("occ", 3, 0), "Move Occluder").ok, true);
    assert.equal(line(draft, 12), "rect 43,90 122,105");
    assert.equal(draft.history.value.past.length, 1);
    assert.equal(draft.changes.value, 1);
    assert.equal(draft.preview.value, null);
    assert.equal(draft.undo(), true);
    assert.equal(draft.source.value, SOURCE);
    assert.equal(draft.dirty.value, false);
    assert.equal(draft.redo(), true);
    assert.equal(line(draft, 12), "rect 43,90 122,105");
  });

  it("snaps a refused drag back and says why", () => {
    const { draft } = setup();
    draft.beginGesture("Move Occluder");
    assert.equal(draft.moveGesture(move("occ", 2, 0)).ok, true);
    const off = draft.moveGesture(move("occ", 45, 0));
    assert.equal(off.ok, false);
    assert.equal(draft.preview.value, null, "the preview snaps back to the start");
    const end = draft.endGesture(move("occ", 45, 0), "Move Occluder");
    assert.ok(!end.ok && end.refusal.kind === "kernel");
    assert.equal(end.refusal.message, "Can't move it further right — it would leave the picture.");
    assert.match(end.refusal.detail ?? "", /off the surface at 164,105/);
    assert.equal(draft.source.value, SOURCE);
    assert.equal(draft.history.value.past.length, 0);
    assert.equal(draft.gesturing.value, false);
    assert.equal(draft.canUndo.value, false);
  });

  it("refuses edits on a lens-locked plane, in plain words with the count and box as detail", () => {
    const { draft, lens, unlocks } = setup("depth");
    // Moving art in the Depth lens touches the locked visual plane: a box
    // outline one row lower changes 21 + 19 cells at each long edge.
    const art = draft.apply(move("box", 0, 1), "Move Box");
    assert.ok(!art.ok && art.refusal.kind === "lock");
    assert.equal(
      art.refusal.message,
      "This would change the art, which is locked in the Depth lens.",
    );
    assert.equal(
      art.refusal.detail,
      "Art is locked in the Depth lens: 80 cells at 10,10..30,31 would change.",
    );
    assert.ok(art.refusal.cells.includes(1));
    assert.equal(draft.source.value, SOURCE);

    // The occluder outline one row lower: 80 + 78 cells at each long edge.
    lens.value = "art";
    const depth = draft.apply(move("occ", 0, 1), "Move Occluder");
    assert.ok(!depth.ok && depth.refusal.kind === "lock");
    assert.equal(
      depth.refusal.message,
      "This would change the depth, which is locked in the Art lens.",
    );
    assert.match(
      depth.refusal.detail,
      /^Depth is locked in the Art lens: 316 cells at 40,90\.\.119,106/,
    );
    unlocks.value = { ...NO_UNLOCKS, priority: true };
    assert.equal(draft.apply(move("occ", 0, 1), "Move Occluder").ok, true);
  });

  it("keeps depth values off limits in the Walk lens until they are allowed", () => {
    const { draft, unlocks } = setup("walk");
    // A barrier moves freely: the cells it leaves hold what was under it.
    assert.equal(draft.apply(move("edge", 0, -2), "Move Floor edge").ok, true);
    const paint = draft.apply(
      { type: "setItemColor", itemId: "edge", plane: "priority", value: 12 },
      "Priority 12",
    );
    assert.ok(!paint.ok && paint.refusal.kind === "lock");
    assert.equal(
      paint.refusal.message,
      "This would change depth values 4–15, which are locked in the Walk lens.",
    );
    assert.match(paint.refusal.detail, /^Depth values 4–15 are locked in the Walk lens: 120 cells/);
    const moved = draft.apply(move("occ", 1, 0), "Move Occluder");
    assert.ok(!moved.ok);
    unlocks.value = { ...NO_UNLOCKS, depthInWalk: true };
    assert.equal(draft.apply(move("occ", 1, 0), "Move Occluder").ok, true);
    assert.equal(draft.changes.value, 2);
  });

  it("refuses an edit that reaches outside the edited items", () => {
    const { draft } = setup("art");
    // Opening the box lets the paint flood the whole white room.
    const result = draft.apply({ type: "deleteItem", itemId: "box" }, "Delete Box");
    assert.ok(!result.ok && result.refusal.kind === "lock");
    assert.equal(result.refusal.message, "This would change another object's art.");
    assert.match(result.refusal.detail, /outside the edited item/);
    assert.equal(draft.source.value, SOURCE);
  });

  it("rebases on Keep and throws changes away on Discard", () => {
    const { draft } = setup("depth");
    assert.equal(draft.apply(move("occ", 0, 2), "Move Occluder").ok, true);
    const edited = draft.source.value;
    draft.markKept(testRevision("kept"));
    assert.equal(draft.kept.value.revision, testRevision("kept"));
    assert.equal(draft.dirty.value, false);
    assert.equal(draft.changes.value, 0);
    assert.equal(draft.apply(move("occ", 0, 1), "Move Occluder").ok, true);
    assert.equal(draft.changes.value, 1);
    draft.discard();
    assert.equal(draft.source.value, edited);
  });

  it("keeps the undo history across Keep: undo then reverts the kept edit as an unkept change", () => {
    const { draft } = setup("depth");
    assert.equal(draft.apply(move("occ", 0, 2), "Move Occluder").ok, true);
    assert.equal(draft.apply(move("occ", 0, 1), "Move Occluder").ok, true);
    const kept = draft.source.value;
    draft.markKept(testRevision("kept"));
    assert.equal(draft.changes.value, 0);
    assert.equal(draft.canUndo.value, true, "the kept edits stay undoable");
    assert.equal(draft.undo(), true);
    assert.equal(draft.dirty.value, true, "undoing past Keep is an unkept change");
    assert.equal(draft.changes.value, 1);
    assert.equal(draft.kept.value.source, kept, "the kept text stays the base");
    assert.equal(draft.undo(), true);
    assert.equal(draft.source.value, SOURCE);
    assert.equal(draft.changes.value, 2);
    assert.equal(draft.redo(), true);
    assert.equal(draft.redo(), true);
    assert.equal(draft.dirty.value, false, "redo back to the kept text is clean again");
    assert.equal(draft.changes.value, 0);
  });

  it("counts a change only when the bytes differ; a note change keeps the same bytes", async () => {
    const { draft } = setup("depth");
    const original = draft.compiled.value.bytes;
    assert.equal(
      draft.apply({ type: "setItemMeta", itemId: "occ", label: "Table" }, "Rename").ok,
      true,
    );
    assert.deepEqual([draft.changes.value, draft.notesOnly.value], [1, true]);
    assert.equal(changeCount(draft.changes.value, draft.notesOnly.value), "1 note change");

    const kept: PictureEdit[] = [];
    const keeper = useStudioKeep({
      draft,
      keep: async (baseRevision) => {
        kept.push(draftPictureEdit(draft, 5, baseRevision));
        return {
          status: "committed",
          projectId: null,
          revision: testRevision("notes"),
          authoring: authoringFingerprint(undefined),
        };
      },
    });
    assert.equal(await keeper.keep(), true);
    // The kept bytes are the stored ones: the transaction saves only the text.
    assert.deepEqual(kept[0]!.bytes, original);
    assert.equal(kept[0]!.reason, "1 note change");
    assert.match(kept[0]!.source, /# @item occ "Table" depth/);
    assert.deepEqual([draft.changes.value, draft.notesOnly.value], [0, false]);

    // A move changes the bytes: a change like any other, counted with the note after it.
    assert.equal(draft.apply(move("occ", 0, 1), "Move Occluder").ok, true);
    assert.equal(
      draft.apply({ type: "setItemMeta", itemId: "occ", locked: true }, "Lock").ok,
      true,
    );
    assert.deepEqual([draft.changes.value, draft.notesOnly.value], [2, false]);
    assert.equal(changeCount(2, false), "2 changes");
    assert.equal(draft.undo(), true);
    assert.equal(draft.undo(), true);
    assert.deepEqual([draft.dirty.value, draft.notesOnly.value], [false, false]);
  });

  it("names the items an operation edits and fresh ids for copies", () => {
    const { draft } = setup();
    const document = draft.document.value;
    assert.deepEqual(
      editedItems(document, { type: "setPoint", line: 12, pointIndex: 0, x: 1, y: 1 }),
      ["occ"],
    );
    assert.equal(freshItemId(document, "occ"), "occ-copy");
    const copied = draft.apply(
      { type: "duplicateItem", itemId: "edge", dx: 4, dy: 4, newId: "edge-copy", newLabel: "Copy" },
      "Duplicate",
    );
    assert.equal(copied.ok, true);
    assert.equal(freshItemId(draft.document.value, "edge"), "edge-copy-2");
  });
});

describe("useStudioDrag", () => {
  function dragRig() {
    const { draft } = setup("depth");
    const frames: (() => void)[] = [];
    const reports: boolean[] = [];
    let previews = 0;
    const moveGesture = draft.moveGesture;
    draft.moveGesture = (op) => {
      previews++;
      return moveGesture(op);
    };
    let selected: string | undefined;
    const drag = useStudioDrag({
      draft,
      editableId: () => selected,
      pick: () => (selected = "occ"),
      onSelection: ({ x, y }) => y >= 90 && y <= 105 && x >= 40 && x <= 119,
      labelOf: (id) => id,
      report: (outcome) => void reports.push(outcome.ok),
      frame: (callback) => frames.push(callback),
      cancelFrame: () => {},
    });
    const event = {} as PointerEvent;
    const at = (x: number, y: number) => ({ event, cell: { x, y }, handle: undefined });
    return { draft, drag, frames, reports, at, previews: () => previews };
  }

  it("previews once per animation frame however many moves arrive, and records one step", () => {
    const { draft, drag, frames, at, previews } = dragRig();
    drag.press(at(60, 95));
    for (let dx = 1; dx <= 5; dx++) drag.drag(at(60 + dx, 95));
    assert.equal(previews(), 0, "no kernel run per pointer move");
    assert.equal(frames.length, 1, "one frame requested for the burst");
    frames.shift()!();
    assert.equal(previews(), 1);
    assert.match(draft.preview.value!.source, /rect 45,90 124,105/);
    drag.drag(at(62, 96));
    drag.release(at(62, 96));
    assert.equal(line(draft, 12), "rect 42,91 121,106");
    assert.equal(draft.history.value.past.length, 1);
  });

  it("adds a point with an Alt+press by the line, placed by the drag, as one step each", () => {
    const { draft } = setup("walk");
    const frames: (() => void)[] = [];
    const drag = useStudioDrag({
      draft,
      editableId: () => "edge",
      pick: () => assert.fail("an Alt+press by the line keeps the selection"),
      onSelection: () => true,
      labelOf: (id) => id,
      report: (outcome) => assert.equal(outcome.ok, true),
      insertAt: (id, cell) => nearestInsertion(draft.document.value, id, cell),
      frame: (callback) => frames.push(callback),
      cancelFrame: () => {},
    });
    const alt = { altKey: true } as PointerEvent;
    const at = (x: number, y: number) => ({ event: alt, cell: { x, y }, handle: undefined });
    // A click under 80,140 on the edge 20,140-139,140 adds 80,140 there.
    drag.press(at(80, 141));
    assert.equal(drag.dragging.value, true);
    frames.shift()!();
    assert.match(draft.preview.value!.source, /line 20,140 80,140 139,140/);
    drag.release(at(80, 141));
    assert.equal(line(draft, 16), "line 20,140 80,140 139,140");
    // By 100,141 the nearest segment is now 80,140-139,140: the point, 100,140,
    // is its index 2; the drag carries it 9 rows down.
    drag.press(at(100, 141));
    drag.drag(at(100, 150));
    drag.release(at(100, 150));
    assert.equal(line(draft, 16), "line 20,140 80,140 100,149 139,140");
    assert.deepEqual(
      draft.history.value.past.map((step) => step.label),
      ["Add point to edge", "Add point to edge"],
    );
  });

  it("abandons a cancelled drag without a step", () => {
    const { draft, drag, frames, at } = dragRig();
    drag.press(at(60, 95));
    drag.drag(at(70, 95));
    frames.shift()!();
    assert.equal(drag.abort(), true);
    assert.equal(draft.source.value, SOURCE);
    assert.equal(draft.gesturing.value, false);
    assert.equal(draft.history.value.past.length, 0);
  });
});

describe("several items as one", () => {
  const both = (dx: number, dy: number) => [move("box", dx, dy), move("paint", dx, dy)];

  it("moves a batch as one undo step, the fill with its outline", () => {
    const { draft } = setup("art");
    assert.equal(draft.apply(both(4, -2), "Nudge 2 items").ok, true);
    assert.equal(line(draft, 3), "rect 14,8 34,28");
    assert.equal(line(draft, 7), "fill 24,18");
    assert.deepEqual(
      draft.history.value.past.map((step) => step.label),
      ["Nudge 2 items"],
    );
    assert.equal(draft.undo(), true);
    assert.equal(draft.source.value, SOURCE);
    // The outline alone, 20 px right, leaves the paint's seed outside: the red floods the room.
    const alone = draft.apply(move("box", 20, 0), "Move Box");
    assert.ok(!alone.ok && alone.refusal.kind === "lock");
    assert.equal(alone.refusal.message, "This would change another object's art.");
    assert.equal(draft.apply(both(20, 0), "Move 2 items").ok, true);
  });

  it("refuses the whole batch when one member breaks a lens lock", () => {
    const { draft } = setup("depth");
    const outcome = draft.apply([move("occ", 0, 1), move("box", 0, 1)], "Nudge 2 items");
    assert.ok(!outcome.ok && outcome.refusal.kind === "lock");
    assert.equal(
      outcome.refusal.message,
      "This would change the art, which is locked in the Depth lens.",
    );
    assert.equal(draft.source.value, SOURCE, "the occluder did not move either");
    assert.equal(draft.history.value.past.length, 0);
  });

  function editingRig(ids: string[] = ["box", "paint"]) {
    const { draft } = setup("art");
    const selectedId = ref<string | undefined>();
    const selection = { ids };
    const scope = effectScope();
    const editing = scope.run(() =>
      useStudioEditing({
        draft,
        selectedId,
        itemIds: () => selection.ids,
        selectItems: (next) => void (selection.ids = [...next]),
        frozen: () => false,
      }),
    )!;
    return { draft, editing, selection, scope };
  }

  it("nudges, duplicates and deletes the selection, each as one step", () => {
    const { draft, editing, selection, scope } = editingRig();
    assert.equal(editing.several.value, true);
    assert.equal(editing.nudge(4, -2), true);
    assert.equal(editing.nudge(0, 8), true);
    assert.equal(line(draft, 3), "rect 14,16 34,36");
    assert.deepEqual(
      draft.history.value.past.map((step) => step.label),
      ["Nudge 2 items", "Nudge 2 items"],
    );
    assert.equal(draft.undo() && draft.undo(), true);

    assert.equal(editing.duplicate(), true);
    assert.deepEqual(selection.ids, ["box-copy", "paint-copy"], "the copies are selected");
    assert.deepEqual(
      draft.document.value.items.map((item) => item.id),
      ["box", "box-copy", "paint", "paint-copy", "occ", "edge"],
    );
    assert.equal(draft.history.value.past.length, 1);
    assert.equal(draft.undo(), true);

    selection.ids = ["box", "paint"];
    assert.equal(editing.remove(), true);
    assert.deepEqual(selection.ids, []);
    assert.deepEqual(
      draft.document.value.items.map((item) => item.id),
      ["occ", "edge"],
    );
    assert.deepEqual(
      draft.history.value.past.map((step) => step.label),
      ["Delete 2 items"],
    );
    assert.equal(draft.undo(), true);
    assert.equal(draft.source.value, SOURCE);

    // Draw order moves one item at a time.
    selection.ids = ["box", "paint"];
    assert.equal(editing.reorder(1), false);
    assert.equal(
      editing.notice.value?.text,
      "Draw order changes one item at a time: select just one.",
    );
    scope.stop();
  });

  it("makes the selection one named item without changing a byte", () => {
    const { draft, editing, selection, scope } = editingRig();
    const bytes = draft.compiled.value.bytes;
    assert.equal(editing.combine("Red box"), true);
    assert.deepEqual(selection.ids, ["red-box"]);
    assert.deepEqual(
      draft.document.value.items.map((item) => [item.id, item.label, item.kind]),
      [
        ["red-box", "Red box", "art"],
        ["occ", "Occluder", "depth"],
        ["edge", "Floor edge", "walk"],
      ],
    );
    assert.deepEqual(draft.compiled.value.bytes, bytes);
    assert.deepEqual([draft.changes.value, draft.notesOnly.value], [1, true]);
    assert.deepEqual(
      draft.history.value.past.map((step) => step.label),
      ["Make one item Red box"],
    );
    // Not neighbours: the box and the occluder have the paint between them.
    selection.ids = ["red-box", "edge"];
    assert.equal(editing.combine("Group"), false);
    assert.equal(
      editing.notice.value?.text,
      "Only neighbours in the draw order can be made one item: select the items between them too.",
    );
    scope.stop();
  });

  it("drags the whole selection from any member's body, as one step, keeping it selected", () => {
    const { draft } = setup("art");
    const frames: (() => void)[] = [];
    const drag = useStudioDrag({
      draft,
      editableId: () => undefined,
      editableIds: () => ["box", "paint"],
      pick: () => assert.fail("a press on the selection keeps it"),
      onSelection: ({ x, y }) => x >= 10 && x <= 30 && y >= 10 && y <= 30,
      labelOf: (id) => id,
      report: (outcome) => assert.equal(outcome.ok, true),
      frame: (callback) => frames.push(callback),
      cancelFrame: () => {},
    });
    const event = {} as PointerEvent;
    const at = (x: number, y: number) => ({ event, cell: { x, y }, handle: undefined });
    drag.press(at(20, 20));
    drag.drag(at(24, 18));
    frames.shift()!();
    assert.match(draft.preview.value!.source, /fill 24,18/);
    drag.release(at(24, 18));
    assert.equal(line(draft, 3), "rect 14,8 34,28");
    assert.equal(line(draft, 7), "fill 24,18");
    assert.deepEqual(
      draft.history.value.past.map((step) => step.label),
      ["Move 2 items"],
    );
  });

  it("a click on the selection without a drag selects just the item clicked", () => {
    const { draft } = setup("art");
    const picked: { x: number; y: number }[] = [];
    const drag = useStudioDrag({
      draft,
      editableId: () => undefined,
      editableIds: () => ["box", "paint"],
      pick: (cell) => void picked.push(cell),
      onSelection: () => true,
      labelOf: (id) => id,
      report: () => {},
      frame: () => 0,
      cancelFrame: () => {},
    });
    const at = { event: {} as PointerEvent, cell: { x: 20, y: 20 }, handle: undefined };
    drag.press(at);
    assert.deepEqual(picked, [], "the press keeps the selection for a drag");
    drag.release(at);
    assert.deepEqual(picked, [{ x: 20, y: 20 }]);
    assert.equal(draft.history.value.past.length, 0);
  });

  it("Shift+click toggles the item under the pointer; Shift+drag draws a marquee", () => {
    const { draft } = setup("art");
    const toggled: { x: number; y: number }[] = [];
    const boxes: unknown[] = [];
    const drag = useStudioDrag({
      draft,
      editableId: () => "box",
      pick: () => assert.fail("Shift never replaces the selection"),
      onSelection: () => true,
      labelOf: (id) => id,
      report: () => {},
      extend: (cell) => void toggled.push(cell),
      marquee: (box) => void boxes.push(box),
      frame: () => 0,
      cancelFrame: () => {},
    });
    const shift = { shiftKey: true } as PointerEvent;
    const at = (x: number, y: number) => ({ event: shift, cell: { x, y }, handle: undefined });
    drag.press(at(20, 20));
    drag.release(at(20, 20));
    assert.deepEqual(toggled, [{ x: 20, y: 20 }]);
    drag.press(at(40, 30));
    drag.drag(at(5, 50));
    assert.deepEqual(drag.marqueeBox.value, { x1: 5, y1: 30, x2: 40, y2: 50 });
    drag.release(at(5, 50));
    assert.deepEqual(boxes, [{ x1: 5, y1: 30, x2: 40, y2: 50 }]);
    assert.equal(drag.marqueeBox.value, undefined);
    assert.equal(draft.history.value.past.length, 0, "selecting edits nothing");
  });
});
