/**
 * Progress-target ownership: every history mutation names a typed target and
 * proves its authority inside the write transaction — a saved body's presence
 * and captured epoch, or an installed instance's live lifetime receipt. The
 * checks hold when two storage domains share a bare id, when two folders share
 * a resource hash, when a body is removed and recreated under the same id, and
 * when a caller hands a merge the manifest key of somebody else's tape.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { stampBoot, type HistoryBatch, type HistoryBoot } from "../../src/agent/history.ts";
import {
  appendHistoryBatch,
  clearStagedOriginal,
  commitStagedOriginal,
  importGameHistory,
  loadGameHistory,
  mergeHistoryBatch,
  moveHistoryRecord,
  renewHistoryWriter,
  resolveStagedSwap,
  saveHistoryBookmark,
  stageRetainedOriginal,
  startNewTimeline,
  type ProjectHistory,
  type RetainedOriginal,
} from "../src/history/historyStorage.ts";
import {
  clearCachedGame,
  readHistoryLifetime,
  saveAuthoredGame,
} from "../src/project/gameStorage.ts";
import {
  installedProgressTarget,
  projectProgressTarget,
  type InstalledProgressTarget,
  type ProjectProgressTarget,
  type ProgressTarget,
} from "../src/project/progressTarget.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId, testRevision } from "./identity.ts";
import type { ProjectId } from "../../src/gameIdentity.ts";

const RECORDS = installIndexedDbFixture();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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

/** The lifetime an installed boot captured before any receipt existed. */
const INSTALLED_EPOCH = "initial";

function batch(segment: string, n: number): HistoryBatch {
  return {
    segment,
    batch: n,
    seqStart: n - 1,
    seqEnd: n,
    events: [],
    marks: [],
    sync: [],
    ...(n === 1 ? { boot: BOOT } : {}),
  };
}

function retained(id: string): RetainedOriginal {
  return {
    id,
    boot: BOOT,
    from: { segment: "s.1", seq: 0, tick: 0 },
    retainedAt: 1,
  };
}

const BOOKMARK = { segment: "s.1", seq: 0, tick: 0, label: "Here", at: 1 };

function importedTape(target: ProgressTarget): ProjectHistory {
  return {
    recording: {
      version: 1,
      identity: target.identity,
      profile: "2.936",
      resourceSet: "rev-1",
      startedAt: 1_757_000_000_000,
      segments: [{ id: "imp.s1", boot: BOOT, anchors: [], events: [], marks: [], sync: [] }],
    },
  };
}

function installedTarget(folder: string): InstalledProgressTarget {
  const target = installedProgressTarget({ folder }, testRevision("tape"));
  assert.ok(target !== null);
  return target;
}

async function savedTarget(projectId: ProjectId): Promise<ProjectProgressTarget> {
  const target = projectProgressTarget(
    projectId,
    testRevision("tape"),
    await readHistoryLifetime(projectId),
  );
  assert.ok(target !== null);
  return target;
}

async function saveGame(name: string): Promise<{
  projectId: ProjectId;
  target: ProjectProgressTarget;
}> {
  const projectId = testProjectId(name);
  await saveAuthoredGame(projectId, {
    title: name,
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });
  return { projectId, target: await savedTarget(projectId) };
}

/** A record key exists, strings only — the fixture's whole store is key flat. */
const stored = (key: string) => RECORDS.has(key);

test("a project target whose body was never saved cannot open a tape", async () => {
  const projectId = testProjectId("never-saved");
  const target = projectProgressTarget(projectId, testRevision("tape"), "initial");
  assert.ok(target !== null);
  assert.equal(await appendHistoryBatch(target, batch("s.1", 1), "2.936"), false);
  assert.equal(await importGameHistory(target, importedTape(target)), false);
  await assert.rejects(stageRetainedOriginal(target, retained("b-1")), /removed/);
  assert.equal(stored(`history/${target.locator}`), false);
});

