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
  historyBootSemantic,
  historyFingerprint,
  validateHistoryRecording,
  type HistoryBatch,
  type HistoryBoot,
} from "../../src/agent/history.ts";
import { updateBodyRecord } from "../src/gameStorage.ts";
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
  mergeHistoryBatch,
  migrateHistoryRecord,
  resolveStagedSwap,
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
  // batch lands — then the run continues consecutively from it.
  assert.equal(await appendHistoryBatch(key, { ...batch(9), segment: "s-a.9" }, "2.936"), false);
  assert.equal(
    await appendHistoryBatch(key, { ...batch(8), segment: "s-a.9", boot: BOOT }, "2.936"),
    true,
  );
  assert.equal(await appendHistoryBatch(key, { ...batch(9), segment: "s-a.9" }, "2.936"), true);
  assert.equal((await loadGameHistory(key))?.segments.length, 2);
});

test("a later batch is refused until the failed one between commits", async () => {
  const key = "tape-store-order";
  const ev = (seq: number) => ({
    seq,
    tick: seq,
    cycle: seq,
    cause: { kind: "key" as const, code: 60 + seq },
  });
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936"), true);
  assert.equal(await appendHistoryBatch(key, batch(2, { events: [ev(1)] }), "2.936"), true);

  // Batch 3's commit fails; batch 4 arrives first on the resend turn and
  // must NOT append — its events belong after 3's.
  assert.equal(await appendHistoryBatch(key, batch(4, { events: [ev(3)] }), "2.936"), false);
  assert.equal((await loadGameHistory(key))?.segments[0]?.events.map((e) => e.seq).join(","), "1");

  // The missing batch lands on resend; then the held batch retries and
  // appends in the stream's original order.
  assert.equal(await appendHistoryBatch(key, batch(3, { events: [ev(2)] }), "2.936"), true);
  assert.equal(await appendHistoryBatch(key, batch(4, { events: [ev(3)] }), "2.936"), true);
  assert.equal(
    (await loadGameHistory(key))?.segments[0]?.events.map((e) => e.seq).join(","),
    "1,2,3",
  );
});

test("the replay boundary rejects a tape whose event lane is out of order", () => {
  // The contract half of ordering: whatever a commit bug or a hand-edited
  // archive produces, a disordered stream must not replay.
  const recording = {
    version: HISTORY_FORMAT_VERSION,
    profile: "2.936",
    resourceSet: "rev-1",
    startedAt: 0,
    segments: [
      {
        id: "s-o.1",
        boot: BOOT,
        anchors: [],
        events: [
          { seq: 2, tick: 2, cycle: 2, cause: { kind: "key", code: 65 } },
          { seq: 1, tick: 1, cycle: 1, cause: { kind: "key", code: 66 } },
        ],
        marks: [],
        sync: [],
      },
    ],
  };
  assert.throws(() => validateHistoryRecording(recording), /ordered by seq/);
});

test("a stamped record whose fields drifted fails validation", () => {
  // The fingerprint is the recorded expectation over the record's own
  // semantic fields — a record that no longer matches its stamp never
  // reaches a drive.
  const stamped: HistoryBoot = {
    ...BOOT,
    fingerprint: historyFingerprint(historyBootSemantic(BOOT)),
  };
  const good = {
    version: HISTORY_FORMAT_VERSION,
    profile: "2.936",
    resourceSet: "rev-1",
    startedAt: 0,
    segments: [{ id: "s-f.1", boot: stamped, anchors: [], events: [], marks: [], sync: [] }],
  };
  validateHistoryRecording(good); // self-consistent: passes

  const drifted = JSON.parse(JSON.stringify(good));
  drifted.segments[0].boot.rng = 8;
  assert.throws(() => validateHistoryRecording(drifted), /fingerprint does not match/);
});

