import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AuditionLeaseAcquire,
  AuditionSnapshot,
  AuditionTarget,
} from "../src/audio/soundAudition.ts";
import { createSoundPreview, type SoundPreviewDriver } from "../src/studio/sound/soundPreview.ts";
import { createRuntimePauseLeaseAcquire } from "../src/engine/runtimePauseLease.ts";

/**
 * The preview controller headless: the driver's lease request forwards to the
 * host's runtime pause hold, the device choice becomes the soundDevice operand
 * on every retarget, and close disposes the audition — the service's own epoch
 * guard retires any late handle.
 */

const IDLE: AuditionSnapshot = {
  status: "idle",
  epoch: 0,
  closed: false,
  target: null,
  positionTicks: 0,
  authoredExtentTicks: null,
  playbackExtentTicks: 0,
  laneControls: "four",
  laneMuted: [false, false, false, false],
  soloLane: null,
  leaseHeld: false,
  underrunTicks: 0,
  refusal: null,
  warnings: [],
};

function stubDriver() {
  const calls: string[] = [];
  let target: AuditionTarget | null = null;
  const listeners = new Set<(s: AuditionSnapshot) => void>();
  const driver: SoundPreviewDriver = {
    setTarget(offered) {
      target = { ...offered };
      calls.push(`target:${offered.device}`);
      return IDLE;
    },
    play() {
      calls.push("play");
      return Promise.resolve(IDLE);
    },
    pause() {
      calls.push("pause");
    },
    resume() {
      calls.push("resume");
      return Promise.resolve(IDLE);
    },
    stop() {
      calls.push("stop");
      return IDLE;
    },
    seek(tick) {
      calls.push(`seek:${tick}`);
      return Promise.resolve(IDLE);
    },
    setLaneMuted(lane, muted) {
      calls.push(`mute:${lane}:${muted}`);
    },
    setLaneSolo(lane) {
      calls.push(`solo:${lane}`);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot() {
      return IDLE;
    },
    close() {
      calls.push("close");
      return Promise.resolve();
    },
  };
  return { driver, calls, target: () => target };
}

function recordingAcquire() {
  const owners: string[] = [];
  const released: string[] = [];
  let token = 0;
  const acquire = createRuntimePauseLeaseAcquire(
    {
      getWorker: () => null, // no running game: the no-run lease path
      pause: () => {},
      resume: () => {},
      readState: () => Promise.resolve({ cycles: 0 }),
    },
    (owner) => `tok-${owner}-${++token}`,
  );
  return {
    acquire,
    owners,
    released,
    // Wrap so tests see the owner the service asked for.
    recording: async (owner: string) => {
      owners.push(owner);
      const lease = await acquire(owner);
      return {
        release() {
          released.push(owner);
          lease.release();
        },
      };
    },
  };
}

test("the driver's lease request forwards to the runtime pause acquirer", async () => {
  const recording = recordingAcquire();
  let captured: AuditionLeaseAcquire | undefined;
  const stub = stubDriver();
  createSoundPreview({
    acquirePauseLease: recording.recording,
    driver: (acquire) => {
      captured = acquire;
      return { driver: stub.driver, audio: null };
    },
  });
  const identity = {
    owner: "sound-audition",
    target: {
      projectId: "p",
      workspaceId: "w",
      documentId: "sound:3",
      revision: 1,
      payloadHash: "h",
      profileId: "2.936" as const,
      device: 1,
      adjustment: 0,
    },
    epoch: 0,
  };
  const lease = await captured!(identity);
  assert.deepEqual(recording.owners, ["sound-audition"]);
  lease.release();
  assert.deepEqual(recording.released, ["sound-audition"]);
});

test("the device choice becomes the soundDevice operand on each retarget", () => {
  const stub = stubDriver();
  const preview = createSoundPreview({
    acquirePauseLease: async () => ({ release() {} }),
    driver: () => ({ driver: stub.driver, audio: null }),
  });
  const target = {
    projectId: "p",
    workspaceId: "w",
    documentId: "sound:0",
    revision: 2,
    payload: new Uint8Array([8, 0, 10, 0, 12, 0, 14, 0, 255, 255, 255, 255, 255, 255, 255, 255]),
    profileId: "2.936" as const,
  };
  preview.setTarget(target);
  assert.equal(stub.target()!.device, 1, "the three-voice chip operand");
  preview.setDevice("pc-speaker");
  assert.equal(stub.target()!.device, 0, "switching to the speaker retargets");
  assert.deepEqual(
    stub.calls.filter((c) => c.startsWith("target")),
    ["target:1", "target:0"],
  );
  preview.stop();
  assert.deepEqual(stub.calls.at(-1), "stop");
});

test("close disposes the driver exactly once and unsubscribes", async () => {
  const stub = stubDriver();
  const preview = createSoundPreview({
    acquirePauseLease: async () => ({ release() {} }),
    driver: () => ({ driver: stub.driver, audio: null }),
  });
  let notified = 0;
  preview.subscribe(() => notified++);
  await preview.close();
  assert.deepEqual(stub.calls, ["close"]);
});