test("a removed-and-recreated body refuses the old epoch while the new writer lands", async () => {
  const { projectId, target: stale } = await saveGame("recreated-body");
  assert.equal(await appendHistoryBatch(stale, batch("s.1", 1), "2.936"), true);
  const staleTape = `history/${stale.locator}`;

  await clearCachedGame(projectId);
  const { target: fresh } = await saveGame("recreated-body");
  assert.notEqual(fresh.locator, stale.locator, "the recreation minted a new epoch");

  // Every mutation the old writer attempts refuses — nothing lands on the
  // dead tape and nothing leaks onto the live one.
  assert.equal(await appendHistoryBatch(stale, batch("s.1", 2), "2.936"), false);
  assert.equal(await mergeHistoryBatch(stale, staleTape, batch("s.1", 2), "2.936"), false);
  assert.equal(await importGameHistory(stale, importedTape(stale)), false);
  await assert.rejects(stageRetainedOriginal(stale, retained("b-1")), /removed/);
  await assert.rejects(commitStagedOriginal(stale, "b-1"), /removed/);
  await assert.rejects(clearStagedOriginal(stale, "b-1"), /removed/);
  await assert.rejects(resolveStagedSwap(stale, null), /removed/);
  await assert.rejects(saveHistoryBookmark(stale, BOOKMARK), /removed/);
  await assert.rejects(renewHistoryWriter(stale, "s.1"), /removed/);
  // A new-timeline write runs the same guards: seed an unextendable record so
  // the call reaches its write path at all.
  RECORDS.set(staleTape, {
    format: "monotio.agi.history",
    version: 1,
    projectId: staleTape,
    recording: { segments: [] },
    committed: {},
  });
  await assert.rejects(startNewTimeline(stale, "2.936"), /removed/);
  assert.equal(stored(`${staleTape}/next`), false, "no timeline was opened for the dead epoch");
  assert.equal(stored(`${staleTape}/s/s.1/00000002`), false);

  // The live epoch's writer is unaffected.
  assert.equal(await appendHistoryBatch(fresh, batch("s.1", 1), "2.936"), true);
  assert.ok((await loadGameHistory(fresh.locator))?.segments.length === 1);
});

test("an installed instance and a saved project sharing one bare id keep separate tapes", async () => {
  const installed = installedTarget("shared-name");
  const { target: saved } = await saveGame("shared-name");
  assert.notEqual(installed.locator, saved.locator);

  assert.equal(
    await appendHistoryBatch(installed, batch("s-inst", 1), "2.936", INSTALLED_EPOCH),
    true,
  );
  assert.equal(await appendHistoryBatch(saved, batch("s-saved", 1), "2.936"), true);

  const installedTape = await loadGameHistory(installed.locator);
  const savedTape = await loadGameHistory(saved.locator);
  assert.deepEqual(
    installedTape?.segments.map((s) => s.id),
    ["s-inst"],
  );
  assert.deepEqual(
    savedTape?.segments.map((s) => s.id),
    ["s-saved"],
  );
});

test("two installed folders sharing one resource hash keep separate tapes", async () => {
  // The released fallback keyed progress on the WORDS.TOK hash — two
  // different folders holding byte-identical games would share one record
  // set. The installed locator digests the folder, so the tapes stay apart.
  const one = installedProgressTarget(
    { folder: "Games/Folder One", hash: "same-words-hash" },
    testRevision("tape"),
  );
  const two = installedProgressTarget(
    { folder: "Games/Folder Two", hash: "same-words-hash" },
    testRevision("tape"),
  );
  assert.ok(one !== null && two !== null);
  assert.notEqual(one.locator, two.locator);

  assert.equal(await appendHistoryBatch(one, batch("s.1", 1), "2.936", INSTALLED_EPOCH), true);
  assert.equal(await appendHistoryBatch(two, batch("s.2", 1), "2.936", INSTALLED_EPOCH), true);
  assert.deepEqual(
    (await loadGameHistory(one.locator))?.segments.map((s) => s.id),
    ["s.1"],
  );
  assert.deepEqual(
    (await loadGameHistory(two.locator))?.segments.map((s) => s.id),
    ["s.2"],
  );
});

test("an installed write needs the lifetime its boot captured — absent, null and stale all refuse", async () => {
  const target = installedTarget("lifetime-proof");
  const key = `history/${target.locator}`;

  assert.equal(await appendHistoryBatch(target, batch("s.1", 1), "2.936"), false);
  assert.equal(await appendHistoryBatch(target, batch("s.1", 1), "2.936", null), false);
  assert.equal(await appendHistoryBatch(target, batch("s.1", 1), "2.936", ""), false);
  await assert.rejects(stageRetainedOriginal(target, retained("b-1")), /lifetime/);

  // The captured lifetime is checked against the live receipt: once the
  // instance's lifetime moved on, the writer holding the old one is dead.
  assert.equal(await appendHistoryBatch(target, batch("s.1", 1), "2.936", INSTALLED_EPOCH), true);
  RECORDS.set(`lifetime/${target.locator}`, {
    projectId: `lifetime/${target.locator}`,
    epoch: "second-boot",
    deleted: false,
  });
  assert.equal(
    await appendHistoryBatch(target, batch("s.1", 2), "2.936", INSTALLED_EPOCH),
    false,
    "the boot-time epoch no longer holds",
  );
  assert.equal(await appendHistoryBatch(target, batch("s.1", 2), "2.936", "second-boot"), true);

  // A removed instance's receipt ends every writer for good.
  RECORDS.set(`lifetime/${target.locator}`, {
    projectId: `lifetime/${target.locator}`,
    epoch: "second-boot",
    deleted: true,
  });
  assert.equal(await appendHistoryBatch(target, batch("s.1", 3), "2.936", "second-boot"), false);
  assert.equal(RECORDS.has(`${key}/s/s.1/00000003`), false);
});

