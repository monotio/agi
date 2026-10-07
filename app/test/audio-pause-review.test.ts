import { scheduler as testScheduler } from "node:timers/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgiAudio } from "../src/audio/AgiAudio.ts";

const settle = () => testScheduler.yield();

test("a pause arriving during a user-gesture unlock freezes the context after unlock settles", async () => {
  let finishUnlock: (() => void) | undefined;
  let gesture = false;
  const listeners = new Set<() => void>();
  const stateChanged = () => {
    for (const listener of listeners) queueMicrotask(listener);
  };
  const parameter = () => ({ setValueAtTime() {} });
  const context = {
    state: "suspended",
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    addEventListener(type: string, listener: () => void): void {
      if (type === "statechange") listeners.add(listener);
    },
    createGain: () => ({ gain: parameter(), connect() {}, disconnect() {} }),
    createOscillator: () => ({
      frequency: parameter(),
      connect() {},
      start() {},
      stop() {},
      disconnect() {},
    }),
    resume(): Promise<void> {
      // Initial output can legitimately be refused by autoplay admission.
      if (!gesture) return Promise.reject(new Error("gesture required"));
      return new Promise<void>((resolve) => {
        finishUnlock = () => {
          context.state = "running";
          stateChanged();
          resolve();
        };
      });
    },
    suspend(): Promise<void> {
      context.state = "suspended";
      stateChanged();
      return Promise.resolve();
    },
  };
  const audio = new AgiAudio({ contextFactory: () => context as unknown as AudioContext });
  try {
    audio.output({ kind: "speaker", divisor: 2712 });
    await settle();
    assert.equal(context.state, "suspended");
    gesture = true;
    const unlocking = audio.resume();
    assert.ok(finishUnlock, "the user gesture requested the pending unlock");
    audio.setPauseOwner("studio", true);
    finishUnlock();
    await unlocking;
    await settle();
    assert.equal(audio.isPaused, true);
    assert.equal(context.state, "suspended", "late unlock cannot leave a held context running");
  } finally {
    audio.stop();
  }
});
