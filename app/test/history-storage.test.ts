/**
 * The stored history record carries several writers on one manifest: the
 * batch committer, the recovery-branch list (Resume here's departing
 * sessions) and the bookmarks. A commit must never drop what another
 * writer stored — the adopted session's own boot batch lands right after
 * the original is retained, and a store that rewrote only its own fields
 * would erase it.
 *
 * The swap itself is staged: the departing session waits in a bounded
 * staged lane and joins the branch list only once the worker acknowledges
 * the adoption, so a failed or uncertain swap never costs a kept session.
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
import {
  appendHistoryBatch,
  clearStagedOriginal,
  commitStagedOriginal,
  HISTORY_BRANCHES_MAX,
  HISTORY_STAGED_MAX,
  HISTORY_TOTAL_BYTE_LIMIT,
  HISTORY_WRITER_LEASE_MS,
  importGameHistory,
  loadGameHistory,
  loadHistoryBookmarks,
  loadProjectHistory,
  loadRetainedBranches,
  loadTapeOutline,
  mergeHistoryBatch,
  moveHistoryRecord,
  resolveStagedSwap,
  renewHistoryWriter,
  saveHistoryBookmark,
  stageRetainedOriginal,
  type RetainedOriginal,
} from "../src/historyStorage.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId, testRevision } from "./identity.ts";

const RECORDS = installIndexedDbFixture();

const KEY = "tape-store-fixture";
const IDENTITY = { project: testProjectId(KEY), revision: testRevision("tape") };

const BOOT: HistoryBoot = {
  files: { "VOL.0": "eA==" },
  dictionary: [],
  authorRooms: false,
  rng: 7,
  soundDevice: 1,
  resourceSet: "rev-1",
  requestSerial: 0,
};

let branchSerial = 0;
function retainedOn(from: string, at = 1): RetainedOriginal {
  return {
    id: `b-${++branchSerial}`,
    boot: BOOT,
    from: { segment: from, seq: 4, tick: 9 },
    retainedAt: at,
  };
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

test("commits keep the recovery branches and bookmarks other writers stored", async () => {
  // The boot batch opens the segment; the departing session stages and
  // promotes on top — the exact order Resume from here writes.
  assert.equal(await appendHistoryBatch(KEY, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  const retained = retainedOn("s-a.1");
  await stageRetainedOriginal(KEY, retained);
  await commitStagedOriginal(KEY, retained.id);
  assert.deepEqual(await loadRetainedBranches(KEY), [retained]);

  // The adopted session's first batch commits over the record — the kept
  // branch must still be there when the tape reopens.
  assert.equal(
    await appendHistoryBatch(
      KEY,
      {
        ...batch(1),
        segment: "s-a.2",
        boot: { ...BOOT, resumedFrom: { segment: "s-a.1", seq: 4, tick: 9 } },
      },
      "2.936",
      IDENTITY,
    ),
    true,
  );
  assert.deepEqual(await loadRetainedBranches(KEY), [retained]);

  // Same for bookmarks: a commit after the pin must not erase it.
  await saveHistoryBookmark(KEY, { segment: "s-a.1", seq: 4, tick: 9, label: "Note", at: 2 });
  assert.equal(
    await appendHistoryBatch(
      KEY,
      batch(2, {
        events: [{ seq: 1, tick: 3, cycle: 3, cause: { kind: "key", code: 65 } }],
      }),
      "2.936",
      IDENTITY,
    ),
    true,
  );
  assert.equal((await loadHistoryBookmarks(KEY)).length, 1);
  assert.deepEqual(await loadRetainedBranches(KEY), [retained]);

  // The recording itself folded both segments.
  const recording = await loadGameHistory(KEY);
  assert.equal(recording?.segments.length, 2);
  assert.equal(recording?.segments[1]?.boot.resumedFrom?.segment, "s-a.1");
});

test("a resent batch lands once, and a batchless segment waits for its boot", async () => {
  const key = "tape-store-dedup";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);

  // A resend of the same (segment, batch) commits nothing twice.
  const dup = batch(2, {
    events: [{ seq: 0, tick: 2, cycle: 2, cause: { kind: "key", code: 66 } }],
  });
  assert.equal(await appendHistoryBatch(key, dup, "2.936", IDENTITY), true);
  assert.equal(await appendHistoryBatch(key, dup, "2.936", IDENTITY), true);
  const recording = await loadGameHistory(key);
  assert.equal(recording?.segments[0]?.events.length, 1);

  // Out of order: a batch for an unknown segment is refused until its boot
  // batch lands — then the run continues consecutively from it.
  assert.equal(
    await appendHistoryBatch(key, { ...batch(9), segment: "s-a.9" }, "2.936", IDENTITY),
    false,
  );
  assert.equal(
    await appendHistoryBatch(key, { ...batch(8), segment: "s-a.9", boot: BOOT }, "2.936", IDENTITY),
    true,
  );
  assert.equal(
    await appendHistoryBatch(key, { ...batch(9), segment: "s-a.9" }, "2.936", IDENTITY),
    true,
  );
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
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  assert.equal(
    await appendHistoryBatch(key, batch(2, { events: [ev(1)] }), "2.936", IDENTITY),
    true,
  );

  // Batch 3's commit fails; batch 4 arrives first on the resend turn and
  // must NOT append — its events belong after 3's.
  assert.equal(
    await appendHistoryBatch(key, batch(4, { events: [ev(3)] }), "2.936", IDENTITY),
    false,
  );
  assert.equal((await loadGameHistory(key))?.segments[0]?.events.map((e) => e.seq).join(","), "1");

  // The missing batch lands on resend; then the held batch retries and
  // appends in the stream's original order.
  assert.equal(
    await appendHistoryBatch(key, batch(3, { events: [ev(2)] }), "2.936", IDENTITY),
    true,
  );
  assert.equal(
    await appendHistoryBatch(key, batch(4, { events: [ev(3)] }), "2.936", IDENTITY),
    true,
  );
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
    identity: IDENTITY,
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
    identity: IDENTITY,
    profile: "2.936",
    resourceSet: "rev-1",
    startedAt: 0,
    segments: [{ id: "s-f.1", boot: stamped, anchors: [], events: [], marks: [], sync: [] }],
  };
  validateHistoryRecording(good); // self-consistent: passes

  const drifted = JSON.parse(JSON.stringify(good));
  drifted.segments[0].boot.rng = 8;
  assert.throws(() => validateHistoryRecording(drifted), /fingerprint does not match/);

  // A newer recorder's fingerprint says so rather than posing as drift.
  const newer = JSON.parse(JSON.stringify(good));
  newer.segments[0].boot.fingerprint.v = 2;
  assert.throws(() => validateHistoryRecording(newer), /fingerprint version 2 is not supported/);

  // The header names a known interpreter, and an end event a known reason.
  assert.throws(
    () => validateHistoryRecording({ ...good, profile: "" }),
    /recording profile must be a known interpreter profile/,
  );
  const ended = JSON.parse(JSON.stringify(good));
  ended.segments[0].events = [
    { seq: 0, tick: 0, cycle: 0, cause: { kind: "end", reason: "nope" } },
  ];
  assert.throws(() => validateHistoryRecording(ended), /end reason is invalid/);
});

test("an end batch alone cannot skip a failed lower batch", async () => {
  const key = "tape-store-endgap";
  const ev = (seq: number) => ({
    seq,
    tick: seq,
    cycle: seq,
    cause: { kind: "key" as const, code: 60 + seq },
  });
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  assert.equal(
    await appendHistoryBatch(key, batch(2, { events: [ev(1)] }), "2.936", IDENTITY),
    true,
  );

  // Batch 3's commit failed; a normal eject closer (batch 4, end:eject,
  // no gap declaration) must NOT seal the segment past it — the marker
  // alone is not permission to abandon the missing batch's events.
  const closer = batch(4, {
    events: [ev(3)],
    end: { seq: 4, tick: 4, cycle: 4, reason: "eject" },
  });
  assert.equal(await appendHistoryBatch(key, closer, "2.936", IDENTITY), false);
  assert.equal((await loadGameHistory(key))?.segments[0]?.end, undefined);

  // The missing batch lands on resend; then the closer retries and seals.
  assert.equal(
    await appendHistoryBatch(key, batch(3, { events: [ev(2)] }), "2.936", IDENTITY),
    true,
  );
  assert.equal(await appendHistoryBatch(key, closer, "2.936", IDENTITY), true);
  const segment = (await loadGameHistory(key))?.segments[0];
  assert.equal(segment?.end?.reason, "eject");
  assert.equal(segment?.events.map((e) => e.seq).join(","), "1,2,3");
});

test("an end batch may jump only the batch numbers its sender abandoned", async () => {
  const key = "tape-store-endjump";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  assert.equal(await appendHistoryBatch(key, batch(2, {}), "2.936", IDENTITY), true);

  // Batches 3-4 were dropped by the worker's queue overflow; its budget
  // closing batch seals the segment only by declaring the abandoned run.
  const end = { seq: 40, tick: 40, cycle: 40, reason: "budget" as const };
  assert.equal(await appendHistoryBatch(key, batch(5, { end }), "2.936", IDENTITY), false);
  assert.equal(
    await appendHistoryBatch(key, batch(5, { end, gap: [3, 4] }), "2.936", IDENTITY),
    true,
  );
  const segment = (await loadGameHistory(key))?.segments[0];
  assert.equal(segment?.end?.reason, "budget");

  // An abandoned payload never became durable and must not receive an ACK.
  assert.equal(await appendHistoryBatch(key, batch(3, {}), "2.936", IDENTITY), false);
  assert.equal((await loadGameHistory(key))?.segments[0]?.events.length, 0);

  // A gap declaration is not a blank check: batch 8 was never abandoned.
  assert.equal(await appendHistoryBatch(key, batch(9, { gap: [6, 7] }), "2.936", IDENTITY), false);
});

test("a staged swap leaves the kept branches intact until the adoption commits", async () => {
  const key = "tape-store-staged";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  const first = retainedOn("s-a.1", 1);
  const second = { ...retainedOn("s-a.2", 2), boot: { ...BOOT, rng: 99 } };
  await stageRetainedOriginal(key, first);
  await commitStagedOriginal(key, first.id);
  assert.deepEqual(await loadRetainedBranches(key), [first]);

  // Resume from here again: the departing session stages beside the kept
  // branches — until the worker acknowledges, the branch list is unchanged.
  await stageRetainedOriginal(key, second);
  assert.deepEqual(await loadRetainedBranches(key), [first]);

  // Abandoned (adoption refused): the staged copy clears, nothing changed.
  await clearStagedOriginal(key, second.id);
  assert.deepEqual(await loadRetainedBranches(key), [first]);

  // Committed (adoption acknowledged): the staged session joins the kept
  // branches — the earlier one is preserved, not replaced.
  await stageRetainedOriginal(key, second);
  await commitStagedOriginal(key, second.id);
  assert.deepEqual(await loadRetainedBranches(key), [first, second]);
});

test("a staged copy is the recovery route when no branch exists yet", async () => {
  const key = "tape-store-staged-only";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  // The swap's ack was lost after the worker adopted — the staged departing
  // session is the only copy. It waits in the pending lane, not the branch
  // list, until the tape proves the adoption ran.
  const staged = retainedOn("s-a.1", 3);
  await stageRetainedOriginal(key, staged);
  assert.deepEqual(await loadRetainedBranches(key), []);
  assert.equal((await loadTapeOutline(key))?.pending, 1);

  // The departing segment's "resume" end commits — the adoption is proven
  // and the candidate settles into the branch list on its own.
  assert.equal(
    await appendHistoryBatch(
      key,
      batch(2, { end: { seq: 4, tick: 9, cycle: 9, reason: "resume" } }),
      "2.936",
      IDENTITY,
    ),
    true,
  );
  assert.equal(await resolveStagedSwap(key, await loadGameHistory(key)), "settled");
  assert.deepEqual(await loadRetainedBranches(key), [staged]);
  assert.equal((await loadTapeOutline(key))?.pending, 0);
});

test("the staged lane's overflow joins the branches — a new swap never overwrites a pending one", async () => {
  const key = "tape-store-staged-overflow";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  const staged = Array.from({ length: HISTORY_STAGED_MAX + 2 }, (_, i) =>
    retainedOn("s-a.1", i + 1),
  );
  for (const s of staged) await stageRetainedOriginal(key, s);
  // Past the bound the oldest candidates promote — every departing session
  // stays a valid restore point and the pending lane stays free.
  const branches = await loadRetainedBranches(key);
  assert.equal(branches.length, 2);
  assert.deepEqual(
    branches.map((b) => b.id),
    [staged[0]!.id, staged[1]!.id],
  );
  assert.equal((await loadTapeOutline(key))?.pending, HISTORY_STAGED_MAX);
});

test("the departing segment's resume end settles its staged swap as adopted", async () => {
  const key = "tape-store-resolve-resume";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  const staged = retainedOn("s-a.1", 4);
  await stageRetainedOriginal(key, staged);
  // The adoption ran; its "resume" end committed but the promotion write
  // did not. The tape alone settles the candidate into the branch list.
  assert.equal(
    await appendHistoryBatch(
      key,
      batch(2, { end: { seq: 4, tick: 9, cycle: 9, reason: "resume" } }),
      "2.936",
      IDENTITY,
    ),
    true,
  );
  const recording = await loadGameHistory(key);
  assert.equal(await resolveStagedSwap(key, recording), "settled");
  assert.deepEqual(await loadRetainedBranches(key), [staged]);
});

test("a natural end settles the staged swap as never adopted", async () => {
  const key = "tape-store-resolve-quit";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  await stageRetainedOriginal(key, retainedOn("s-a.1", 4));
  // The departing session was quit while a staged swap was still pending —
  // the snapshot is redundant and clears.
  assert.equal(
    await appendHistoryBatch(
      key,
      batch(2, { end: { seq: 4, tick: 9, cycle: 9, reason: "quit" } }),
      "2.936",
      IDENTITY,
    ),
    true,
  );
  const recording = await loadGameHistory(key);
  assert.equal(await resolveStagedSwap(key, recording), "settled");
  assert.deepEqual(await loadRetainedBranches(key), []);
  assert.equal((await loadTapeOutline(key))?.pending, 0);
});

test("an open departing segment stays ambiguous until the worker's word settles it", async () => {
  const key = "tape-store-resolve-open";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  const staged = retainedOn("s-a.1", 4);
  await stageRetainedOriginal(key, staged);
  const recording = await loadGameHistory(key);
  // The segment is still open: the "resume" end may simply be the write
  // that failed — the tape alone cannot call it either way.
  assert.equal(await resolveStagedSwap(key, recording), "ambiguous");
  assert.equal((await loadTapeOutline(key))?.pending, 1, "the copy stays preserved");

  // The worker still live on that segment proves the swap never ran.
  assert.equal(await resolveStagedSwap(key, recording, "s-a.1"), "settled");
  assert.deepEqual(await loadRetainedBranches(key), []);

  // Staged again, and this time the worker reports a different live
  // segment — the adoption happened, the promotion is owed.
  await stageRetainedOriginal(key, staged);
  assert.equal(await resolveStagedSwap(key, recording, "s-a.2"), "settled");
  assert.deepEqual(await loadRetainedBranches(key), [staged]);
});

test("the branch list is bounded — the oldest kept session sheds past the cap", async () => {
  const key = "tape-store-branches-bound";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  const kept = Array.from({ length: HISTORY_BRANCHES_MAX + 3 }, (_, i) =>
    retainedOn("s-a.1", i + 1),
  );
  for (const b of kept) {
    await stageRetainedOriginal(key, b);
    await commitStagedOriginal(key, b.id);
  }
  const branches = await loadRetainedBranches(key);
  assert.equal(branches.length, HISTORY_BRANCHES_MAX);
  assert.equal(branches[0]!.id, kept[3]!.id, "the three oldest shed");
  assert.equal(branches.at(-1)!.id, kept.at(-1)!.id);
});

test("a branch restored by Undo rewind leaves the list", async () => {
  const key = "tape-store-branch-drop";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  const kept = retainedOn("s-a.1", 1);
  await stageRetainedOriginal(key, kept);
  await commitStagedOriginal(key, kept.id);
  const departing = retainedOn("s-a.2", 2);
  await stageRetainedOriginal(key, departing);
  // The restore's commit names the adopted branch — it leaves the list and
  // the newly departing session takes a slot of its own.
  await commitStagedOriginal(key, departing.id, kept.id);
  assert.deepEqual(
    (await loadRetainedBranches(key)).map((b) => b.id),
    [departing.id],
  );
});

test("an unsettled staged candidate travels the backup and reimports unsettled", async () => {
  const key = "tape-store-staged-export";
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  // A departing session staged for a swap the worker never settled — the
  // only copy of that session. A backup that drops it loses the recovery
  // route outright.
  const staged = retainedOn("s-a.1", 6);
  await stageRetainedOriginal(key, staged);
  assert.deepEqual(await loadRetainedBranches(key), [], "unsettled: no branch yet");

  const exported = await loadProjectHistory(key);
  assert.deepEqual(exported?.staged, [staged], "the staged candidate joins the archive");

  // Re-imported under a fresh key it stays unsettled — the new browser
  // cannot pretend the swap committed, so it waits for the settle pass.
  const importedKey = "tape-store-staged-imported";
  assert.equal(await importGameHistory(importedKey, exported!, IDENTITY), true);
  assert.deepEqual(await loadRetainedBranches(importedKey), [], "not promoted by import");
  assert.equal((await loadTapeOutline(importedKey))?.pending, 1, "still queued for settling");
  assert.deepEqual((await loadProjectHistory(importedKey))?.staged, [staged]);
});

test("an imported project's tape persists whole — recording, kept session, bookmarks", async () => {
  const key = "tape-store-imported";
  const recording = {
    version: HISTORY_FORMAT_VERSION,
    identity: IDENTITY,
    profile: "2.936" as const,
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
  assert.equal(
    await importGameHistory(key, { recording, branches: [retained], bookmarks }, IDENTITY),
    true,
  );

  // The tape opens under the imported project's key, siblings intact.
  const loaded = await loadProjectHistory(key);
  assert.deepEqual(loaded?.recording, recording);
  assert.deepEqual(loaded?.branches, [retained]);
  assert.deepEqual(loaded?.bookmarks, bookmarks);
  assert.deepEqual(await loadRetainedBranches(key), [retained]);

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
      IDENTITY,
    ),
    true,
  );
  const after = await loadGameHistory(key);
  assert.equal(after?.segments.length, 2);
  assert.deepEqual(await loadRetainedBranches(key), [retained], "the kept session survived");
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
        IDENTITY,
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
    await appendHistoryBatch(key, { ...batch(1), segment: "s-o.0", boot: BOOT }, "2.936", IDENTITY),
    true,
  );
  const end = { seq: 0, tick: 0, cycle: 0, reason: "quit" as const };
  for (let seg = 1; seg <= 70; seg++) {
    assert.equal(
      await appendHistoryBatch(
        key,
        { ...batch(1), segment: `s-o.${seg}`, boot: BOOT, end },
        "2.936",
        IDENTITY,
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

  // A late batch for an evicted segment remains unacknowledged: the host
  // must retain it for recovery rather than claim it became durable.
  assert.equal(
    await appendHistoryBatch(key, { ...batch(2), segment: "s-o.1" }, "2.936", IDENTITY),
    false,
  );
  assert.equal(
    (await loadGameHistory(key))?.segments.find((s) => s.id === "s-o.1"),
    undefined,
    "the evicted segment stays absent",
  );
});

test("retention never evicts another live writer or acknowledges its discarded events", async () => {
  const key = "tape-store-all-open";
  for (let seg = 1; seg <= 66; seg++) {
    assert.equal(
      await appendHistoryBatch(
        key,
        { ...batch(1), segment: `s-p.${seg}`, boot: BOOT },
        "2.936",
        IDENTITY,
      ),
      true,
    );
  }
  const event = { seq: 0, tick: 1, cycle: 1, cause: { kind: "key" as const, code: 65 } };
  assert.equal(
    await appendHistoryBatch(
      key,
      {
        ...batch(2),
        segment: "s-p.1",
        events: [event],
      },
      "2.936",
      IDENTITY,
    ),
    true,
  );
  const recording = await loadGameHistory(key);
  assert.equal(recording?.segments.length, 66);
  assert.deepEqual(recording?.segments[0]?.events, [event]);
  assert.equal(RECORDS.has(`history/${key}/s/s-p.1/00000002`), true);
});

test("a mid-session key change carries the live tape to the new record", async () => {
  const from = "tape-migrate-from";
  const to = "tape-migrate-to";
  assert.equal(
    await appendHistoryBatch(from, { ...batch(1), segment: "sM.1", boot: BOOT }, "2.936", IDENTITY),
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
      IDENTITY,
    ),
    true,
  );

  await moveHistoryRecord(from, to);

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
      IDENTITY,
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
  await moveHistoryRecord("tape-migrate-none", "tape-migrate-none-2");
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
        IDENTITY,
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
    mergeHistoryBatch(key, { ...batch(1), segment: "s-t.a", boot: BOOT }, "2.936", IDENTITY),
    mergeHistoryBatch(
      key,
      { ...batch(1), segment: "s-t.b", boot: { ...BOOT, rng: 42 } },
      "2.936",
      IDENTITY,
    ),
  ]);
  assert.equal(a, true);
  assert.equal(b, true);
  const recording = await loadGameHistory("tape-store-twotab");
  assert.deepEqual(recording?.segments.map((s) => s.id).sort(), ["s-t.a", "s-t.b"]);
});

test("commits write one immutable batch record; the manifest alone carries progress", async () => {
  const key = "tape-store-append";
  const before = new Set(RECORDS.keys());
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  const afterBoot = [...RECORDS.keys()].filter((k) => !before.has(k));
  // The boot commit wrote the manifest, the batch record and the files blob —
  // three records, no whole-tape document.
  assert.deepEqual(afterBoot.sort(), [
    `history/${key}`,
    `history/${key}/blob/${
      Object.keys((RECORDS.get(`history/${key}`) as { blobs: Record<string, string[]> }).blobs)[0]
    }`,
    `history/${key}/s/s-a.1/00000001`,
  ]);
  assert.equal(
    await appendHistoryBatch(
      key,
      batch(2, {
        events: [{ seq: 0, tick: 1, cycle: 1, cause: { kind: "key", code: 65 } }],
      }),
      "2.936",
      IDENTITY,
    ),
    true,
  );
  // A steady-state commit adds exactly the batch record — the manifest put
  // rewrites the same key, the tape's other records are untouched.
  const batch2 = RECORDS.get(`history/${key}/s/s-a.1/00000002`) as { segment: string };
  assert.equal(batch2.segment, "s-a.1");
  assert.equal(RECORDS.has(`history/${key}/s/s-a.1/00000001`), true);
});

test("the manifest outline carries extents and marks — the live timeline needs no tape load", async () => {
  const key = "tape-store-outline";
  const mark = (seq: number, tick: number, room: number) => ({
    seq,
    tick,
    cycle: tick,
    room,
    via: "edge",
  });
  const ev = (seq: number, tick: number) => ({
    seq,
    tick,
    cycle: tick,
    cause: { kind: "key" as const, code: 65 },
  });
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  assert.equal(
    await appendHistoryBatch(
      key,
      batch(2, { events: [ev(0, 3)], marks: [mark(0, 3, 2)] }),
      "2.936",
      IDENTITY,
    ),
    true,
  );
  assert.equal(
    await appendHistoryBatch(
      key,
      {
        ...batch(1),
        segment: "s-a.2",
        boot: BOOT,
        end: { seq: 0, tick: 7, cycle: 7, reason: "quit" },
      },
      "2.936",
      IDENTITY,
    ),
    true,
  );

  const outline = await loadTapeOutline(key);
  assert.ok(outline !== null);
  assert.deepEqual(
    outline.segments.map((s) => [s.id, s.extent]),
    [
      ["s-a.1", 3],
      ["s-a.2", 7],
    ],
  );
  assert.deepEqual(
    outline.segments[0]?.marks.map((m) => [m.tick, m.room]),
    [[3, 2]],
  );
  assert.equal(outline.branches, 0);
  assert.equal(outline.pending, 0);
});

test("segments replaying the same bytes share one file blob", async () => {
  const key = "tape-store-blobs";
  const blobKeys = () =>
    [...RECORDS.keys()].filter((k) => String(k).startsWith(`history/${key}/blob/`));
  // 66 segments booting the same file set: retention drops the oldest two,
  // but every kept boot still shares the one blob.
  const end = { seq: 0, tick: 0, cycle: 0, reason: "quit" as const };
  for (let seg = 1; seg <= 66; seg++) {
    assert.equal(
      await appendHistoryBatch(
        key,
        { ...batch(1), segment: `s-d.${seg}`, boot: BOOT, ...(seg < 66 ? { end } : {}) },
        "2.936",
        IDENTITY,
      ),
      true,
    );
  }
  assert.equal(blobKeys().length, 1, "64 kept boots dedup to one blob");
  const manifest = RECORDS.get(`history/${key}`) as { blobs: Record<string, string[]> };
  assert.equal(Object.values(manifest.blobs)[0]?.length, 64);

  // A changed file set gets its own blob; the shared one stays.
  const other = { ...BOOT, files: { "VOL.0": "eB==", LOGDIR: "eGM=" } };
  assert.equal(
    await appendHistoryBatch(
      key,
      { ...batch(1), segment: "s-d.67", boot: other },
      "2.936",
      IDENTITY,
    ),
    true,
  );
  assert.equal(blobKeys().length, 2, "the changed set adds one blob");
});

test("eviction deletes an evicted segment's batch records and its private blob", async () => {
  const key = "tape-store-gc";
  const end = { seq: 0, tick: 0, cycle: 0, reason: "quit" as const };
  // 65 segments: the 65th commit evicts the oldest.
  for (let seg = 1; seg <= 65; seg++) {
    const boot = { ...BOOT, files: { "VOL.0": `e${seg}==` } };
    assert.equal(
      await appendHistoryBatch(
        key,
        { ...batch(1), segment: `s-g.${seg}`, boot, ...(seg < 65 ? { end } : {}) },
        "2.936",
        IDENTITY,
      ),
      true,
    );
  }
  // s-g.1 evicted: its batch record and its unshared blob are gone.
  assert.equal(RECORDS.has(`history/${key}/s/s-g.1/00000001`), false);
  const manifest = RECORDS.get(`history/${key}`) as { blobs: Record<string, string[]> };
  assert.equal(Object.keys(manifest.blobs).length, 64);
  const blobRecords = [...RECORDS.keys()].filter((k) =>
    String(k).startsWith(`history/${key}/blob/`),
  );
  assert.equal(blobRecords.length, 64);
  const recording = await loadGameHistory(key);
  assert.equal(recording?.segments.length, 64);
  assert.equal(recording?.segments[0]?.id, "s-g.2");
  // Reassembled tape still replays: a kept segment's boot carries its files.
  assert.equal(recording?.segments[0]?.boot.files["VOL.0"], "e2==");
});

test("history uses v1 and refuses unsupported or obsolete storage without rewriting", async () => {
  assert.equal(HISTORY_FORMAT_VERSION, 1);
  for (const kind of ["envelope", "recording", "singleton", "missing-directory"]) {
    const key = `tape-store-refuse-${kind}`;
    await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY);
    const manifest = RECORDS.get(`history/${key}`) as Record<string, unknown>;
    assert.equal(manifest["version"], 1);
    if (kind === "envelope") manifest["version"] = 2;
    if (kind === "recording") (manifest["recording"] as { version: number }).version = 2;
    if (kind === "singleton") manifest["retained"] = retainedOn("s-a.1");
    if (kind === "missing-directory") delete manifest["segments"];
    const before = JSON.stringify([...RECORDS]);
    await assert.rejects(loadGameHistory(key), /history record/i);
    assert.equal(await appendHistoryBatch(key, batch(2), "2.936", IDENTITY), false);
    assert.equal(JSON.stringify([...RECORDS]), before);
  }
});

test("import refuses an unsupported recording version without replacing stored history", async () => {
  const key = "tape-store-import-version";
  await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY);
  const history = (await loadProjectHistory(key))!;
  history.recording.version = 2;
  const before = JSON.stringify([...RECORDS]);
  assert.equal(await importGameHistory(key, history, IDENTITY), false);
  assert.equal(JSON.stringify([...RECORDS]), before);
});

test("renewed paused writers survive pressure while crashed writers expire", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const key = "tape-store-writer-leases";
  for (let seg = 1; seg <= 66; seg++) {
    await appendHistoryBatch(
      key,
      { ...batch(1), segment: `writer-${seg}`, boot: BOOT },
      "2.936",
      IDENTITY,
    );
  }
  t.mock.timers.tick(HISTORY_WRITER_LEASE_MS - 1);
  assert.equal(await renewHistoryWriter(key, "writer-1"), true);
  t.mock.timers.tick(2);
  assert.equal(
    await appendHistoryBatch(
      key,
      {
        ...batch(1),
        segment: "new-writer",
        boot: BOOT,
      },
      "2.936",
      IDENTITY,
    ),
    true,
  );
  const recording = await loadGameHistory(key);
  assert.equal(recording?.segments.length, 64);
  assert.equal(recording?.dropped, 3);
  assert.equal(recording?.segments[0]?.id, "writer-1");
  assert.equal(recording?.segments.at(-1)?.id, "new-writer");
  assert.equal(await renewHistoryWriter(key, "writer-2"), false);
  assert.equal(
    await appendHistoryBatch(key, { ...batch(2), segment: "writer-2" }, "2.936", IDENTITY),
    false,
  );
  assert.equal(RECORDS.has(`history/${key}/s/writer-2/00000002`), false);
});

test("evicted final-batch resends deduplicate without acknowledging uncommitted batches", async () => {
  const key = "tape-store-evicted-ack";
  const end = { seq: 0, tick: 0, cycle: 0, reason: "budget" as const };
  await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY);
  const final = batch(3, { end, gap: [2] });
  assert.equal(await appendHistoryBatch(key, final, "2.936", IDENTITY), true);
  for (let seg = 1; seg <= 64; seg++) {
    await appendHistoryBatch(
      key,
      { ...batch(1), segment: `later-${seg}`, boot: BOOT, end },
      "2.936",
      IDENTITY,
    );
  }
  assert.equal(RECORDS.has(`history/${key}/s/s-a.1/00000003`), false);
  assert.equal(
    await appendHistoryBatch(key, final, "2.936", IDENTITY),
    true,
    "retry after lost ACK",
  );
  assert.equal(await appendHistoryBatch(key, batch(4), "2.936", IDENTITY), false, "never stored");
  assert.equal(
    await appendHistoryBatch(key, batch(2), "2.936", IDENTITY),
    false,
    "abandoned gap was never stored",
  );
  assert.equal(await appendHistoryBatch(key, batch(1, { boot: BOOT }), "2.936", IDENTITY), true);
  assert.equal(
    (await loadGameHistory(key))?.segments.some((s) => s.id === "s-a.1"),
    false,
    "boot resend cannot resurrect a retained-away segment",
  );
});
