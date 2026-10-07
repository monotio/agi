/**
 * Durable progress recovery at removal: `removeProjectWithProgress` captures
 * every legacy record the project id still owns — the `history/<id>` root and
 * all its descendants, `/next` timelines, unknown future records and orphans,
 * the conversation, the lifetime receipt and the caller's raw localStorage
 * observations — into one immutable `legacy-progress/` record inside the same
 * transaction that deletes them, so a cursor, clone or quota failure keeps
 * every byte in place. A stale explicit target refuses rather than deleting a
 * recreated body, and captures stay readable after the project is gone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { stampBoot, type HistoryBatch, type HistoryBoot } from "../../src/agent/history.ts";
import { appendHistoryBatch, saveHistoryBookmark } from "../src/history/historyStorage.ts";
import {
  clearCachedGame,
  listLegacyProgress,
  listLegacyProgressRows,
  loadLegacyProgressRecord,
  readHistoryLifetime,
  readLegacyProgressRow,
  readLegacySourceSnapshot,
  removeProjectWithProgress,
  saveAuthoredGame,
} from "../src/project/gameStorage.ts";
import {
  newLegacyProgressRecord,
  UnsupportedRecoveryError,
  type RawLocalEntry,
} from "../src/project/legacyProgressRecovery.ts";
import {
  projectProgressTarget,
  type ProjectProgressTarget,
} from "../src/project/progressTarget.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId, testRevision } from "./identity.ts";
import type { ProjectId } from "../../src/gameIdentity.ts";

const RECORDS = installIndexedDbFixture();
const localValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => localValues.set(key, value),
    removeItem: (key: string) => localValues.delete(key),
  },
});

const BOOT: HistoryBoot = stampBoot({
  files: { "VOL.0": "eA==" },
  dictionary: [],
  authorRooms: false,
  rng: 7,
  soundDevice: 1,
  resourceSet: "rev-1",
  requestSerial: 0,
});

const BOOT_BATCH: HistoryBatch = {
  segment: "s.1",
  batch: 1,
  seqStart: 0,
  seqEnd: 0,
  events: [],
  marks: [],
  sync: [],
  boot: BOOT,
};

/** A live saved project plus the progress target its body snapshot proves. */
async function saveGame(
  name: string,
): Promise<{ projectId: ProjectId; target: ProjectProgressTarget }> {
  const projectId = testProjectId(name);
  await saveAuthoredGame(projectId, {
    title: name,
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });
  const target = projectProgressTarget(
    projectId,
    testRevision("tape"),
    await readHistoryLifetime(projectId),
  );
  assert.ok(target !== null);
  return { projectId, target };
}

/** A record value no version of the app understands — captured, never parsed. */
function opaqueRecord(tag: string): Record<string, unknown> {
  return {
    format: "future.record",
    version: 99,
    tag,
    nested: { map: new Map([["k", { deep: true }]]), list: [1, "two"] },
  };
}

const localEntry = (key: string, value: string): RawLocalEntry => ({ key, value });

