import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
import { loadAuthoredGame } from "../src/project/gameStorage.ts";
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

test("mutating review diagnostics cannot authorize a broken resource reference", async () => {
  const seed = prepareLocalProject({ title: "Review authority", kind: "boilerplate" });
  await seed.save();
  const workspace = await openEditableProject(seed.projectId);
  workspace.draft.edit(
    "logic:1",
    "call(42); return;",
    workspace.draft.capture().version("logic:1"),
  );
  const candidate = workspace.buildSelected(["logic:1"]);
  const error = candidate.diagnostics.find((entry) => entry.severity === "error");
  assert.ok(error, "the missing called LOGIC must be diagnosed before review");
  const before = (await loadAuthoredGame(seed.projectId))!.generation;
  // A review consumer can be JavaScript. Either a detached value or a frozen
  // value is fine; writable UI objects must never be admission authority.
  try {
    Object.assign(error, { severity: "warning" });
  } catch (caught) {
    assert.ok(caught instanceof TypeError);
  }
  await assert.rejects(workspace.keepCandidate(candidate), /reference/i);
  assert.equal((await loadAuthoredGame(seed.projectId))!.generation, before);
});

test("a consumer's saved identity copy cannot corrupt the next Keep baseline", async () => {
  const seed = prepareLocalProject({ title: "Saved identity", kind: "boilerplate" });
  await seed.save();
  const workspace = await openEditableProject(seed.projectId);
  const snapshot = workspace.draft.capture();
  const source = snapshot.read("logic:1")!.content;
  workspace.draft.edit("logic:1", `${source}\n// first edit`, snapshot.version("logic:1"));
  const first = await workspace.keepCandidate(workspace.buildSelected(["logic:1"]));
  const generation = first.saved.generation;
  for (const exposed of [first.saved, workspace.savedIdentity()]) {
    try {
      Object.assign(exposed, { generation: generation + 100 });
    } catch (caught) {
      assert.ok(caught instanceof TypeError);
    }
  }
  assert.equal(workspace.savedIdentity().generation, generation);
  const newer = workspace.draft.capture();
  workspace.draft.edit("logic:1", `${source}\n// next edit`, newer.version("logic:1"));
  const second = await workspace.keepCandidate(workspace.buildSelected(["logic:1"]));
  assert.equal(second.saved.generation, generation + 1);
});
