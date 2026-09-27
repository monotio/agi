import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HistoryUnsavedError,
  useGameLifecycle,
  type GameLifecycleOptions,
} from "../src/useGameLifecycle.ts";
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
  await assert.rejects(lifecycle.ejectGame(), HistoryUnsavedError);
  assert.equal(state.leaving, false);
  assert.deepEqual(calls, ["pause", "resume"]);
});

/** A lifecycle whose history barrier never answers — only the history choice decides Exit. */
function exitWithSilentHistory(state: Record<string, unknown>, calls: string[]) {
  return useGameLifecycle({
    state,
    hook: {},
    audio: { stop: () => {}, setPaused: () => {} },
    authoring: { getSession: () => null, resetSession: () => {} },
    autosave: {
      flushAutosaveDetailed: async () => ({ status: "saved" }),
      reset: () => {},
      resetScreen: () => {},
    },
    testRecorder: { reset: () => {} },
    link: {
      query: async (type: string) => {
        calls.push(type);
        throw new Error("history timeout");
      },
      terminateWorker: () => calls.push("terminate"),
      drainPendingQueries: () => {},
      clearShake: () => {},
    },
    pauseEngine: () => {},
    resumeEngine: () => {},
    resetPauseOwners: () => {},
    resetHistoryView: () => {},
    promptCancel: () => {},
    abortWalkthrough: () => {},
    stopHistoryWriter: () => {},
    setActiveReplaySeed: () => {},
    drainHistoryCommits: async () => {},
    nextSessionId: () => 0,
  } as unknown as GameLifecycleOptions);
}

function exitState(historyBlocked: { message: string } | null) {
  return {
    leaving: false,
    powerUp: { busy: false },
    walkthrough: {},
    historyBlocked,
  };
}

test("a history that can never be stored does not block Exit", async () => {
  const calls: string[] = [];
  const state = exitState({ message: "Your game is saved. This session's rewind timeline…" });
  await exitWithSilentHistory(state, calls).ejectGame();
  assert.equal(state.leaving, false);
  assert.deepEqual(calls, ["terminate"], "no durability barrier waits on a refused tape");
});

test("Leave without this session's timeline exits past a pending history save", async () => {
  const calls: string[] = [];
  const state = exitState(null);
  const lifecycle = exitWithSilentHistory(state, calls);
  await assert.rejects(lifecycle.ejectGame(), HistoryUnsavedError);
  assert.deepEqual(calls, ["historyEnd"]);
  await lifecycle.ejectGame({ abandonHistory: true });
  assert.deepEqual(calls, ["historyEnd", "terminate"]);
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

test("Leaving a game behind storage saves nothing over the newer project, and is not refused", async (t) => {
  // Another tab committed a newer revision: this game's files, conversation
  // and checkpoint all describe bytes storage no longer holds — whether this
  // tab heard (marked behind) or only the project index says so.
  const unheard = testProjectId("leave-behind-unheard");
  const newer = createContainer();
  newer.putResource("logic", 0, Uint8Array.of(0));
  await saveAuthoredGame(unheard, {
    title: "Kept elsewhere",
    provider: "stub",
    model: "offline-stub",
    files: Object.fromEntries(newer.files),
    words: [],
  });
  t.after(() => clearCachedGame(unheard));
  const running = { installed: false, title: "Behind", files: {}, words: [] };
  const revision = await gameRevision({});
  for (const game of [
    { ...running, projectId: testProjectId("leave-behind-marked"), revision, behindStorage: true },
    { ...running, projectId: unheard, revision },
  ] satisfies BootedGame[]) {
    const calls: string[] = [];
    const state = {
      leaving: false,
      phase: "running",
      powerUp: { busy: false },
      walkthrough: { active: false, status: "stopped" },
    };
    const noop = () => {};
    const lifecycle = useGameLifecycle({
      state,
      audio: { stop: noop, setPaused: noop },
      hook: {},
      authoring: {
        getSession: () => ({}),
        isRemixNeedsSave: () => true,
        persistRemix: async () => {
          calls.push("persist");
          throw new Error("The game was changed elsewhere");
        },
        resetSession: noop,
      },
      autosave: {
        flushAutosaveDetailed: async () => {
          calls.push("flush");
          return { status: "storage_failure" };
        },
        reset: noop,
        resetScreen: noop,
      },
      link: {
        query: async (kind: string) => {
          calls.push(kind);
          return kind === "exportFiles" ? {} : true;
        },
        terminateWorker: () => calls.push("terminate"),
        drainPendingQueries: noop,
        clearShake: noop,
      },
      testRecorder: { reset: noop },
      pauseEngine: noop,
      resumeEngine: noop,
      abortWalkthrough: noop,
      promptCancel: noop,
      drainHistoryCommits: async () => {},
      nextSessionId: noop,
      setActiveReplaySeed: noop,
      stopHistoryWriter: noop,
      resetPauseOwners: noop,
      resetHistoryView: noop,
      releaseAgentAudioPreviews: noop,
    } as unknown as GameLifecycleOptions);
    lifecycle.setBootedGame(game);
    await lifecycle.ejectGame();
    assert.deepEqual(calls, ["historyEnd", "terminate"], game.projectId);
    assert.equal(state.phase, "idle");
    assert.equal(lifecycle.getBootedGame(), null);
  }
});

function quitHarness() {
  const calls: string[] = [];
  const state = {
    leaving: false,
    phase: "running",
    gameEnded: null as { projectId: string; title: string } | null,
    powerUp: { busy: false },
    walkthrough: { active: false, status: "stopped" },
  };
  const noop = () => {};
  const lifecycle = useGameLifecycle({
    state,
    audio: { stop: noop, setPaused: noop },
    hook: {},
    logAgent: noop,
    authoring: { getSession: () => null, resetSession: noop },
    autosave: {
      flushAutosaveDetailed: async () => {
        calls.push("flush");
        return { status: "saved" };
      },
      lastAutosaveRecord: () => null,
      reset: noop,
      resetScreen: noop,
    },
    link: {
      query: async (kind: string) => {
        calls.push(kind);
        return true;
      },
      terminateWorker: () => calls.push("terminate"),
      drainPendingQueries: noop,
      clearShake: noop,
    },
    testRecorder: { reset: noop },
    pauseEngine: noop,
    resumeEngine: noop,
    abortWalkthrough: noop,
    promptCancel: noop,
    drainHistoryCommits: async () => {},
    nextSessionId: noop,
    setActiveReplaySeed: noop,
    stopHistoryWriter: noop,
    resetPauseOwners: noop,
    resetHistoryView: noop,
    releaseAgentAudioPreviews: noop,
  } as unknown as GameLifecycleOptions);
  return { calls, state, lifecycle };
}

test("A game that quits returns Home with its ending noted and no autosave taken after the quit", async () => {
  const { calls, state, lifecycle } = quitHarness();
  const projectId = testProjectId("quits-at-the-quiz");
  lifecycle.setBootedGame({
    installed: false,
    projectId,
    title: "Quiz Game",
    revision: await gameRevision({}),
    files: {},
    words: [],
  });
  await lifecycle.gameQuit();
  assert.deepEqual(calls, ["historyEnd", "terminate"], "the ended interpreter is not flushed");
  assert.equal(state.phase, "idle");
  assert.deepEqual(state.gameEnded, { projectId, title: "Quiz Game" });
});