test("removal captures every legacy record and raw local string before deleting them", async () => {
  const { projectId, target } = await saveGame("capture-all");
  // A live namespaced tape: owned progress, deleted — not captured.
  assert.equal(await appendHistoryBatch(target, BOOT_BATCH, "2.936"), true);
  const namespaced = [...RECORDS.keys()].filter(
    (key) => typeof key === "string" && key.startsWith(`history/${target.locator}`),
  );
  assert.ok(namespaced.length > 0, "the namespaced tape exists");

  // The released unscoped layout, including records no build of this version
  // understands and an orphan child with no root ancestor record.
  const legacyHead = opaqueRecord("head");
  const legacyNext = opaqueRecord("next");
  const legacyBatch = opaqueRecord("batch");
  const legacyOrphan = opaqueRecord("orphan");
  const conversation = opaqueRecord("conversation");
  RECORDS.set(`history/${projectId}`, legacyHead);
  RECORDS.set(`history/${projectId}/next`, legacyNext);
  RECORDS.set(`history/${projectId}/s/old.1/00000001`, legacyBatch);
  RECORDS.set(`history/${projectId}/future/orphan`, legacyOrphan);
  RECORDS.set(`conversation/${projectId}`, conversation);
  const observed: RawLocalEntry[] = [
    localEntry("agi-save.raw-slot", "not-json { with whitespace\n"),
    localEntry("agi-map.legacy", "\u0000binary-ish\t"),
  ];

  const removed = await removeProjectWithProgress(target, observed);
  assert.equal(removed.retiredLocator, target.locator);
  assert.ok(removed.recoveryId !== null);

  // Everything the id owned is gone: body, legacy tape, namespaced tape,
  // conversation — and the lifetime receipt is retired under a new epoch.
  assert.equal(RECORDS.get(projectId), undefined, "the body left");
  for (const key of [
    `history/${projectId}`,
    `history/${projectId}/next`,
    `history/${projectId}/s/old.1/00000001`,
    `history/${projectId}/future/orphan`,
    `conversation/${projectId}`,
    ...namespaced,
  ])
    assert.equal(RECORDS.get(key), undefined, `${String(key)} left`);
  const receipt = RECORDS.get(`lifetime/${projectId}`) as { deleted?: boolean } | undefined;
  assert.equal(receipt?.deleted, true, "the old epoch is retired");

  // The capture is one immutable record holding every value verbatim —
  // structured-clone content preserved, raw strings unparsed.
  const capture = await loadLegacyProgressRecord(removed.recoveryId);
  assert.ok(capture !== null);
  assert.equal(capture.projectId, removed.recoveryId);
  assert.equal(capture.version, 1);
  assert.equal(capture.source, projectId);
  assert.equal(capture.reason, "remove");
  assert.deepEqual(capture.local, observed);
  const captured = new Map(capture.records.map((entry) => [entry.key, entry.value]));
  assert.deepEqual(captured.get(`history/${projectId}`), legacyHead);
  assert.deepEqual(captured.get(`history/${projectId}/next`), legacyNext);
  assert.deepEqual(captured.get(`history/${projectId}/s/old.1/00000001`), legacyBatch);
  assert.deepEqual(captured.get(`history/${projectId}/future/orphan`), legacyOrphan);
  assert.deepEqual(captured.get(`conversation/${projectId}`), conversation);
  const capturedReceipt = captured.get(`lifetime/${projectId}`) as { epoch?: string };
  assert.equal(capturedReceipt?.epoch, target.bodyEpoch, "the live receipt was captured");
  for (const key of namespaced)
    assert.equal(
      captured.has(String(key)),
      false,
      "owned current-format progress is deleted, not preserved as legacy",
    );

  // The capture survives without the body — recovery lookup is contextual.
  const listed = await listLegacyProgress(projectId);
  assert.deepEqual(
    listed.map((record) => record.projectId),
    [removed.recoveryId],
  );
});

test("a stale explicit target refuses: the recreated body and its legacy data survive", async () => {
  const { projectId, target: stale } = await saveGame("stale-selection");
  await clearCachedGame(projectId);
  const { target: fresh } = await saveGame("stale-selection");
  RECORDS.set(`history/${projectId}`, opaqueRecord("legacy"));

  await assert.rejects(removeProjectWithProgress(stale, []), /removed|replaced/);
  assert.ok(RECORDS.get(projectId) !== undefined, "the recreated body survived");
  assert.ok(RECORDS.get(`history/${projectId}`) !== undefined, "nothing was captured or deleted");
  assert.equal(await listLegacyProgress(projectId).then((r) => r.length), 0);

  const removed = await removeProjectWithProgress(fresh, []);
  assert.ok(removed.recoveryId !== null, "the live epoch's removal proceeds");
  assert.equal(RECORDS.get(projectId), undefined);
});

test("removal of an absent body is an idempotent no-op", async () => {
  const projectId = testProjectId("never-existed");
  const before = new Map(RECORDS);
  await clearCachedGame(projectId);
  await clearCachedGame(projectId);
  assert.deepEqual(RECORDS, before, "no receipt, delete or capture is minted for a missing body");
  assert.equal((await listLegacyProgress(projectId)).length, 0);

  // An explicit target always needs a live body at its epoch — there is no
  // absent-body no-op on the production path.
  const target = projectProgressTarget(projectId, testRevision("tape"), "initial");
  assert.ok(target !== null);
  await assert.rejects(removeProjectWithProgress(target, []), /removed/);
});