test("an end batch alone cannot skip a failed lower batch", async () => {
  const key = "tape-store-endgap";
  const ev = (seq: number) => ({
    seq,
    tick: seq,
    cycle: seq,
    cause: { kind: "key" as const, code: 60 + seq },
  });
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936"), true);
  assert.equal(await appendHistoryBatch(key, batch(2, { events: [ev(1)] }), "2.936"), true);

  // Batch 3's commit failed; a normal eject closer (batch 4, end:eject,
  // no gap declaration) must NOT seal the segment past it — the marker
  // alone is not permission to abandon the missing batch's events.
  const closer = batch(4, {
    events: [ev(3)],
    end: { seq: 4, tick: 4, cycle: 4, reason: "eject" },
  });
  assert.equal(await appendHistoryBatch(key, closer, "2.936"), false);
  assert.equal((await loadGameHistory(key))?.segments[0]?.end, undefined);

  // The missing batch lands on resend; then the closer retries and seals.
  assert.equal(await appendHistoryBatch(key, batch(3, { events: [ev(2)] }), "2.936"), true);
  assert.equal(await appendHistoryBatch(key, closer, "2.936"), true);
  const segment = (await loadGameHistory(key))?.segments[0];
  assert.equal(segment?.end?.reason, "eject");
  assert.equal(segment?.events.map((e) => e.seq).join(","), "1,2,3");
});

