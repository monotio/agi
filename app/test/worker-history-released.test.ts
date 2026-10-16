/**
 * Tapes recorded by released versions replay on this one to the same state.
 * history-1.2.2-paused-reenter.json was recorded by the 1.2.2 worker: a host
 * re-entry, then a pause before the next poll, four paused polls in which 1.2.2
 * ran no cycle, a resume and more polls. Never regenerate it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { historySyncDigest, type HistoryBatch } from "../../src/agent/history.ts";
import type { WorkerControl } from "../src/worker/workerProtocol.ts";
import { base64ToBytes, bytesToBase64 } from "../src/project/bytes.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { collectSegments, replayHistorySegment } from "./worker-ctx.ts";

test("a 1.2.2 tape with a re-entry held by a pause replays to its recorded state", () => {
  const tape = JSON.parse(
    readFileSync(new URL("formats/history-1.2.2-paused-reenter.json", import.meta.url), "utf8"),
  ) as { batches: HistoryBatch[]; final: { v40: number; v41: number; digest: string } };
  const [segment] = collectSegments(
    tape.batches.map((batch) => ({ type: "historyBatch", epoch: 0, batch }) as WorkerControl),
  );
  const replayed = replayHistorySegment(segment!);
  assert.equal(replayed.error, null);
  assert.equal(replayed.diverged, null, "every recorded sync mark holds");
  const engine = replayed.ctx.run.engine!;
  assert.deepEqual([engine.vars[40], engine.vars[41]], [tape.final.v40, tape.final.v41]);
  assert.equal(historySyncDigest(engine), tape.final.digest);
});

test("every released anchor in history-1.2.2-paused-reenter.json and project-v1.zip restores and replays without rewriting stored bytes", async () => {
  const tapeBytes = readFileSync(
    new URL("formats/history-1.2.2-paused-reenter.json", import.meta.url),
  );
  const tapeBefore = tapeBytes.slice();
  const tape = JSON.parse(new TextDecoder().decode(tapeBytes)) as {
    batches: HistoryBatch[];
    final: { v40: number; v41: number; digest: string };
  };
  const [tapeSegment] = collectSegments(
    tape.batches.map((batch) => ({ type: "historyBatch", epoch: 0, batch }) as WorkerControl),
  );
  assert.equal(tapeSegment!.anchors.length, 3);
  const segmentBefore = structuredClone(tapeSegment!);
  for (let i = 0; i < tapeSegment!.anchors.length; i++) {
    const replayed = replayHistorySegment(tapeSegment!, { anchor: i });
    assert.equal(replayed.error, null, `1.2.2 anchor ${i} must restore and replay`);
    assert.equal(replayed.diverged, null);
    const engine = replayed.ctx.run.engine!;
    assert.deepEqual([engine.vars[40], engine.vars[41]], [tape.final.v40, tape.final.v41]);
    assert.equal(historySyncDigest(engine), tape.final.digest);
  }
  assert.deepEqual(tapeSegment, segmentBefore, "anchor replay must not mutate the segment");
  assert.deepEqual(tapeBytes, tapeBefore);

  // State verification still rejects a released anchor whose fingerprint does not match its state.
  const tampered = structuredClone(tapeSegment!);
  tampered.anchors[0]!.rng ^= 1;
  const rejected = replayHistorySegment(tampered, { anchor: 0 });
  assert.match(rejected.error ?? "", /semantic fingerprint does not hold/);

  const tamperedImage = structuredClone(tapeSegment!);
  const imgBytes = base64ToBytes(tamperedImage.anchors[0]!.image);
  const v40Offset = 38 + 31 + 2 + 7 + 40;
  imgBytes[v40Offset] = imgBytes[v40Offset]! ^ 1; // Flip v40 inside save block 1 while keeping v1 header byte.
  tamperedImage.anchors[0]!.image = bytesToBase64(imgBytes);
  const rejectedImage = replayHistorySegment(tamperedImage, { anchor: 0 });
  assert.match(rejectedImage.error ?? "", /semantic fingerprint does not hold/);

  const zipBytes = new Uint8Array(readFileSync(new URL("formats/project-v1.zip", import.meta.url)));
  const zipBefore = zipBytes.slice();
  const project = await readGameZip(zipBytes);
  const projectSegments = project.history!.recording.segments;
  assert.equal(projectSegments.length, 1);
  assert.equal(projectSegments[0]!.anchors.length, 5);
  for (const segment of projectSegments) {
    const before = structuredClone(segment);
    for (let i = 0; i < segment.anchors.length; i++) {
      const replayed = replayHistorySegment(segment, { anchor: i });
      assert.equal(replayed.error, null, `project-v1.zip anchor ${i} must restore and replay`);
      assert.equal(replayed.diverged, null);
    }
    assert.deepEqual(segment, before);
  }
  assert.deepEqual(zipBytes, zipBefore);
});
