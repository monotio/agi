/**
 * The stored tape's nested recording version under the format bump: this
 * build writes version 3 (which adds admitted project images) while still
 * reading and extending a released version-1 tape in place — never forking
 * it into an "older timeline" it is not. The upgrade is the first committed
 * append's business and lands in that commit's transaction; reads,
 * bookmarks, retained branches and dedup resends keep the tape at v1, and a
 * refused or failed commit upgrades nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HISTORY_FORMAT_VERSION,
  stampBoot,
  type HistoryBatch,
  type HistoryBoot,
} from "../../src/agent/history.ts";
import {
  appendHistoryBatch,
  commitStagedOriginal,
  importGameHistory,
  loadGameHistory,
  loadHistoryBookmarks,
  loadProjectHistory,
  loadRetainedBranches,
  moveHistoryRecord,
  readOldTimeline,
  renewHistoryWriter,
  saveHistoryBookmark,
  stageRetainedOriginal,
  startNewTimeline,
  UnextendableHistoryError,
  type RetainedOriginal,
} from "../src/history/historyStorage.ts";
import { historyArchiveData, readHistoryArchive } from "../src/archive/historyArchive.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import {
  installedProgressTarget,
  type InstalledProgressTarget,
} from "../src/project/progressTarget.ts";
import { testRevision } from "./identity.ts";

const RECORDS = installIndexedDbFixture();

/** Identity carried by read-only archive fixtures. */
const IDENTITY = installedProgressTarget(
  { folder: "format-store" },
  testRevision("tape"),
)!.identity;

/** The lifetime an installed target's boot captured — no receipt was ever written. */
const INSTALLED_EPOCH = "initial";

/** An installed tape's progress target from its folder name. */
function installedTarget(folder: string): InstalledProgressTarget {
  const target = installedProgressTarget({ folder }, testRevision("tape"));
  assert.ok(target !== null);
  return target;
}

const BOOT: HistoryBoot = stampBoot({
  files: { "VOL.0": "eA==" },
  dictionary: [],
  authorRooms: false,
  rng: 7,
  soundDevice: 1,
  resourceSet: "rev-1",
  requestSerial: 0,
});

function batch(n: number, extra: Partial<HistoryBatch> = {}): HistoryBatch {
  return {
    segment: "s.1",
    batch: n,
    seqStart: n - 1,
    seqEnd: n,
    events: [],
    marks: [],
    sync: [],
    ...extra,
  };
}

interface StoredManifest {
  recording: { version: number };
  committed: Record<string, number[]>;
  bytes: Record<string, number>;
  blobs: Record<string, string[]>;
}

function manifestOf(key: string): StoredManifest {
  const manifest = RECORDS.get(`history/${key}`) as StoredManifest | undefined;
  assert.ok(manifest !== undefined, `no manifest stored at history/${key}`);
  return manifest;
}

/**
 * Rewind a committed tape's version stamp to the released contract — the
 * stored layout a 1.0 write left is identical apart from this number.
 */
function stampVersion(key: string, version: number): void {
  manifestOf(key).recording.version = version;
}

const DEBUG_END = { seq: 9, tick: 9, cycle: 9, reason: "debugger" as const };

test("a stored v1 tape loads and re-exports under its own version, untouched", async () => {
  const target = installedTarget("fmt-v1-read");
  const key = target.locator;
  assert.equal(
    await appendHistoryBatch(target, batch(1, { boot: BOOT }), "2.936", INSTALLED_EPOCH),
    true,
  );
  assert.equal(
    await appendHistoryBatch(
      target,
      batch(2, {
        events: [{ seq: 0, tick: 2, cycle: 2, cause: { kind: "key", code: 65 } }],
        end: { seq: 1, tick: 2, cycle: 2, reason: "quit" },
      }),
      "2.936",
      INSTALLED_EPOCH,
    ),
    true,
  );
  stampVersion(key, 1);
  const before = JSON.stringify([...RECORDS]);

  const loaded = await loadGameHistory(key);
  assert.equal(loaded?.version, 1);
  assert.equal(loaded?.segments[0]?.end?.reason, "quit");
  assert.equal(loaded?.segments[0]?.events.length, 1);

  // The export path keeps the stamp — an untouched v1 tape stays a v1 record.
  const exported = await loadProjectHistory(key);
  assert.equal(exported?.recording.version, 1);
  const archived = JSON.parse(historyArchiveData(exported!)) as {
    version: number;
    recording: { version: number };
  };
  assert.equal(archived.version, 1, "the wrapper is unchanged");
  assert.equal(archived.recording.version, 1, "the recording keeps its own version");

  // A supported tape is not an old timeline: nothing forks, nothing reads back raw.
  assert.equal(await readOldTimeline(key), null);
  await startNewTimeline(target, "2.936", INSTALLED_EPOCH);
  assert.equal(RECORDS.has(`history/${key}/next`), false, "no next timeline was needed");

  // Not one read or side write rewrote a byte.
  assert.equal(JSON.stringify([...RECORDS]), before);
});

