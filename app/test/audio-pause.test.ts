import { scheduler as testScheduler } from "node:timers/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgiAudio } from "../src/audio/AgiAudio.ts";

/**
 * An AudioContext double whose suspend/resume transitions the test settles
 * by hand: each call queues a pending transition, `settle()` completes the
 * oldest one like the real control thread, `fail()` rejects it. currentTime
 * only advances when the test moves it — a frozen context is asserted by
 * state and by which transitions ran, not by a clock.
 */
function context(initial: "running" | "suspended" = "running") {
  interface Pending {
    kind: "suspend" | "resume";
    accept(): void;
    refuse(error: Error): void;
  }
  const calls: string[] = [];
  const pending: Pending[] = [];
  const stateListeners: (() => void)[] = [];
  const fireStateChange = () => {
    for (const listener of stateListeners) listener();
  };
  const params = () => ({
    value: 0,
    at: [] as number[],
    setValueAtTime(value: number, at: number) {
      this.value = value;
      this.at.push(at);
    },
    linearRampToValueAtTime(value: number, at: number) {
      this.value = value;
      this.at.push(at);
    },
  });
  const node = () => ({
    stopped: false,
    connect() {},
    disconnect() {},
    start() {},
    stop() {
      this.stopped = true;
    },
  });
  type Gain = ReturnType<typeof node> & { gain: ReturnType<typeof params> };
  const gains: Gain[] = [];
  const ctx = {
    state: initial as string,
    currentTime: 0.5,
    sampleRate: 48000,
    destination: {},
    addEventListener(_type: string, listener: () => void) {
      stateListeners.push(listener);
    },
    suspend(): Promise<void> {
      calls.push("suspend");
      return new Promise<void>((resolve, reject) => {
        pending.push({
          kind: "suspend",
          accept: () => {
            ctx.state = "suspended";
            fireStateChange();
            resolve();
          },
          refuse: reject,
        });
      });
    },
    resume(): Promise<void> {
      calls.push("resume");
      return new Promise<void>((resolve, reject) => {
        pending.push({
          kind: "resume",
          accept: () => {
            ctx.state = "running";
            fireStateChange();
            resolve();
          },
          refuse: reject,
        });
      });
    },
    createGain: () => {
      const gain = { ...node(), gain: params() };
      gains.push(gain);
      return gain;
    },
    createOscillator: () => ({ ...node(), type: "square", frequency: params() }),
    createBuffer: (_channels: number, length: number, _rate: number) => {
      const data = new Float32Array(length);
      return { data, getChannelData: () => data };
    },
    createBufferSource: () => ({
      ...node(),
      buffer: null,
      loop: false,
      playbackRate: params(),
    }),
    createBiquadFilter: () => ({
      ...node(),
      type: "bandpass",
      Q: params(),
      frequency: params(),
    }),
  };
  return {
    ctx,
    calls,
    pending,
    gains,
    /** Complete the oldest queued transition, flipping the state. */
    settle(): void {
      const next = pending.shift();
      assert.ok(next, "no context transition is pending");
      next.accept();
    },
    /** Reject the oldest queued transition (a closed context's InvalidStateError). */
    fail(error = new Error("context closed")): void {
      const next = pending.shift();
      assert.ok(next, "no context transition is pending");
      next.refuse(error);
    },
    /** A transition nobody asked for: autoplay unblock, an ended OS interruption. */
    external(state: "running" | "suspended"): void {
      ctx.state = state;
      fireStateChange();
    },
    audio: new AgiAudio({ contextFactory: () => ctx as unknown as AudioContext }),
  };
}

/** Let queued transition reconciles run. */
const settle = () => testScheduler.yield();

