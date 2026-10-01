import assert from "node:assert/strict";
import { test } from "node:test";
import { createPauseHolds } from "../src/engine/pauseHolds.ts";
import { createRuntimePauseLeaseAcquire } from "../src/engine/runtimePauseLease.ts";

test("a failed audition pause releases its partially registered owner and preserves the existing hold", async () => {
  const worker = {};
  const messages: boolean[] = [];
  let failNextAudioPause = false;
  const holds = createPauseHolds({
    post(paused) {
      messages.push(paused);
    },
    audio: {
      setPaused() {
        if (failNextAudioPause) {
          failNextAudioPause = false;
          throw new Error("audio context failed while parking");
        }
      },
    },
    state: { paused: false },
  });
  holds.pauseEngine("open-dialog");
  const acquire = createRuntimePauseLeaseAcquire(
    {
      getWorker: () => worker,
      pause: holds.pauseEngine,
      resume: holds.resumeEngine,
      readState: async () => ({ cycles: 1 }),
    },
    () => "sound-preview-owned",
  );
  failNextAudioPause = true;
  await assert.rejects(acquire("sound-preview"), /audio context failed/);
  assert.deepEqual(holds.pauseOwners(), ["open-dialog"]);
  assert.deepEqual(messages, [true], "the earlier dialog's hold remains applied");
  holds.resumeEngine("open-dialog");
  assert.deepEqual(holds.pauseOwners(), []);
  assert.deepEqual(messages, [true, false], "closing the earlier dialog resumes the game");
});

test("a first audition pause that fails after posting does not leave the game frozen", async () => {
  const worker = {};
  const messages: boolean[] = [];
  const state = { paused: false };
  let failFirst = true;
  const holds = createPauseHolds({
    post(paused) {
      messages.push(paused);
    },
    audio: {
      setPaused(paused) {
        if (paused && failFirst) {
          failFirst = false;
          throw new Error("audio context failed after freeze");
        }
      },
    },
    state,
  });
  const acquire = createRuntimePauseLeaseAcquire(
    {
      getWorker: () => worker,
      pause: holds.pauseEngine,
      resume: holds.resumeEngine,
      readState: async () => ({ cycles: 1 }),
    },
    () => "first-preview-owned",
  );
  await assert.rejects(acquire("sound-preview"), /audio context failed/);
  assert.deepEqual(holds.pauseOwners(), []);
  assert.equal(state.paused, false);
  assert.deepEqual(
    messages,
    [true, false],
    "the posted freeze is compensated on acquisition failure",
  );
});
