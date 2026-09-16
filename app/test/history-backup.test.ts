import { test } from "node:test";
import assert from "node:assert/strict";
import { collectHistoryBackup } from "../src/historyBackup.ts";

test("failed history reads preserve worker recovery bytes and declare the missing tape", async () => {
  const batch = {
    segment: "s1.s1",
    batch: 1,
    seqStart: 0,
    seqEnd: 0,
    events: [],
    marks: [],
    sync: [],
  };
  const result = await collectHistoryBackup(
    async () => {
      throw new Error("storage denied");
    },
    async () => [batch],
  );
  assert.equal(result.history, null);
  assert.equal(result.report.complete, false);
  assert.deepEqual(result.report.recoveryBatches, [batch]);
  assert.match(result.report.notes.join(" "), /not automatically restored/);
  assert.match(result.report.notes.join(" "), /could not be read/);
});

test("empty readable history is complete; worker failure is explicitly partial", async () => {
  assert.equal((await collectHistoryBackup(async () => null, null)).report.complete, true);
  const result = await collectHistoryBackup(
    async () => null,
    async () => {
      throw new Error("dead worker");
    },
  );
  assert.equal(result.report.complete, false);
  assert.match(result.report.notes.join(" "), /could not be captured/);
});
