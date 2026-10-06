import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectScope, nextTick, ref, shallowRef } from "vue";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { testRevision } from "./identity.ts";
import { NO_UNLOCKS, type LensUnlocks } from "../src/studio/studioLocks.ts";
import type { StudioLens } from "../src/studio/studioView.ts";
import { nearestInsertion } from "../../src/studio/editPoints.ts";
import { movedWith, sideEffectNote } from "../src/studio/studioMessages.ts";
import { keyLabel } from "../src/ui/keyLabel.ts";
import { useStudioDrag } from "../src/studio/useStudioDrag.ts";
import { useStudioEditing } from "../src/studio/useStudioEditing.ts";
import {
  changeCount,
  draftPictureEdit,
  type DraftOutcome,
  editedItems,
  freshItemId,
  useStudioDraft,
} from "../src/studio/useStudioDraft.ts";
import { useStudioKeep } from "../src/studio/useStudioKeep.ts";
import { useUndoOrder } from "../src/studio/useUndoOrder.ts";
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

/** A mixed pond: water art and a barrier (priority 0) far below it. */
const POND = [
  '# @item pond "Pond" mixed', //  1
  "vis 1", //                      2
  "rect 20,20 40,30", //           3
  "vis off", //                    4
  "pri 0", //                      5
  "line 20,100 40,100", //         6
  "# @end", //                     7
  "end", //                        8
].join("\n");

function setupWith(source: string, lens: StudioLens) {
  const base = ref({ source, revision: testRevision("draft") });
  return {
    draft: useStudioDraft({ base, profile: DEFAULT_V2_PROFILE, lens, unlocks: NO_UNLOCKS }),
  };
}

const move = (itemId: string, dx: number, dy: number) =>
  ({ type: "moveItem", itemId, dx, dy }) as const;
const line = (draft: ReturnType<typeof setup>["draft"], n: number) =>
  draft.source.value.split("\n")[n - 1];