test("a capture failure aborts the removal — body, tape and receipt all survive", async (t) => {
  const { projectId, target } = await saveGame("quota-fails");
  RECORDS.set(`history/${projectId}`, opaqueRecord("head"));
  RECORDS.set(`history/${projectId}/s/old.1/00000001`, opaqueRecord("batch"));
  RECORDS.set(`conversation/${projectId}`, opaqueRecord("conversation"));

  // The recovery insert lands at commit — the journal's apply dies on it and
  // the transaction restores every staged delete with it.
  const real = RECORDS.set.bind(RECORDS);
  const failing = t.mock.method(RECORDS, "set", (key: IDBValidKey, value: unknown) => {
    if (String(key).startsWith("legacy-progress/")) throw new Error("QuotaExceededError");
    return real(key, value);
  });
  await assert.rejects(removeProjectWithProgress(target, []), /Quota/);
  failing.mock.restore();

  assert.ok(RECORDS.get(projectId) !== undefined, "the body was restored");
  assert.ok(RECORDS.get(`history/${projectId}`) !== undefined, "the tape was restored");
  assert.ok(RECORDS.get(`conversation/${projectId}`) !== undefined, "the conversation survived");
  const receipt = RECORDS.get(`lifetime/${projectId}`) as { epoch?: string; deleted?: boolean };
  assert.equal(receipt?.epoch, target.bodyEpoch, "the live receipt was not retired");
  assert.equal(receipt?.deleted, false);
  assert.equal((await listLegacyProgress(projectId)).length, 0, "no half-written capture");

  // And the same call succeeds once storage accepts writes again.
  const removed = await removeProjectWithProgress(target, []);
  assert.ok(removed.recoveryId !== null);
  assert.equal(RECORDS.get(projectId), undefined);
});

test("a record this store cannot clone aborts capture and removal together", async () => {
  const { projectId, target } = await saveGame("uncloneable");
  RECORDS.set(`history/${projectId}`, opaqueRecord("head"));
  RECORDS.set(`history/${projectId}/opaque`, { notCloneable: () => 1 });

  await assert.rejects(removeProjectWithProgress(target, []));
  assert.ok(RECORDS.get(projectId) !== undefined, "the body stayed");
  assert.ok(RECORDS.get(`history/${projectId}`) !== undefined, "the legacy tape stayed");
  assert.equal((await listLegacyProgress(projectId)).length, 0);
});

test("a cursor failure aborts capture and removal together", async (t) => {
  const { projectId, target } = await saveGame("cursor-fails");
  RECORDS.set(`history/${projectId}/s/old.1/00000001`, opaqueRecord("batch"));

  const failing = t.mock.method(RECORDS, "keys", () => {
    throw new Error("cursor enumeration failed");
  });
  await assert.rejects(removeProjectWithProgress(target, []), /cursor enumeration/);
  failing.mock.restore();

  assert.ok(RECORDS.get(projectId) !== undefined);
  assert.ok(RECORDS.get(`history/${projectId}/s/old.1/00000001`) !== undefined);
});

test("a capture whose version this build does not know is refused, never rewritten", async () => {
  const future = {
    projectId: "legacy-progress/unknown-source/rec-1",
    format: "monotio.agi.legacy-progress",
    version: 2,
    payload: { anything: new Uint8Array([1, 2, 3]) },
  };
  RECORDS.set(future.projectId, future);
  const before = JSON.stringify(RECORDS.get(future.projectId));

  await assert.rejects(listLegacyProgress("unknown-source"), UnsupportedRecoveryError);
  await assert.rejects(loadLegacyProgressRecord(future.projectId), UnsupportedRecoveryError);
  assert.equal(
    JSON.stringify(RECORDS.get(future.projectId)),
    before,
    "an unknown capture is never rewritten",
  );
});

test("ordinary progress writes create no recovery captures", async () => {
  const { target } = await saveGame("no-snapshots");
  assert.equal(await appendHistoryBatch(target, BOOT_BATCH, "2.936"), true);
  await saveHistoryBookmark(target, { segment: "s.1", seq: 0, tick: 0, label: "Pin", at: 1 });
  await saveAuthoredGame(target.project, {
    title: "no-snapshots",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });
  assert.deepEqual(await listLegacyProgress(target.project), []);
});

test("the compatibility removal entrypoint captures the same legacy records", async () => {
  const { projectId } = await saveGame("compat-removal");
  RECORDS.set(`history/${projectId}`, opaqueRecord("head"));
  RECORDS.set(`conversation/${projectId}`, opaqueRecord("conversation"));

  await clearCachedGame(projectId);
  const captures = await listLegacyProgress(projectId);
  assert.equal(captures.length, 1, "compat removal captured before deleting");
  const keys = captures[0]!.records.map((entry) => entry.key).sort();
  assert.deepEqual(keys, [
    `conversation/${projectId}`,
    `history/${projectId}`,
    `lifetime/${projectId}`,
  ]);
  assert.equal(RECORDS.get(projectId), undefined);
});

