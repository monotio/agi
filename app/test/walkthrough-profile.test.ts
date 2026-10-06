import { scheduler as testScheduler } from "node:timers/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInitialWalkthroughState,
  useWalkthroughController,
  type WalkthroughControllerContext,
  type WalkthroughUiState,
} from "../src/walkthrough/useWalkthroughController.ts";
import { clearWalkthroughCache } from "../src/walkthrough/walkthrough.ts";
import type { ReplayDriver, ReplayObservation } from "../src/walkthrough/replay.ts";
import type { AgiAudio } from "../src/audio/AgiAudio.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import type { WorkerInbound } from "../src/worker/workerProtocol.ts";

const REVISION = "b".repeat(64);

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

function artifactFor(profile: string, project = "synthetic") {
  return {
    schema: "monotio.agi.walkthrough.v1",
    identity: { project, revision: REVISION },
    coverage: "partial",
    profile,
    seed: 1,
    virtualTicks: 100,
    cycles: 100,
    elapsedMs: 1600,
    actions: [{ kind: "advance", ticks: 100 }],
  };
}

/**
 * A controller wired to a fake worker and driver. `reported` is the profile
 * the worker's `booted` last reported; a fresh boot reports `bootProfile`
 * before its tick-0 observation, the order the real worker posts them in.
 * `sessionId` seeds the host's active session — a game opened after an
 * earlier eject runs under a nonzero one. Every host side effect the start
 * path can reach is counted, so a refused preflight can be proven silent.
 */
function harness(options: {
  current: boolean;
  reported?: string | null;
  bootProfile?: string | null;
  sessionId?: number;
}) {
  const state = {
    walkthrough: createInitialWalkthroughState(),
    phase: "running",
    error: "",
    soundPlaying: false,
    resumed: false,
  } as unknown as WalkthroughControllerContext["state"] & { walkthrough: WalkthroughUiState };

  const observationListeners = new Set<(obs: ReplayObservation) => void>();
  const posted: WorkerInbound[] = [];
  const batchOptions: Parameters<ReplayDriver["playBatch"]>[1][] = [];
  const calls = {
    promptCancels: 0,
    queryDrains: 0,
    audioStops: 0,
    seedWrites: [] as (number | null)[],
    walkthroughResets: 0,
  };
  let playBatchCalls = 0;
  let bootGameCalls = 0;
  let bootAuthoredCalls = 0;
  let sessionId = options.sessionId ?? 0;
  let reported = options.reported ?? null;
  let current = options.current;
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
      const obs = fakeObservation(tick, sid);
      driver.latest = obs;
      return obs;
    },
    snapshot: () => {},
    playBatch: (_actions, options) => {
      playBatchCalls++;
      batchOptions.push(options);
      return batch;
    },
  };

  const makeWorker = (out: WorkerInbound[]): Worker =>
    ({
      postMessage(msg: WorkerInbound) {
        out.push(msg);
        if (msg.type === "resetReplay") {
          const sid = (msg as { sessionId?: number }).sessionId;
          for (const listener of observationListeners) listener(fakeObservation(0, sid));
        }
      },
    }) as unknown as Worker;
  let worker = makeWorker(posted);
  let booted = { revision: REVISION } as unknown as BootedGame;

  const ctx: WalkthroughControllerContext = {
    state,
    audio: {
      stop() {
        calls.audioStops++;
      },
      setPaused() {},
    } as unknown as AgiAudio,
    replayDriver: driver,
    getWorker: () => worker,
    getWorkerProfile: () => reported,
    getBootedGame: () => booted,
    isCurrentGame: () => current,
    nextSessionId: () => ++sessionId,
    getActiveSessionId: () => sessionId,
    setActiveReplaySeed: (seed) => {
      calls.seedWrites.push(seed);
    },
    observationListeners,
    cancelPendingPrompts: () => {
      calls.promptCancels++;
    },
    drainPendingQueries: () => {
      calls.queryDrains++;
    },
    bootGame: async () => {
      bootGameCalls++;
      // `booted` reports the profile before the tick-0 observation posts.
      reported = options.bootProfile ?? null;
      for (const listener of observationListeners) listener(fakeObservation(0, sessionId));
    },
    bootAuthoredGame: async () => {
      bootAuthoredCalls++;
    },
    configForGame: (_project, config) => config,
    ejectGame: async () => {},
    sendDirection: () => {},
    logAgent: () => {},
    isInstalledGame: () => current === false,
    onWalkthroughReset: () => {
      calls.walkthroughResets++;
    },
  };

  const controller = useWalkthroughController(ctx);
  return {
    state,
    posted,
    controller,
    calls,
    batchOptions,
    session: () => sessionId,
    resets: () => posted.filter((m) => m.type === "resetReplay").length,
    playBatchCalls: () => playBatchCalls,
    bootGameCalls: () => bootGameCalls,
    bootAuthoredCalls: () => bootAuthoredCalls,
    /** The slot changed hands mid-preflight: another worker serves another game. */
    replaceWorker: () => {
      const nextPosted: WorkerInbound[] = [];
      worker = makeWorker(nextPosted);
      current = false;
      booted = { revision: "c".repeat(64) } as unknown as BootedGame;
      return nextPosted;
    },
    setCurrent: (value: boolean) => {
      current = value;
    },
  };
}

