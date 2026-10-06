import { scheduler as testScheduler } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { useWorkerLink } from "../src/engine/useWorkerLink.ts";
import { createPauseHolds } from "../src/engine/pauseHolds.ts";
import { AgiAudio } from "../src/audio/AgiAudio.ts";
import type { WorkerOutbound } from "../src/worker/workerProtocol.ts";
import type { EngineState, TextHook } from "../src/engine/useEngineTypes.ts";

/**
 * The audio pause owners are the local holds (overlays via pauseHolds, the
 * walkthrough, screen resets) and the worker's authoring suspension. These
 * tests drive the real adapter through a deferred-transition context double
 * so a release order is observed as an actual context state, not a flag.
 */
function fakeWorker() {
  const posted: unknown[] = [];
  return {
    posted,
    terminated: false,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: unknown) {
      posted.push(msg);
    },
    terminate() {
      this.terminated = true;
    },
  };
}

function fakeContext() {
  const pending: { accept(): void }[] = [];
  const params = () => ({
    value: 0,
    setValueAtTime(value: number) {
      this.value = value;
    },
    linearRampToValueAtTime(value: number) {
      this.value = value;
    },
  });
  const node = () => ({
    connect() {},
    disconnect() {},
    start() {},
    stop() {},
  });
  const ctx = {
    state: "running" as string,
    currentTime: 0.5,
    sampleRate: 48000,
    destination: {},
    suspend(): Promise<void> {
      return new Promise<void>((resolve) => {
        pending.push({
          accept: () => {
            ctx.state = "suspended";
            resolve();
          },
        });
      });
    },
    resume(): Promise<void> {
      return new Promise<void>((resolve) => {
        pending.push({
          accept: () => {
            ctx.state = "running";
            resolve();
          },
        });
      });
    },
    createGain: () => ({ ...node(), gain: params() }),
    createOscillator: () => ({ ...node(), type: "square", frequency: params() }),
    createBuffer: (_c: number, length: number, _r: number) => ({
      data: new Float32Array(length),
      getChannelData() {
        return this.data;
      },
    }),
    createBufferSource: () => ({ ...node(), buffer: null, loop: false, playbackRate: params() }),
    createBiquadFilter: () => ({ ...node(), type: "bandpass", Q: params(), frequency: params() }),
  };
  return {
    ctx,
    /** Complete the oldest queued suspend/resume. */
    settle(): void {
      const next = pending.shift();
      assert.ok(next, "no context transition is pending");
      next.accept();
    },
  };
}

const flush = () => testScheduler.yield();

function rig() {
  const context = fakeContext();
  const audio = new AgiAudio({
    contextFactory: () => context.ctx as unknown as AudioContext,
  });
  const state = { paused: false } as unknown as EngineState;
  const hook = {
    rows: [],
    modal: null,
    textMode: false,
    profile: null,
    paused: false,
    cycle: 0,
    frame: 0,
    autosave: -1,
    room: 0,
    egoX: 0,
    egoY: 0,
  } as unknown as TextHook;
  const link = useWorkerLink({
    state,
    hook,
    audio,
    onFrame: () => {},
    logAgent: () => {},
    getBootedGame: () => null,
    getActiveWalkthroughSession: () => 0,
    observationListeners: new Set(),
  });
  const postedPause: boolean[] = [];
  const holds = createPauseHolds({
    post: (paused) => postedPause.push(paused),
    audio,
    state,
  });
  return { link, audio, state, context, postedPause, holds };
}

function deliver(w: ReturnType<typeof fakeWorker>, msg: WorkerOutbound): void {
  w.onmessage!({ data: msg });
}

test("the worker's sound pause survives a local overlay's resume", async () => {
  const { link, audio, context, postedPause, holds } = rig();
  const w = fakeWorker();
  link.wireWorker(w as unknown as Worker);
  audio.output({ kind: "speaker", divisor: 2712 });
  deliver(w, { type: "soundPaused", paused: true });
  context.settle();
  await flush();
  assert.equal(context.ctx.state, "suspended");
  holds.pauseEngine("overlay");
  assert.deepEqual(postedPause, [true]);
  holds.resumeEngine("overlay");
  assert.deepEqual(postedPause, [true, false]);
  await flush();
  assert.equal(
    context.ctx.state,
    "suspended",
    "the overlay's resume must not lift the worker's hold",
  );
  deliver(w, { type: "soundPaused", paused: false });
  context.settle();
  await flush();
  assert.equal(context.ctx.state, "running");
});

test("a local overlay hold survives the worker's early sound release", async () => {
  const { link, audio, context, holds } = rig();
  const w = fakeWorker();
  link.wireWorker(w as unknown as Worker);
  audio.output({ kind: "speaker", divisor: 2712 });
  deliver(w, { type: "soundPaused", paused: true });
  context.settle();
  await flush();
  holds.pauseEngine("overlay");
  deliver(w, { type: "soundPaused", paused: false });
  await flush();
  assert.equal(context.ctx.state, "suspended", "the overlay still holds the freeze");
  holds.resumeEngine("overlay");
  context.settle();
  await flush();
  assert.equal(context.ctx.state, "running");
});

test("local pause owners still compose with each other", async () => {
  const { audio, context, postedPause, holds } = rig();
  audio.output({ kind: "speaker", divisor: 2712 });
  holds.pauseEngine("a");
  holds.pauseEngine("b");
  assert.deepEqual(postedPause, [true], "only the first owner freezes the worker");
  holds.resumeEngine("a");
  assert.deepEqual(postedPause, [true], "an owner remains");
  assert.equal(audio.isPaused, true);
  holds.resumeEngine("b");
  assert.deepEqual(postedPause, [true, false]);
  context.settle();
  await flush();
  context.settle();
  await flush();
  assert.equal(context.ctx.state, "running");
});

test("a replacement worker drops the old run's audio hold, and its stale messages stay fenced", async () => {
  const { link, audio, context } = rig();
  const oldWorker = fakeWorker();
  link.wireWorker(oldWorker as unknown as Worker);
  audio.output({ kind: "speaker", divisor: 2712 });
  deliver(oldWorker, { type: "soundPaused", paused: true });
  context.settle();
  await flush();
  assert.equal(context.ctx.state, "suspended");
  const next = fakeWorker();
  link.wireWorker(next as unknown as Worker);
  context.settle();
  await flush();
  assert.equal(context.ctx.state, "running", "the old run's hold cleared at the boundary");
  deliver(oldWorker, { type: "soundPaused", paused: true });
  await flush();
  assert.equal(context.ctx.state, "running", "a stale worker cannot re-freeze audio");
});

test("terminating the worker releases its audio hold", async () => {
  const { link, audio, context } = rig();
  const w = fakeWorker();
  link.wireWorker(w as unknown as Worker);
  audio.output({ kind: "speaker", divisor: 2712 });
  deliver(w, { type: "soundPaused", paused: true });
  context.settle();
  await flush();
  assert.equal(context.ctx.state, "suspended");
  link.terminateWorker();
  context.settle();
  await flush();
  assert.equal(context.ctx.state, "running");
});
