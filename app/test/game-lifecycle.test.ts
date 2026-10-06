import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HistoryUnsavedError,
  useGameLifecycle,
  type GameLifecycleOptions,
} from "../src/engine/useGameLifecycle.ts";
import type { ResumeBootCandidate, ResumeBootCarrier } from "../src/saves/useAutosaveController.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import {
  clearCachedGame,
  loadAuthoredGame,
  readHistoryLifetime,
  saveAuthoredGame,
  updateAuthoredGameFiles,
  type CachedGameData,
} from "../src/project/gameStorage.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import { bindProgressTarget } from "../src/project/progressBinding.ts";
import { createContainer } from "../../src/container/container.ts";
import type { BootedGame, ProjectId } from "../src/project/gameTypes.ts";

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
    autosave: {
      // No resume intent exists in this harness: an ordinary departure
      // proceeds, a foreign carrier would refuse.
      beginResumeBoot: (carrier?: ResumeBootCarrier) => carrier === undefined,
      flushAutosaveDetailed: async () => ({ status: "saved" }),
    },
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
      beginResumeBoot: (carrier?: ResumeBootCarrier) => carrier === undefined,
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
    historyLifetime: await readHistoryLifetime(projectId),
  };
  bindProgressTarget(game);
  game.authoredGame = (await loadAuthoredGame(projectId))!;
  // Another tab kept an edit after this game booted.
  const kept = createContainer();
  kept.putResource("logic", 0, Uint8Array.of(0));
  kept.putResource("logic", 1, Uint8Array.of(1));
  assert.equal(await updateAuthoredGameFiles(projectId, Object.fromEntries(kept.files)), true);
  const newer = (await loadAuthoredGame(projectId))!;
  game.behindStorage = true;

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
  const { data, progressKey, progressTarget, notes } = await lifecycle.exportCurrentGame();
  assert.deepEqual(notes, ["The game is from before the changes in the other tab."]);
  assert.deepEqual(data.files, files, "the download is the running game");
  assert.equal(progressTarget?.kind, "project");
  assert.equal(progressKey, progressTarget?.locator, "the key is the bound locator");
  assert.equal(progressKey, `project:${projectId}:${game.historyLifetime}`);
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
        beginResumeBoot: (carrier?: ResumeBootCarrier) => carrier === undefined,
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
    assert.deepEqual(calls, ["terminate"], game.projectId);
    assert.equal(state.phase, "idle");
    assert.equal(lifecycle.getBootedGame(), null);
  }
});