function serveArtifact(profile: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => artifactFor(profile),
  })) as unknown as typeof fetch;
  clearWalkthroughCache();
  return () => {
    globalThis.fetch = originalFetch;
    clearWalkthroughCache();
  };
}

/**
 * Per-target artifact control: each walkthrough name resolves to its own
 * profile and `project` identity; an entry with `hold` stays in flight until
 * that promise resolves, which is how a stale preflight is held past the
 * newer request that replaces it.
 */
function serveArtifacts(
  map: Record<string, { profile: string; project?: string; hold?: Promise<void> }>,
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const name = /walkthroughs\/([^/?]+)\.json/.exec(String(input))?.[1] ?? "";
    const entry = map[name];
    if (entry?.hold) await entry.hold;
    if (!entry) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => artifactFor(entry.profile, entry.project) };
  }) as unknown as typeof fetch;
  clearWalkthroughCache();
  return () => {
    globalThis.fetch = originalFetch;
    clearWalkthroughCache();
  };
}

async function flush(): Promise<void> {
  await testScheduler.yield();
}

test("a running game on another interpreter refuses before the reset touches it", async () => {
  const restore = serveArtifact("2.936");
  const h = harness({ current: true, reported: "2.917" });
  try {
    void h.controller.startWalkthrough("synthetic");
    await flush();
    assert.equal(h.state.walkthrough.status, "error");
    assert.equal(h.state.walkthrough.active, false);
    assert.match(h.state.walkthrough.error, /2\.936/);
    assert.match(h.state.walkthrough.error, /2\.917/);
    assert.equal(h.resets(), 0, "the replay reset is never posted");
    assert.equal(h.playBatchCalls(), 0, "no tape action is submitted");
    assert.equal(h.bootGameCalls(), 0, "the running game is left alone");
  } finally {
    restore();
    h.controller.abort();
  }
});

test("a fresh boot on another interpreter refuses after ready, before any action", async () => {
  const restore = serveArtifact("2.936");
  const h = harness({ current: false, bootProfile: "2.917" });
  try {
    void h.controller.startWalkthrough("synthetic");
    await flush();
    assert.equal(h.bootGameCalls(), 1, "the fresh boot did run");
    assert.equal(h.state.walkthrough.status, "error");
    assert.equal(h.state.walkthrough.active, false);
    assert.match(h.state.walkthrough.error, /2\.936/);
    assert.match(h.state.walkthrough.error, /2\.917/);
    assert.equal(h.playBatchCalls(), 0, "no tape action is submitted");
  } finally {
    restore();
    h.controller.abort();
  }
});

test("a fresh boot reporting no interpreter refuses the tape", async () => {
  const restore = serveArtifact("2.936");
  const h = harness({ current: false, bootProfile: null });
  try {
    void h.controller.startWalkthrough("synthetic");
    await flush();
    assert.equal(h.state.walkthrough.status, "error");
    assert.match(h.state.walkthrough.error, /2\.936/);
    assert.equal(h.playBatchCalls(), 0);
  } finally {
    restore();
    h.controller.abort();
  }
});

test("an interpreter this build does not know refuses before any boot", async () => {
  const restore = serveArtifact("9.999");
  const h = harness({ current: false });
  try {
    void h.controller.startWalkthrough("synthetic");
    await flush();
    assert.equal(h.state.walkthrough.status, "error");
    assert.match(h.state.walkthrough.error, /9\.999/);
    assert.equal(h.bootGameCalls(), 0);
    assert.equal(h.resets(), 0);
    assert.equal(h.playBatchCalls(), 0);
  } finally {
    restore();
    h.controller.abort();
  }
});

test("a matching profile on a fresh boot plays the tape", async () => {
  const restore = serveArtifact("2.936");
  const h = harness({ current: false, bootProfile: "2.936" });
  try {
    void h.controller.startWalkthrough("synthetic");
    await flush();
    assert.equal(h.state.walkthrough.status, "playing");
    assert.equal(h.state.walkthrough.error, "");
    assert.equal(h.playBatchCalls(), 1);
  } finally {
    restore();
    h.controller.abort();
  }
});