describe("audio pause freezes the context clock", () => {
  it("suspends the running context on pause and resumes it on release", async () => {
    const { audio, ctx, calls, gains, settle: land } = context();
    audio.output({ kind: "speaker", divisor: 2712 });
    audio.setPaused(true);
    assert.equal(gains[0]!.gain.value, 0, "silent before the suspend lands");
    assert.deepEqual(calls, ["suspend"]);
    assert.equal(ctx.state, "running", "the transition is still settling");
    land();
    await settle();
    assert.equal(ctx.state, "suspended");
    assert.equal(audio.isPaused, true);
    audio.setPaused(false);
    assert.equal(gains[0]!.gain.value, 0.5);
    assert.deepEqual(calls, ["suspend", "resume"]);
    land();
    await settle();
    assert.equal(ctx.state, "running");
    assert.equal(audio.isPaused, false);
  });

  it("ends frozen after pause-release-pause while the first suspend is in flight", async () => {
    const { audio, ctx, calls, pending, settle: land } = context();
    audio.output({ kind: "speaker", divisor: 2712 });
    audio.setPaused(true);
    audio.setPaused(false);
    audio.setPaused(true);
    assert.deepEqual(calls, ["suspend"], "requests fold into the in-flight transition");
    land();
    await settle();
    assert.deepEqual(calls, ["suspend"], "the last request wins without a stray resume");
    assert.equal(ctx.state, "suspended");
    assert.equal(pending.length, 0);
    assert.equal(audio.isPaused, true);
  });

  it("resumes after a release that arrived while the suspend was in flight", async () => {
    const { audio, ctx, calls, settle: land } = context();
    audio.output({ kind: "speaker", divisor: 2712 });
    audio.setPaused(true);
    audio.setPaused(false);
    assert.deepEqual(calls, ["suspend"], "the release reconciles after the in-flight op");
    land();
    await settle();
    assert.deepEqual(calls, ["suspend", "resume"]);
    land();
    await settle();
    assert.equal(ctx.state, "running");
    assert.equal(audio.isPaused, false);
  });

  it("ends frozen after release-repause while the resume is in flight", async () => {
    const { audio, ctx, calls, settle: land } = context();
    audio.output({ kind: "speaker", divisor: 2712 });
    audio.setPaused(true);
    land();
    await settle();
    audio.setPaused(false);
    assert.deepEqual(calls, ["suspend", "resume"]);
    audio.setPaused(true);
    land();
    await settle();
    assert.deepEqual(calls, ["suspend", "resume", "suspend"]);
    land();
    await settle();
    assert.equal(ctx.state, "suspended");
    assert.equal(audio.isPaused, true);
  });

  it("keeps output and an unlock request from lifting a pause", async () => {
    const { audio, ctx, calls, gains, settle: land } = context();
    audio.output({ kind: "speaker", divisor: 2712 });
    audio.setPaused(true);
    land();
    await settle();
    audio.output({ kind: "speaker", divisor: 1356 });
    // The user-gesture unlock must not resolve while a pause owner holds.
    await Promise.race([audio.resume(), settle()]);
    await settle();
    assert.deepEqual(calls, ["suspend"], "no resume was requested");
    assert.equal(ctx.state, "suspended");
    assert.equal(gains[0]!.gain.value, 0);
  });

  it("suspends a context first created while paused", async () => {
    const { audio, ctx, calls, gains, settle: land } = context();
    audio.setPaused(true);
    assert.deepEqual(calls, [], "no context exists to suspend yet");
    audio.output({ kind: "speaker", divisor: 2712 });
    assert.equal(gains[0]!.gain.value, 0, "the context comes up silent");
    assert.deepEqual(calls, ["suspend"], "the outstanding pause suspends the new context");
    land();
    await settle();
    assert.equal(ctx.state, "suspended");
    audio.setPaused(false);
    land();
    await settle();
    assert.equal(ctx.state, "running");
    assert.equal(gains[0]!.gain.value, 0.5);
  });

  it("stays suspended when stop() lands during a pending suspension", async () => {
    const { audio, ctx, calls, settle: land } = context();
    audio.output({ kind: "speaker", divisor: 2712 });
    audio.setPaused(true);
    audio.stop();
    assert.equal(audio.isPlaying, false);
    land();
    await settle();
    assert.equal(ctx.state, "suspended");
    assert.deepEqual(calls, ["suspend"]);
  });

  it("swallows a rejected suspend and answers the next request", async () => {
    const { audio, ctx, calls, gains, fail, settle: land } = context();
    audio.output({ kind: "speaker", divisor: 2712 });
    audio.setPaused(true);
    fail();
    await settle();
    assert.equal(ctx.state, "running", "the rejected suspend left it running");
    assert.equal(gains[0]!.gain.value, 0, "still silent while the hold stands");
    audio.setPaused(false);
    assert.equal(gains[0]!.gain.value, 0.5);
    audio.setPaused(true);
    land();
    await settle();
    assert.deepEqual(calls, ["suspend", "suspend"], "a later pause retries");
    assert.equal(ctx.state, "suspended");
  });

  it("re-asserts the freeze when the context starts running on its own", async () => {
    const { audio, ctx, calls, external, settle: land } = context();
    audio.setPaused(true);
    audio.output({ kind: "speaker", divisor: 2712 });
    land();
    await settle();
    assert.equal(ctx.state, "suspended");
    // WebKit auto-resumes a context created suspended; an OS interruption
    // ending looks the same — the held pause must freeze it again.
    external("running");
    assert.deepEqual(calls, ["suspend", "suspend"]);
    land();
    await settle();
    assert.equal(ctx.state, "suspended");
    audio.setPaused(false);
    land();
    await settle();
    assert.equal(ctx.state, "running");
  });

  it("leaves a closed context alone", async () => {
    const { audio, ctx, calls } = context();
    audio.output({ kind: "speaker", divisor: 2712 });
    ctx.state = "closed";
    audio.setPaused(true);
    await settle();
    audio.setPaused(false);
    await settle();
    assert.deepEqual(calls, []);
  });

  it("keeps mute and volume across a suspended pause", async () => {
    const { audio, gains, settle: land } = context();
    audio.setVolume(0.7);
    audio.output({ kind: "speaker", divisor: 2712 });
    audio.setPaused(true);
    land();
    await settle();
    audio.setMuted(true);
    assert.equal(gains[0]!.gain.value, 0);
    audio.setMuted(false);
    assert.equal(gains[0]!.gain.value, 0, "unmute during pause stays silent");
    audio.setPaused(false);
    land();
    await settle();
    assert.equal(gains[0]!.gain.value, 0.7);
  });
});

