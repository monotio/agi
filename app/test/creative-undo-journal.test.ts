import assert from "node:assert/strict";
import { test } from "node:test";
import { CreativeUndoJournal } from "../src/studio/creative/creativeUndoJournal.ts";

const W = 1000;

test("creative undo journal: edits capture once, gestures coalesce, undo and redo walk the chain", () => {
  const journal = new CreativeUndoJournal();
  assert.equal(journal.undoTarget(), null);
  assert.equal(journal.redoTarget(), null);

  // First edit mints a capture slot.
  const first = journal.step("import", 0, W);
  assert.deepEqual(first, { kind: "capture", seq: 1 });
  assert.equal(journal.pendingCaptures, 1);
  journal.persisted(1, "snap-a");

  // A different field is a new step; the same field inside the window
  // coalesces, so a drag is one step, not one row per pointermove.
  const second = journal.step("crop:underlay", 10, W);
  assert.equal(second.kind, "capture");
  if (second.kind === "capture") journal.persisted(second.seq, "snap-b");
  assert.equal(journal.step("crop:underlay", 20, W).kind, "coalesced");
  assert.equal(journal.step("crop:underlay", 30, W).kind, "coalesced");
  assert.deepEqual(journal.pastIds, ["snap-a", "snap-b"]);

  // After the window lapses the same field is a new step.
  const third = journal.step("crop:underlay", 30 + W + 1, W);
  assert.equal(third.kind, "capture");
  if (third.kind === "capture") journal.persisted(third.seq, "snap-c");

  // Undo walks the chain backwards; redo follows the displaced trail.
  assert.equal(journal.undoTarget(), "snap-c");
  journal.noteUndo("snap-c", "snap-live-1");
  assert.equal(journal.liveId, "snap-c");
  assert.equal(journal.undoTarget(), "snap-b");
  assert.equal(journal.redoTarget(), "snap-live-1");
  journal.noteUndo("snap-b", "snap-c");
  assert.equal(journal.undoTarget(), "snap-a");
  journal.noteRedo("snap-c", "snap-b");
  assert.equal(journal.liveId, "snap-c");
  assert.equal(journal.undoTarget(), "snap-b");
  journal.noteRedo("snap-live-1", "snap-c");
  assert.equal(journal.redoTarget(), null);
});

test("creative undo journal: a retained live state pushes instead of recapturing", () => {
  const journal = new CreativeUndoJournal();
  const step = journal.step("import", 0, W);
  assert.equal(step.kind, "capture");
  if (step.kind === "capture") journal.persisted(step.seq, "snap-a");

  // Restore puts the cursor on a retained row; editing adopts it as the
  // step's pre-state instead of writing a duplicate snapshot.
  journal.noteUndo("snap-a", "snap-b");
  const adopt = journal.step("crop:x", 10, W);
  assert.deepEqual(adopt, { kind: "retained", snapshotId: "snap-a" });
  assert.deepEqual(journal.pastIds, ["snap-a"]);
  assert.equal(journal.redoTarget(), null);
});

test("creative undo journal: branching after undo clears future but keeps past order", () => {
  const journal = new CreativeUndoJournal();
  for (const id of ["a", "b"]) {
    const step = journal.step(null, 0, W);
    assert.equal(step.kind, "capture");
    if (step.kind === "capture") journal.persisted(step.seq, id);
  }
  journal.noteUndo("b", "c");
  // The restored row is the new step's pre-state: it rejoins past, the redo
  // branch ends, and no duplicate snapshot is minted.
  const step = journal.step("edit", 10, W);
  assert.deepEqual(step, { kind: "retained", snapshotId: "b" });
  assert.deepEqual(journal.futureIds, []);
  assert.deepEqual(journal.pastIds, ["a", "b"]);
});

test("creative undo journal: failed captures leave a gap a retry fills in order", () => {
  const journal = new CreativeUndoJournal();
  const first = journal.step("import", 0, W);
  const second = journal.step("crop", 10, W);
  assert.equal(first.kind, "capture");
  assert.equal(second.kind, "capture");
  if (first.kind !== "capture" || second.kind !== "capture") return;
  journal.failed(first.seq);
  journal.persisted(second.seq, "snap-b");
  assert.deepEqual(journal.pastIds, ["snap-b"]);
  assert.equal(journal.pendingCaptures, 0);
  // The retry rejoins where the step was taken.
  journal.persisted(first.seq, "snap-a");
  assert.deepEqual(journal.pastIds, ["snap-a", "snap-b"]);
  assert.equal(journal.undoTarget(), "snap-b");
});

test("creative undo journal: hydrate reseeds from the retained index, drop forgets a row", () => {
  const journal = new CreativeUndoJournal();
  journal.hydrate(["snap-a", "snap-b"]);
  assert.equal(journal.undoTarget(), "snap-b");
  assert.equal(journal.redoTarget(), null);
  journal.noteUndo("snap-b", "snap-c");
  assert.equal(journal.liveId, "snap-b");
  journal.drop("snap-b");
  assert.equal(journal.liveId, null);
  assert.deepEqual(journal.pastIds, ["snap-a"]);
});

test("creative undo journal: explicit restore keeps the displaced state undoable", () => {
  const journal = new CreativeUndoJournal();
  for (const id of ["a", "b", "c"]) {
    const step = journal.step(null, 0, W);
    if (step.kind === "capture") journal.persisted(step.seq, id);
  }
  journal.noteRestore("a", "snap-live");
  assert.equal(journal.liveId, "a");
  assert.equal(journal.undoTarget(), "snap-live");
  assert.deepEqual(journal.pastIds, ["b", "c", "snap-live"]);
});
