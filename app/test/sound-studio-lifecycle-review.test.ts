import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareLocalProject } from "../src/project/localProject.ts";
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

test("closing Sound Studio cancels an outstanding real project open", async () => {
  const seed = prepareLocalProject({ title: "Close during sound open", kind: "blank" });
  await seed.save();
  const workspace = new SoundStudioWorkspace();
  let notifications = 0;
  workspace.subscribe(() => {
    notifications++;
  });
  const opening = workspace.open(seed.projectId);
  workspace.close();
  const closedNotifications = notifications;
  assert.equal(workspace.project, null);
  await opening;
  assert.equal(
    workspace.project === null,
    true,
    "late project load must not reopen a closed workspace",
  );
  assert.equal(workspace.projectId, null);
  assert.equal(notifications, closedNotifications, "late load must not notify disposed UI");
});
