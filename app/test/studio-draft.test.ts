import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ref } from "vue";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { testRevision } from "./identity.ts";
import { NO_UNLOCKS, type LensUnlocks } from "../src/studio/studioLocks.ts";
import type { StudioLens } from "../src/studio/studioView.ts";
import { useStudioDrag } from "../src/studio/useStudioDrag.ts";
import {
  changeCount,
  editedItems,
  freshItemId,
  useStudioDraft,
} from "../src/studio/useStudioDraft.ts";
import { useStudioKeep } from "../src/studio/useStudioKeep.ts";
import type { PictureEdit } from "../src/resourceCommit.ts";

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
      pictureNumber: () => 5,
      keep: async (edit) => {
        kept.push(edit);
        return { status: "committed", projectId: null, revision: testRevision("notes") };
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
