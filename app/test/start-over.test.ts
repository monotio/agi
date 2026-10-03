import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createStartOver } from "../src/engine/startOver.ts";
import { createPauseHolds } from "../src/engine/pauseHolds.ts";
import { createWorkerQueries } from "../src/engine/workerQueries.ts";
import {
  HistoryUnsavedError,
  useGameLifecycle,
  type GameLifecycleOptions,
} from "../src/engine/useGameLifecycle.ts";
import { readAutosave, useAutosaveController } from "../src/saves/useAutosaveController.ts";
import { writeAutosave } from "../src/saves/gameProgress.ts";
import { installedProgressTarget } from "../src/project/progressTarget.ts";
import { requireResourceRevision } from "../../src/gameIdentity.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import type { EngineState } from "../src/engine/useEngineTypes.ts";

/**
 * Start over seals the running session's timeline before its worker is
 * replaced. When the seal fails it refuses as Exit does: the checkpoint,
 * the worker and every other pause hold stay exactly as they were.
 */

const KEY = "adventure";
const config = { provider: "stub" as const, apiKey: "", model: "offline-stub" };

function installLocalStorage(t: TestContext): void {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  });
}

function fakeWorker() {
  const posted: { type: string; paused?: boolean }[] = [];
  return {
    posted,
    postMessage: (msg: { type: string; paused?: boolean }) => void posted.push(msg),
    terminate: () => {},
  };
}
type FakeWorker = ReturnType<typeof fakeWorker>;

/**
 * A running installed game with a checkpoint, a real pause-hold set and a
 * real history seal whose `historyEnd` query goes through `historyEnd`.
 */
function runningGame(
  t: TestContext,
  historyEnd: (worker: FakeWorker, timeoutMs: number | undefined) => Promise<unknown>,
) {
  installLocalStorage(t);
  // The checkpoint sits under the game's physical locator, where a bound
  // installed boot writes it — the released spelling is read context only.
  const target = installedProgressTarget({ folder: KEY }, requireResourceRevision("b".repeat(64)))!;
  writeAutosave(localStorage, target, {
    format: "monotio.agi.autosave",
    version: 1,
    image: "checkpoint",
    cycle: 42,
    room: 1,
    savedAt: 1,
    game: {
      installed: true,
      identity: target.identity,
    },
  });
  const state = {
    phase: "running",
    paused: false,
    resumed: false,
    installedGames: null,
    leaving: false,
    powerUp: { busy: false },
    historyBlocked: null,
  } as unknown as EngineState;
  const game = {
    installed: true,
    folder: KEY,
    revision: requireResourceRevision("b".repeat(64)),
  } as unknown as BootedGame;
  const first = fakeWorker();
  let worker: FakeWorker = first;
  const session = 0;
  const holds = createPauseHolds({
    post: (paused) => worker.postMessage({ type: "pause", paused }),
    audio: { setPaused: () => {} },
    state,
  });
  const lifecycle = useGameLifecycle({
    state,
    link: {
      query: (type: string, _extra: unknown, timeoutMs?: number) => {
        assert.equal(type, "historyEnd");
        return historyEnd(worker, timeoutMs);
      },
    },
    drainHistoryCommits: async () => {},
  } as unknown as GameLifecycleOptions);
  const autosave = useAutosaveController({
    state,
    getBootedGame: () => game,
    getWorker: () => worker as unknown as Worker,
    logAgent: () => {},
    isInstalledGame: () => true,
    // The fresh boot replaces the worker, as useWorkerLink.spawnWorker does.
    bootGame: async () => {
      worker = fakeWorker();
    },
    // The lifecycle's fresh-boot seam: the served build re-binds to the
    // selected locator, the operation is re-admitted, then the checkpoint
    // commit and the worker swap land.
    bootInstalledFresh: async (selected, admission) => {
      const landed = installedProgressTarget({ folder: selected.folder }, target.identity.revision);
      if (landed === null || landed.locator !== selected.locator)
        return { status: "refused" as const };
      if (!admission.admitted(landed)) return { status: "superseded" as const };
      admission.commit();
      worker = fakeWorker();
      return { status: "completed" as const };
    },
    bootAuthoredGame: async () => assert.fail("an installed game never boots as a project"),
    configForGame: (_project, llm) => llm,
    // No resume intent is armed by a start-over; retirement is unreachable.
    retireFailedRecovery: () => {},
  });
  let expectingStartOver = false;
  const startOver = createStartOver({
    state,
    getBootedGame: () => game,
    getWorker: () => worker as unknown as Worker,
    getSessionId: () => session,
    sealHistory: lifecycle.sealHistory,
    drainHistoryCommits: async () => {},
    pauseEngine: holds.pauseEngine,
    resumeEngine: holds.resumeEngine,
    selectTarget: (targetKey, booted) => autosave.selectProgressTarget(targetKey, booted),
    hasEarlierSession: async () => false,
    expectStartOver: (expected = true) => {
      expectingStartOver = expected;
    },
    bootFresh: autosave.startOver,
    showNote: () => {},
  });
  return {
    state,
    first,
    holds,
    startOver,
    target,
    worker: () => worker,
    expectingStartOver: () => expectingStartOver,
    pauses: () => first.posted.filter((m) => m.type === "pause").map((m) => m.paused),
  };
}