test("bookmarks, writer renewals and retained branches never migrate the tape's version", async () => {
  const target = installedTarget("fmt-v1-side");
  const key = target.locator;
  assert.equal(
    await appendHistoryBatch(target, batch(1, { boot: BOOT }), "2.936", INSTALLED_EPOCH),
    true,
  );
  stampVersion(key, 1);

  await saveHistoryBookmark(
    target,
    { segment: "s.1", seq: 0, tick: 0, label: "Pin", at: 1 },
    INSTALLED_EPOCH,
  );
  assert.equal(await renewHistoryWriter(target, "s.1", INSTALLED_EPOCH), true);
  const staged: RetainedOriginal = {
    id: "b-1",
    boot: BOOT,
    from: { segment: "s.1", seq: 0, tick: 0 },
    retainedAt: 1,
  };
  await stageRetainedOriginal(target, staged, INSTALLED_EPOCH);
  await commitStagedOriginal(target, staged.id, undefined, INSTALLED_EPOCH);

  assert.equal(manifestOf(key).recording.version, 1, "side writes leave the version alone");
  assert.deepEqual(
    (await loadHistoryBookmarks(key)).map((b) => b.label),
    ["Pin"],
  );
  assert.deepEqual(
    (await loadRetainedBranches(key)).map((b) => b.id),
    ["b-1"],
  );
});

test("the first committed append upgrades a stored v1 tape atomically with its batch", async () => {
  const target = installedTarget("fmt-v1-append");
  const key = target.locator;
  assert.equal(
    await appendHistoryBatch(target, batch(1, { boot: BOOT }), "2.936", INSTALLED_EPOCH),
    true,
  );
  assert.equal(
    await appendHistoryBatch(
      target,
      batch(2, { events: [{ seq: 0, tick: 1, cycle: 1, cause: { kind: "key", code: 65 } }] }),
      "2.936",
      INSTALLED_EPOCH,
    ),
    true,
  );
  const retained: RetainedOriginal = {
    id: "b-1",
    boot: BOOT,
    from: { segment: "s.1", seq: 0, tick: 1 },
    retainedAt: 1,
  };
  await stageRetainedOriginal(target, retained, INSTALLED_EPOCH);
  await commitStagedOriginal(target, retained.id, undefined, INSTALLED_EPOCH);
  await saveHistoryBookmark(
    target,
    { segment: "s.1", seq: 0, tick: 1, label: "Here", at: 2 },
    INSTALLED_EPOCH,
  );
  stampVersion(key, 1);
  const blobKeys = [...RECORDS.keys()].filter((k) => String(k).startsWith(`history/${key}/blob/`));

  // One commit lands a batch carrying v2-only data: the same transaction
  // flips the recording header, so no reader ever sees v2 content under a
  // v1 stamp.
  assert.equal(
    await appendHistoryBatch(
      target,
      batch(3, {
        events: [{ seq: 1, tick: 2, cycle: 2, cause: { kind: "key", code: 66 } }],
        end: DEBUG_END,
      }),
      "2.936",
      INSTALLED_EPOCH,
    ),
    true,
  );
  assert.equal(manifestOf(key).recording.version, HISTORY_FORMAT_VERSION);

  const tape = await loadGameHistory(key);
  assert.equal(tape?.version, HISTORY_FORMAT_VERSION);
  assert.equal(tape?.segments[0]?.end?.reason, "debugger");
  assert.deepEqual(
    tape?.segments[0]?.events.map((e) => e.seq),
    [0, 1],
    "the v1-era events survived",
  );
  // Ledger, bytes, blobs, branches, staged promotion and bookmarks carried.
  assert.deepEqual(manifestOf(key).committed["s.1"], [1, 2, 3]);
  assert.ok(manifestOf(key).bytes["s.1"]! > 0);
  assert.deepEqual(
    [...RECORDS.keys()].filter((k) => String(k).startsWith(`history/${key}/blob/`)),
    blobKeys,
  );
  assert.deepEqual(
    (await loadRetainedBranches(key)).map((b) => b.id),
    ["b-1"],
  );
  assert.deepEqual(
    (await loadHistoryBookmarks(key)).map((b) => b.label),
    ["Here"],
  );
});

