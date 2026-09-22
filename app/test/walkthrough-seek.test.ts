import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInitialWalkthroughState,
  useWalkthroughController,
  type WalkthroughControllerContext,
  type WalkthroughUiState,
} from "../src/useWalkthroughController.ts";
import type { ReplayDriver, ReplayObservation } from "../src/replay.ts";
import type { AgiAudio } from "../src/audio/AgiAudio.ts";
import type { BootedGame } from "../src/gameTypes.ts";
import type { WorkerInbound } from "../src/workerProtocol.ts";

const REVISION = "a".repeat(64);

function fakeObservation(tick: number, sessionId?: number): ReplayObservation {
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    revision: 1,
    tick,
    cycle: tick,
    blocked: null,
    state: {
      room: 1,
      vars: [0, 0, 0, 0],
      egoX: 10,
      egoY: 100,
      modalKind: null,
      inputEnabled: true,
    } as unknown as ReplayObservation["state"],
    rows: [],
    egoView: 0,
    releaseGate: 0,
  };
}

/**
 * A controller wired to a fake worker and driver: the walkthrough's batch
 * stays in flight, and `resetReplay` answers its tick-0 observation the way
 * the real worker does.
 */
function harness() {
  const state = {
    walkthrough: createInitialWalkthroughState(),
    phase: "running",
    error: "",
    soundPlaying: false,
    resumed: false,
  } as unknown as WalkthroughControllerContext["state"] & { walkthrough: WalkthroughUiState };

  const observationListeners = new Set<(obs: ReplayObservation) => void>();
  const posted: WorkerInbound[] = [];
  const restoreCalls: { tick: number; sessionId: number | undefined }[] = [];
  const playBatchStarts: number[] = [];
  const batchOptions: Parameters<ReplayDriver["playBatch"]>[1][] = [];
  let sessionId = 0;
  // The batch promise a run awaits — kept pending so the run stays live.
  const batch: Promise<never> = new Promise(() => {});

  const driver: ReplayDriver = {
    sessionId: 0,
    latest: null,
    advance: async () => fakeObservation(0),
    key: () => {},
    direction: () => {},
    answer: () => {},
    setPromptEcho: () => {},
    promptPending: () => false,
    restore: async (tick, sid) => {
      restoreCalls.push({ tick, sessionId: sid });
      // The worker's nearest-snapshot choice, mirrored: the tape's
      // checkpoints sit at ticks 500 and 1000.
      const snapTick = [500, 1000].filter((t) => t <= tick).at(-1) ?? 0;
      const obs = fakeObservation(snapTick, sid);
      driver.latest = obs;
      return obs;
    },
    snapshot: () => {},
    playBatch: (_actions, options) => {
      playBatchStarts.push(options?.startIndex ?? 0);
      batchOptions.push(options);
      return batch;
    },
  };

  const worker = {
    postMessage(msg: WorkerInbound) {
      posted.push(msg);
      if (msg.type === "resetReplay") {
        const sid = (msg as { sessionId?: number }).sessionId;
        for (const listener of observationListeners) listener(fakeObservation(0, sid));
      }
    },
  } as unknown as Worker;

  const ctx: WalkthroughControllerContext = {
    state,
    audio: { stop() {}, setPaused() {} } as unknown as AgiAudio,
    replayDriver: driver,
    getWorker: () => worker,
    getBootedGame: () => ({ revision: REVISION }) as unknown as BootedGame,
    isCurrentGame: () => true,
    nextSessionId: () => ++sessionId,
    getActiveSessionId: () => sessionId,
    setActiveReplaySeed: () => {},
    observationListeners,
    cancelPendingPrompts: () => {},
    drainPendingQueries: () => {},
    bootGame: async () => {},
    bootAuthoredGame: async () => {},
    configForGame: (_project, config) => config,
    ejectGame: async () => {},
    sendDirection: () => {},
    logAgent: () => {},
    isInstalledGame: () => false,
    onWalkthroughReset: () => {},
  };

  const controller = useWalkthroughController(ctx);
  return { state, driver, posted, restoreCalls, playBatchStarts, batchOptions, controller };
}