test("a compatibility clear on an absent body leaves orphaned records untouched", async () => {
  // Orphaned legacy keys beside an already-retired receipt — the state a
  // finished removal or an interrupted writer can leave. With no live body
  // to own them, a compatibility clear changes nothing: no new capture, no
  // deletes, no receipt rotation, no minted deletion UUID.
  const projectId = testProjectId("absent-orphans");
  const receipt = {
    projectId: `lifetime/${projectId}`,
    epoch: "4a4255c3-1111-4222-8333-000000000042",
    deleted: true,
  };
  RECORDS.set(`history/${projectId}`, opaqueRecord("head"));
  RECORDS.set(`history/${projectId}/next`, opaqueRecord("next"));
  RECORDS.set(`history/${projectId}/future/orphan`, opaqueRecord("orphan"));
  RECORDS.set(`conversation/${projectId}`, opaqueRecord("conversation"));
  RECORDS.set(`lifetime/${projectId}`, receipt);
  const before = new Map(RECORDS);

  await clearCachedGame(projectId);
  await clearCachedGame(projectId);

  assert.deepEqual(RECORDS, before, "no capture, delete or receipt rotation");

  // An explicit target on an absent body still refuses.
  const target = projectProgressTarget(projectId, testRevision("tape"), "initial");
  assert.ok(target !== null);
  await assert.rejects(removeProjectWithProgress(target, []), /removed/);
  assert.deepEqual(RECORDS, before, "a refused explicit target writes nothing either");
});

test("a compatibility clear after a real removal mints nothing further", async () => {
  const { projectId } = await saveGame("clear-twice");
  RECORDS.set(`history/${projectId}`, opaqueRecord("head"));
  RECORDS.set(`history/${projectId}/future/orphan`, opaqueRecord("orphan"));

  await clearCachedGame(projectId);
  assert.equal((await listLegacyProgress(projectId)).length, 1);
  const settled = new Map(RECORDS);

  await clearCachedGame(projectId);
  await clearCachedGame(projectId);

  assert.deepEqual(RECORDS, settled, "no second capture and no rotated receipt");
  assert.equal((await listLegacyProgress(projectId)).length, 1);
});

test("capture rows report each row's real state — a future or malformed row hides nothing", async () => {
  const source = testProjectId("capture-rows");
  const known = newLegacyProgressRecord(
    source,
    [localEntry("agi-save.raw", "raw string")],
    [{ key: `history/${source}`, value: opaqueRecord("head") }],
  );
  const future = {
    projectId: `legacy-progress/${source}/future-1`,
    format: "monotio.agi.legacy-progress",
    version: 2,
    payload: { raw: new Uint8Array([9]) },
  };
  const malformed = {
    projectId: `legacy-progress/${source}/broken-1`,
    format: "monotio.agi.legacy-progress",
    version: 1,
    local: "not-an-array",
  };
  const stray = { projectId: `legacy-progress/${source}/stray-1`, note: "not a capture" };
  for (const row of [known, future, malformed, stray]) RECORDS.set(row.projectId, row);

  // The strict decoder listing still refuses the unknown version…
  await assert.rejects(listLegacyProgress(source), UnsupportedRecoveryError);

  // …while the row listing keeps every stored row honestly visible.
  const rows = await listLegacyProgressRows(source);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    new Map(rows.map((row) => [row.key, row.state])),
    new Map([
      [known.projectId, "available"],
      [future.projectId, "unsupported"],
      [malformed.projectId, "unreadable"],
      [stray.projectId, "unreadable"],
    ]),
  );

  const knownRow = await readLegacyProgressRow(known.projectId);
  assert.ok(knownRow.state === "available");
  assert.equal(knownRow.record.source, source);
  const futureRow = await readLegacyProgressRow(future.projectId);
  assert.ok(futureRow.state === "unsupported");
  assert.deepEqual(futureRow.value, future, "the raw envelope is untouched");
  assert.equal((await readLegacyProgressRow(malformed.projectId)).state, "unreadable");
  assert.equal(
    (await readLegacyProgressRow(`legacy-progress/${source}/missing-1`)).state,
    "absent",
    "a missing record is absent, never a refusal",
  );

  // A key outside the capture prefix, or under it without the source/id row
  // shape, is a caller error — never a read of some other record.
  await assert.rejects(readLegacyProgressRow(`history/${source}`), /legacy progress record key/);
  await assert.rejects(
    readLegacyProgressRow(`legacy-progress/${source}`),
    /legacy progress record key/,
  );

  // Rows page instead of scanning every stored capture.
  const page = await listLegacyProgressRows(source, { limit: 2 });
  assert.deepEqual(
    page.map((row) => row.key),
    rows.slice(0, 2).map((row) => row.key),
  );
  const rest = await listLegacyProgressRows(source, { after: page[1]!.key });
  assert.deepEqual(
    rest.map((row) => row.key),
    rows.slice(2).map((row) => row.key),
  );

  // Every read was a read — the stored envelopes are byte-identical.
  assert.deepEqual(RECORDS.get(future.projectId), future);
  assert.deepEqual(RECORDS.get(malformed.projectId), malformed);
  assert.deepEqual(RECORDS.get(stray.projectId), stray);
});