test("an end batch may jump only the batch numbers its sender abandoned", async () => {
  const key = "tape-store-endjump";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936"), true);
  assert.equal(await appendHistoryBatch(key, batch(2, {}), "2.936"), true);

  // Batches 3-4 were dropped by the worker's queue overflow; its budget
  // closing batch seals the segment only by declaring the abandoned run.
  const end = { seq: 40, tick: 40, cycle: 40, reason: "budget" as const };
  assert.equal(await appendHistoryBatch(key, batch(5, { end }), "2.936"), false);
  assert.equal(await appendHistoryBatch(key, batch(5, { end, gap: [3, 4] }), "2.936"), true);
  const segment = (await loadGameHistory(key))?.segments[0];
  assert.equal(segment?.end?.reason, "budget");

  // The abandoned numbers joined the ledger: a late resend of one dedups
  // to an ack — the worker is not made to retry a write it dropped.
  assert.equal(await appendHistoryBatch(key, batch(3, {}), "2.936"), true);
  assert.equal((await loadGameHistory(key))?.segments[0]?.events.length, 0);

  // A gap declaration is not a blank check: batch 8 was never abandoned.
  assert.equal(await appendHistoryBatch(key, batch(9, { gap: [6, 7] }), "2.936"), false);
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

test("a second stage is refused while a swap candidate is still pending", async () => {
  const key = "tape-store-staged-blocked";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936"), true);
  assert.equal(await stageRetainedOriginal(key, retainedOn("s-a.1", 1)), true);
  // The first swap's promotion never landed — the next swap must not
  // overwrite the only durable copy of that departing session.
  assert.equal(await stageRetainedOriginal(key, retainedOn("s-a.9", 2)), false);
  assert.deepEqual(await loadRetainedOriginal(key), retainedOn("s-a.1", 1));
});

test("the departing segment's resume end settles its staged swap as adopted", async () => {
  const key = "tape-store-resolve-resume";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936"), true);
  const staged = retainedOn("s-a.1", 4);
  await stageRetainedOriginal(key, staged);
  // The adoption ran; its "resume" end committed but the promotion write
  // did not. The tape alone settles the candidate into the retained slot.
  assert.equal(
    await appendHistoryBatch(
      key,
      batch(2, { end: { seq: 4, tick: 9, cycle: 9, reason: "resume" } }),
      "2.936",
    ),
    true,
  );
  const recording = await loadGameHistory(key);
  assert.equal(await resolveStagedSwap(key, recording), "promoted");
  assert.deepEqual(await loadRetainedOriginal(key), staged);
});

test("a natural end settles the staged swap as never adopted", async () => {
  const key = "tape-store-resolve-quit";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936"), true);
  await stageRetainedOriginal(key, retainedOn("s-a.1", 4));
  // The departing session was quit while a staged swap was still pending —
  // the snapshot is redundant and clears.
  assert.equal(
    await appendHistoryBatch(
      key,
      batch(2, { end: { seq: 4, tick: 9, cycle: 9, reason: "quit" } }),
      "2.936",
    ),
    true,
  );
  const recording = await loadGameHistory(key);
  assert.equal(await resolveStagedSwap(key, recording), "cleared");
  assert.equal(await loadRetainedOriginal(key), null);
});

test("an open departing segment stays ambiguous until the worker's word settles it", async () => {
  const key = "tape-store-resolve-open";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936"), true);
  const staged = retainedOn("s-a.1", 4);
  await stageRetainedOriginal(key, staged);
  const recording = await loadGameHistory(key);
  // The segment is still open: the "resume" end may simply be the write
  // that failed — the tape alone cannot call it either way.
  assert.equal(await resolveStagedSwap(key, recording), "ambiguous");
  assert.deepEqual(await loadRetainedOriginal(key), staged);

  // The worker still live on that segment proves the swap never ran.
  assert.equal(await resolveStagedSwap(key, recording, "s-a.1"), "cleared");
  assert.equal(await loadRetainedOriginal(key), null);

  // Staged again, and this time the worker reports a different live
  // segment — the adoption happened, the promotion is owed.
  await stageRetainedOriginal(key, staged);
  assert.equal(await resolveStagedSwap(key, recording, "s-a.2"), "promoted");
  assert.deepEqual(await loadRetainedOriginal(key), staged);
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

test("the segment bound drops the oldest ended segments but never the live tail", async () => {
  const key = "tape-store-bound";
  const end = { seq: 0, tick: 0, cycle: 0, reason: "quit" as const };
  for (let seg = 1; seg <= 66; seg++) {
    // Every segment but the tail is ended — an open segment is live or
    // unresolved and is never evicted.
    assert.equal(
      await appendHistoryBatch(
        key,
        { ...batch(1), segment: `s-b.${seg}`, boot: BOOT, ...(seg < 66 ? { end } : {}) },
        "2.936",
      ),
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

test("an open head does not pin the ended segments behind it", async () => {
  const key = "tape-store-open-head";
  // One crashed session left its segment open; 70 later sessions ended
  // cleanly. The bound must still evict the ended ones oldest-first —
  // an unfinished head cannot disable retention for the whole tape.
  assert.equal(
    await appendHistoryBatch(key, { ...batch(1), segment: "s-o.0", boot: BOOT }, "2.936"),
    true,
  );
  const end = { seq: 0, tick: 0, cycle: 0, reason: "quit" as const };
  for (let seg = 1; seg <= 70; seg++) {
    assert.equal(
      await appendHistoryBatch(
        key,
        { ...batch(1), segment: `s-o.${seg}`, boot: BOOT, end },
        "2.936",
      ),
      true,
    );
  }
  const recording = await loadGameHistory(key);
  assert.ok(recording !== null);
  assert.equal(recording.segments.length, 64);
  assert.equal(recording.dropped, 7);
  // The open head survived — every drop was an ended segment.
  assert.equal(recording.segments[0]?.id, "s-o.0");
  assert.equal(recording.segments.at(-1)?.id, "s-o.70");

  // A late batch for an evicted segment acks-and-drops instead of pinning
  // the sender's resend on a segment that is gone on purpose.
  assert.equal(await appendHistoryBatch(key, { ...batch(2), segment: "s-o.1" }, "2.936"), true);
  assert.equal(
    (await loadGameHistory(key))?.segments.find((s) => s.id === "s-o.1"),
    undefined,
    "the tombstone swallowed the straggler",
  );
});

test("an all-open tape still sheds its oldest segments past the bound", async () => {
  const key = "tape-store-all-open";
  // 66 unfinished sessions — tabs that crashed or never closed. Nothing
  // carries an end, yet the bound holds: the oldest sheds and the newest
  // open tail — the session that could still be live — is always kept.
  for (let seg = 1; seg <= 66; seg++) {
    assert.equal(
      await appendHistoryBatch(key, { ...batch(1), segment: `s-p.${seg}`, boot: BOOT }, "2.936"),
      true,
    );
  }
  const recording = await loadGameHistory(key);
  assert.equal(recording?.segments.length, 64);
  assert.equal(recording?.dropped, 2);
  assert.equal(recording?.segments[0]?.id, "s-p.3");
  assert.equal(recording?.segments.at(-1)?.id, "s-p.66");
});

test("a mid-session key change carries the live tape to the new record", async () => {
  const from = "tape-migrate-from";
  const to = "tape-migrate-to";
  assert.equal(
    await appendHistoryBatch(from, { ...batch(1), segment: "sM.1", boot: BOOT }, "2.936"),
    true,
  );
  assert.equal(
    await appendHistoryBatch(
      from,
      {
        ...batch(2),
        segment: "sM.1",
        events: [{ seq: 0, tick: 1, cycle: 1, cause: { kind: "key", code: 65 } }],
      },
      "2.936",
    ),
    true,
  );

  await migrateHistoryRecord(from, to);

  // The continuing session's next batch lands on the moved record — its
  // ledger carried, so batch 3 is simply next.
  assert.equal(
    await appendHistoryBatch(
      to,
      {
        ...batch(3),
        segment: "sM.1",
        events: [{ seq: 1, tick: 2, cycle: 2, cause: { kind: "key", code: 66 } }],
      },
      "2.936",
    ),
    true,
  );
  const moved = await loadGameHistory(to);
  assert.equal(moved?.segments.length, 1);
  assert.equal(moved?.segments[0]?.events.length, 2);
  // The source keeps its own copy — that game's sessions still replay.
  assert.equal((await loadGameHistory(from))?.segments[0]?.events.length, 1);
});

test("migrating an absent record is a no-op", async () => {
  await migrateHistoryRecord("tape-migrate-none", "tape-migrate-none-2");
  assert.equal(await loadGameHistory("tape-migrate-none-2"), null);
});

test("the total byte bound evicts oldest segments and reports the loss", async () => {
  const key = "tape-store-bytes";
  // A patch event's payload is honest tape data — size the segments so a
  // few of them exceed the total bound without needing the segment cap.
  const payload = "A".repeat(4 * 1024 * 1024);
  const needed = Math.ceil(HISTORY_TOTAL_BYTE_LIMIT / (4 * 1024 * 1024)) + 2;
  const end = { seq: 1, tick: 1, cycle: 1, reason: "quit" as const };
  for (let seg = 1; seg <= needed; seg++) {
    assert.equal(
      await appendHistoryBatch(
        key,
        {
          ...batch(1),
          segment: `s-c.${seg}`,
          boot: BOOT,
          ...(seg < needed ? { end } : {}),
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

test("two clients committing concurrently never lose an acknowledged batch", async () => {
  const key = "history/tape-store-twotab";
  // Two tabs each run a live session on the same project and post their
  // segments' boot batches at once. Each tab's own appendHistoryBatch mutex
  // does not reach the other tab — the read-modify-write must hold one
  // read-write transaction or the second put erases the first segment, and
  // the acked batch is never resent. mergeHistoryBatch is the per-tab half:
  // calling it twice concurrently is exactly what two tabs produce.
  const [a, b] = await Promise.all([
    mergeHistoryBatch(key, { ...batch(1), segment: "s-t.a", boot: BOOT }, "2.936"),
    mergeHistoryBatch(key, { ...batch(1), segment: "s-t.b", boot: { ...BOOT, rng: 42 } }, "2.936"),
  ]);
  assert.equal(a, true);
  assert.equal(b, true);
  const recording = await loadGameHistory("tape-store-twotab");
  assert.deepEqual(recording?.segments.map((s) => s.id).sort(), ["s-t.a", "s-t.b"]);
});

test("a tape from an older format version is replaced, not extended", async () => {
  const key = "tape-store-version";
  // Seed the record a previous build left: the storage envelope is
  // version 1 either way — the tape's own version moved under it.
  await updateBodyRecord(`history/${key}`, () => ({
    put: {
      format: "monotio.agi.history",
      version: 1,
      projectId: `history/${key}`,
      recording: {
        version: HISTORY_FORMAT_VERSION - 1,
        profile: "2.936",
        resourceSet: "rev-old",
        startedAt: 1,
        segments: [{ id: "old.1", boot: BOOT, anchors: [], events: [], marks: [], sync: [] }],
      },
      committed: { "old.1": [1] },
      bytes: { "old.1": 10 },
      retained: retainedOn("old.1"),
      bookmarks: [{ segment: "old.1", seq: 0, tick: 0, label: "old", at: 1 }],
    },
    result: undefined,
  }));

  // The new session's boot batch replaces the tape — appending a current
  // segment under the old version label would make the whole record
  // unreadable, and the old tape's extras point at segments that are gone.
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936"), true);
  const recording = await loadGameHistory(key);
  assert.equal(recording?.version, HISTORY_FORMAT_VERSION);
  assert.deepEqual(
    recording?.segments.map((s) => s.id),
    ["s-a.1"],
  );
  assert.equal(await loadRetainedOriginal(key), null);
  assert.deepEqual(await loadHistoryBookmarks(key), []);
});
