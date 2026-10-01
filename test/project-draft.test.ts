import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";

test("a proposal owns its content and applies a coordinated edit atomically", () => {
  const picture = Uint8Array.of(255);
  const draft = new ProjectDraft({ "logic:1": "return;", "picture:1": picture, words: "[]" });
  picture[0] = 0;
  const base = draft.capture();
  const bytes = Uint8Array.of(240, 2, 255);
  const proposal = draft.propose(base, "Add a command", [
    { key: "logic:1", content: 'if (said("look")) { print("Hello"); }' },
    { key: "words", content: '[["look",100]]' },
    { key: "picture:1", content: bytes },
  ]);
  bytes[0] = 0;
  const displayed = proposal.changes()[2]!.content as Uint8Array;
  displayed[0] = 1;
  assert.deepEqual(base.read("picture:1")!.content, Uint8Array.of(255));
  const applied = draft.apply(proposal);
  assert.equal(applied.label, "Add a command");
  assert.equal(applied.keys.length, 3);
  assert.deepEqual(draft.capture().read("picture:1")!.content, Uint8Array.of(240, 2, 255));
  assert.equal(draft.capture().read("words")!.content, '[["look",100]]');
  assert.equal(base.read("words")!.content, "[]", "captured inputs stay immutable");
  assert.equal(proposal.base.read("words")!.content, "[]", "diffs retain their exact before image");
  assert.throws(() => draft.apply(proposal), /stale|already/i);
});

test("typing in a consulted document invalidates the whole proposal without partial writes", () => {
  const draft = new ProjectDraft({ "logic:1": "return;", words: "[]" });
  const base = draft.capture();
  const proposal = draft.propose(base, "Respond", [
    { key: "logic:1", content: "increment(v40); return;" },
  ]);
  draft.edit("words", '[["look",100]]', base.version("words"));
  assert.throws(() => draft.apply(proposal), /stale/i);
  assert.equal(draft.capture().read("logic:1")!.content, "return;");
  assert.equal(draft.capture().read("words")!.content, '[["look",100]]');
});

test("delete and recreate cannot recycle a document version or revive an old edit", () => {
  const draft = new ProjectDraft({ "logic:1": "return;" });
  const opened = draft.capture();
  draft.edit("logic:1", null, opened.version("logic:1"));
  const removed = draft.capture();
  assert.equal(removed.read("logic:1"), undefined);
  assert.ok(removed.version("logic:1") > opened.version("logic:1"));
  draft.edit("logic:1", "return;", removed.version("logic:1"));
  assert.throws(() => draft.edit("logic:1", "quit(0);", opened.version("logic:1")), /stale/i);
  assert.equal(draft.capture().read("logic:1")!.content, "return;");
});

test("foreign snapshots and copied proposal objects cannot authorize a write", () => {
  const left = new ProjectDraft({ "logic:1": "return;" });
  const right = new ProjectDraft({ "logic:1": "return;" });
  const base = left.capture();
  assert.throws(() => right.propose(base, "Wrong project", []), /workspace/i);
  const proposal = left.propose(base, "Edit", [{ key: "logic:1", content: "" }]);
  assert.throws(() => right.apply(proposal), /workspace/i);
  assert.throws(() => left.apply({ ...proposal }), /workspace/i);
});

test("named undo and redo cover every participant while unrelated typing survives", () => {
  const draft = new ProjectDraft({ "logic:1": "return;", "logic:2": "return;", words: "[]" });
  const transaction = draft.apply(
    draft.propose(draft.capture(), "Add response", [
      { key: "logic:1", content: "// response\nreturn;" },
      { key: "words", content: '[["look",100]]' },
      { key: "view:1", content: Uint8Array.of(1, 2) },
    ]),
  );
  draft.edit("logic:2", "// unfinished", draft.capture().version("logic:2"));
  draft.undo(transaction.id);
  assert.equal(draft.capture().read("logic:1")!.content, "return;");
  assert.equal(draft.capture().read("words")!.content, "[]");
  assert.equal(draft.capture().read("view:1"), undefined);
  assert.equal(draft.capture().read("logic:2")!.content, "// unfinished");
  draft.redo(transaction.id);
  assert.equal(draft.capture().read("words")!.content, '[["look",100]]');
  assert.deepEqual(draft.capture().read("view:1")!.content, Uint8Array.of(1, 2));
  assert.throws(() => draft.redo(transaction.id), /applied|redo/i);
});

