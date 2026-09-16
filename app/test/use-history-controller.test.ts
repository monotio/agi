/**
 * The host-side commit ledger: a batch storage refuses stays listed as
 * unsaved until a resend of that exact batch commits — the worker's backoff
 * keeps reposting it, so the test drives the same batch again and watches
 * the ledger clear. A game switch drops the ledger: the old worker's
 * resends are gone with it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { useHistoryController } from "../src/useHistoryController.ts";
import type { BootedGame } from "../src/gameTypes.ts";
import type { HistoryBatch, HistoryBoot } from "../../src/agent/history.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId, testRevision } from "./identity.ts";
import {
  clearCachedGame,
  readHistoryLifetime,
  saveAuthoredGame,
  saveAuthoredGameWithLifetime,
  loadAuthoredGameWithHistoryLifetime,
} from "../src/gameStorage.ts";
import {
  clearStagedOriginal,
  commitStagedOriginal,
  resolveStagedSwap,
  saveHistoryBookmark,
  stageRetainedOriginal,
} from "../src/historyStorage.ts";

const records = installIndexedDbFixture();

const BOOT: HistoryBoot = {
  files: { "VOL.0": "eA==" },
  dictionary: [],
  authorRooms: false,
  rng: 7,
  soundDevice: 1,
  resourceSet: "rev-1",
  requestSerial: 0,
};

function game(id: string): BootedGame {
  return {
    installed: false,
    title: "",
    revision: testRevision("game"),
    files: {},
    words: [],
    projectId: testProjectId(id),
  };
}

test("a refused commit stays unsaved until a resend commits it", async () => {
  const state = {
    historyPending: 0,
    historyUnsaved: null as { batches: number; since: number } | null,
  };
  // Read through a function — assert.* narrows the property permanently.
  const unsaved = () => state.historyUnsaved;
  let booted = game("hc-a");
  const controller = useHistoryController({
    state,
    getBootedGame: () => booted,
    getProfile: () => "2.936",
    logAgent: () => {},
  });

  // A batch whose segment never opened is refused — and stays listed.
  const orphan: HistoryBatch = {
    segment: "sX.9",
    batch: 2,
    seqStart: 0,
    seqEnd: 1,
    events: [{ seq: 0, tick: 1, cycle: 1, cause: { kind: "key", code: 65 } }],
    marks: [],
    sync: [],
  };
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: orphan }), false);
  assert.equal(state.historyPending, 0, "pending counts in-flight work, not the ledger");
  assert.equal(unsaved()?.batches, 1);
  assert.ok(Number.isFinite(unsaved()!.since));

  // The worker's resend still cannot land — the ledger holds one entry, not two.
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: orphan }), false);
  assert.equal(unsaved()?.batches, 1);

  // Recovery without reloading the worker: the resend finally delivers the
  // boot batch, then the orphaned resend commits and the ledger clears.
  assert.equal(
    await controller.handleHistoryBatch({
      epoch: 0,
      batch: { ...orphan, batch: 1, events: [], boot: BOOT },
    }),
    true,
  );
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: orphan }), true);
  assert.ok(unsaved() === null, "the ledger cleared once its batches committed");

  // Two refusals under game A — never-opened segments — then the game
  // switches: the ledger the old session left behind is gone with its worker.
  assert.equal(
    await controller.handleHistoryBatch({ epoch: 0, batch: { ...orphan, segment: "sX.10" } }),
    false,
  );
  assert.equal(
    await controller.handleHistoryBatch({ epoch: 0, batch: { ...orphan, segment: "sX.11" } }),
    false,
  );
  assert.equal(unsaved()?.batches, 2);
  booted = game("hc-b");
  assert.equal(
    await controller.handleHistoryBatch({ epoch: 0, batch: { ...orphan, segment: "sY.1" } }),
    false,
  );
  assert.equal(
    unsaved()?.batches,
    1,
    "the new session's own refusal is counted — the old ledger is gone",
  );
});

test("a mid-session storage-key change migrates the tape instead of orphaning it", async () => {
  const state = {
    historyPending: 0,
    historyUnsaved: null as { batches: number; since: number } | null,
  };
  let booted = game("hc-catalog");
  const controller = useHistoryController({
    state,
    getBootedGame: () => booted,
    getProfile: () => "2.936",
    logAgent: () => {},
  });

  // The session's stream commits under the catalog game's key.
  const b = (n: number, extra: Partial<HistoryBatch> = {}): HistoryBatch => ({
    segment: "sR.1",
    batch: n,
    seqStart: n - 1,
    seqEnd: n,
    events: [],
    marks: [],
    sync: [],
    ...extra,
  });
  assert.equal(
    await controller.handleHistoryBatch({ epoch: 0, batch: b(1, { boot: BOOT }) }),
    true,
  );
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: b(2) }), true);

  // Saving a recording converts the catalog game into a remix project:
  // `booted` swaps mid-session while the same worker keeps posting the
  // same segment's batches. The record must move — without the migration
  // every later commit refuses against a key that never saw the boot.
  booted = game("hc-remix");
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: b(3) }), true);
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: b(4) }), true);
  assert.equal(state.historyUnsaved, null, "no batch is stranded by the key change");

  // The moved record holds the whole stream; a resend dedups under it.
  const { loadGameHistory } = await import("../src/historyStorage.ts");
  const moved = await loadGameHistory("hc-remix");
  assert.equal(moved?.segments.length, 1);
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: b(4) }), true);

  // A different session's batch under yet another key is a real switch —
  // the migration path does not follow it.
  booted = game("hc-other");
  assert.equal(
    await controller.handleHistoryBatch({
      epoch: 0,
      batch: { ...b(1, { boot: BOOT }), segment: "sZ.1" },
    }),
    true,
  );
  assert.equal((await loadGameHistory("hc-other"))?.segments.length, 1);
});

test("a paused writer renews its lease and stops renewing when the segment ends", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const booted = game("hc-lease");
  const scheduled: { callback: () => void; cancelled: boolean }[] = [];
  const state = {
    historyPending: 0,
    historyUnsaved: null as { batches: number; since: number } | null,
  };
  const controller = useHistoryController({
    state,
    getBootedGame: () => booted,
    getProfile: () => "2.936",
    logAgent: () => {},
    scheduleRenewal: (callback, delay) => {
      assert.equal(delay, 30_000);
      const task = { callback, cancelled: false };
      scheduled.push(task);
      return () => {
        task.cancelled = true;
      };
    },
  });
  const batch: HistoryBatch = {
    segment: "sLease.s1",
    batch: 0,
    seqStart: 0,
    seqEnd: 0,
    boot: BOOT,
    events: [],
    marks: [],
    sync: [],
  };
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch }), true);
  assert.equal(scheduled.length, 1);
  now += 30_000;
  const read = t.mock.method(records, "get", () => {
    throw new Error("transient lease read refusal");
  });
  scheduled[0]!.callback();
  await controller.drainHistoryCommits();
  assert.equal(scheduled.length, 2, "renewal rearms while play is paused and no batches arrive");
  assert.notEqual(state.historyUnsaved, null);
  read.mock.restore();
  const { boot: _boot, ...tail } = batch;
  assert.equal(
    await controller.handleHistoryBatch({
      epoch: 0,
      batch: {
        ...tail,
        batch: 1,
        end: { seq: 0, tick: 0, cycle: 0, reason: "eject" },
      } as HistoryBatch,
    }),
    true,
  );
  assert.equal(scheduled[1]!.cancelled, true);
  assert.equal(state.historyUnsaved, null, "a durable end clears transient lease warnings");
});

test("an old boot resend cannot steal renewal from the current paused segment", async () => {
  const booted = game("hc-stale-boot");
  const state = {
    historyPending: 0,
    historyUnsaved: null as { batches: number; since: number } | null,
  };
  let renew: (() => void) | undefined;
  const controller = useHistoryController({
    state,
    getBootedGame: () => booted,
    getProfile: () => "2.936",
    logAgent: () => {},
    scheduleRenewal: (callback) => {
      renew = callback;
      return () => {
        renew = undefined;
      };
    },
  });
  const first: HistoryBatch = {
    segment: "sStale.s1",
    batch: 0,
    seqStart: 0,
    seqEnd: 0,
    boot: BOOT,
    events: [],
    marks: [],
    sync: [],
  };
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: first }), true);
  const { boot: _boot, ...tail } = first;
  assert.equal(
    await controller.handleHistoryBatch({
      epoch: 0,
      batch: { ...tail, batch: 1, end: { seq: 0, tick: 0, cycle: 0, reason: "budget" } },
    }),
    true,
  );
  assert.equal(
    await controller.handleHistoryBatch({
      epoch: 0,
      batch: { ...first, segment: "sStale.s2", batch: 2 },
    }),
    true,
  );
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: first }), true);
  assert.ok(renew);
  renew();
  await controller.drainHistoryCommits();
  assert.equal(state.historyUnsaved, null, "current open segment is renewed, not the ended resend");
  controller.stopWriterRenewal();
});

test("a delayed first batch from a deleted game cannot join a recreated project", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const id = testProjectId("hc-recreated");
  const data = { title: "Original", provider: "stub", model: "stub", files: {}, words: [] };
  const committedLifetime = await saveAuthoredGameWithLifetime(id, data);
  assert.equal(typeof committedLifetime, "string");
  const loaded = (await loadAuthoredGameWithHistoryLifetime(id))!;
  assert.equal(loaded.lifetime, committedLifetime);
  assert.equal(loaded.data.title, "Original");
  const booted = { ...game(id), historyLifetime: loaded.lifetime };
  const state = {
    historyPending: 0,
    historyUnsaved: null as { batches: number; since: number } | null,
  };
  const controller = useHistoryController({
    state,
    getBootedGame: () => booted,
    getProfile: () => "2.936",
    logAgent: () => {},
  });
  // The first batch has not even reached storage when another tab removes
  // and reimports the same ID. The boot-time token must still be invalid.
  await clearCachedGame(id);
  assert.equal(await saveAuthoredGame(id, { ...data, title: "Reimported" }), true);
  const first = {
    epoch: 0,
    batch: {
      segment: "old.s1",
      batch: 1,
      seqStart: 0,
      seqEnd: 0,
      events: [],
      marks: [],
      sync: [],
      boot: BOOT,
    },
  };
  assert.equal(await controller.handleHistoryBatch(first), false);
  assert.equal(records.has(`history/${id}`), false);
  assert.equal(state.historyUnsaved?.batches, 1);
  // A newly booted copy of the recreated game can record, while rollover
  // segments from the original worker remain refused.
  const recreated = { ...game(id), historyLifetime: await readHistoryLifetime(id) };
  const fresh = useHistoryController({
    state: { historyPending: 0, historyUnsaved: null },
    getBootedGame: () => recreated,
    getProfile: () => "2.936",
    logAgent: () => {},
  });
  assert.notEqual(recreated.historyLifetime, booted.historyLifetime);
  assert.equal(
    await fresh.handleHistoryBatch({ ...first, batch: { ...first.batch, segment: "new.s1" } }),
    true,
  );
  assert.equal(
    await controller.handleHistoryBatch({ ...first, batch: { ...first.batch, segment: "old.s2" } }),
    false,
  );
  const tape = records.get(`history/${id}`) as { segments: { id: string }[] };
  assert.deepEqual(
    tape.segments.map((segment) => segment.id),
    ["new.s1"],
  );
  const before = structuredClone([...records.entries()]);
  const stale = booted.historyLifetime;
  await assert.rejects(
    stageRetainedOriginal(
      id,
      {
        id: "late-branch",
        boot: BOOT,
        from: { segment: "old.s1", seq: 0, tick: 0 },
        retainedAt: 1,
      },
      stale,
    ),
    /removed game/,
  );
  await assert.rejects(commitStagedOriginal(id, "late-branch", undefined, stale), /removed game/);
  await assert.rejects(clearStagedOriginal(id, "late-branch", stale), /removed game/);
  await assert.rejects(resolveStagedSwap(id, null, "old.s1", stale), /removed game/);
  await assert.rejects(
    saveHistoryBookmark(
      id,
      {
        label: "Old session",
        segment: "old.s1",
        seq: 0,
        tick: 0,
        at: 1,
      },
      stale,
    ),
    /removed game/,
  );
  assert.deepEqual(
    [...records.entries()],
    before,
    "stale metadata writers cannot touch the new lifetime",
  );
});

test("an installed game records without a saved project body", async () => {
  const id = "installed-no-body";
  const booted: BootedGame = {
    installed: true,
    folder: id,
    title: "Installed game",
    revision: testRevision(id),
    files: {},
    words: [],
    historyLifetime: await readHistoryLifetime(id),
  };
  assert.equal(records.has(id), false);
  const controller = useHistoryController({
    state: { historyPending: 0, historyUnsaved: null },
    getBootedGame: () => booted,
    getProfile: () => "2.936",
    logAgent: () => {},
  });
  assert.equal(
    await controller.handleHistoryBatch({
      epoch: 0,
      batch: {
        segment: "installed.s1",
        batch: 1,
        seqStart: 0,
        seqEnd: 0,
        events: [],
        marks: [],
        sync: [],
        boot: BOOT,
      },
    }),
    true,
  );
  assert.equal(records.has(`history/${id}`), true);
  assert.equal(records.has(id), false);
});
