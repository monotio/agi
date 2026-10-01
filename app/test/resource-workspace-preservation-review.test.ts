import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readProjectWorkspace,
  writeProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { inspectEditableProject } from "../src/project/projectWorkspaceSource.ts";
import { reconcileResourceWorkspace } from "../src/project/resourceWorkspace.ts";

test("resource reconciliation preserves formatting of unchanged world metadata", () => {
  const candidate = prepareLocalProject({ title: "World formatting", kind: "starter" });
  const data = candidate.data();
  const documents = { ...readProjectWorkspace(data.workspace) };
  assert.equal(typeof documents["world"], "string");
  const formatted = JSON.stringify(JSON.parse(documents["world"] as string), null, 2);
  documents["world"] = formatted;
  const input = {
    ...data,
    projectId: candidate.projectId,
    authoredAt: "2000-01-01T00:00:00.000Z",
    workspace: writeProjectWorkspace(documents),
  };
  assert.equal(inspectEditableProject(input).requiresSourceReview, false);
  const reconciled = reconcileResourceWorkspace({
    workspace: input.workspace,
    files: input.files,
    profileId: "2.936",
    authoringState: input.authoringState,
    changedDocuments: ["picture:1"],
  });
  assert.equal(readProjectWorkspace(reconciled)["world"], formatted);
});

test("resource reconciliation preserves an unrelated verified workspace source over older legacy text", () => {
  const candidate = prepareLocalProject({ title: "Exact source", kind: "starter" });
  const data = candidate.data();
  const documents = { ...readProjectWorkspace(data.workspace) };
  assert.equal(typeof documents["logic:1"], "string");
  const source = `// Authored room commentary\n${documents["logic:1"] as string}\n`;
  documents["logic:1"] = source;
  const input = {
    ...data,
    projectId: candidate.projectId,
    authoredAt: "2000-01-01T00:00:00.000Z",
    workspace: writeProjectWorkspace(documents),
  };
  assert.equal(inspectEditableProject(input).requiresSourceReview, false);
  const reconciled = reconcileResourceWorkspace({
    workspace: input.workspace,
    files: input.files,
    profileId: "2.936",
    authoringState: input.authoringState,
    changedDocuments: ["picture:1"],
  });
  assert.equal(readProjectWorkspace(reconciled)["logic:1"], source);
});
