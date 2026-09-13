/**
 * The stored history record carries three writers on one row: the batch
 * committer, the retained-original slot (Resume here's departing session)
 * and the bookmarks. A commit must never drop what another writer stored —
 * the adopted session's own boot batch lands right after the original is
 * retained, and a store that rewrote only its own fields would erase it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryBatch, HistoryBoot } from "../../src/agent/history.ts";
import {
  appendHistoryBatch,
  loadGameHistory,
  loadHistoryBookmarks,
  loadRetainedOriginal,
  saveHistoryBookmark,
  saveRetainedOriginal,
} from "../src/historyStorage.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();

const KEY = "tape-store-fixture";

const BOOT: HistoryBoot = {
  files: { "VOL.0": "eA==" },
  dictionary: [],
  authorRooms: false,
  rng: 7,
  soundDevice: 1,
  resourceSet: "rev-1",
  requestSerial: 0,
};

function batch(n: number, extra: Partial<HistoryBatch> = {}): HistoryBatch {
  return {
    segment: "e1.s1",
    batch: n,
    seqStart: n - 1,
    seqEnd: n,
    events: [],
    marks: [],
    sync: [],
    ...extra,
  };
}

test("commits keep the retained original and bookmarks other writers stored", async () => {
  // The boot batch opens the segment; the retained original lands on top —
  // the exact order Resume here writes.
  assert.equal(await appendHistoryBatch(KEY, batch(1, { boot: BOOT }), "2.936"), true);
  const retained = {
    boot: BOOT,
    from: { segment: "e1.s1", seq: 4, tick: 9 },
    retainedAt: 1,
  };
  await saveRetainedOriginal(KEY, retained);
  assert.deepEqual(await loadRetainedOriginal(KEY), retained);

  // The adopted session's first batch commits over the record — the
  // retained original must still be there when the tape reopens.
  assert.equal(
    await appendHistoryBatch(
      KEY,
      {
        ...batch(1),
        segment: "e1.s2",
        boot: { ...BOOT, resumedFrom: { segment: "e1.s1", seq: 4, tick: 9 } },
      },
      "2.936",
    ),
    true,
  );
  assert.deepEqual(await loadRetainedOriginal(KEY), retained);

  // Same for bookmarks: a commit after the pin must not erase it.
  await saveHistoryBookmark(KEY, { segment: "e1.s1", seq: 4, tick: 9, label: "Note", at: 2 });
  assert.equal(
    await appendHistoryBatch(
      KEY,
      batch(2, {
        events: [{ seq: 1, tick: 3, cycle: 3, cause: { kind: "key", code: 65 } }],
      }),
      "2.936",
    ),
    true,
  );
  assert.equal((await loadHistoryBookmarks(KEY)).length, 1);
  assert.deepEqual(await loadRetainedOriginal(KEY), retained);

  // The recording itself folded both segments.
  const recording = await loadGameHistory(KEY);
  assert.equal(recording?.segments.length, 2);
  assert.equal(recording?.segments[1]?.boot.resumedFrom?.segment, "e1.s1");
});

test("a resent batch lands once, and a batchless segment waits for its boot", async () => {
  const key = "tape-store-dedup";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936"), true);

  // A resend of the same (segment, batch) commits nothing twice.
  const dup = batch(2, {
    events: [{ seq: 0, tick: 2, cycle: 2, cause: { kind: "key", code: 66 } }],
  });
  assert.equal(await appendHistoryBatch(key, dup, "2.936"), true);
  assert.equal(await appendHistoryBatch(key, dup, "2.936"), true);
  const recording = await loadGameHistory(key);
  assert.equal(recording?.segments[0]?.events.length, 1);

  // Out of order: a batch for an unknown segment is refused until its boot
  // batch lands — then both fold in.
  assert.equal(await appendHistoryBatch(key, { ...batch(9), segment: "e1.s9" }, "2.936"), false);
  assert.equal(
    await appendHistoryBatch(key, { ...batch(1), segment: "e1.s9", boot: BOOT }, "2.936"),
    true,
  );
  assert.equal(await appendHistoryBatch(key, { ...batch(9), segment: "e1.s9" }, "2.936"), true);
  assert.equal((await loadGameHistory(key))?.segments.length, 2);
});
