import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
import { loadAuthoredGame } from "../src/project/gameStorage.ts";
import { createSoundDocument } from "../../src/sound/document.ts";
import { openContainer } from "../../src/container/container.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem(key: string) {
      return cache.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      cache.set(key, value);
    },
    removeItem(key: string) {
      cache.delete(key);
    },
  },
});

async function cueProject(title: string, referenced = false) {
  const seed = prepareLocalProject({ title, kind: "blank" });
  await seed.save();
  const workspace = await openEditableProject(seed.projectId);
  const base = workspace.draft.capture();
  const changes = [{ key: "sound:42", content: createSoundDocument().encode() }];
  workspace.draft.edit("sound:42", changes[0]!.content, base.version("sound:42"));
  if (referenced)
    workspace.draft.edit("logic:1", "sound(42, f90); return;", base.version("logic:1"));
  await workspace.keepCandidate(
    workspace.buildSelected(referenced ? ["sound:42", "logic:1"] : ["sound:42"]),
  );
  return workspace;
}

test("an explicitly reviewed unreferenced SOUND removal keeps and reopens as removed", async () => {
  const workspace = await cueProject("Reviewed cue removal");
  const base = workspace.draft.capture();
  workspace.draft.edit("sound:42", null, base.version("sound:42"));
  const candidate = workspace.buildSelected(["sound:42"]);
  assert.deepEqual(candidate.removedResources, ["sound:42"]);
  await assert.rejects(workspace.keepCandidate(candidate), /review|remov/i);
  await workspace.keepCandidate(candidate, { reviewedRemovals: ["sound:42"] });
  const data = await loadAuthoredGame(workspace.projectId);
  assert.ok(data);
  assert.equal(openContainer(new Map(Object.entries(data.files))).getResource("sound", 42), null);
  const reopened = await openEditableProject(workspace.projectId);
  assert.equal(reopened.draft.capture().read("sound:42"), undefined);
});

test("a reviewed removal with a surviving real LOGIC reference cannot Keep", async () => {
  const workspace = await cueProject("Referenced cue removal", true);
  const generation = workspace.savedIdentity().generation;
  workspace.draft.edit("sound:42", null, workspace.draft.capture().version("sound:42"));
  const candidate = workspace.buildSelected(["sound:42"]);
  assert.ok(candidate.diagnostics.some((entry) => entry.severity === "error"));
  await assert.rejects(workspace.keepCandidate(candidate, { reviewedRemovals: ["sound:42"] }));
  const data = await loadAuthoredGame(workspace.projectId);
  assert.ok(data);
  assert.equal(data.generation, generation);
  assert.ok(openContainer(new Map(Object.entries(data.files))).getResource("sound", 42));
});

test("a complete reviewed LOGIC repair and SOUND removal land in one Keep", async () => {
  const workspace = await cueProject("Coordinated cue removal", true);
  const base = workspace.draft.capture();
  workspace.draft.apply(
    workspace.draft.propose(base, "Remove cue and its trigger", [
      { key: "sound:42", content: null },
      { key: "logic:1", content: "return;" },
    ]),
  );
  const candidate = workspace.buildSelected(["sound:42", "logic:1"]);
  assert.equal(candidate.diagnostics.filter((entry) => entry.severity === "error").length, 0);
  await workspace.keepCandidate(candidate, { reviewedRemovals: ["sound:42"] });
  const data = await loadAuthoredGame(workspace.projectId);
  assert.ok(data);
  assert.equal(openContainer(new Map(Object.entries(data.files))).getResource("sound", 42), null);
  const reopened = await openEditableProject(workspace.projectId);
  assert.equal(reopened.draft.capture().read("logic:1")?.content, "return;");
});