describe("named pause owners", () => {
  it("keeps a named owner frozen across the ambient release", async () => {
    const { audio, ctx, gains, settle: land } = context();
    audio.output({ kind: "speaker", divisor: 2712 });
    audio.setPauseOwner("worker", true);
    assert.equal(gains[0]!.gain.value, 0);
    land();
    await settle();
    assert.equal(ctx.state, "suspended");
    // The ambient channel never held; releasing it cannot lift the worker hold.
    audio.setPaused(false);
    await settle();
    assert.equal(ctx.state, "suspended");
    assert.equal(gains[0]!.gain.value, 0);
    audio.setPauseOwner("worker", false);
    land();
    await settle();
    assert.equal(ctx.state, "running");
    assert.equal(gains[0]!.gain.value, 0.5);
  });

  it("keeps the worker's hold when the ambient pause releases first", async () => {
    const { audio, ctx, calls, settle: land } = context();
    audio.output({ kind: "speaker", divisor: 2712 });
    audio.setPaused(true);
    land();
    await settle();
    audio.setPauseOwner("worker", true);
    audio.setPaused(false);
    await settle();
    assert.equal(ctx.state, "suspended", "the owner outlives the ambient hold");
    assert.deepEqual(calls, ["suspend"], "no resume ran while an owner held");
    audio.setPauseOwner("worker", false);
    land();
    await settle();
    assert.equal(ctx.state, "running");
  });

  it("stays frozen until the last named owner releases", async () => {
    const { audio, ctx, settle: land } = context();
    audio.output({ kind: "speaker", divisor: 2712 });
    audio.setPauseOwner("worker", true);
    audio.setPauseOwner("debugger", true);
    land();
    await settle();
    audio.setPauseOwner("worker", false);
    await settle();
    assert.equal(ctx.state, "suspended");
    audio.setPauseOwner("debugger", false);
    land();
    await settle();
    assert.equal(ctx.state, "running");
    assert.equal(audio.isPaused, false);
  });
});
