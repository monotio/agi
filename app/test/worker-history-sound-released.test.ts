import assert from "node:assert/strict";
import { test } from "node:test";
import { validateHistoryRecording } from "../../src/agent/history.ts";
import { replayHistorySegment } from "./worker-ctx.ts";
import { releasedSound, assertSoundContinuation } from "../../test/released-sound.ts";

for (const capture of releasedSound.captures) {
  for (const anchor of [undefined, 0]) {
    test(`released ${capture.name} History ${anchor === undefined ? "boot" : "anchor"} resumes sound and game`, () => {
      const before = JSON.stringify(capture.history);
      const tape = validateHistoryRecording(capture.history);
      assert.equal(JSON.stringify(tape), before, "reader keeps released state and fingerprints");
      const replay = replayHistorySegment(tape.segments[0]!, {
        ...(anchor !== undefined ? { anchor } : {}),
        recordingVersion: tape.version,
      });
      assert.equal(replay.error, null);
      assert.equal(replay.diverged, null);
      assert.equal(replay.incompatible, null);
      assertSoundContinuation(replay.ctx.run.engine!, capture.name);
      assert.equal(JSON.stringify(capture.history), before);
    });
  }
}