test("a running game on the tape's interpreter resets and plays", async () => {
  const restore = serveArtifact("2.936");
  const h = harness({ current: true, reported: "2.936" });
  try {
    void h.controller.startWalkthrough("synthetic");
    await flush();
    assert.equal(h.state.walkthrough.status, "playing");
    assert.equal(h.resets(), 1);
    assert.equal(h.playBatchCalls(), 1);
    assert.equal(h.bootGameCalls(), 0);
  } finally {
    restore();
    h.controller.abort();
  }
});

test("a refused mismatch leaves the running game's session and host state untouched", async () => {
  const restore = serveArtifact("2.936");
  const h = harness({ current: true, reported: "2.917", sessionId: 3 });
  try {
    void h.controller.startWalkthrough("synthetic");
    await flush();
    assert.equal(h.state.walkthrough.status, "error");
    assert.match(h.state.walkthrough.error, /2\.936/);
    assert.match(h.state.walkthrough.error, /2\.917/);
    // The refused preflight moved nothing: the nonzero session the game
    // runs under is intact, and no prompt, query, audio, seed, autosave
    // or reset side effect fired for a start that never committed.
    assert.equal(h.session(), 3);
    assert.equal(h.calls.promptCancels, 0);
    assert.equal(h.calls.queryDrains, 0);
    assert.equal(h.calls.audioStops, 0);
    assert.equal(h.calls.seedWrites.length, 0);
    assert.equal(h.calls.walkthroughResets, 0);
    assert.equal(h.resets(), 0);
    assert.equal(h.playBatchCalls(), 0);
    assert.equal(h.bootGameCalls(), 0);
  } finally {
    restore();
    h.controller.abort();
  }
});

test("a refused unsupported tape leaves the running game's session and host state untouched", async () => {
  const restore = serveArtifact("9.999");
  const h = harness({ current: true, reported: "2.917", sessionId: 3 });
  try {
    void h.controller.startWalkthrough("synthetic");
    await flush();
    assert.equal(h.state.walkthrough.status, "error");
    assert.equal(
      h.state.walkthrough.error,
      "This walkthrough requires an unsupported interpreter profile: 9.999. Choose another walkthrough.",
    );
    assert.equal(h.session(), 3);
    assert.equal(h.calls.promptCancels, 0);
    assert.equal(h.calls.queryDrains, 0);
    assert.equal(h.calls.audioStops, 0);
    assert.equal(h.calls.seedWrites.length, 0);
    assert.equal(h.calls.walkthroughResets, 0);
    assert.equal(h.resets(), 0);
    assert.equal(h.playBatchCalls(), 0);
    assert.equal(h.bootGameCalls(), 0);
  } finally {
    restore();
    h.controller.abort();
  }
});

test("a refused start leaves the running walkthrough alive on its own session", async () => {
  const restore = serveArtifacts({
    synthetic: { profile: "2.936" },
    "adventure-department": { profile: "2.917", project: "adventure-department" },
  });
  const h = harness({ current: true, reported: "2.936" });
  try {
    void h.controller.startWalkthrough("synthetic");
    await flush();
    assert.equal(h.state.walkthrough.status, "playing");
    assert.equal(h.session(), 1);
    const run = h.batchOptions[0]!;

    void h.controller.startWalkthrough("adventure-department");
    await flush();
    // The refused start reports its error while the tape it could not
    // replace keeps playing: same session, same unaborted batch, same
    // alias — nothing retired, nothing reviveable.
    assert.equal(h.state.walkthrough.status, "playing");
    assert.equal(h.state.walkthrough.active, true);
    assert.equal(h.state.walkthrough.alias, "synthetic");
    assert.equal(h.session(), 1);
    assert.equal(run.signal?.aborted, false);
    assert.equal(run.isCurrentSession?.(), true);
    assert.match(h.state.walkthrough.error, /2\.917/);
    assert.match(h.state.walkthrough.error, /2\.936/);
    assert.equal(h.calls.promptCancels, 1);
    assert.equal(h.calls.queryDrains, 1);
    assert.equal(h.calls.audioStops, 1);
    assert.equal(h.calls.seedWrites.length, 1);
    assert.equal(h.calls.walkthroughResets, 1);
    assert.equal(h.resets(), 1);
    assert.equal(h.playBatchCalls(), 1);
  } finally {
    restore();
    h.controller.abort();
  }
});

test("a refused unsupported tape keeps the running walkthrough's live batch", async () => {
  const restore = serveArtifacts({
    synthetic: { profile: "2.936" },
    other: { profile: "9.999", project: "adventure-department" },
  });
  const h = harness({ current: true, reported: "2.936" });
  try {
    void h.controller.startWalkthrough("synthetic");
    await flush();
    const run = h.batchOptions[0]!;

    void h.controller.startWalkthrough("other");
    await flush();
    assert.equal(
      h.state.walkthrough.error,
      "This walkthrough requires an unsupported interpreter profile: 9.999. Choose another walkthrough.",
    );
    assert.equal(h.state.walkthrough.status, "playing");
    assert.equal(h.state.walkthrough.active, true);
    assert.equal(h.state.walkthrough.alias, "synthetic");
    assert.equal(h.session(), 1);
    assert.equal(run.signal?.aborted, false);
    assert.equal(run.isCurrentSession?.(), true);
    assert.equal(h.playBatchCalls(), 1);
  } finally {
    restore();
    h.controller.abort();
  }
});