test("a refused commit and a resend ACK leave a v1 tape at v1", async () => {
  const target = installedTarget("fmt-v1-refused");
  const key = target.locator;
  assert.equal(
    await appendHistoryBatch(target, batch(1, { boot: BOOT }), "2.936", INSTALLED_EPOCH),
    true,
  );
  stampVersion(key, 1);
  const before = JSON.stringify([...RECORDS]);

  // Ordering refusal: batch 2 was never sent, so batch 3 — even carrying a
  // v2-only end — must wait, and the stamp must not move.
  assert.equal(
    await appendHistoryBatch(target, batch(3, { end: DEBUG_END }), "2.936", INSTALLED_EPOCH),
    false,
  );
  assert.equal(manifestOf(key).recording.version, 1);
  assert.equal(RECORDS.has(`history/${key}/s/s.1/00000003`), false);

  // A dedup resend of the committed batch acks without writing at all.
  assert.equal(
    await appendHistoryBatch(target, batch(1, { boot: BOOT }), "2.936", INSTALLED_EPOCH),
    true,
  );
  assert.equal(JSON.stringify([...RECORDS]), before, "no write landed");
});

test("a mid-commit failure rolls back the batch and the upgrade together", async (t) => {
  const target = installedTarget("fmt-v1-rollback");
  const key = target.locator;
  assert.equal(
    await appendHistoryBatch(target, batch(1, { boot: BOOT }), "2.936", INSTALLED_EPOCH),
    true,
  );
  stampVersion(key, 1);

  // The manifest put dies after the batch record was staged: the whole
  // transaction aborts, so neither the record nor the new version lands.
  const manifestKey = `history/${key}`;
  const real = RECORDS.set.bind(RECORDS);
  const failing = t.mock.method(RECORDS, "set", (k: IDBValidKey, v: unknown) => {
    if (k === manifestKey) throw new Error("disk full mid-commit");
    return real(k, v);
  });
  assert.equal(
    await appendHistoryBatch(target, batch(2, { end: DEBUG_END }), "2.936", INSTALLED_EPOCH),
    false,
  );
  failing.mock.restore();

  assert.equal(manifestOf(key).recording.version, 1, "the failed commit upgraded nothing");
  assert.equal(RECORDS.has(`${manifestKey}/s/s.1/00000002`), false, "no orphan batch");
  assert.equal((await loadGameHistory(key))?.version, 1, "the tape still reads as v1");

  // The resend commits the pair atomically this time.
  assert.equal(
    await appendHistoryBatch(target, batch(2, { end: DEBUG_END }), "2.936", INSTALLED_EPOCH),
    true,
  );
  assert.equal(manifestOf(key).recording.version, HISTORY_FORMAT_VERSION);
  const tape = await loadGameHistory(key);
  assert.equal(tape?.version, HISTORY_FORMAT_VERSION);
  assert.equal(tape?.segments[0]?.end?.reason, "debugger");
});

