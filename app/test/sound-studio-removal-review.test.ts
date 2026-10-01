import assert from "node:assert/strict";
import { test } from "node:test";
import { openContainer } from "../../src/container/container.ts";
import { readMusicDocument } from "../../src/authoring/projectDocuments.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { loadAuthoredGame } from "../src/project/gameStorage.ts";
import { SoundStudioWorkspace } from "../src/studio/sound/soundWorkspace.ts";
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

test("Sound Studio can review and Keep removal of its kept unreferenced cue", async () => {
  const seed = prepareLocalProject({ title: "Remove kept cue", kind: "blank" });
  await seed.save();
  const workspace = new SoundStudioWorkspace();
  await workspace.open(seed.projectId);
  const num = workspace.createCue("danger");
  await workspace.keepCandidate(workspace.buildSelected(workspace.dirtyKeys()));
  const before = await loadAuthoredGame(seed.projectId);
  assert.ok(before);
  assert.ok(openContainer(new Map(Object.entries(before.files))).getResource("sound", num));
  assert.equal(workspace.removeCue(num), null, "removal must reach the existing Keep review");
  assert.equal(workspace.documentFor(num), null);
  const removal = workspace.buildSelected(workspace.dirtyKeys());
  assert.deepEqual(removal.removedResources, [`sound:${num}`]);
  await workspace.keepCandidate(removal);
  const after = await loadAuthoredGame(seed.projectId);
  assert.ok(after);
  assert.equal(openContainer(new Map(Object.entries(after.files))).getResource("sound", num), null);
  await workspace.open(seed.projectId);
  assert.equal(workspace.documentFor(num), null);
  const music = workspace.draft?.capture().read("music")?.content ?? "{}";
  assert.equal(typeof music, "string");
  assert.equal(readMusicDocument(music as string)[String(num)], undefined);
});
