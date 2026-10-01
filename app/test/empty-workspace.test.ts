import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyWorkspaceChanges } from "../src/studio/workspace/emptyWorkspace.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";

test("Add a room supplies runnable boot and room documents as one session edit", () => {
  const changes = emptyWorkspaceChanges("room");
  const blank = createStarterProject("blank");
  const documents = Object.fromEntries(changes.map((change) => [change.key, change.content!]));
  const result = compileProjectDocuments({
    files: Object.fromEntries(blank.files()),
    documents,
    profileId: "2.936",
  });
  assert.ok(result.build);
  assert.ok(documents["logic:0"]);
  assert.ok(documents["logic:1"]);
  assert.ok(documents["picture:1"]);
  assert.match(String(documents["logic:1"]), /Your game starts here/);
});
