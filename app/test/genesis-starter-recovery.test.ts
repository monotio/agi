/**
 * Genesis starter recovery: a provider-driven Create that fails or is
 * cancelled before finish offers "Open starter" on the error surface, and
 * the explicit click commits the same prepared canonical Starter once and
 * boots it as an ordinary manual project. Storage is the real contract —
 * the fake IndexedDB and localStorage fixtures carry it — while the
 * provider side stays a deterministic fake stack or the no-key refusal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useGameLifecycle, type GameLifecycleOptions } from "../src/engine/useGameLifecycle.ts";
import {
  createGenesisStarterRecovery,
  type GenesisStarterOffer,
  type GenesisStarterRecovery,
  type PrepareStarter,
} from "../src/authoring/genesisStarterRecovery.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import {
  clearCachedGame,
  listCachedGames,
  loadAuthoredGame,
  saveAuthoredGame,
} from "../src/project/gameStorage.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import type { EngineState } from "../src/engine/useEngineTypes.ts";
import type { AuthoringLoader } from "../src/agent/authoringLoader.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";
import type { BootResources } from "../src/agent/agentSession.ts";

installIndexedDbFixture();
// The project index lives in localStorage; each test file runs in its own
// process. The index view enumerates localStorage's own keys, so entries
// live as enumerable properties beside the API.
const localValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem(key: string) {
      return localValues.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      localValues.set(key, value);
      Object.defineProperty(this, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
    },
    removeItem(key: string) {
      localValues.delete(key);
      Reflect.deleteProperty(this, key);
    },
  },
});

const OPENAI: LlmConfig = { provider: "openai", apiKey: "sk-test", model: "gpt-test" };
const NO_KEY: LlmConfig = { provider: "openai", apiKey: "", model: "gpt-test" };
const STUB: LlmConfig = { provider: "stub", apiKey: "", model: "offline-stub" };

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The minimal booted bytes a successful fake genesis hands over. */
const GENESIS_RESULT: BootResources = { files: {}, words: [] };

/**
 * A loader whose AgentSession is a controllable stand-in: startGenesis is
 * the test's promise, getAuthoringState the empty authoring record the boot
 * fingerprints.
 */
function fakeAuthoring(run: () => Promise<BootResources>) {
  const sessions: { startGenesis: () => Promise<BootResources> }[] = [];
  const loadAuthoring = (async () => ({
    AgentSession: class {
      constructor() {
        sessions.push(this);
      }
      getAuthoringState(): Record<string, unknown> {
        return {};
      }
      getMessages(): { role: "user" | "assistant"; text: string }[] {
        return [];
      }
      startGenesis(): Promise<BootResources> {
        return run();
      }
    },
  })) as unknown as AuthoringLoader;
  return { loadAuthoring, sessions };
}