test("a merge cannot redirect a write onto another tape's manifest key", async () => {
  const target = installedTarget("merge-owner");
  const victim = installedTarget("merge-victim");
  assert.equal(await appendHistoryBatch(victim, batch("s.1", 1), "2.936", INSTALLED_EPOCH), true);

  // Another tape's root, an arbitrary descendant and a look-alike prefix all
  // refuse — the only writable keys are the target's root and its /next chain.
  assert.equal(
    await mergeHistoryBatch(
      target,
      `history/${victim.locator}`,
      batch("s.9", 1),
      "2.936",
      INSTALLED_EPOCH,
    ),
    false,
  );
  assert.equal(
    await mergeHistoryBatch(
      target,
      `history/${target.locator}/s/s.9`,
      batch("s.9", 1),
      "2.936",
      INSTALLED_EPOCH,
    ),
    false,
  );
  assert.equal(
    await mergeHistoryBatch(
      target,
      `history/${target.locator}-extra`,
      batch("s.9", 1),
      "2.936",
      INSTALLED_EPOCH,
    ),
    false,
  );

  // Its own root and its own next timeline are the target's tape.
  assert.equal(
    await mergeHistoryBatch(
      target,
      `history/${target.locator}`,
      batch("s.1", 1),
      "2.936",
      INSTALLED_EPOCH,
    ),
    true,
  );
  assert.equal(
    await mergeHistoryBatch(
      target,
      `history/${target.locator}/next`,
      { ...batch("s.next", 1), boot: stampBoot({ ...BOOT, rng: 3 }) },
      "2.936",
      INSTALLED_EPOCH,
    ),
    true,
  );
  assert.equal(stored(`history/${victim.locator}/s/s.9/00000001`), false);
});

test("a project target refuses a conflicting supplied lifetime", async () => {
  const { target } = await saveGame("conflicting-lifetime");
  // A lifetime that names the captured epoch is consistent; any other
  // spelling — or a null lifetime — is a different writer claiming the tape.
  assert.equal(await appendHistoryBatch(target, batch("s.1", 1), "2.936", target.bodyEpoch), true);
  assert.equal(await appendHistoryBatch(target, batch("s.1", 2), "2.936", "not-the-epoch"), false);
  assert.equal(await appendHistoryBatch(target, batch("s.1", 2), "2.936", null), false);
  await assert.rejects(saveHistoryBookmark(target, BOOKMARK, "not-the-epoch"), /epoch/);
  assert.equal(
    await appendHistoryBatch(target, batch("s.1", 2), "2.936"),
    true,
    "the epoch's own writer is unaffected",
  );
});

test("a move writes the destination tape under the destination's authority", async () => {
  const { target: stale } = await saveGame("move-dest-stale");
  await clearCachedGame(testProjectId("move-dest-stale"));

  const source = installedTarget("move-source");
  assert.equal(await appendHistoryBatch(source, batch("s.1", 1), "2.936", INSTALLED_EPOCH), true);

  // The destination's guards run inside the destination transaction — a
  // stale destination refuses and the source tape is untouched.
  await assert.rejects(moveHistoryRecord(source, stale), /removed|replaced/);
  assert.equal(stored(`history/${stale.locator}`), false);
  assert.ok(await loadGameHistory(source.locator));

  // A live installed destination receives the moved tape under its identity.
  const destination = installedTarget("move-dest");
  await moveHistoryRecord(source, destination, INSTALLED_EPOCH);
  const moved = await loadGameHistory(destination.locator);
  assert.deepEqual(
    moved?.segments.map((s) => s.id),
    ["s.1"],
  );
  assert.equal(moved?.identity.project, destination.identity.project);
});
