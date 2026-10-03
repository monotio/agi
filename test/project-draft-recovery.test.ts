import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";

const kept = {
  "logic:0": "return;",
  "logic:1": "return;",
  "view:1": Uint8Array.of(1),
  words: "[]",
};

test("recovery preserves unfinished text, resource deletion and independent selection", () => {
  const draft = new ProjectDraft(kept);
  draft.edit("logic:0", 'print("unfinished', draft.capture().version("logic:0"));
  draft.edit("view:1", null, draft.capture().version("view:1"));
  const recovery = draft.captureRecovery();
  const recovered = ProjectDraft.recover(kept, recovery);
  assert.deepEqual(recovered.dirtyKeys(), ["logic:0", "view:1"]);
  assert.equal(recovered.capture().read("logic:0")?.content, 'print("unfinished');
  assert.equal(recovered.capture().read("view:1"), undefined);
  assert.deepEqual(recovered.select(["view:1"]).keys, ["view:1"]);
  assert.equal(recovered.select(["view:1"]).documents()["logic:0"], "return;");
  assert.equal(recovered.select([]).documents()["view:1"] instanceof Uint8Array, true);
});

test("recovery compacts overlapping pending operations without splitting their selection closure", () => {
  const draft = new ProjectDraft(kept);
  draft.apply(
    draft.propose(draft.capture(), "New word", [
      { key: "logic:0", content: "first" },
      { key: "words", content: "new" },
    ]),
  );
  draft.apply(
    draft.propose(draft.capture(), "Response", [
      { key: "words", content: "newer" },
      { key: "logic:1", content: "second" },
    ]),
  );
  draft.edit("view:1", Uint8Array.of(2), draft.capture().version("view:1"));
  const recovery = draft.captureRecovery();
  assert.deepEqual(recovery.groups, [["logic:0", "logic:1", "words"]]);
  const recovered = ProjectDraft.recover(kept, recovery);
  assert.deepEqual(recovered.select(["logic:0"]).keys, ["logic:0", "logic:1", "words"]);
  assert.deepEqual(recovered.select(["view:1"]).keys, ["view:1"]);
});

test("a clean member of an outstanding operation stays coupled after recovery", () => {
  const draft = new ProjectDraft(kept);
  draft.apply(
    draft.propose(draft.capture(), "Change both", [
      { key: "logic:0", content: "changed" },
      { key: "logic:1", content: "changed" },
    ]),
  );
  draft.edit("logic:1", "return;", draft.capture().version("logic:1"));
  const recovery = draft.captureRecovery();
  assert.deepEqual(
    recovery.changes.map(({ key }) => key),
    ["logic:0"],
  );
  const recovered = ProjectDraft.recover(kept, recovery);
  assert.deepEqual(recovered.select(["logic:0"]).keys, ["logic:0", "logic:1"]);
});

test("recovery owns bytes and starts a fresh workspace lifetime", () => {
  const draft = new ProjectDraft(kept);
  draft.edit("view:1", Uint8Array.of(9), draft.capture().version("view:1"));
  const proposal = draft.propose(draft.capture(), "Later", [{ key: "logic:0", content: "later" }]);
  const selection = draft.select(["view:1"]);
  const recovery = draft.captureRecovery();
  const recovered = ProjectDraft.recover(kept, recovery);
  (recovery.changes[0]!.content as Uint8Array)[0] = 7;
  assert.deepEqual(recovered.capture().read("view:1")?.content, Uint8Array.of(9));
  assert.deepEqual(draft.capture().read("view:1")?.content, Uint8Array.of(9));
  assert.throws(() => recovered.apply(proposal), /workspace/);
  assert.throws(() => recovered.acknowledgeKept(selection), /workspace/);
});

test("recovery rejects invalid structure before touching the kept inputs", () => {
  const original = new Uint8Array(kept["view:1"]);
  assert.throws(
    () =>
      ProjectDraft.recover(kept, {
        changes: [{ key: "logic:0", version: -1, content: "bad" }],
        groups: [],
      }),
    /version/,
  );
  assert.throws(
    () => ProjectDraft.recover(kept, { changes: [], groups: [["logic:0", "../../secret"]] }),
    /document/,
  );
  assert.throws(
    () => ProjectDraft.recover(kept, { changes: [], groups: [["logic:0", "logic:0"]] }),
    /group/,
  );
  assert.deepEqual(kept["view:1"], original);
});
