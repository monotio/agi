import assert from "node:assert/strict";
import { test } from "node:test";
import { AgiAudio } from "../src/audio/AgiAudio.ts";
import {
  SoundAudition,
  type AuditionLeaseAcquire,
  type AuditionSnapshot,
  type AuditionTarget,
} from "../src/audio/soundAudition.ts";

class ReviewAudio extends AgiAudio {
  readonly audible = [true, true, true, true];
  override resume(): Promise<void> {
    return Promise.resolve();
  }
  override setLaneAudible(lane: number, audible: boolean): void {
    this.audible[lane] = audible;
  }
  override setPauseOwner(): void {}
  override stop(): void {}
  override output(): void {}
  override close(): Promise<void> {
    return Promise.resolve();
  }
}

function fixture(documentId = "sound:1"): AuditionTarget {
  return {
    projectId: "review-project",
    documentId,
    revision: 1,
    profileId: "2.936",
    device: 1,
    // One ten-tick tone followed by the sentinel, three empty streams.
    payload: Uint8Array.from([
      8, 0, 15, 0, 17, 0, 19, 0, 10, 0, 1, 0x80, 0x90, 255, 255, 255, 255, 255, 255, 255, 255,
    ]),
  };
}

function harness(acquire: AuditionLeaseAcquire = () => ({ release() {} })) {
  const audio = new ReviewAudio();
  let serial = 0;
  const timers = new Map<number, () => void>();
  const audition = new SoundAudition({
    audio,
    acquire,
    scheduler: {
      now: () => 0,
      setTimeout(callback) {
        const id = ++serial;
        timers.set(id, callback);
        return id;
      },
      clearTimeout(handle) {
        if (typeof handle === "number") timers.delete(handle);
      },
    },
  });
  return { audio, audition };
}

test("a lease recipient cannot rewrite the audition's owned target", async () => {
  const { audition } = harness((request) => {
    request.target.documentId = "foreign-sound";
    request.target.device = 0;
    return { release() {} };
  });
  try {
    audition.setTarget(fixture());
    await audition.play();
    assert.equal(audition.snapshot().target?.documentId, "sound:1");
    assert.equal(audition.snapshot().target?.device, 1);
  } finally {
    await audition.close();
  }
});

test("each audition observer receives its own observational snapshot", async () => {
  const { audition } = harness();
  let observed: AuditionSnapshot | undefined;
  audition.subscribe((snapshot) => {
    if (snapshot.target) snapshot.target.documentId = "observer-mutation";
  });
  audition.subscribe((snapshot) => {
    observed = snapshot;
  });
  try {
    audition.setTarget(fixture());
    assert.equal(observed?.target?.documentId, "sound:1");
    assert.equal(audition.snapshot().target?.documentId, "sound:1");
  } finally {
    await audition.close();
  }
});

test("a seek superseded by an observer cannot mute the replacement audition", async () => {
  const { audition, audio } = harness();
  audition.setTarget(fixture());
  let replacement: Promise<AuditionSnapshot> | undefined;
  let replaced = false;
  audition.subscribe((snapshot) => {
    if (snapshot.status === "seeking" && !replaced) {
      replaced = true;
      audition.setTarget(fixture("sound:2"));
      replacement = audition.play();
    }
  });
  try {
    await audition.seek(1);
    assert.ok(replacement);
    await replacement;
    assert.equal(audition.snapshot().status, "playing");
    assert.equal(audition.snapshot().target?.documentId, "sound:2");
    assert.deepEqual(audio.audible, [true, true, true, true]);
  } finally {
    await audition.close();
  }
});