function harness(options?: {
  loadAuthoring?: AuthoringLoader;
  recovery?: GenesisStarterRecovery;
  activeConfig?: LlmConfig;
}) {
  const state = {
    agentTask: null,
    leaving: false,
    phase: "idle",
    error: "",
    status: "",
    loading: null,
    genesisStarter: null as GenesisStarterOffer | null,
    staleTab: false,
    projectRemoved: false,
    historyBlocked: null,
    historyRetry: null,
    powerUp: { open: false, busy: false },
    walkthrough: { active: false, status: "stopped", error: "" },
    textMode: false,
    modal: null,
    showObjView: null,
    controls: [],
    inputEnabled: false,
    inputReady: false,
    holdToMove: false,
    waitingForKey: false,
    gameEdit: null,
    rows: [],
    paused: false,
    profile: null,
    soundPlaying: false,
    soundMode: "web",
    shake: false,
  };
  const noop = () => {};
  const sessions: unknown[] = [];
  const calls = { sessionResets: 0 };
  let active = options?.activeConfig ?? STUB;
  const lifecycle = useGameLifecycle({
    state,
    hook: {},
    audio: { stop: noop, setPaused: noop, useGameFiles: noop },
    logAgent: noop,
    link: {
      spawnWorker: () => ({ postMessage: noop }),
      query: async () => true,
      terminateWorker: noop,
      drainPendingQueries: noop,
      clearShake: noop,
    },
    autosave: {
      beginResumeBoot: () => true,
      drainFlushWaiters: noop,
      resetScreen: noop,
      reset: noop,
      flushAutosaveDetailed: async () => ({ status: "saved" }),
      takeResumeState: async () => ({ status: "none" }),
    },
    authoring: {
      setSession: (session: unknown) => sessions.push(session),
      getSession: () => sessions.at(-1) ?? null,
      resetSession: () => {
        calls.sessionResets++;
      },
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
    getSessionId: () => 0,
    nextSessionId: () => 0,
    getActiveReplaySeed: () => null,
    setActiveReplaySeed: noop,
    setActiveLlmConfig: (config: LlmConfig) => {
      active = config;
    },
    getActiveLlmConfig: () => active,
    abortWalkthrough: noop,
    drainHistoryCommits: async () => {},
    stopHistoryWriter: noop,
    loadAuthoring: options?.loadAuthoring,
    genesisStarterRecovery: options?.recovery,
  } as unknown as GameLifecycleOptions);
  return { state: state as unknown as EngineState, lifecycle, sessions, calls };
}

/** A prepared-candidate spy: same contract, a save the test can gate or fail first. */
function recordingPrepare(
  gate?: (candidate: ReturnType<typeof prepareLocalProject>) => Promise<void>,
) {
  const record = {
    candidates: [] as ReturnType<typeof prepareLocalProject>[],
    saves: 0,
  };
  const prepare: PrepareStarter = async (title) => {
    const candidate = prepareLocalProject({ title, kind: "starter" });
    record.candidates.push(candidate);
    return {
      projectId: candidate.projectId,
      workspaceId: candidate.workspaceId,
      data: () => candidate.data(),
      save: async () => {
        record.saves++;
        if (gate) await gate(candidate);
        return candidate.save();
      },
    };
  };
  return { record, prepare };
}

test("a provider refusal offers the prepared starter and Open starter commits it once", async (t) => {
  const { state, lifecycle, sessions, calls } = harness();
  await lifecycle.bootAuthoredGame("template", NO_KEY, { title: "Quiet Museum" });
  assert.equal(state.phase, "error");
  assert.match(state.error, /Connect an API key/);
  const offer = state.genesisStarter;
  assert.ok(offer, "the failed run's starter is on offer");
  assert.equal(offer.title, "Quiet Museum");
  assert.equal(listCachedGames().length, 0, "the failure alone stores nothing");
  assert.equal(calls.sessionResets, 0, "the failed session stayed live until the choice");

  await lifecycle.openStarterRecovery();
  const projectId = lifecycle.getBootedGame()?.projectId;
  assert.ok(projectId?.startsWith("local-"), "the manual project's own id");
  const stored = await loadAuthoredGame(projectId!);
  assert.ok(stored);
  assert.equal(stored.title, "Quiet Museum");
  assert.equal(stored.roomGeneration, false);
  assert.equal(stored.library?.profile, "2.936");
  assert.equal(state.genesisStarter, null, "a handed offer clears once opened");
  assert.ok(sessions.length >= 1);
  assert.equal(calls.sessionResets, 1, "the explicit choice retired the failed session");
  t.after(() => clearCachedGame(projectId!));

  // A second click settles against nothing: the offer was consumed.
  await lifecycle.openStarterRecovery();
  assert.equal(lifecycle.getBootedGame()?.projectId, projectId);
  assert.equal(listCachedGames().filter((game) => game.title === "Quiet Museum").length, 1);
});

test("no offer before the failure lands, and the stub never arms one", async () => {
  const pending = deferred<BootResources>();
  const { loadAuthoring } = fakeAuthoring(() => pending.promise);
  const { record, prepare } = recordingPrepare();
  const recovery = createGenesisStarterRecovery({ prepare });
  const { state, lifecycle } = harness({ loadAuthoring, recovery });
  const booting = lifecycle.bootAuthoredGame("template", OPENAI, { title: "Pending" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(record.candidates.length, 1, "armed before the request settles");
  assert.equal(state.phase, "loading");
  const shown = state.genesisStarter;
  assert.equal(shown, null, "nothing offered while the run is alive");
  assert.equal(recovery.pending(), null);
  pending.reject(new Error("provider 400"));
  await booting;
  assert.equal(state.phase, "error");
  const offer = state.genesisStarter;
  assert.ok(offer);
  assert.equal(offer.title, "Pending");

  // The deterministic offline author needs no recovery: no candidate prepared.
  await lifecycle.bootAuthoredGame("template", STUB, { title: "Offline" });
  assert.equal(record.candidates.length, 1, "the stub run never armed recovery");
});

test("a cancelled generation offers the same starter recovery", async (t) => {
  const { loadAuthoring } = fakeAuthoring(() =>
    Promise.reject(new Error("Agent task cancelled. Unapplied changes were discarded.")),
  );
  const { state, lifecycle } = harness({ loadAuthoring });
  await lifecycle.bootAuthoredGame("template", OPENAI, { title: "Cancelled" });
  assert.equal(state.phase, "error");
  assert.equal(state.genesisStarter?.title, "Cancelled");
  await lifecycle.openStarterRecovery();
  const projectId = lifecycle.getBootedGame()?.projectId;
  assert.ok(projectId);
  t.after(() => clearCachedGame(projectId!));
});

test("a later boot supersedes the offer; a stale failure cannot overwrite the slot", async () => {
  const first = deferred<BootResources>();
  let run = 0;
  const { loadAuthoring } = fakeAuthoring(() => {
    run++;
    return run === 1 ? first.promise : Promise.reject(new Error("second refusal"));
  });
  const { record, prepare } = recordingPrepare();
  const recovery = createGenesisStarterRecovery({ prepare });
  const { state, lifecycle } = harness({ loadAuthoring, recovery });
  const booting = lifecycle.bootAuthoredGame("template", OPENAI, { title: "First" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(record.candidates.length, 1);
  const firstCandidate = record.candidates[0]!;

  // A newer Create owns the slot before the first request answers.
  await lifecycle.bootAuthoredGame("template", OPENAI, { title: "Second" });
  assert.equal(state.phase, "error");
  assert.equal(state.genesisStarter?.title, "Second");
  assert.equal(record.candidates.length, 2, "the second run armed its own starter");

  // The stale refusal resolves into a superseded epoch: silent, no offer.
  first.reject(new Error("late refusal"));
  await booting;
  assert.equal(state.error, "Error: second refusal");
  assert.equal(state.genesisStarter?.title, "Second");
  assert.equal(record.saves, 0);

  // A stale click against the retired offer commits nothing.
  assert.equal(await recovery.open({ title: "First", opening: false }), null);
  assert.equal(await loadAuthoredGame(firstCandidate.projectId), null);

  // Leaving the slot retires the second run's offer too.
  const secondOffer = recovery.pending()!;
  await lifecycle.ejectGame();
  assert.equal(state.phase, "idle");
  assert.equal(state.genesisStarter, null);
  assert.equal(await recovery.open(secondOffer), null);
  assert.equal(record.saves, 0);
});

test("a late success from a superseded run neither boots nor saves over the slot", async () => {
  const first = deferred<BootResources>();
  let run = 0;
  const { loadAuthoring } = fakeAuthoring(() => {
    run++;
    return run === 1 ? first.promise : Promise.reject(new Error("second refusal"));
  });
  const { state, lifecycle } = harness({ loadAuthoring });
  const firstProject = testProjectId("stale-genesis");
  const booting = lifecycle.bootAuthoredGame("template", OPENAI, {
    projectId: firstProject,
    title: "First",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await lifecycle.bootAuthoredGame("template", OPENAI, { title: "Second" });
  first.resolve(GENESIS_RESULT);
  await booting;
  assert.equal(await loadAuthoredGame(firstProject), null, "the late world never stored");
  assert.equal(state.genesisStarter?.title, "Second");
  assert.equal(lifecycle.getBootedGame(), null, "no booted game replaced the slot");
});

test("a successful later generation clears the offer", async (t) => {
  let run = 0;
  const { loadAuthoring } = fakeAuthoring(() => {
    run++;
    return run === 1 ? Promise.reject(new Error("refusal")) : Promise.resolve(GENESIS_RESULT);
  });
  const { state, lifecycle } = harness({ loadAuthoring });
  await lifecycle.bootAuthoredGame("template", OPENAI, { title: "Failed" });
  assert.ok(state.genesisStarter);
  const projectId = testProjectId("later-success");
  await lifecycle.bootAuthoredGame("template", OPENAI, { projectId, title: "Second" });
  assert.equal(state.genesisStarter, null);
  assert.equal(lifecycle.getBootedGame()?.projectId, projectId);
  assert.ok(await loadAuthoredGame(projectId));
  t.after(() => clearCachedGame(projectId));
});

test("a double-click settles one commit under one project id", async (t) => {
  const { loadAuthoring } = fakeAuthoring(() => Promise.reject(new Error("refusal")));
  const gate = deferred<void>();
  const { record, prepare } = recordingPrepare(async () => {
    await gate.promise;
  });
  const recovery = createGenesisStarterRecovery({ prepare });
  const { lifecycle } = harness({ loadAuthoring, recovery });
  await lifecycle.bootAuthoredGame("template", OPENAI, { title: "Once" });
  const candidate = record.candidates[0]!;
  t.after(() => clearCachedGame(candidate.projectId));

  const first = lifecycle.openStarterRecovery();
  const second = lifecycle.openStarterRecovery();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(record.saves, 1, "the second click settles with the first");
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(record.saves, 1);
  assert.equal(lifecycle.getBootedGame()?.projectId, candidate.projectId);
  assert.equal(listCachedGames().filter((game) => game.title === "Once").length, 1);
});

test("a failed save keeps the same prepared candidate for the retry", async (t) => {
  const { loadAuthoring } = fakeAuthoring(() => Promise.reject(new Error("refusal")));
  let failNext = true;
  const { record, prepare } = recordingPrepare(async () => {
    if (failNext) {
      failNext = false;
      throw new Error("Browser storage quota");
    }
  });
  const recovery = createGenesisStarterRecovery({ prepare });
  const { state, lifecycle } = harness({ loadAuthoring, recovery });
  await lifecycle.bootAuthoredGame("template", OPENAI, { title: "Retry" });
  const candidate = record.candidates[0]!;
  t.after(() => clearCachedGame(candidate.projectId));

  await lifecycle.openStarterRecovery();
  assert.match(state.error, /Could not save the starter/);
  assert.equal(state.phase, "error");
  assert.equal(state.genesisStarter?.title, "Retry", "the same offer stays for retry");
  assert.equal(await loadAuthoredGame(candidate.projectId), null);

  // Retry commits the identical candidate — same project id, one copy.
  await lifecycle.openStarterRecovery();
  assert.equal(lifecycle.getBootedGame()?.projectId, candidate.projectId);
  assert.equal(record.saves, 2);
  assert.equal(listCachedGames().filter((game) => game.title === "Retry").length, 1);
});

test("recovery never takes the failed run's requested project id", async (t) => {
  const { loadAuthoring } = fakeAuthoring(() => Promise.reject(new Error("refusal")));
  const { record, prepare } = recordingPrepare();
  const { state, lifecycle } = harness({
    loadAuthoring,
    recovery: createGenesisStarterRecovery({ prepare }),
  });
  const existing = testProjectId("existing-adventure");
  const kept = { first: Uint8Array.of(1, 2, 3) };
  await saveAuthoredGame(existing, {
    title: "Existing adventure",
    provider: "stub",
    model: "offline-stub",
    files: { "VOL.0": kept.first },
    words: [],
  });
  t.after(() => clearCachedGame(existing));

  // The failed run asked to overwrite that project; the fallback must not.
  await lifecycle.bootAuthoredGame("template", OPENAI, {
    projectId: existing,
    title: "Adventure",
    overwrite: true,
  });
  assert.ok(state.genesisStarter);
  await lifecycle.openStarterRecovery();
  const recovered = lifecycle.getBootedGame()?.projectId;
  assert.ok(recovered);
  assert.notEqual(recovered, existing);
  assert.ok(recovered!.startsWith("local-"));
  const untouched = await loadAuthoredGame(existing);
  assert.equal(untouched?.title, "Existing adventure");
  assert.deepEqual(untouched?.files, { "VOL.0": kept.first });
  assert.equal(record.candidates.length, 1);
  t.after(() => clearCachedGame(recovered!));
});

test("controller: a retired or stale offer opens nothing and hands no identity", async () => {
  const { record, prepare } = recordingPrepare();
  const recovery = createGenesisStarterRecovery({ prepare });
  const first = await recovery.begin("First");
  const second = await recovery.begin("Second");
  assert.notEqual(first, second);
  assert.ok(recovery.superseded(first));
  assert.equal(recovery.fail(first), null, "the superseded run cannot offer");
  assert.equal(recovery.fail(second)?.title, "Second");
  const offer = recovery.pending()!;
  assert.equal(record.candidates.length, 2);

  // An object posing as the offer but not owned by the run opens nothing.
  assert.equal(await recovery.open({ title: "First", opening: false }), null);
  assert.equal(record.saves, 0);

  recovery.retire();
  assert.equal(recovery.pending(), null);
  assert.equal(await recovery.open(offer), null, "a retired offer is inert");

  // handOver seals the run: a later failure offers nothing.
  const third = await recovery.begin("Third");
  recovery.handedOver(third);
  assert.equal(recovery.fail(third), null);
  assert.equal(recovery.pending(), null);
});

for (const newerOutcome of ["error", "success"] as const) {
  test(`a superseded starter save failure cannot replace a newer ${newerOutcome} screen`, async (t) => {
    let run = 0;
    const { loadAuthoring } = fakeAuthoring(() => {
      run++;
      if (run === 1) return Promise.reject(new Error("First provider refusal"));
      return newerOutcome === "error"
        ? Promise.reject(new Error("Newer provider refusal"))
        : Promise.resolve(GENESIS_RESULT);
    });
    const saveGate = deferred<void>();
    const { record, prepare } = recordingPrepare(async () => saveGate.promise);
    const recovery = createGenesisStarterRecovery({ prepare });
    const { state, lifecycle } = harness({ loadAuthoring, recovery });
    await lifecycle.bootAuthoredGame("template", OPENAI, { title: "First attempt" });
    const firstOffer = state.genesisStarter;
    assert.ok(firstOffer);

    const opening = lifecycle.openStarterRecovery();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(record.saves, 1);
    assert.equal(firstOffer.opening, true);

    const newerId = testProjectId(`newer-${newerOutcome}-after-starter`);
    t.after(() => clearCachedGame(newerId));
    await lifecycle.bootAuthoredGame("template", OPENAI, {
      projectId: newerId,
      title: "Newer attempt",
    });
    const ownedError = state.error;
    const ownedPhase = state.phase;
    const ownedOffer = state.genesisStarter;
    const ownedGame = lifecycle.getBootedGame();
    if (newerOutcome === "error") {
      assert.equal(ownedPhase, "error");
      assert.match(ownedError, /Newer provider refusal/);
      assert.ok(ownedOffer);
      assert.notEqual(ownedOffer, firstOffer);
    } else {
      assert.equal(ownedGame?.projectId, newerId);
      assert.equal(ownedOffer, null);
    }

    saveGate.reject(new Error("Old storage quota refusal"));
    await opening;
    assert.equal(state.error, ownedError, "the retired save owns no current error surface");
    assert.equal(state.phase, ownedPhase);
    assert.equal(state.genesisStarter, ownedOffer);
    assert.equal(lifecycle.getBootedGame(), ownedGame);
    assert.equal(firstOffer.opening, false);
    assert.equal(await loadAuthoredGame(record.candidates[0]!.projectId), null);
  });
}

test("a superseded starter save that lands stays shelved and takes nothing", async (t) => {
  let run = 0;
  const { loadAuthoring } = fakeAuthoring(() => {
    run++;
    return run === 1
      ? Promise.reject(new Error("First provider refusal"))
      : Promise.resolve(GENESIS_RESULT);
  });
  const saveGate = deferred<void>();
  const { record, prepare } = recordingPrepare(async () => saveGate.promise);
  const recovery = createGenesisStarterRecovery({ prepare });
  const { state, lifecycle } = harness({ loadAuthoring, recovery });
  await lifecycle.bootAuthoredGame("template", OPENAI, { title: "First attempt" });
  const firstOffer = state.genesisStarter;
  assert.ok(firstOffer);

  const opening = lifecycle.openStarterRecovery();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(record.saves, 1);

  const newerId = testProjectId("newer-success-after-landed-save");
  t.after(() => clearCachedGame(newerId));
  await lifecycle.bootAuthoredGame("template", OPENAI, {
    projectId: newerId,
    title: "Newer attempt",
  });
  const ownedGame = lifecycle.getBootedGame();
  assert.equal(ownedGame?.projectId, newerId);

  // The retired save commits late: the library keeps it, the running screen
  // does not.
  saveGate.resolve();
  await opening;
  const shelvedId = record.candidates[0]!.projectId;
  t.after(() => clearCachedGame(shelvedId));
  assert.ok(await loadAuthoredGame(shelvedId), "the clicked commit still landed");
  assert.equal(lifecycle.getBootedGame(), ownedGame, "the newer game keeps the slot");
  assert.equal(state.genesisStarter, null);
  assert.equal(state.error, "");
  assert.equal(firstOffer.opening, false);
});

for (const delayedStage of ["loader", "seed"] as const) {
  test(`a retired creation cannot arm after a delayed ${delayedStage}`, async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    let retiredRequests = 0;
    const retired = fakeAuthoring(() => {
      retiredRequests++;
      return Promise.reject(new Error("Retired provider refusal"));
    });
    const newer = fakeAuthoring(() => Promise.reject(new Error("Current provider refusal")));
    let loads = 0;
    const loadAuthoring = (async () => {
      loads++;
      if (loads !== 1) return newer.loadAuthoring();
      if (delayedStage === "loader") {
        entered.resolve();
        await gate.promise;
      }
      return retired.loadAuthoring();
    }) as AuthoringLoader;
    const recovery = createGenesisStarterRecovery({
      prepare: async (title) => {
        if (title === "Retired attempt" && delayedStage === "seed") {
          entered.resolve();
          await gate.promise;
        }
        return prepareLocalProject({ title, kind: "starter" });
      },
    });
    const { state, lifecycle, sessions } = harness({ loadAuthoring, recovery });
    const oldBoot = lifecycle.bootAuthoredGame("template", OPENAI, {
      title: "Retired attempt",
    });
    await entered.promise;
    await lifecycle.bootAuthoredGame("template", OPENAI, {
      projectId: testProjectId(`current-after-delayed-${delayedStage}`),
      title: "Current attempt",
    });
    const ownedError = state.error;
    const ownedOffer = state.genesisStarter;
    const ownedSession = sessions.at(-1);
    assert.match(ownedError, /Current provider refusal/);
    assert.ok(ownedOffer);
    gate.resolve();
    await oldBoot;
    assert.equal(state.error, ownedError);
    assert.equal(state.genesisStarter, ownedOffer);
    assert.equal(sessions.at(-1), ownedSession);
    assert.equal(retiredRequests, 0, "a retired creation must not start a provider request");
  });
}