test("a v1 import lands supported — no fork, and the first live append upgrades it", async () => {
  const target = installedTarget("fmt-v1-import");
  const key = target.locator;
  const history = {
    recording: {
      version: 1,
      identity: IDENTITY,
      profile: "2.936" as const,
      resourceSet: "rev-1",
      startedAt: 1_757_000_000_000,
      segments: [
        {
          id: "imp.s1",
          boot: BOOT,
          anchors: [],
          events: [{ seq: 0, tick: 1, cycle: 1, cause: { kind: "key" as const, code: 65 } }],
          marks: [],
          sync: [],
          end: { seq: 1, tick: 1, cycle: 1, reason: "quit" as const },
        },
      ],
    },
  };
  assert.equal(await importGameHistory(target, history, INSTALLED_EPOCH), true);
  assert.equal((await loadGameHistory(key))?.version, 1, "the imported tape keeps v1");
  assert.equal(RECORDS.has(`history/${key}/next`), false, "not classified as an old tape");

  assert.equal(
    await appendHistoryBatch(
      target,
      {
        segment: "live.s1",
        batch: 1,
        seqStart: 0,
        seqEnd: 0,
        events: [],
        marks: [],
        sync: [],
        boot: stampBoot({ ...BOOT, resumedFrom: { segment: "imp.s1", seq: 1, tick: 1 } }),
      },
      "2.936",
      INSTALLED_EPOCH,
    ),
    true,
  );
  assert.equal(manifestOf(key).recording.version, HISTORY_FORMAT_VERSION);
  const tape = await loadGameHistory(key);
  assert.equal(tape?.version, HISTORY_FORMAT_VERSION);
  assert.deepEqual(
    tape?.segments.map((s) => s.id),
    ["imp.s1", "live.s1"],
    "the imported segment kept its place",
  );
});

test("a v1 import of an unsettled staged candidate stays staged through the upgrade", async () => {
  const target = installedTarget("fmt-v1-import-staged");
  const key = target.locator;
  const staged: RetainedOriginal = {
    id: "b-imp",
    boot: BOOT,
    from: { segment: "imp.s1", seq: 1, tick: 1 },
    retainedAt: 5,
  };
  const history = {
    recording: {
      version: 1,
      identity: IDENTITY,
      profile: "2.936" as const,
      resourceSet: "rev-1",
      startedAt: 1_757_000_000_000,
      segments: [{ id: "imp.s1", boot: BOOT, anchors: [], events: [], marks: [], sync: [] }],
    },
    staged: [staged],
  };
  assert.equal(await importGameHistory(target, history, INSTALLED_EPOCH), true);
  assert.equal(manifestOf(key).recording.version, 1);

  // The first append upgrades; the unsettled candidate is still queued.
  assert.equal(
    await appendHistoryBatch(target, batch(2, { events: [] }), "2.936", INSTALLED_EPOCH),
    false,
    "batch 2 without an open segment for s.1 is refused — the imported segment id differs",
  );
  assert.equal(
    await appendHistoryBatch(
      target,
      { ...batch(1), segment: "live.s1", boot: BOOT },
      "2.936",
      INSTALLED_EPOCH,
    ),
    true,
  );
  assert.equal(manifestOf(key).recording.version, HISTORY_FORMAT_VERSION);
  const exported = await loadProjectHistory(key);
  assert.deepEqual(
    exported?.staged?.map((s) => s.id),
    ["b-imp"],
    "the staged candidate survived the upgrade",
  );
});

test("a nested version this build does not know is refused without rewriting a byte", async () => {
  const target = installedTarget("fmt-version-gate");
  const key = target.locator;
  assert.equal(
    await appendHistoryBatch(target, batch(1, { boot: BOOT }), "2.936", INSTALLED_EPOCH),
    true,
  );
  for (const [version, stored] of [
    [HISTORY_FORMAT_VERSION + 1, "newer"],
    [0, "older"],
    [-1, "older"],
  ] as const) {
    stampVersion(key, version);
    const before = JSON.stringify([...RECORDS]);
    await assert.rejects(
      loadGameHistory(key),
      (error: unknown) => error instanceof UnextendableHistoryError && error.stored === stored,
    );
    await assert.rejects(
      appendHistoryBatch(target, batch(2, { end: DEBUG_END }), "2.936", INSTALLED_EPOCH),
      (error: unknown) => error instanceof UnextendableHistoryError,
    );
    assert.equal(JSON.stringify([...RECORDS]), before, `version ${version} stayed untouched`);
  }
});

test("a stored tape whose stamp claims v1 but holds a v2-only reason fails loudly", async () => {
  const target = installedTarget("fmt-v1-forged");
  const key = target.locator;
  assert.equal(
    await appendHistoryBatch(target, batch(1, { boot: BOOT }), "2.936", INSTALLED_EPOCH),
    true,
  );
  assert.equal(
    await appendHistoryBatch(target, batch(2, { end: DEBUG_END }), "2.936", INSTALLED_EPOCH),
    true,
  );
  stampVersion(key, 1);
  await assert.rejects(loadGameHistory(key), /end reason is invalid/);
});

