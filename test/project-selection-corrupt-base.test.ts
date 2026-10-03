import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer, openContainer } from "../src/container/container.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { compileProjectDocuments } from "../src/authoring/projectDocuments.ts";
import { compileProjectSelection } from "../src/authoring/projectSelection.ts";

test("an unreadable before image conservatively pulls dependencies of the rebuilt kept logic", () => {
  const view = JSON.stringify({
    loops: [{ cels: [{ width: 1, height: 1, transparentColor: 0, pixels: [1] }] }],
  });
  const documents = {
    "logic:0": "load.view(2); return;",
    "view:1": view,
    "view:2": view,
    words: "[]",
    bindings: "{}",
  };
  const profileId = "2.936";
  const original = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    profileId,
    documents,
  });
  const files = Object.fromEntries(original.files());
  files["LOGDIR"] = new Uint8Array(files["LOGDIR"]!);
  files["LOGDIR"].set([0x30, 0, 0], 0); // A missing volume makes the old LOGIC unreadable.
  const draft = new ProjectDraft(documents);
  draft.edit(
    "view:2",
    view.replace('"pixels":[1]', '"pixels":[3]'),
    draft.capture().version("view:2"),
  );
  const built = compileProjectSelection({ files, profileId, draft, keys: ["view:1"] });
  assert.deepEqual(built.selection.keys, ["view:1", "view:2"]);
  assert.deepEqual(
    openContainer(built.compiled.files()).getResource("logic", 0),
    openContainer(original.files()).getResource("logic", 0),
  );
  assert.notDeepEqual(
    openContainer(built.compiled.files()).getResource("view", 2),
    openContainer(original.files()).getResource("view", 2),
  );
  assert.deepEqual(files["LOGDIR"].subarray(0, 3), Uint8Array.of(0x30, 0, 0));
  assert.equal(
    files["LOGDIR"].subarray(3).every((byte) => byte === 0xff),
    true,
  );
});