/** The refusal: nothing Start over would have replaced has moved. */
function assertRefused(game: ReturnType<typeof runningGame>): void {
  assert.equal(readAutosave(game.target.locator)?.image, "checkpoint", "the checkpoint is kept");
  assert.equal(readAutosave(game.target.locator)?.cycle, 42);
  assert.equal(game.worker(), game.first, "no new worker was spawned");
  assert.equal(game.expectingStartOver(), false, "no Started over mark is expected");
}

const failures = {
  rejects: () => Promise.reject(new Error("engine worker stopped")),
  "never answers": (worker: FakeWorker, timeoutMs: number | undefined) =>
    createWorkerQueries().query(() => worker as unknown as Worker, "historyEnd", {}, timeoutMs),
};

for (const [failure, historyEnd] of Object.entries(failures)) {
  /** Run Start over to its refusal; a silent worker's query times out on mocked timers. */
  async function refuse(t: TestContext, game: ReturnType<typeof runningGame>): Promise<void> {
    const pending = game.startOver(KEY, config);
    if (failure === "never answers") {
      for (let i = 0; i < 20 && !game.first.posted.some((m) => m.type === "historyEnd"); i++)
        await new Promise((resolve) => setImmediate(resolve));
      assert.ok(
        game.first.posted.some((m) => m.type === "historyEnd"),
        "the seal was asked",
      );
      t.mock.timers.tick(10_000);
    }
    await assert.rejects(pending, HistoryUnsavedError);
  }

  test(`Start over refuses when the timeline seal ${failure}; a running game runs again`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const game = runningGame(t, historyEnd);
    await refuse(t, game);
    assertRefused(game);
    assert.deepEqual(game.holds.pauseOwners(), [], "Start over released its own hold");
    assert.equal(game.state.paused, false);
    assert.deepEqual(game.pauses(), [true, false], "frozen for the seal, then running again");
  });

  test(`Start over refuses when the timeline seal ${failure}; a paused game stays paused`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const game = runningGame(t, historyEnd);
    game.holds.pauseEngine("transport");
    await refuse(t, game);
    assertRefused(game);
    assert.deepEqual(game.holds.pauseOwners(), ["transport"], "the player's pause is kept");
    assert.equal(game.state.paused, true);
    assert.deepEqual(game.pauses(), [true], "no resume was posted");
  });
}

test("Start over without the unsaved timeline proceeds past a failing seal", async (t) => {
  const game = runningGame(t, failures.rejects);
  await assert.rejects(game.startOver(KEY, config), HistoryUnsavedError);
  await game.startOver(KEY, config, { abandonHistory: true });
  assert.equal(readAutosave(game.target.locator), null, "the checkpoint is cleared");
  assert.notEqual(game.worker(), game.first, "the game booted afresh");
  assert.equal(game.expectingStartOver(), true, "the fresh boot is marked Started over");
});
