import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer, openContainer } from "../src/container/container.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { compileProjectDocuments } from "../src/authoring/projectDocuments.ts";
import { compileProjectSelection } from "../src/authoring/projectSelection.ts";

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

const profileId = "2.936" as const;
const view = JSON.stringify({
  loops: [{ cels: [{ width: 1, height: 1, transparentColor: 0, pixels: [1] }] }],
});
function workspace(extra: Record<string, string | Uint8Array> = {}) {
  const documents = {
    "logic:0": "return;",
    "logic:1": "return;",
    "view:1": view,
    words: "[]",
    bindings: "{}",
    ...extra,
  };
  const files = Object.fromEntries(
    compileProjectDocuments({
      files: Object.fromEntries(createContainer().files),
      profileId,
      documents,
    }).files(),
  );
  const draft = new ProjectDraft(documents);
  return { files, draft, profileId };
}
function edit(draft: ProjectDraft, key: string, content: string | Uint8Array | null) {
  draft.edit(key, content, draft.capture().version(key));
}

test("selected build uses kept unrelated logic and leaves later typing dirty after acknowledgement", () => {
  const input = workspace();
  edit(input.draft, "logic:1", 'print("unfinished');
  edit(input.draft, "view:1", view.replace("[1]", "[2]"));
  const candidate = compileProjectSelection({ ...input, keys: ["view:1"] });
  assert.deepEqual(candidate.selection.keys, ["view:1"]);
  assert.equal(candidate.compiled.documents()["logic:1"], "return;");
  edit(input.draft, "view:1", view.replace("[1]", "[3]"));
  assert.throws(() => input.draft.assertCurrent(candidate.selection), /Stale/);
  assert.equal(input.draft.acknowledgeKept(candidate.selection), true);
  assert.deepEqual(input.draft.dirtyKeys(), ["logic:1", "view:1"]);
});

test("selection closes new binding, vocabulary and resource dependencies to a fixed point", () => {
  const input = workspace();
  edit(input.draft, "logic:0", 'if (said("open")) { call(next_room); } return;');
  edit(input.draft, "bindings", JSON.stringify({ next_room: { kind: "logic", num: 2 } }));
  edit(input.draft, "words", JSON.stringify([["open", 100]]));
  edit(input.draft, "logic:2", "load.view(3); return;");
  edit(input.draft, "view:3", view);
  edit(input.draft, "logic:1", "unfinished(");
  const candidate = compileProjectSelection({ ...input, keys: ["logic:0"] });
  assert.deepEqual(candidate.selection.keys, ["bindings", "logic:0", "logic:2", "view:3", "words"]);
  assert.deepEqual(candidate.references.diagnostics, []);
  assert.ok(openContainer(candidate.compiled.files()).getResource("view", 3));
});

test("selection includes the dirty referring logic when a resource deletion has a coordinated repair", () => {
  const input = workspace({ "logic:0": "load.view(1); return;" });
  edit(input.draft, "view:1", null);
  edit(input.draft, "logic:0", "return;");
  const candidate = compileProjectSelection({ ...input, keys: ["view:1"] });
  assert.deepEqual(candidate.selection.keys, ["logic:0", "view:1"]);
  assert.equal(openContainer(candidate.compiled.files()).getResource("view", 1), null);
  assert.deepEqual(candidate.references.diagnostics, []);
});

test("compilation reports missing and indirect references rather than authorizing removal", () => {
  const input = workspace({ "logic:0": "load.view(1); load.view.v(v2); return;" });
  edit(input.draft, "view:1", null);
  const candidate = compileProjectSelection({ ...input, keys: ["view:1"] });
  assert.ok(candidate.references.diagnostics.some((entry) => entry.code === "missing-resource"));
  assert.ok(
    candidate.references.diagnostics.some((entry) => entry.code === "unresolved-reference"),
  );
  assert.deepEqual(candidate.removedResources, ["view:1"]);
});

test("invalid related bindings block the candidate, while unrelated broken bindings stay draft-only", () => {
  const input = workspace();
  edit(input.draft, "bindings", "{");
  edit(input.draft, "logic:0", 'print("hello"); return;');
  assert.doesNotThrow(() => compileProjectSelection({ ...input, keys: ["logic:0"] }));
  edit(input.draft, "logic:0", "call(next_room); return;");
  assert.throws(() => compileProjectSelection({ ...input, keys: ["logic:0"] }), /bindings/);
});

test("changed binding selects its current target without pulling an unfinished former target", () => {
  const input = workspace({ bindings: JSON.stringify({ hero: { kind: "view", num: 1 } }) });
  edit(input.draft, "logic:0", "load.view(hero); return;");
  edit(input.draft, "bindings", JSON.stringify({ hero: { kind: "view", num: 2 } }));
  edit(input.draft, "view:1", "unfinished");
  edit(input.draft, "view:2", view);
  const candidate = compileProjectSelection({ ...input, keys: ["logic:0"] });
  assert.deepEqual(candidate.selection.keys, ["bindings", "logic:0", "view:2"]);
  assert.equal(candidate.compiled.documents()["view:1"], view);
});

test("a vocabulary edit includes the current source repair when the kept source cannot compile", () => {
  const input = workspace({
    "logic:0": 'if (said("open")) { return; } return;',
    words: '[["open",100]]',
  });
  edit(input.draft, "words", '[["unlock",100]]');
  edit(input.draft, "logic:0", 'if (said("unlock")) { return; } return;');
  const candidate = compileProjectSelection({ ...input, keys: ["words"] });
  assert.deepEqual(candidate.selection.keys, ["logic:0", "words"]);
  assert.deepEqual(candidate.references.diagnostics, []);
});

test("an inventory location byte selects no logic, while a real room load still does", () => {
  const input = workspace({
    "logic:0": "new.room(42); return;",
    "logic:42": "return;",
    inventory: JSON.stringify([{ name: "key", startingRoom: 42 }]),
  });
  edit(input.draft, "inventory", JSON.stringify([{ name: "key", startingRoom: 43 }]));
  edit(input.draft, "logic:42", "print(1); return;");
  const candidate = compileProjectSelection({ ...input, keys: ["inventory"] });
  assert.deepEqual(candidate.selection.keys, ["inventory"]);
  assert.equal(candidate.compiled.documents()["logic:42"], "return;");
  const room = compileProjectSelection({ ...input, keys: ["logic:0"] });
  assert.deepEqual(room.selection.keys, ["logic:0", "logic:42"]);
});

test("recompiled kept logic brings its new binding target while leaving unfinished source typing aside", () => {
  const input = workspace({
    "logic:0": "load.view(hero); return;",
    bindings: JSON.stringify({ hero: { kind: "view", num: 1 } }),
  });
  edit(input.draft, "bindings", JSON.stringify({ hero: { kind: "view", num: 2 } }));
  edit(input.draft, "view:2", view);
  edit(input.draft, "logic:0", 'print("unfinished');
  const candidate = compileProjectSelection({ ...input, keys: ["bindings"] });
  assert.deepEqual(candidate.selection.keys, ["bindings", "view:2"]);
  assert.equal(candidate.compiled.documents()["logic:0"], "load.view(hero); return;");
  assert.deepEqual(candidate.references.diagnostics, []);
});