test("a live legacy source snapshot returns the complete unscoped records, read-only", async () => {
  const source = testProjectId("legacy-source");
  const head = opaqueRecord("head");
  const next = opaqueRecord("next");
  const batch = opaqueRecord("batch");
  const unknown = opaqueRecord("unknown");
  const conversation = opaqueRecord("conversation");
  const receipt = {
    projectId: `lifetime/${source}`,
    epoch: "7f311db9-2222-4333-8444-000000000007",
    deleted: true,
  };
  RECORDS.set(`history/${source}`, head);
  RECORDS.set(`history/${source}/next`, next);
  RECORDS.set(`history/${source}/s/old.1/00000001`, batch);
  RECORDS.set(`history/${source}/future/unknown`, unknown);
  RECORDS.set(`conversation/${source}`, conversation);
  RECORDS.set(`lifetime/${source}`, receipt);
  // A near-prefix record belongs to a different source and stays out.
  RECORDS.set(`history/${source}x`, opaqueRecord("foreign"));
  const before = new Map(RECORDS);

  const snapshot = await readLegacySourceSnapshot(source);
  assert.equal(snapshot.source, source);
  const entries = new Map(snapshot.records.map((entry) => [entry.key, entry.value]));
  assert.deepEqual(
    [...entries.keys()],
    [
      `history/${source}`,
      `history/${source}/future/unknown`,
      `history/${source}/next`,
      `history/${source}/s/old.1/00000001`,
      `conversation/${source}`,
      `lifetime/${source}`,
    ],
  );
  assert.deepEqual(entries.get(`history/${source}`), head);
  assert.deepEqual(entries.get(`history/${source}/next`), next);
  assert.deepEqual(entries.get(`history/${source}/s/old.1/00000001`), batch);
  assert.deepEqual(entries.get(`history/${source}/future/unknown`), unknown);
  assert.deepEqual(entries.get(`conversation/${source}`), conversation);
  assert.deepEqual(entries.get(`lifetime/${source}`), receipt);
  assert.deepEqual(RECORDS, before, "the snapshot wrote nothing");

  // An absent source snapshots empty, without needing a body or live epoch.
  const empty = await readLegacySourceSnapshot(testProjectId("no-such-source"));
  assert.deepEqual(empty.records, []);

  // Recognized progress namespaces and empty names are not legacy sources:
  // the current locators and the unreleased folder-only predecessor alike.
  await assert.rejects(readLegacySourceSnapshot(`project:${source}:initial`), /locator/);
  await assert.rejects(readLegacySourceSnapshot(`installed:${"0".repeat(64)}`), /locator/);
  await assert.rejects(
    readLegacySourceSnapshot(`installed:${"0".repeat(64)}:${"1".repeat(64)}`),
    /locator/,
  );
  await assert.rejects(
    readLegacySourceSnapshot(`project:${source}:4a4255c3-1111-4222-8333-000000000042`),
    /locator/,
  );
  await assert.rejects(readLegacySourceSnapshot(""), /source/);

  // Near-match spellings that never matched either grammar stay readable
  // released sources — no broad `installed:`/`project:` prefix prohibition.
  for (const near of [
    "installed:trap",
    `installed:${"0".repeat(63)}`,
    `installed:${"0".repeat(65)}`,
    `installed:${"A".repeat(64)}`,
    `installed:${"z".repeat(64)}`,
    `installed:${"0".repeat(64)}:`,
    `installed:${"0".repeat(64)}:not-a-revision`,
    "project:ordinary-folder",
    `project:${source}:not-an-epoch`,
    "project:custom:",
  ]) {
    const snapshot = await readLegacySourceSnapshot(near);
    assert.equal(snapshot.source, near);
    assert.deepEqual(snapshot.records, [], near);
  }
});

test("a failed record read rejects the snapshot instead of reporting empty", async (t) => {
  const source = testProjectId("snapshot-fails");
  RECORDS.set(`history/${source}`, opaqueRecord("head"));
  const failing = t.mock.method(RECORDS, "get", () => {
    throw new Error("record read failed");
  });
  await assert.rejects(readLegacySourceSnapshot(source), /record read failed/);
  failing.mock.restore();
});
