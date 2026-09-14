/**
 * The stored history record carries several writers on one row: the batch
 * committer, the retained-original slot (Resume here's departing session)
 * and the bookmarks. A commit must never drop what another writer stored —
 * the adopted session's own boot batch lands right after the original is
 * retained, and a store that rewrote only its own fields would erase it.
 *
 * The swap itself is staged: the departing session is stored beside the
 * retained one and promoted only once the worker acknowledges the adoption,
 * so a failed or uncertain swap never costs the kept session.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HISTORY_FORMAT_VERSION,
  type HistoryBatch,
  type HistoryBoot,
} from "../../src/agent/history.ts";
import {
  appendHistoryBatch,
  clearStagedOriginal,
  commitStagedOriginal,
  HISTORY_TOTAL_BYTE_LIMIT,
  importGameHistory,
  loadGameHistory,
  loadHistoryBookmarks,
  loadProjectHistory,
  loadRetainedOriginal,
  saveHistoryBookmark,
  stageRetainedOriginal,
  type RetainedOriginal,
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

function retainedOn(from: string, at = 1): RetainedOriginal {
  return { boot: BOOT, from: { segment: from, seq: 4, tick: 9 }, retainedAt: at };
}

function batch(n: number, extra: Partial<HistoryBatch> = {}): HistoryBatch {
  return {
    segment: "s-a.1",
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
  const retained = retainedOn("s-a.1");
  await stageRetainedOriginal(KEY, retained);
  await commitStagedOriginal(KEY);
  assert.deepEqual(await loadRetainedOriginal(KEY), retained);

  // The adopted session's first batch commits over the record — the
  // retained original must still be there when the tape reopens.
  assert.equal(
    await appendHistoryBatch(
      KEY,
      {
        ...batch(1),
        segment: "s-a.2",
        boot: { ...BOOT, resumedFrom: { segment: "s-a.1", seq: 4, tick: 9 } },
      },
      "2.936",
    ),
    true,
  );
  assert.deepEqual(await loadRetainedOriginal(KEY), retained);

  // Same for bookmarks: a commit after the pin must not erase it.
  await saveHistoryBookmark(KEY, { segment: "s-a.1", seq: 4, tick: 9, label: "Note", at: 2 });
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
  assert.equal(recording?.segments[1]?.boot.resumedFrom?.segment, "s-a.1");
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
  assert.equal(await appendHistoryBatch(key, { ...batch(9), segment: "s-a.9" }, "2.936"), false);
  assert.equal(
    await appendHistoryBatch(key, { ...batch(1), segment: "s-a.9", boot: BOOT }, "2.936"),
    true,
  );
  assert.equal(await appendHistoryBatch(key, { ...batch(9), segment: "s-a.9" }, "2.936"), true);
  assert.equal((await loadGameHistory(key))?.segments.length, 2);
});

test("a staged swap leaves the kept session intact until the adoption commits", async () => {
  const key = "tape-store-staged";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936"), true);
  const first = retainedOn("s-a.1", 1);
  const second = { ...retainedOn("s-a.2", 2), boot: { ...BOOT, rng: 99 } };
  await stageRetainedOriginal(key, first);
  await commitStagedOriginal(key);
  assert.deepEqual(await loadRetainedOriginal(key), first);

  // Resume here again: the departing session stages beside the kept one —
  // until the worker acknowledges, the kept session still answers.
  await stageRetainedOriginal(key, second);
  assert.deepEqual(await loadRetainedOriginal(key), first);

  // Abandoned (adoption failed): the staged copy clears, nothing changed.
  await clearStagedOriginal(key);
  assert.deepEqual(await loadRetainedOriginal(key), first);

  // Committed (adoption acknowledged): the staged session becomes the kept
  // one — exactly once.
  await stageRetainedOriginal(key, second);
  await commitStagedOriginal(key);
  assert.deepEqual(await loadRetainedOriginal(key), second);
});

test("a staged copy is the recovery route when no retained original exists", async () => {
  const key = "tape-store-staged-only";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936"), true);
  // The swap's ack was lost after the worker adopted — the staged departing
  // session is the only copy, and Back to before must still find it.
  await stageRetainedOriginal(key, retainedOn("s-a.1", 3));
  assert.deepEqual(await loadRetainedOriginal(key), retainedOn("s-a.1", 3));
});

test("an imported project's tape persists whole — recording, kept session, bookmarks", async () => {
  const key = "tape-store-imported";
  const recording = {
    version: HISTORY_FORMAT_VERSION,
    profile: "2.936",
    resourceSet: "rev-a",
    startedAt: 1_757_000_000_000,
    segments: [
      {
        id: "sess1.s1",
        boot: BOOT,
        anchors: [],
        events: [{ seq: 0, tick: 3, cycle: 3, cause: { kind: "key" as const, code: 65 } }],
        marks: [],
        sync: [],
      },
    ],
  };
  const retained = retainedOn("sess1.s1", 5);
  const bookmarks = [{ segment: "sess1.s1", seq: 0, tick: 3, label: "Here", at: 9 }];
  assert.equal(await importGameHistory(key, { recording, retained, bookmarks }), true);

  // The tape opens under the imported project's key, siblings intact.
  const loaded = await loadProjectHistory(key);
  assert.deepEqual(loaded?.recording, recording);
  assert.deepEqual(loaded?.retained, retained);
  assert.deepEqual(loaded?.bookmarks, bookmarks);
  assert.deepEqual(await loadRetainedOriginal(key), retained);

  // The fresh commit ledger dedups nothing — a resend of the imported
  // session's own batch number still lands (no worker resends it; the
  // imported tape's batches simply were never committed here).
  assert.equal(
    await appendHistoryBatch(
      key,
      {
        segment: "sess2.s1",
        batch: 1,
        seqStart: 0,
        seqEnd: 0,
        events: [],
        marks: [],
        sync: [],
        boot: { ...BOOT, resumedFrom: { segment: "sess1.s1", seq: 0, tick: 3 } },
      },
      "2.936",
    ),
    true,
  );
  const after = await loadGameHistory(key);
  assert.equal(after?.segments.length, 2);
  assert.deepEqual(await loadRetainedOriginal(key), retained, "the kept session survived");
});

test("the segment bound drops the oldest segments but never the live tail", async () => {
  const key = "tape-store-bound";
  for (let seg = 1; seg <= 66; seg++) {
    assert.equal(
      await appendHistoryBatch(key, { ...batch(1), segment: `s-b.${seg}`, boot: BOOT }, "2.936"),
      true,
    );
  }
  const recording = await loadGameHistory(key);
  assert.ok(recording !== null);
  assert.equal(recording.segments.length, 64);
  assert.equal(recording.dropped, 2);
  // The tail (the newest segment) is always kept.
  assert.equal(recording.segments.at(-1)?.id, "s-b.66");
  assert.equal(recording.segments[0]?.id, "s-b.3");
});

test("the total byte bound evicts oldest segments and reports the loss", async () => {
  const key = "tape-store-bytes";
  // A patch event's payload is honest tape data — size the segments so a
  // few of them exceed the total bound without needing the segment cap.
  const payload = "A".repeat(4 * 1024 * 1024);
  const needed = Math.ceil(HISTORY_TOTAL_BYTE_LIMIT / (4 * 1024 * 1024)) + 2;
  for (let seg = 1; seg <= needed; seg++) {
    assert.equal(
      await appendHistoryBatch(
        key,
        {
          ...batch(1),
          segment: `s-c.${seg}`,
          boot: BOOT,
          events: [
            {
              seq: 0,
              tick: 1,
              cycle: 1,
              cause: { kind: "patch", resource: "logic", num: 1, data: payload },
            },
          ],
        },
        "2.936",
      ),
      true,
    );
  }
  const recording = await loadGameHistory(key);
  assert.ok(recording !== null);
  assert.ok(recording.segments.length < needed);
  assert.equal(recording.dropped, needed - recording.segments.length);
  assert.equal(recording.segments.at(-1)?.id, `s-c.${needed}`);
});