test("a late resend acked by an eviction receipt writes nothing — no casual upgrade", async () => {
  const target = installedTarget("fmt-v1-evicted-ack");
  const key = target.locator;
  const end = { seq: 0, tick: 0, cycle: 0, reason: "quit" as const };
  assert.equal(
    await appendHistoryBatch(target, batch(1, { boot: BOOT }), "2.936", INSTALLED_EPOCH),
    true,
  );
  assert.equal(await appendHistoryBatch(target, batch(2, { end }), "2.936", INSTALLED_EPOCH), true);
  // Push s.1 past the segment bound; its committed batches become receipts.
  for (let seg = 1; seg <= 65; seg++) {
    assert.equal(
      await appendHistoryBatch(
        target,
        { ...batch(1), segment: `e.${seg}`, boot: BOOT, end },
        "2.936",
        INSTALLED_EPOCH,
      ),
      true,
    );
  }
  stampVersion(key, 1);

  // The receipt acks the resend of a published batch and refuses one that
  // was never published — both without a write, so the stamp stays.
  assert.equal(await appendHistoryBatch(target, batch(2, { end }), "2.936", INSTALLED_EPOCH), true);
  assert.equal(await appendHistoryBatch(target, batch(3, {}), "2.936", INSTALLED_EPOCH), false);
  assert.equal(manifestOf(key).recording.version, 1);
});

test("moving a v1 tape to an empty key preserves its stamp; merging onto one lifts it", async () => {
  const fromTarget = installedTarget("fmt-move-from");
  const toTarget = installedTarget("fmt-move-to");
  const from = fromTarget.locator;
  const to = toTarget.locator;
  assert.equal(
    await appendHistoryBatch(fromTarget, batch(1, { boot: BOOT }), "2.936", INSTALLED_EPOCH),
    true,
  );
  stampVersion(from, 1);
  await moveHistoryRecord(fromTarget, toTarget, INSTALLED_EPOCH);
  assert.equal(manifestOf(to).recording.version, 1, "a re-keyed copy keeps its version");
  assert.equal((await loadGameHistory(to))?.version, 1);

  // The destination already holds a v1 tape; a current source merging in lifts
  // the union's stamp — the merged record must not claim v1 over current data.
  const srcTarget = installedTarget("fmt-move-src");
  assert.equal(
    await appendHistoryBatch(
      srcTarget,
      { ...batch(1), segment: "src.s1", boot: BOOT },
      "2.936",
      INSTALLED_EPOCH,
    ),
    true,
  );
  await moveHistoryRecord(srcTarget, toTarget, INSTALLED_EPOCH);
  assert.equal(manifestOf(to).recording.version, HISTORY_FORMAT_VERSION);
  const tape = await loadGameHistory(to);
  assert.equal(tape?.version, HISTORY_FORMAT_VERSION);
  assert.ok((tape?.segments.length ?? 0) >= 2, "both tapes' segments merged");
});

test("the archive wrapper admits nested versions 1, 2 and 3 and rejects the rest", () => {
  const archive = (version: unknown) =>
    new TextEncoder().encode(
      JSON.stringify({
        format: "monotio.agi.history",
        version: 1,
        recording: {
          version,
          identity: IDENTITY,
          profile: "2.936",
          resourceSet: "rev-1",
          startedAt: 1,
          segments: [],
        },
      }),
    );
  assert.equal(readHistoryArchive(archive(1)).recording.version, 1);
  assert.equal(readHistoryArchive(archive(2)).recording.version, 2);
  assert.equal(readHistoryArchive(archive(3)).recording.version, 3);
  assert.throws(() => readHistoryArchive(archive(4)), /unsupported version/);
  assert.throws(() => readHistoryArchive(archive(0)), /unsupported version/);
  // The wrapper itself is unchanged — a v2 wrapper is still refused.
  assert.throws(
    () =>
      readHistoryArchive(
        new TextEncoder().encode(
          JSON.stringify({ format: "monotio.agi.history", version: 2, recording: {} }),
        ),
      ),
    /not a history record/,
  );
});
