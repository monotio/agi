import { drainProjectNotices, NOTICE_BARRIER } from "./projectNotices.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_CHANNEL,
  announceProjectWrite,
  type NoticeChannel,
} from "../src/project/projectBroadcast.ts";
import { watchProjectWrites } from "../src/project/projectTransaction.ts";
import {
  clearCachedGame,
  readHistoryLifetime,
  renameAuthoredGame,
  saveAuthoredGame,
} from "../src/project/gameStorage.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId, testRevision } from "./identity.ts";

installIndexedDbFixture();

/** A channel another tab would post on: `deliver` plays its message. */
function fakeChannel() {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const posted: unknown[] = [];
  const channel: NoticeChannel = {
    postMessage: (message) => posted.push(message),
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const deliver = (data: unknown) => {
    for (const listener of listeners) listener({ data });
  };
  return { channel, posted, deliver, listeners };
}

function running(overrides: Partial<BootedGame> = {}): BootedGame {
  return {
    installed: false,
    projectId: testProjectId("shared-project"),
    title: "Shared",
    revision: testRevision("r1"),
    files: {},
    words: [],
    ...overrides,
  };
}

test("another tab's newer revision marks the running game behind storage, once", () => {
  const { channel, deliver, listeners } = fakeChannel();
  const game = running();
  let told = 0;
  const stop = watchProjectWrites(
    { getBootedGame: () => game, onBehindStorage: () => told++, onRemoved: () => {} },
    channel,
  );
  const projectId = testProjectId("shared-project");

  // Writes that leave the running revision alone (a rename, a preview, a
  // conversation) or name another project change nothing.
  deliver({ projectId, revision: testRevision("r1"), generation: 5 });
  deliver({ projectId: testProjectId("other"), revision: testRevision("r2"), generation: 2 });
  deliver({ projectId, revision: 7, generation: 2 });
  deliver("not a notice");
  assert.equal(game.behindStorage, undefined);
  assert.equal(told, 0);

  deliver({ projectId, revision: testRevision("r2"), generation: 6 });
  assert.equal(game.behindStorage, true);
  assert.equal(told, 1);
  // Behind is behind: a later write does not say it again.
  deliver({ projectId, revision: testRevision("r3"), generation: 7 });
  assert.equal(told, 1);

  stop();
  assert.equal(listeners.size, 0);
});

test("an installed edition or an empty slot has no stored project to fall behind", () => {
  const { channel, deliver } = fakeChannel();
  let booted: BootedGame | null = running({ installed: true });
  let told = 0;
  watchProjectWrites(
    { getBootedGame: () => booted, onBehindStorage: () => told++, onRemoved: () => {} },
    channel,
  );
  const notice = {
    projectId: testProjectId("shared-project"),
    revision: testRevision("r2"),
    generation: 2,
  };
  deliver(notice);
  assert.equal(booted.behindStorage, undefined);
  booted = null;
  deliver(notice);
  assert.equal(told, 0);
});

test("another tab's removal of the lifetime a game runs stops everything it stores, once", () => {
  const { channel, deliver } = fakeChannel();
  const projectId = testProjectId("shared-project");
  const game = running({ historyLifetime: "lifetime-1" });
  const heard: string[] = [];
  watchProjectWrites(
    {
      getBootedGame: () => game,
      onBehindStorage: () => heard.push("behind"),
      onRemoved: () => heard.push("removed"),
    },
    channel,
  );
  // Another project's removal, or an earlier lifetime of this id (removed
  // before this game was added again), is not this game's.
  deliver({ projectId: testProjectId("other"), removed: "lifetime-1" });
  deliver({ projectId, removed: "lifetime-0" });
  deliver({ projectId, removed: 7 });
  assert.equal(game.removed, undefined);
  assert.deepEqual(heard, []);

  deliver({ projectId, removed: "lifetime-1" });
  assert.equal(game.removed, true);
  assert.equal(game.behindStorage, true, "nothing writes over storage any more");
  // Said once; a later write notice of the id is not "changed in another tab".
  deliver({ projectId, removed: "lifetime-1" });
  deliver({ projectId, revision: testRevision("r2"), generation: 1 });
  assert.deepEqual(heard, ["removed"]);

  // A game already behind storage still learns it was removed.
  const behind = running({ historyLifetime: "lifetime-1", behindStorage: true });
  let told = 0;
  watchProjectWrites(
    { getBootedGame: () => behind, onBehindStorage: () => {}, onRemoved: () => told++ },
    channel,
  );
  deliver({ projectId, removed: "lifetime-1" });
  assert.equal(behind.removed, true);
  assert.equal(told, 1);
});

test("removing a project tells other tabs the lifetime it ended, once", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const id = testProjectId("removed-announced");
  const otherTab = new BroadcastChannel(PROJECT_CHANNEL);
  const heard: unknown[] = [];
  otherTab.addEventListener("message", (event) => {
    if (event.data?.projectId !== NOTICE_BARRIER) heard.push(event.data);
  });
  t.after(() => {
    otherTab.close();
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  await saveAuthoredGame(id, {
    title: "Removed",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });
  const lifetime = await readHistoryLifetime(id);
  assert.ok(lifetime);
  await drainProjectNotices(otherTab);
  heard.length = 0;

  await clearCachedGame(id);
  // Removing it again ends no lifetime and says nothing.
  await clearCachedGame(id);
  await drainProjectNotices(otherTab);
  assert.deepEqual(heard, [{ projectId: id, removed: lifetime }]);
});

test("without BroadcastChannel nothing is announced or watched, and nothing throws", () => {
  const stop = watchProjectWrites(
    { getBootedGame: () => running(), onBehindStorage: () => {}, onRemoved: () => {} },
    null,
  );
  stop();
  announceProjectWrite({ projectId: "p", revision: testRevision("r"), generation: 1 }, null);
  announceProjectWrite(
    { projectId: "p", revision: testRevision("r"), generation: 1 },
    {
      postMessage: () => {
        throw new Error("closed");
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  );
});

test("every committed project write tells other tabs its project, revision and generation", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const id = testProjectId("announced");
  // Another tab's channel: a separate object on the same name hears the writes.
  const otherTab = new BroadcastChannel(PROJECT_CHANNEL);
  const heard: unknown[] = [];
  otherTab.addEventListener("message", (event) => {
    if (event.data?.projectId !== NOTICE_BARRIER) heard.push(event.data);
  });
  t.after(async () => {
    otherTab.close();
    await clearCachedGame(id);
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  await saveAuthoredGame(id, {
    title: "Announced",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });
  assert.equal(await renameAuthoredGame(id, "Renamed"), true);
  // A refused write commits nothing and says nothing.
  assert.equal(await renameAuthoredGame(id, "Stale", 1), false);
  await drainProjectNotices(otherTab);

  const stored = JSON.parse(values.get(`monotio_agi.authored.${id}`)!) as {
    library: { revision: string };
  };
  assert.deepEqual(heard, [
    { projectId: id, revision: stored.library.revision, generation: 1 },
    { projectId: id, revision: stored.library.revision, generation: 2 },
  ]);
});