function quitHarness(flushResult: object = { status: "saved" }) {
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
      beginResumeBoot: (carrier?: ResumeBootCarrier) => carrier === undefined,
      flushAutosaveDetailed: async () => {
        calls.push("flush");
        return flushResult;
      },
      clearAutosave: () => calls.push("clear autosave"),
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

/**
 * A moment the interpreter cannot checkpoint — here the demo pack's f15 text
 * window, which stays up while the game runs on — is not a data risk: the
 * last save point stays and the sealed timeline holds the rest. Exit leaves.
 */
test("Exit leaves quietly when the current moment cannot be checkpointed", async () => {
  const { calls, state, lifecycle } = quitHarness({ status: "not_checkpointable" });
  await lifecycle.ejectGame();
  assert.deepEqual(calls, ["flush", "historyEnd", "terminate"], "the timeline is still sealed");
  assert.equal(state.leaving, false);
});

test("Exit still refuses when browser storage fails or the autosave times out", async () => {
  for (const status of ["storage_failure", "timeout"]) {
    const { calls, state, lifecycle } = quitHarness({ status });
    await assert.rejects(lifecycle.ejectGame(), /Settings → This game → Download…/);
    assert.deepEqual(calls, ["flush"], `${status} keeps the game running`);
    assert.equal(state.leaving, false);
  }
});

/** A boot-path lifecycle: real storage and binding, fake worker and session seams. */
function bootHarness(overrides: Partial<GameLifecycleOptions> = {}) {
  const workers: { posted: unknown[]; postMessage(m: unknown): void }[] = [];
  const sessions: unknown[] = [];
  const noop = () => {};
  const state = {
    loading: null as unknown,
    leaving: false,
    powerUp: { busy: false },
    phase: "idle" as string,
    error: "",
    installedGames: [] as unknown[],
    genesisStarter: null as unknown,
    soundMode: "pc-speaker" as string,
  };
  const lifecycle = useGameLifecycle({
    state,
    hook: {},
    audio: { useGameFiles: noop, stop: noop, setPaused: noop },
    logAgent: noop,
    link: {
      spawnWorker: () => {
        const worker = {
          posted: [] as unknown[],
          postMessage(msg: unknown) {
            worker.posted.push(msg);
          },
          terminate: noop,
        };
        workers.push(worker);
        return worker;
      },
      terminateWorker: noop,
      drainPendingQueries: noop,
      clearShake: noop,
      query: async () => null,
    },
    autosave: {
      // Ordinary boots only: no resume intent is armed here, so a foreign
      // carrier refuses the gate and admission defers to its dead intent.
      beginResumeBoot: (carrier?: ResumeBootCarrier) => carrier === undefined,
      takeResumeState: async (boot: ResumeBootCandidate, carrier?: ResumeBootCarrier) =>
        carrier === undefined ? { status: "none" as const } : carrier.admit(boot),
      resetScreen: noop,
      reset: noop,
      drainFlushWaiters: noop,
      flushAutosaveDetailed: async () => ({ status: "saved" }),
    },
    authoring: {
      getSession: () => null,
      setSession: (session: unknown) => sessions.push(session),
      resetSession: noop,
      attachSessionRuntime: noop,
      postSessionSnapshot: noop,
    },
    testRecorder: { reset: noop },
    promptCancel: noop,
    releaseAgentAudioPreviews: noop,
    pauseEngine: noop,
    resumeEngine: noop,
    resetPauseOwners: noop,
    resetHistoryView: noop,
    getSessionId: () => 1,
    nextSessionId: () => 2,
    getActiveReplaySeed: () => null,
    setActiveReplaySeed: noop,
    setActiveLlmConfig: noop,
    getActiveLlmConfig: () => ({ provider: "stub", apiKey: "", model: "offline-stub" }),
    abortWalkthrough: noop,
    drainHistoryCommits: async () => {},
    stopHistoryWriter: noop,
    ...overrides,
  } as unknown as GameLifecycleOptions);
  return { lifecycle, workers, sessions, state };
}

const STUB_CONFIG = { provider: "stub" as const, apiKey: "", model: "offline-stub" };

test("Exit ignores a project flush that answers after the physical session is retired", async () => {
  let release: (() => void) | undefined;
  let pauses = 0;
  const { lifecycle } = bootHarness({
    flushProject: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    pauseEngine: () => {
      pauses++;
    },
  });
  const leaving = lifecycle.ejectGame();
  lifecycle.shutdownEngine();
  release!();
  let failure: unknown;
  await leaving.catch((error) => {
    failure = error;
  });
  assert.equal(pauses, 0);
  assert.equal(failure, undefined);
});

function saveBody(id: ProjectId, fill: number) {
  return saveAuthoredGame(id, {
    title: id,
    provider: "stub",
    model: "offline-stub",
    files: { "WORDS.TOK": Uint8Array.of(fill) },
    words: [],
  });
}

test("a saved-world boot binds its physical progress target before the worker boots", async (t) => {
  const id = testProjectId("boot-binds-target");
  t.after(() => clearCachedGame(id));
  await saveBody(id, 7);
  const epoch = await readHistoryLifetime(id);
  const revision = await gameRevision({ "WORDS.TOK": Uint8Array.of(7) });
  const { lifecycle, workers } = bootHarness();
  await lifecycle.bootAuthoredGame("", STUB_CONFIG, { projectId: id, useCached: true });
  const game = lifecycle.getBootedGame();
  assert.equal(game?.projectId, id);
  assert.equal(game?.historyLifetime, epoch, "the boot carries the atomic snapshot's epoch");
  assert.equal(
    game?.progressTarget?.locator,
    `project:${id}:${epoch}`,
    "the binding lands before any worker traffic",
  );
  assert.equal(game?.progressTarget?.identity.project, id);
  assert.equal(game?.progressTarget?.identity.revision, revision);
  assert.equal(
    lifecycle.currentGame()?.progressTarget?.locator,
    `project:${id}:${epoch}`,
    "currentGame exposes the binding beside the released identity",
  );
  const boot = workers[0]?.posted.find((m) => (m as { type: string }).type === "boot");
  assert.ok(boot, "the bound game is the one posted to the worker");
});

test("an opening retired while run modules load never spawns a worker", async (t) => {
  const id = testProjectId("retired-module-load");
  t.after(() => clearCachedGame(id));
  await saveBody(id, 3);
  let current = true;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { lifecycle, workers } = bootHarness({
    prepareRun: () =>
      new Promise<void>((resolve) => {
        release = resolve;
        entered!();
      }),
  });
  const boot = lifecycle.bootAuthoredGame("", STUB_CONFIG, {
    projectId: id,
    useCached: true,
    opening: { isCurrent: () => current },
  });
  await ready;
  current = false;
  release!();
  await boot;
  assert.equal(workers.length, 0);
  assert.equal(lifecycle.getBootedGame(), null);
});

test("a cached boot superseded while storage answered never takes the slot", async (t) => {
  const idA = testProjectId("superseded-a");
  const idB = testProjectId("superseded-b");
  t.after(async () => {
    await clearCachedGame(idA);
    await clearCachedGame(idB);
  });
  await saveBody(idA, 1);
  await saveBody(idB, 2);
  const { lifecycle, workers, sessions } = bootHarness();
  // The first boot parks on the atomic body read; the second retires it
  // before storage answers.
  const first = lifecycle.bootAuthoredGame("", STUB_CONFIG, {
    projectId: idA,
    useCached: true,
  });
  const second = lifecycle.bootAuthoredGame("", STUB_CONFIG, {
    projectId: idB,
    useCached: true,
  });
  await Promise.all([first, second]);
  const game = lifecycle.getBootedGame();
  assert.equal(game?.projectId, idB, "the newer boot owns the slot");
  assert.equal(game?.progressTarget?.locator, `project:${idB}:${await readHistoryLifetime(idB)}`);
  assert.equal(workers.length, 1, "the retired boot never spawned a worker");
  const boots = workers[0]!.posted.filter((m) => (m as { type: string }).type === "boot");
  assert.equal(boots.length, 1);
  assert.deepEqual(
    (boots[0] as { files: Record<string, Uint8Array> }).files["WORDS.TOK"],
    Uint8Array.of(2),
    "only the newer game's bytes reach a worker",
  );
  assert.equal(sessions.length, 1, "the retired boot never touched the session");
});

test("a superseded creation's finish saves and boots nothing", async (t) => {
  const id = testProjectId("superseded-finish");
  t.after(() => clearCachedGame(id));
  const { lifecycle, workers } = bootHarness();
  const files = { "WORDS.TOK": Uint8Array.of(9) };
  const session = { getAuthoringState: () => ({}), getMessages: () => [] };
  const resources = { files, words: [] as [string, number][], transcript: [], sessionId: "s1" };
  const boot = { projectId: id, title: "Late world", config: STUB_CONFIG };
  // Epoch 0 was this run's when it armed; a newer action has taken the slot
  // since (shutdownEngine moves the clock), so the finish belongs to a
  // retired run.
  lifecycle.shutdownEngine();
  await lifecycle.finishAuthoredBoot(session as never, resources, boot, 0);
  assert.equal(await loadAuthoredGame(id), null, "the retired run's first save never lands");
  assert.equal(lifecycle.getBootedGame(), null);
  assert.equal(workers.length, 0);

  // Positive control: the same finish with the live epoch runs the full
  // save-and-boot, bound to the epoch its own save returned.
  await lifecycle.finishAuthoredBoot(session as never, resources, boot);
  const game = lifecycle.getBootedGame();
  assert.equal(game?.projectId, id);
  const epoch = await readHistoryLifetime(id);
  assert.equal(
    game?.progressTarget?.locator,
    `project:${id}:${epoch}`,
    "the saved body's own epoch binds the running game",
  );
  assert.equal(game?.historyLifetime, epoch);
  assert.equal(
    game?.authoredGame?.generation,
    (await loadAuthoredGame(id))?.generation,
    "the first editable session carries the generation its own save committed",
  );
  assert.equal(workers.length, 1);
});

for (const replacement of ["installed", "authored"] as const) {
  test(`a refused editor barrier keeps the current workspace before ${replacement} replacement`, async () => {
    const state = {
      phase: "running",
      loading: null,
      error: "",
      genesisStarter: null,
      powerUp: { busy: false },
    };
    const lifecycle = useGameLifecycle({
      state,
      devFixtures: true,
      autosave: { beginResumeBoot: () => true },
      flushProject: async () => {
        throw new Error("Could not save notes. Retry the save.");
      },
      prepareRun: async () => {
        throw new Error("replacement began");
      },
    } as unknown as GameLifecycleOptions);
    const replacing =
      replacement === "installed"
        ? lifecycle.bootGame("synthetic")
        : lifecycle.bootAuthoredGame(
            "",
            { provider: "stub", model: "offline-stub", apiKey: "" },
            { useCached: true, projectId: testProjectId("replacement") },
          );
    await assert.rejects(replacing, /Could not save notes/);
    assert.equal(state.phase, "running");
    assert.equal(state.loading, null);
    assert.equal(state.error, "");
  });
}