test("undo conflicts preserve later edits and do not roll back other participants", () => {
  const draft = new ProjectDraft({ "logic:1": "return;", words: "[]" });
  const transaction = draft.apply(
    draft.propose(draft.capture(), "Add response", [
      { key: "logic:1", content: "// response\nreturn;" },
      { key: "words", content: '[["look",100]]' },
    ]),
  );
  draft.edit("logic:1", "// user typing", draft.capture().version("logic:1"));
  assert.throws(() => draft.undo(transaction.id), /conflict/i);
  assert.equal(draft.capture().read("logic:1")!.content, "// user typing");
  assert.equal(draft.capture().read("words")!.content, '[["look",100]]');
});

test("invalid batches fail before any edit and identical content is a no-op", () => {
  const draft = new ProjectDraft({ "logic:1": "return;" });
  const before = draft.capture();
  assert.throws(
    () =>
      draft.propose(before, "Duplicate", [
        { key: "logic:1", content: "" },
        { key: "logic:1", content: "return;" },
      ]),
    /duplicate/i,
  );
  assert.throws(
    () =>
      draft.propose(before, "Bad target", [
        { key: "logic:1", content: "" },
        { key: "logic:999", content: "" },
      ]),
    /document/i,
  );
  draft.edit("logic:1", "return;", before.version("logic:1"));
  assert.equal(draft.capture().revision, before.revision);
  assert.equal(draft.capture().read("logic:1")!.content, "return;");
});

test("sequential transaction undo/redo restores history without recycling document versions", () => {
  const draft = new ProjectDraft({ "logic:1": "A", words: "[]" });
  const first = draft.apply(
    draft.propose(draft.capture(), "First", [
      { key: "logic:1", content: "B" },
      { key: "words", content: "first" },
    ]),
  );
  const second = draft.apply(
    draft.propose(draft.capture(), "Second", [{ key: "logic:1", content: "C" }]),
  );
  const latestVersion = draft.capture().version("logic:1");
  draft.undo(second.id);
  draft.undo(first.id);
  assert.equal(draft.capture().read("logic:1")!.content, "A");
  assert.equal(draft.capture().read("words")!.content, "[]");
  assert.ok(draft.capture().version("logic:1") > latestVersion);
  draft.redo(first.id);
  draft.redo(second.id);
  assert.equal(draft.capture().read("logic:1")!.content, "C");
  assert.equal(draft.capture().read("words")!.content, "first");
});

test("typing away and back to identical text does not authorize a history rollback", () => {
  const draft = new ProjectDraft({ "logic:1": "A" });
  const transaction = draft.apply(
    draft.propose(draft.capture(), "First", [{ key: "logic:1", content: "B" }]),
  );
  draft.edit("logic:1", "C", draft.capture().version("logic:1"));
  draft.edit("logic:1", "B", draft.capture().version("logic:1"));
  assert.throws(() => draft.undo(transaction.id), /conflict/i);
  assert.equal(draft.capture().read("logic:1")!.content, "B");
});

test("an old workspace transaction cannot undo an identically numbered new transaction", () => {
  const left = new ProjectDraft({ "logic:1": "A" });
  const right = new ProjectDraft({ "logic:1": "A" });
  const oldTransaction = left.apply(
    left.propose(left.capture(), "Old project", [{ key: "logic:1", content: "B" }]),
  );
  right.apply(right.propose(right.capture(), "New project", [{ key: "logic:1", content: "C" }]));
  assert.throws(() => right.undo(oldTransaction.id), /transaction/i);
  assert.equal(right.capture().read("logic:1")!.content, "C");
});

test("the music metadata document is an admitted draft document", () => {
  const draft = new ProjectDraft({ "logic:1": "return;" });
  const tempo = '{"9":{"revision":"21-abcdef12","tempo":120}}';
  draft.edit("music", tempo, draft.capture().version("music"));
  assert.equal(draft.capture().read("music")!.content, tempo);
  const proposal = draft.propose(draft.capture(), "slower", [
    { key: "music", content: '{"9":{"revision":"21-abcdef12","tempo":90}}' },
  ]);
  draft.apply(proposal);
  assert.equal(
    draft.capture().read("music")!.content,
    '{"9":{"revision":"21-abcdef12","tempo":90}}',
  );
});
