import { test } from "node:test";
import assert from "node:assert/strict";
import { useGameLifecycle, type GameLifecycleOptions } from "../src/useGameLifecycle.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import {
  clearCachedGame,
  loadAuthoredGame,
  saveAuthoredGame,
  updateAuthoredGameFiles,
  type CachedGameData,
} from "../src/gameStorage.ts";
import { gameRevision } from "../src/gameMetadata.ts";
import { createContainer } from "../../src/container/container.ts";
import type { BootedGame } from "../src/gameTypes.ts";

installIndexedDbFixture();
// The project index lives in localStorage; each test file runs in its own process.
const localValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => void localValues.set(key, value),
    removeItem: (key: string) => void localValues.delete(key),
  },
});

test("Exit preserves the worker and session when autosave succeeds but history cannot become durable", async () => {
  const calls: string[] = [];
  const state = { leaving: false, powerUp: { busy: false } };
  const lifecycle = useGameLifecycle({
    state,
    authoring: { getSession: () => null },
    autosave: { flushAutosaveDetailed: async () => ({ status: "saved" }) },
    link: {
      query: async () => {
        throw new Error("history timeout");
      },
      terminateWorker: () => calls.push("terminate"),
      drainPendingQueries: () => calls.push("drain queries"),
    },
    pauseEngine: () => calls.push("pause"),
    resumeEngine: () => calls.push("resume"),
    abortWalkthrough: () => calls.push("abort"),
    promptCancel: () => calls.push("cancel"),
    drainHistoryCommits: async () => {},
    nextSessionId: () => calls.push("next session"),
  } as unknown as GameLifecycleOptions);
  await assert.rejects(lifecycle.ejectGame(), /history.*not.*saved/i);
  assert.equal(state.leaving, false);
  assert.deepEqual(calls, ["pause", "resume"]);
});

test("Download game from a tab behind storage downloads the running game and never rolls storage back", async (t) => {
  const running = createContainer();
  running.putResource("logic", 0, Uint8Array.of(0));
  const files = Object.fromEntries(running.files);
  const projectId = testProjectId("export-behind-storage");
  await saveAuthoredGame(projectId, {
    title: "Exported",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  t.after(() => clearCachedGame(projectId));
  const game: BootedGame = {
    installed: false,
    projectId,
    title: "Exported",
    revision: await gameRevision(files),
    files,
    words: [],
  };
  // Another tab kept an edit after this game booted.
  const kept = createContainer();
  kept.putResource("logic", 0, Uint8Array.of(0));
  kept.putResource("logic", 1, Uint8Array.of(1));
  assert.equal(await updateAuthoredGameFiles(projectId, Object.fromEntries(kept.files)), true);
  const newer = (await loadAuthoredGame(projectId))!;

  const lifecycle = useGameLifecycle({
    state: { phase: "running", powerUp: { busy: false } },
    authoring: {
      getSession: () => null,
      assembleExportData: (
        data: CachedGameData,
        _game: BootedGame,
        _s: null,
        out: Record<string, Uint8Array>,
      ) => ({
        ...data,
        files: out,
      }),
    },
    link: { query: async () => files },
    logAgent: () => {},
  } as unknown as GameLifecycleOptions);
  lifecycle.setBootedGame(game);
  const { data } = await lifecycle.exportCurrentGame();
  assert.deepEqual(data.files, files, "the download is the running game");
  const stored = (await loadAuthoredGame(projectId))!;
  assert.equal(stored.generation, newer.generation, "storage was not written");
  assert.deepEqual(stored.files, newer.files);
  assert.equal(game.revision, await gameRevision(files));
});