describe("useStudioDraft", () => {
  it("keeps the shared undo order exact when its history drops steps at the depth cap", () => {
    const base = ref({ source: SOURCE, revision: testRevision("draft") });
    const scope = effectScope();
    const run = scope.run(() => {
      const draft = useStudioDraft({
        base,
        profile: DEFAULT_V2_PROFILE,
        lens: "depth",
        unlocks: NO_UNLOCKS,
        historyDepth: 2,
      });
      // The door history: counted steps, both counts changing in one assignment.
      const door = shallowRef({ past: 0, future: 0 });
      const order = useUndoOrder([
        {
          past: () => draft.history.value.past.length,
          future: () => draft.history.value.future.length,
          dropped: () => draft.dropped.value,
          undo: draft.undo,
          redo: draft.redo,
        },
        {
          past: () => door.value.past,
          future: () => door.value.future,
          undo: () => {
            const { past, future } = door.value;
            if (past === 0) return false;
            door.value = { past: past - 1, future: future + 1 };
            return true;
          },
          redo: () => {
            const { past, future } = door.value;
            if (future === 0) return false;
            door.value = { past: past + 1, future: future - 1 };
            return true;
          },
        },
      ]);
      return { draft, door, order };
    })!;
    const { draft, door, order } = run;
    const picture = () => assert.equal(draft.apply(move("occ", 1, 0), "Move Occluder").ok, true);
    const doorStep = () => void (door.value = { past: door.value.past + 1, future: 0 });
    // Picture, door, picture, picture (the cap drops the first), door, picture (drops another).
    picture();
    doorStep();
    picture();
    picture();
    doorStep();
    picture();
    assert.equal(draft.history.value.dropped, 2);
    const trail: string[] = [];
    const mark = () => trail.push(`${draft.history.value.past.length}${door.value.past}`);
    while (order.undo()) mark();
    while (order.redo()) mark();
    // Newest first: picture, door, picture, door; then redo walks them back.
    assert.deepEqual(trail, ["12", "11", "01", "00", "01", "11", "12", "22"]);
    scope.stop();
  });

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
    assert.equal(
      end.refusal.message,
      "Part of the item would leave the picture. Move it closer to the centre.",
    );
    assert.match(end.refusal.detail ?? "", /off the surface at 164,105/);
    assert.equal(draft.source.value, SOURCE);
    assert.equal(draft.history.value.past.length, 0);
    assert.equal(draft.gesturing.value, false);
    assert.equal(draft.canUndo.value, false);
  });

  it("refuses painting on a lens-locked plane, in plain words with the count and box as detail", () => {
    const { draft, lens, unlocks } = setup("depth");
    // Recolouring the box's art in the Depth lens: its outline, 21 + 21 + 19 + 19 cells.
    const art = draft.apply(
      { type: "setItemColor", itemId: "box", plane: "visual", value: 2 },
      "Colour Box",
    );
    assert.ok(!art.ok && art.refusal.kind === "lock");
    assert.equal(art.refusal.message, "Visual is locked in the Priority lens.");
    assert.equal(
      art.refusal.detail,
      "Visual is locked in the Priority lens: 80 cells at 10,10..30,30 would change.",
    );
    assert.ok(art.refusal.cells.includes(1));
    assert.equal(draft.source.value, SOURCE);

    // The occluder's depth in the Art lens: its outline, 80 + 80 + 14 + 14 cells.
    lens.value = "art";
    const priority = { type: "setItemColor", itemId: "occ", plane: "priority", value: 12 } as const;
    const depth = draft.apply(priority, "Priority 12");
    assert.ok(!depth.ok && depth.refusal.kind === "lock");
    assert.equal(depth.refusal.message, "Priority is locked in the Visual lens.");
    assert.equal(
      depth.refusal.detail,
      "Priority is locked in the Visual lens: 188 cells at 40,90..119,105 would change.",
    );
    // A point of its outline is editing within the plane too.
    const point = draft.apply(
      { type: "setPoint", line: 12, pointIndex: 0, x: 41, y: 90 },
      "Move point",
    );
    assert.ok(!point.ok && point.refusal.kind === "lock");
    unlocks.value = { ...NO_UNLOCKS, priority: true };
    assert.equal(draft.apply(priority, "Priority 12").ok, true);
  });

  it("moves, copies and deletes whole items with every plane they draw, in any lens", () => {
    const { draft, unlocks } = setup("depth");
    // The box's art moves in the Depth lens; the occluder's depth in the Art lens.
    assert.equal(draft.apply(both(), "Move 2 items").ok, true);
    assert.equal(line(draft, 3), "rect 10,11 30,31");
    assert.deepEqual(unlocks.value, NO_UNLOCKS, "the locks stay as they were");
    const mixed = setupWith(POND, "art");
    // The pond's water and the barrier far below it move as one step.
    assert.equal(mixed.draft.apply(move("pond", 5, -3), "Move Pond").ok, true);
    assert.equal(line(mixed.draft, 3), "rect 25,17 45,27");
    assert.equal(line(mixed.draft, 6), "line 25,97 45,97");
    assert.equal(mixed.draft.history.value.past.length, 1);
    const copy = {
      type: "duplicateItem",
      itemId: "pond",
      dx: 60,
      dy: 0,
      newId: "pond-copy",
      newLabel: "Pond copy",
    } as const;
    assert.equal(mixed.draft.apply(copy, "Duplicate Pond").ok, true);
    assert.equal(
      mixed.draft.apply({ type: "deleteItem", itemId: "pond-copy" }, "Delete Pond copy").ok,
      true,
    );
    // Its barrier alone still follows the lock: that is painting depth.
    const paint = mixed.draft.apply(
      { type: "setItemColor", itemId: "pond", plane: "priority", value: 3 },
      "Priority 3",
    );
    assert.ok(!paint.ok && paint.refusal.kind === "lock");
    assert.equal(paint.refusal.message, "Priority is locked in the Visual lens.");
    // So does a fill that would flood depth along with the art.
    const fill = mixed.draft.apply(
      {
        type: "insertFill",
        atLine: 8,
        x: 80,
        y: 150,
        visual: 2,
        priority: 9,
        id: "flood",
        label: "Flood",
      },
      "Fill",
    );
    assert.ok(!fill.ok && fill.refusal.kind === "lock");
    assert.equal(fill.refusal.message, "Priority is locked in the Visual lens.");
    assert.equal(mixed.draft.history.value.past.length, 3);
    function both() {
      return [move("box", 0, 1), move("paint", 0, 1)];
    }
  });

  it("says when a move took along lines the lens hides", () => {
    const { draft } = setupWith(POND, "art");
    const scope = effectScope();
    const lens = ref<StudioLens>("art");
    const editing = scope.run(() =>
      useStudioEditing({
        draft,
        selectedId: ref("pond"),
        frozen: () => false,
        lens: () => lens.value,
      }),
    )!;
    assert.equal(editing.nudge(1, 0), true);
    assert.equal(editing.notice.value?.text, "Moved Pond with its walk lines.");
    // The Depth lens shows the barrier and hides the water.
    lens.value = "depth";
    assert.equal(editing.nudge(1, 0), true);
    assert.equal(editing.notice.value?.text, "Moved Pond with its visual.");
    scope.stop();
    assert.equal(
      movedWith("3 items", true, ["priority", "walk lines"]),
      "Moved 3 items with their priority and walk lines.",
    );
    assert.equal(movedWith("Box", false, []), null);
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
    assert.equal(paint.refusal.message, "The Walk lens draws walk lines 0–3 only.");
    assert.match(paint.refusal.detail, /^Depth values 4–15 are locked in the Walk lens: 120 cells/);
    // Reshaping the occluder changes depth; moving it whole carries its depth.
    const reshape = { type: "setPoint", line: 12, pointIndex: 0, x: 44, y: 92 } as const;
    assert.ok(!draft.apply(reshape, "Move point").ok);
    assert.equal(draft.apply(move("occ", 1, 0), "Move Occluder").ok, true);
    unlocks.value = { ...NO_UNLOCKS, depthInWalk: true };
    assert.equal(draft.apply(reshape, "Move point").ok, true);
    assert.equal(draft.changes.value, 3);
  });

  it("lands an edit that changes another item's output, as one step with its side effects", () => {
    const { draft } = setup("art");
    // The box 20 right leaves the paint's seed outside it: the red floods the
    // room. Refused before side effects were reported. Every cell turns red
    // but the old and new boxes' 441 each, which share column 30 (861 in
    // all): 26,019 cells, none of them the box's own. The new box's inside
    // stays white, the old one's red.
    const result = draft.apply(move("box", 20, 0), "Move Box");
    assert.ok(result.ok);
    assert.deepEqual(result.sideEffects?.items, [
      { itemId: "paint", label: "Paint", cells: 26019, fill: true },
    ]);
    assert.deepEqual(
      result.sideEffects?.effects.map((e) => [e.plane, e.count, e.bbox]),
      [["art", 26019, { x0: 0, y0: 0, x1: 159, y1: 167 }]],
    );
    assert.deepEqual(
      draft.history.value.past.map((step) => step.label),
      ["Move Box"],
    );
    assert.equal(draft.undo(), true);
    assert.equal(draft.source.value, SOURCE);
    // An edit that changes nothing else carries no report.
    const own = draft.apply(move("occ", 0, 1), "Move Occluder");
    assert.deepEqual(own, { ok: true });
  });

  it("works out a drag's side effects once, when it ends", () => {
    const { draft } = setup("art");
    draft.beginGesture("Move Box");
    const frame = draft.moveGesture(move("box", 20, 0));
    assert.deepEqual(frame, { ok: true }, "a preview frame skips the report");
    const ended = draft.endGesture(move("box", 20, 0), "Move Box");
    assert.ok(ended.ok);
    assert.equal(ended.sideEffects?.cells, 26019);
    assert.equal(draft.history.value.past.length, 1);
  });

  it("a matching saved source retains the next picture gesture and undo steps", async () => {
    const { draft, base } = setup("art");
    assert.ok(draft.apply({ type: "moveItem", itemId: "box", dx: 1, dy: 0 }, "Nudge").ok);
    const saved = draft.source.value;
    draft.beginGesture("Move");
    draft.moveGesture({ type: "moveItem", itemId: "box", dx: 0, dy: 1 });
    base.value = { source: saved, revision: testRevision("saved-picture") };
    await nextTick();
    assert.equal(draft.gesturing.value, true);
    assert.ok(draft.endGesture({ type: "moveItem", itemId: "box", dx: 0, dy: 1 }, "Move").ok);
    assert.equal(draft.history.value.past.length, 2);
  });

  it("clears an edit notice when project Undo restores the source", async () => {
    const scope = effectScope();
    const { draft, base, editing } = scope.run(() => {
      const state = setup("art");
      return {
        ...state,
        editing: useStudioEditing({
          draft: state.draft,
          selectedId: ref("box"),
          frozen: () => false,
          lens: () => "art",
        }),
      };
    })!;
    assert.equal(editing.nudge(20, 0), true);
    const notice = editing.notice.value;
    assert.ok(notice);
    base.value = { source: draft.source.value, revision: testRevision("saved") };
    await nextTick();
    assert.equal(editing.notice.value, notice, "autosave retains the edit's notice");
    base.value = { source: SOURCE, revision: testRevision("restored") };
    await nextTick();
    assert.equal(draft.source.value, SOURCE);
    assert.equal(editing.notice.value, null);
    scope.stop();
  });

  it("says in the status line what else changed, with the undo key, and clears it after", () => {
    const { draft } = setup("art");
    const scope = effectScope();
    const editing = scope.run(() =>
      useStudioEditing({ draft, selectedId: ref("box"), frozen: () => false, lens: () => "art" }),
    )!;
    assert.equal(editing.nudge(20, 0), true);
    assert.equal(
      editing.notice.value?.text,
      `Paint flows differently: 26,019 cells changed. ${keyLabel("Mod+Z")} undoes it.`,
    );
    assert.equal(editing.notice.value?.tone, "ok");
    assert.equal(
      editing.notice.value?.detail,
      "Side effects: other items' art changes. Paint: 26019 cells at 0,0..159,167 (its fill re-pours).",
    );
    assert.equal(editing.undo(), true);
    assert.equal(editing.notice.value, null);
    assert.equal(draft.source.value, SOURCE);
    scope.stop();
    const several = {
      items: [
        { itemId: "a", label: "A", cells: 2, fill: true },
        { itemId: "b", label: "B", cells: 1, fill: false },
        { itemId: null, label: "Loose steps", cells: 1, fill: false },
      ],
      effects: [],
      cells: 17802,
      mask: new Uint8Array(0),
    };
    assert.equal(
      sideEffectNote(several, "⌘Z"),
      "3 other items change: 17,802 cells. ⌘Z undoes it.",
    );
    assert.equal(
      sideEffectNote({ ...several, items: several.items.slice(1, 2), cells: 1 }, "Ctrl+Z"),
      "B changes too: 1 cell. Ctrl+Z undoes it.",
    );
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
  /** Occ, the priority-10 outline at 40..119 by 90..105, starts selected unless `fresh`. */
  function dragRig(fresh = false) {
    const { draft } = setup("depth");
    const frames: (() => void)[] = [];
    const reports: DraftOutcome[] = [];
    const calls: string[] = [];
    let previews = 0;
    const moveGesture = draft.moveGesture;
    draft.moveGesture = (op) => {
      previews++;
      return moveGesture(op);
    };
    let selected = fresh ? undefined : "occ";
    const drag = useStudioDrag({
      draft,
      editableId: () => selected,
      pick: ({ x, y }) => {
        calls.push(`pick ${x},${y}`);
        selected = "occ";
      },
      extend: ({ x, y }) => void calls.push(`extend ${x},${y}`),
      marquee: (box, add) =>
        void calls.push(`${add ? "add" : "box"} ${box.x1},${box.y1} ${box.x2},${box.y2}`),
      clear: () => {
        calls.push("clear");
        selected = undefined;
      },
      onSelection: ({ x, y }) => selected === "occ" && y >= 90 && y <= 105 && x >= 40 && x <= 119,
      labelOf: (id) => id,
      report: (outcome) => void reports.push(outcome),
      frame: (callback) => frames.push(callback),
      cancelFrame: () => {},
    });
    const event = {} as PointerEvent;
    const shift = { shiftKey: true } as PointerEvent;
    const at = (x: number, y: number, pressed = event) => ({
      event: pressed,
      cell: { x, y },
      handle: undefined,
    });
    return {
      draft,
      drag,
      frames,
      reports,
      calls,
      at,
      shift,
      previews: () => previews,
      selected: () => selected,
    };
  }

  it("draws a box that replaces the selection from a press off the selection, moving nothing", () => {
    const { draft, drag, frames, calls, at } = dragRig(true);
    // 60,95 is Occ's own pixel, but Occ is not selected: the drag selects.
    drag.press(at(60, 95));
    drag.drag(at(20, 80));
    assert.deepEqual(drag.marqueeBox.value, { x1: 20, y1: 80, x2: 60, y2: 95 });
    assert.equal(drag.dragging.value, false);
    assert.equal(frames.length, 0, "no preview");
    drag.release(at(10, 70));
    assert.equal(drag.marqueeBox.value, undefined);
    assert.deepEqual(calls, ["box 10,70 60,95"]);
    assert.equal(draft.source.value, SOURCE);
    assert.equal(draft.history.value.past.length, 0);
  });

  it("adds with a Shift box, even from the selection, and toggles with a Shift+click", () => {
    const { drag, calls, at, shift } = dragRig();
    drag.press(at(60, 95, shift));
    drag.drag(at(70, 100, shift));
    drag.release(at(70, 100, shift));
    drag.press(at(12, 12, shift));
    drag.release(at(12, 12, shift));
    assert.deepEqual(calls, ["add 60,95 70,100", "extend 12,12"]);
  });

  it("selects the item under a click, on the selection or off it", () => {
    const { drag, calls, at, draft } = dragRig();
    drag.press(at(60, 95));
    drag.release(at(60, 95));
    drag.press(at(12, 12));
    drag.release(at(12, 12));
    assert.deepEqual(calls, ["pick 60,95", "pick 12,12"]);
    assert.equal(draft.gesturing.value, false);
  });

  it("clears the selection with a click in the margin, and draws a box from it", () => {
    const { drag, calls, at, shift, selected } = dragRig();
    drag.press(at(-6, 40));
    drag.release(at(-6, 40));
    assert.equal(selected(), undefined);
    // A drag from beyond the right edge: the box is cut to the picture.
    drag.press(at(170, -3));
    drag.drag(at(150, 20));
    assert.deepEqual(drag.marqueeBox.value, { x1: 150, y1: 0, x2: 159, y2: 20 });
    drag.release(at(150, 20));
    drag.press(at(-2, 30, shift));
    drag.drag(at(5, 35, shift));
    drag.release(at(5, 35, shift));
    // A Shift+click in the margin changes nothing.
    drag.press(at(-2, 30, shift));
    drag.release(at(-2, 30, shift));
    assert.deepEqual(calls, ["clear", "box 150,0 159,20", "add 0,30 5,35"]);
  });

  it("stops a move at the picture's edge, in the preview and the step alike", () => {
    const { draft, drag, frames, reports, at } = dragRig();
    // Occ's right side is at 119: 100 px right stops after 40.
    drag.press(at(60, 95));
    drag.drag(at(160, 95));
    frames.shift()!();
    assert.match(draft.preview.value!.source, /rect 80,90 159,105/);
    drag.release(at(160, 97));
    assert.equal(line(draft, 12), "rect 80,92 159,107");
    assert.deepEqual(
      reports.map((outcome) => outcome.ok),
      [true, true],
    );
    assert.equal(draft.history.value.past.length, 1);
    // At the edge, a drag further right goes nowhere and says which item is there.
    drag.press(at(100, 100));
    drag.drag(at(110, 100));
    frames.shift()!();
    drag.release(at(110, 100));
    const stopped = reports.at(-1)!;
    assert.ok(!stopped.ok && stopped.refusal.kind === "kernel");
    assert.equal(
      stopped.refusal.message,
      "Occluder is at the picture's right edge. Move it inward.",
    );
    assert.match(stopped.refusal.detail ?? "", /moving by 10,0: "Occluder" is at the right edge/);
    assert.equal(line(draft, 12), "rect 80,92 159,107");
    assert.equal(draft.history.value.past.length, 1);
    assert.equal(draft.gesturing.value, false);
  });

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
    assert.ok(alone.ok);
    assert.equal(alone.sideEffects?.items[0]?.label, "Paint");
    assert.equal(draft.undo(), true);
    // Together, the paint moves with its outline: nothing else changes.
    assert.deepEqual(draft.apply(both(20, 0), "Move 2 items"), { ok: true });
  });

  it("refuses the whole batch when one member breaks a lens lock", () => {
    const { draft } = setup("depth");
    const outcome = draft.apply(
      [
        { type: "setItemColor", itemId: "occ", plane: "priority", value: 11 },
        { type: "setItemColor", itemId: "box", plane: "visual", value: 3 },
      ],
      "Colour 2 items",
    );
    assert.ok(!outcome.ok && outcome.refusal.kind === "lock");
    assert.equal(outcome.refusal.message, "Visual is locked in the Priority lens.");
    assert.equal(draft.source.value, SOURCE, "the occluder did not change either");
    assert.equal(draft.history.value.past.length, 0);
  });

  function editingRig(
    ids: string[] = ["box", "paint"],
    doors: readonly { item: string; label: string }[] = [],
  ) {
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
        doors: () => doors,
      }),
    )!;
    return { draft, editing, selection, selectedId, scope };
  }

  it("stops a nudge at the picture's edge, and says which item is there", () => {
    const { draft, editing, scope } = editingRig();
    // The box's left side is at 10: 15 px left stops after 10, and the paint's seed goes along.
    assert.equal(editing.nudge(-15, 0), true);
    assert.equal(line(draft, 3), "rect 0,10 20,30");
    assert.equal(line(draft, 7), "fill 10,20");
    assert.equal(editing.nudge(-1, 0), false);
    assert.equal(editing.notice.value?.text, "Box is at the picture's left edge. Move it inward.");
    assert.equal(draft.history.value.past.length, 1);
    scope.stop();
  });

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
    assert.equal(editing.notice.value?.text, "Select one item to change its draw order.");
    scope.stop();
  });

  it("groups the selection as one named item and ungroups it, without changing a byte", () => {
    const { draft, editing, selection, selectedId, scope } = editingRig();
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
      ["Group Red box"],
    );
    // Ungroup gives the members back as they were, selected, in one more step.
    const grouped = draft.source.value;
    selection.ids = ["red-box"];
    selectedId.value = "red-box";
    assert.equal(editing.grouped.value, true);
    assert.equal(editing.ungroup(), true);
    assert.equal(draft.source.value, SOURCE);
    assert.deepEqual(selection.ids, ["box", "paint"]);
    assert.deepEqual(draft.compiled.value.bytes, bytes);
    assert.equal(draft.history.value.past.at(-1)?.label, "Ungroup Red box");
    assert.equal(draft.undo(), true);
    assert.equal(draft.source.value, grouped);
    // Not neighbours: the box and the occluder have the paint between them.
    selection.ids = ["red-box", "edge"];
    assert.equal(editing.combine("Group"), false);
    assert.equal(
      editing.notice.value?.text,
      "Group takes neighbours in the draw order. Include the items between them.",
    );
    scope.stop();
  });

  it("keeps a followed member's id on Group, and says when Ungroup can't give it back", () => {
    const door = { item: "paint", label: "Door to room 2" };
    const { draft, editing, selection, selectedId, scope } = editingRig(["box", "paint"], [door]);
    assert.equal(editing.combine("Red box"), true);
    assert.deepEqual(selection.ids, ["paint"], "the group takes the id the door follows");
    assert.equal(draft.document.value.items[0]!.label, "Red box");
    // Grouped again with the occluder, the member's id rides along once more.
    selection.ids = ["paint", "occ"];
    assert.equal(editing.combine("Corner"), true);
    assert.deepEqual(selection.ids, ["paint"]);
    // A group of groups ungroups into drawing elements: the door's art is gone.
    selectedId.value = "paint";
    assert.equal(editing.ungroup(), true);
    assert.ok(!draft.document.value.items.some((item) => item.id === "paint"));
    assert.deepEqual(editing.notice.value, {
      tone: "warn",
      text: "Door to room 2 stays put now: Ungroup split Red box into items.",
    });
    // One level down, Ungroup gives the members their ids back and the door keeps its art.
    assert.equal(draft.undo(), true);
    assert.equal(draft.undo(), true);
    editing.say(null);
    selectedId.value = "paint";
    assert.equal(editing.ungroup(), true);
    assert.equal(draft.source.value, SOURCE);
    assert.notEqual(editing.notice.value?.tone, "warn");
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
