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
      // Feed sound heartbeats through the History event drive too, followed
      // by a real cycle poll that lets the game's logic observe completion.
      const continued = structuredClone(tape.segments[0]!);
      continued.events.push({ seq: 0, tick: 0, cycle: 0, cause: { kind: "clock", ticks: 40 } });
      continued.clock = [{ tick: 1, n: 1, sound: 0, cycle: true }];
      const driven = replayHistorySegment(continued, {
        ...(anchor !== undefined ? { anchor } : {}),
        recordingVersion: tape.version,
        tailTicks: 1,
      });
      assert.equal(driven.error, null);
      assert.equal(driven.applied, 1);
      assert.equal(driven.ctx.run.engine!.flags[40], 1);
      assert.equal(driven.ctx.run.engine!.vars[41], 77);
      assert.equal(JSON.stringify(capture.history), before);
    });
  }
}

test("migrating released sound never authenticates a changed progress entry against itself", () => {
  for (const anchor of [undefined, 0]) {
    const segment = releasedSound.captures[0]!.history.segments[0]!;
    const alteredReplay = structuredClone(segment);
    const point = anchor === undefined ? alteredReplay.boot : alteredReplay.anchors[anchor]!;
    point.replay!.sound!.playback.channels[0]!.cursor = 6;
    assert.match(
      replayHistorySegment(alteredReplay, { ...(anchor !== undefined ? { anchor } : {}) }).error ??
        "",
      /semantic fingerprint does not hold/,
    );

    const alteredImage = structuredClone(segment);
    const imagePoint = anchor === undefined ? alteredImage.boot : alteredImage.anchors[anchor]!;
    const bytes = Buffer.from(imagePoint.image!, "base64");
    // v40 in save block 1, following the host header and save description.
    const v40Offset = 38 + 31 + 2 + 7 + 40;
    bytes[v40Offset] = bytes[v40Offset]! ^ 1;
    imagePoint.image = bytes.toString("base64");
    assert.match(
      replayHistorySegment(alteredImage, { ...(anchor !== undefined ? { anchor } : {}) }).error ??
        "",
      /semantic fingerprint does not hold/,
    );
  }
});
