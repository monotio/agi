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
