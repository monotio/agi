import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";

test("a selected build includes coordinated changes and transitive dependencies, not unrelated drafts", () => {
  const draft = new ProjectDraft({
    "logic:1": "return;",
    "logic:2": "return;",
    "view:1": Uint8Array.of(1),
    words: "[]",
  });
  draft.apply(
    draft.propose(draft.capture(), "Add response", [
      { key: "logic:1", content: "response" },
      { key: "words", content: "look" },
    ]),
  );
  draft.edit("logic:2", "if (unfinished", draft.capture().version("logic:2"));
  draft.edit("view:1", Uint8Array.of(2), draft.capture().version("view:1"));
  const selected = draft.select(["logic:1"], { "logic:1": ["view:1"], "view:1": ["logic:1"] });
  assert.deepEqual(selected.keys, ["logic:1", "view:1", "words"]);
  const documents = selected.documents();
  assert.equal(documents["logic:1"], "response");
  assert.equal(documents["words"], "look");
  assert.equal(documents["logic:2"], "return;", "the build uses the kept unrelated room");
  assert.deepEqual(documents["view:1"], Uint8Array.of(2));
  (documents["view:1"] as Uint8Array)[0] = 9;
  assert.deepEqual(selected.documents()["view:1"], Uint8Array.of(2));
  assert.deepEqual(draft.dirtyKeys(), ["logic:1", "logic:2", "view:1", "words"]);
});

test("a save acknowledgement clears captured content, never newer typing", () => {
  const draft = new ProjectDraft({ "logic:1": "A", "logic:2": "X" });
  draft.edit("logic:1", "B", draft.capture().version("logic:1"));
  const selected = draft.select(["logic:1"]);
  draft.assertCurrent(selected); // Admission before the asynchronous durable write.
  draft.edit("logic:1", "C", draft.capture().version("logic:1"));
  draft.edit("logic:2", "Y", draft.capture().version("logic:2"));
  assert.throws(() => draft.assertCurrent(selected), /stale/i);
  assert.equal(draft.acknowledgeKept(selected), true);
  assert.deepEqual(draft.dirtyKeys(), ["logic:1", "logic:2"]);
  assert.equal(draft.capture().read("logic:1")!.content, "C");
  assert.equal(draft.select(["logic:2"]).documents()["logic:1"], "B");
  assert.equal(selected.documents()["logic:1"], "B", "the candidate remains frozen");
});

test("selection and save acknowledgement are workspace-scoped and duplicate ACKs are harmless", () => {
  const left = new ProjectDraft({ "logic:1": "A" });
  const right = new ProjectDraft({ "logic:1": "A" });
  left.edit("logic:1", "B", left.capture().version("logic:1"));
  const selected = left.select(["logic:1"]);
  assert.throws(() => right.acknowledgeKept(selected), /workspace/i);
  assert.throws(() => left.acknowledgeKept({ ...selected }), /workspace/i);
  assert.equal(left.acknowledgeKept(selected), true);
  assert.deepEqual(left.dirtyKeys(), []);
  left.edit("logic:1", "C", left.capture().version("logic:1"));
  assert.equal(left.acknowledgeKept(selected), true);
  assert.deepEqual(left.dirtyKeys(), ["logic:1"]);
});

test("a superseded selection cannot replace the latest kept base", () => {
  const draft = new ProjectDraft({ "logic:1": "A" });
  draft.edit("logic:1", "B", draft.capture().version("logic:1"));
  const old = draft.select(["logic:1"]);
  draft.edit("logic:1", "C", draft.capture().version("logic:1"));
  const latest = draft.select(["logic:1"]);
  assert.equal(draft.acknowledgeKept(latest), true);
  assert.equal(draft.acknowledgeKept(old), false);
  assert.deepEqual(draft.dirtyKeys(), []);
  assert.equal(draft.select([]).documents()["logic:1"], "C");
});

test("undo of a kept group becomes a new coordinated draft and a deleted document stays absent", () => {
  const draft = new ProjectDraft({ "logic:1": "A", words: "old", "view:1": Uint8Array.of(1) });
  const transaction = draft.apply(
    draft.propose(draft.capture(), "Coordinated edit", [
      { key: "logic:1", content: "B" },
      { key: "words", content: "new" },
      { key: "view:1", content: null },
    ]),
  );
  const selected = draft.select(["logic:1"]);
  assert.deepEqual(selected.keys, ["logic:1", "view:1", "words"]);
  assert.equal(selected.documents()["view:1"], undefined);
  assert.equal(draft.acknowledgeKept(selected), true);
  assert.deepEqual(draft.dirtyKeys(), []);
  draft.undo(transaction.id);
  assert.deepEqual(draft.select(["words"]).keys, ["logic:1", "view:1", "words"]);
  assert.deepEqual(draft.dirtyKeys(), ["logic:1", "view:1", "words"]);
});

test("a fully reverted group no longer couples later independent edits", () => {
  const draft = new ProjectDraft({ "logic:1": "A", words: "old" });
  const transaction = draft.apply(
    draft.propose(draft.capture(), "Change both", [
      { key: "logic:1", content: "B" },
      { key: "words", content: "new" },
    ]),
  );
  draft.undo(transaction.id);
  draft.edit("logic:1", "C", draft.capture().version("logic:1"));
  draft.edit("words", "unrelated", draft.capture().version("words"));
  assert.deepEqual(draft.select(["logic:1"]).keys, ["logic:1"]);
  assert.equal(draft.select(["logic:1"]).documents()["words"], "old");
});