const ARTIFACT = {
  schema: "monotio.agi.walkthrough.v1",
  identity: { project: "kq1", revision: REVISION },
  coverage: "partial",
  profile: "2.917",
  seed: 1,
  virtualTicks: 1500,
  cycles: 1500,
  elapsedMs: 25000,
  actions: [
    { kind: "advance", ticks: 500 },
    { kind: "checkpoint", label: "first", room: 1, score: 0, x: 10, y: 100 },
    { kind: "advance", ticks: 500 },
    { kind: "checkpoint", label: "second", room: 1, score: 0, x: 10, y: 100 },
    { kind: "advance", ticks: 500 },
  ],
};

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("a retarget ahead of the live replay head retunes the seek instead of restarting", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ARTIFACT,
  })) as unknown as typeof fetch;
  const { state, driver, posted, restoreCalls, playBatchStarts, controller } = harness();
  try {
    void controller.startWalkthrough("kq1");
    await flush();
    assert.equal(state.walkthrough.status, "playing");
    assert.equal(state.walkthrough.active, true);
    const resets = () => posted.filter((m) => m.type === "resetReplay").length;
    assert.equal(resets(), 1, "the initial start resets once");

    // A backward seek is in flight: the UI tick still shows where it left
    // (tick 1200) while the replay head has only climbed to 400.
    state.walkthrough.seeking = true;
    state.walkthrough.tick = 1200;
    driver.latest = fakeObservation(400);

    // Retargeting past the head must not restart — the in-flight seek just
    // keeps running to the new target.
    await controller.seekToTick(600);
    await flush();
    assert.equal(restoreCalls.length, 0, "no restore for a retarget ahead of the head");
    assert.equal(resets(), 1, "no tape restart either");
    assert.equal(playBatchStarts.length, 1, "the same batch keeps running");
    assert.equal(state.walkthrough.requestedTick, 600);
    assert.equal(state.walkthrough.seeking, true);

    // A target behind the live head is a real backward seek — restore at
    // the nearest snapshot (tick 500) and resume the tape after it.
    driver.latest = fakeObservation(900);
    await controller.seekToTick(700);
    assert.equal(restoreCalls.length, 1, "a target behind the head restores");
    assert.equal(restoreCalls[0]!.tick, 700);
    await flush();
    assert.equal(resets(), 1, "a restore does not re-boot the tape");
    assert.equal(
      playBatchStarts.at(-1),
      2,
      "the tape resumes at the action after the tick-500 checkpoint",
    );
    assert.equal(state.walkthrough.tick, 500);
    assert.notEqual(state.walkthrough.status, "error");
  } finally {
    globalThis.fetch = originalFetch;
    controller.abort();
  }
});

test("lifting the pointer after a scrub wakes a runner parked on the scrub gate", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ARTIFACT,
  })) as unknown as typeof fetch;
  const { state, driver, batchOptions, controller } = harness();
  try {
    void controller.startWalkthrough("kq1");
    await flush();
    assert.equal(state.walkthrough.status, "playing");
    const options = batchOptions[0]!;
    driver.latest = fakeObservation(400);
    // A pointer held on the timeline pauses the runner until it lifts.
    controller.transport.scrubDown(60);
    assert.equal(options?.isPaused?.(), true, "scrubbing parks the runner");
    let resumed = false;
    void options?.waitForResume?.().then(() => {
      resumed = true;
    });
    await flush();
    assert.equal(resumed, false, "still parked while the pointer is down");
    controller.transport.scrubUp(60);
    await flush();
    assert.equal(options?.isPaused?.(), false);
    assert.equal(resumed, true, "the release wakes the parked runner");
  } finally {
    globalThis.fetch = originalFetch;
    controller.abort();
  }
});
