import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectModel } from "../../src/authoring/projectModel.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { prepareWorkspaceAction } from "../src/studio/workspace/workspaceGuided.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { emptyWorkspaceChanges } from "../src/studio/workspace/emptyWorkspace.ts";

test("guided room creation reads a detached snapshot and returns one coordinated change", () => {
  const documents = Object.fromEntries(
    emptyWorkspaceChanges("room").map((change) => [change.key, change.content!]),
  );
  const build = compileProjectDocuments({ files: {}, documents, profileId: "2.936" });
  const model = new ProjectModel({ documents, build, digest: sha256Hex });
  const snapshot = model.capture();
  const result = prepareWorkspaceAction(snapshot, "2.936", { kind: "add-room", title: "Garden" });
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.changes.some((change) => change.key === "logic:2"));
  assert.ok(result.changes.some((change) => change.key === "picture:2"));
  assert.ok(result.changes.some((change) => change.key === "world"));
  assert.equal(model.capture().revision, snapshot.revision);
  assert.deepEqual(model.capture().documents(), snapshot.documents());
  assert.equal(snapshot.read("logic:2"), undefined);
});