test("a stale preflight cannot commit over the newer start that replaced it", async () => {
  let releaseGate!: () => void;
  const hold = new Promise<void>((resolve) => (releaseGate = resolve));
  const restore = serveArtifacts({
    "tape-a": { profile: "2.936", hold },
    "tape-b": { profile: "2.936" },
  });
  const h = harness({ current: true, reported: "2.936" });
  try {
    void h.controller.startWalkthrough("tape-a"); // held in preflight
    void h.controller.startWalkthrough("tape-b"); // the newer request wins
    await flush();
    releaseGate();
    await flush();
    // Only the newer request committed: one session, one reset, one tape.
    assert.equal(h.session(), 1);
    assert.equal(h.resets(), 1);
    assert.equal(h.playBatchCalls(), 1);
    assert.equal(h.calls.promptCancels, 1);
    assert.equal(h.calls.queryDrains, 1);
    assert.equal(h.calls.audioStops, 1);
    assert.equal(h.calls.seedWrites.length, 1);
    assert.equal(h.calls.walkthroughResets, 1);
    assert.equal(h.state.walkthrough.status, "playing");
    assert.equal(h.state.walkthrough.error, "");
  } finally {
    releaseGate();
    restore();
    h.controller.abort();
  }
});

test("a stop during preflight retires the pending start", async () => {
  let releaseGate!: () => void;
  const hold = new Promise<void>((resolve) => (releaseGate = resolve));
  const restore = serveArtifacts({ "tape-a": { profile: "2.936", hold } });
  const h = harness({ current: true, reported: "2.936", sessionId: 3 });
  try {
    void h.controller.startWalkthrough("tape-a");
    await flush();
    await h.controller.stopWalkthrough();
    releaseGate();
    await flush();
    // Only the stop itself advanced the session; the retired preflight
    // committed nothing and left no error behind.
    assert.equal(h.session(), 4);
    assert.equal(h.state.walkthrough.status, "stopped");
    assert.equal(h.state.walkthrough.error, "");
    assert.equal(h.calls.promptCancels, 1);
    assert.equal(h.calls.queryDrains, 1);
    assert.equal(h.calls.audioStops, 1);
    assert.equal(h.resets(), 0);
    assert.equal(h.playBatchCalls(), 0);
  } finally {
    releaseGate();
    restore();
    h.controller.abort();
  }
});

test("a replaced worker mid-preflight retires the pending start", async () => {
  let releaseGate!: () => void;
  const hold = new Promise<void>((resolve) => (releaseGate = resolve));
  const restore = serveArtifacts({ "tape-a": { profile: "2.936", hold } });
  const h = harness({ current: true, reported: "2.936", sessionId: 3 });
  try {
    void h.controller.startWalkthrough("tape-a");
    await flush();
    const nextPosted = h.replaceWorker();
    releaseGate();
    await flush();
    // The request answered nothing to the worker that replaced it and
    // never committed a boot, reset or session move of its own.
    assert.equal(h.session(), 3);
    assert.equal(h.resets(), 0);
    assert.equal(nextPosted.length, 0);
    assert.equal(h.playBatchCalls(), 0);
    assert.equal(h.bootGameCalls(), 0);
    assert.equal(h.bootAuthoredCalls(), 0);
    assert.equal(h.state.walkthrough.status, "idle");
    assert.equal(h.state.walkthrough.error, "");
  } finally {
    releaseGate();
    restore();
    h.controller.abort();
  }
});

test("a refused fresh boot retires the attempted run's bookkeeping", async () => {
  const restore = serveArtifact("2.936");
  const h = harness({ current: false, reported: null, bootProfile: "2.917" });
  try {
    void h.controller.startWalkthrough("synthetic");
    await flush();
    assert.equal(h.state.walkthrough.status, "error");
    assert.equal(h.state.walkthrough.active, false);
    assert.equal(h.state.walkthrough.seeking, false);
    // The attempted tape's seed retired with it instead of leaking into
    // the next boot, and the refused tape can never be seeked back.
    assert.equal(h.calls.seedWrites.at(-1), null);
    await h.controller.seekToTick(1000);
    assert.equal(h.playBatchCalls(), 0);
    assert.equal(h.resets(), 0);
  } finally {
    restore();
    h.controller.abort();
  }
});
