import assert from "node:assert/strict";
import { test } from "node:test";
import { openEditableProject } from "../src/project/editableProject.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { loadAuthoredGame } from "../src/project/gameStorage.ts";
import { readProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key),
  },
});

test("removing authored music intent stays removed through Keep and reopen", async () => {
  const project = prepareLocalProject({ title: "Clear cue intent", kind: "blank" });
  await project.save();
  const workspace = await openEditableProject(project.projectId);
  const music = '{"9":{"revision":"21-12345678","tempo":120}}';
  workspace.draft.edit("music", music, workspace.draft.capture().version("music"));
  await workspace.keepCandidate(workspace.buildSelected(["music"]));
  const editing = await openEditableProject(project.projectId);
  const snapshot = editing.draft.capture();
  editing.draft.edit("music", null, snapshot.version("music"));
  await editing.keepCandidate(editing.buildSelected(["music"]));
  const stored = await loadAuthoredGame(project.projectId);
  assert.ok(stored);
  assert.equal(readProjectWorkspace(stored.workspace)["music"], undefined);
  assert.equal(
    (stored.authoringState?.["authoring"] as { music?: unknown }).music,
    undefined,
    "removed intent must not remain in the synchronized legacy authoring record",
  );
  const reopened = await openEditableProject(project.projectId);
  assert.equal(reopened.draft.capture().read("music"), undefined);
});
