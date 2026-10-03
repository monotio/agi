/**
 * A stored tape this version cannot extend — the pre-1.0 whole-tape record,
 * or one a newer release wrote — is a permanent refusal, not a storage
 * hiccup: the host stops counting its batches as unsaved, says so once, and
 * lets the player start a new timeline beside it. The old record's bytes
 * stay exactly as they were (the release contract), and deleting the game
 * removes both timelines.
 *
 * A transient failure is different: the banner's Try now reports Saving…,
 * then Saved once the ledger is empty, or the plain reason it is not.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { stampBoot, type HistoryBatch, type HistoryBoot } from "../../src/agent/history.ts";
import {
  appendHistoryBatch,
  loadGameHistory,
  readOldTimeline,
  startNewTimeline,
  UnextendableHistoryError,
} from "../src/history/historyStorage.ts";
import {
  useHistoryController,
  type HistoryBlock,
  type HistoryRetry,
} from "../src/history/useHistoryController.ts";
import {
  clearCachedGame,
  readHistoryLifetime,
  saveAuthoredGame,
} from "../src/project/gameStorage.ts";
import { projectProgressTarget } from "../src/project/progressTarget.ts";
import { bindProgressTarget } from "../src/project/progressBinding.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId, testRevision } from "./identity.ts";

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

function batch(segment: string, n: number, extra: Partial<HistoryBatch> = {}): HistoryBatch {
  return {
    segment,
    batch: n,
    seqStart: n - 1,
    seqEnd: n,
    events: [],
    marks: [],
    sync: [],
    ...extra,
  };
}

/** The pre-1.0 layout: one whole-tape record under the manifest key. */
function legacyTape(key: string): Record<string, unknown> {
  return {
    format: "monotio.agi.history",
    version: 1,
    projectId: `history/${key}`,
    recording: { segments: [{ id: "old.s1", boot: BOOT, events: [], marks: [], sync: [] }] },
    committed: { "old.s1": [1] },
  };
}

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

function historyState() {
  return {
    historyPending: 0,
    historyUnsaved: null as { batches: number; since: number } | null,
    historyBlocked: null as HistoryBlock | null,
    historyRetry: null as HistoryRetry | null,
  };
}

/** A saved body and the game booted from it: the bound target's epoch carried. */
async function bootSavedGame(id: string): Promise<BootedGame> {
  const projectId = testProjectId(id);
  assert.equal(
    await saveAuthoredGame(projectId, {
      title: id,
      provider: "stub",
      model: "stub",
      files: {},
      words: [],
    }),
    true,
  );
  const booted = { ...game(id), historyLifetime: await readHistoryLifetime(projectId) };
  bindProgressTarget(booted);
  return booted;
}

test("a tape this version cannot extend refuses permanently; a new timeline continues beside it", async () => {
  const projectId = testProjectId("timeline-legacy");
  await saveAuthoredGame(projectId, {
    title: "Legacy",
    provider: "stub",
    model: "stub",
    files: {},
    words: [],
  });
  const target = projectProgressTarget(
    projectId,
    testRevision("tape"),
    await readHistoryLifetime(projectId),
  );
  assert.ok(target !== null);
  const key = target.locator;
  RECORDS.set(`history/${key}`, legacyTape(key));
  const before = JSON.stringify(RECORDS.get(`history/${key}`));

  await assert.rejects(
    appendHistoryBatch(target, batch("s1.s1", 1, { boot: BOOT }), "2.936"),
    (error: unknown) => error instanceof UnextendableHistoryError && error.stored === "older",
  );

  // The player's choice: the old record is kept for its own reader.
  await startNewTimeline(target, "2.936");
  assert.equal(await appendHistoryBatch(target, batch("s1.s1", 1, { boot: BOOT }), "2.936"), true);
  assert.equal(await appendHistoryBatch(target, batch("s1.s1", 2), "2.936"), true);
  const tape = await loadGameHistory(key);
  assert.deepEqual(
    tape?.segments.map((segment) => segment.id),
    ["s1.s1"],
  );
  assert.equal(JSON.stringify(RECORDS.get(`history/${key}`)), before, "old bytes untouched");

  // The old timeline downloads as the stored record, verbatim.
  const old = JSON.parse((await readOldTimeline(key))!) as { records: { value: unknown }[] };
  assert.deepEqual(
    old.records.map(({ value }) => JSON.stringify(value)),
    [before],
  );

  // Removing the game removes both timelines.
  await clearCachedGame(projectId);
  assert.deepEqual(
    [...RECORDS.keys()].filter((k) => String(k).startsWith(`history/${key}`)),
    [],
  );
});

test("the host refuses an unextendable tape once: no unsaved ledger, one message, no storage retries", async (t) => {
  const booted = await bootSavedGame("timeline-host");
  const key = booted.progressTarget!.locator;
  RECORDS.set(`history/${key}`, legacyTape(key));
  const state = historyState();
  const logs: string[] = [];
  const nudges: string[] = [];
  const controller = useHistoryController({
    state,
    getBootedGame: () => booted,
    getProfile: () => "2.936",
    logAgent: (_kind, message) => logs.push(message),
    retryWorker: () => nudges.push("retry"),
  });
  const boot = batch("s2.s1", 1, { boot: BOOT });
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: boot }), false);
  assert.equal(state.historyUnsaved, null, "a permanent refusal is not an unsaved retry");
  assert.equal(
    state.historyBlocked?.message,
    "Your game is saved. This session's rewind timeline can't be stored: an older timeline for this game is in a format this version can't extend.",
  );

  // The worker's later posts are answered without touching storage again.
  const reads = t.mock.method(RECORDS, "get");
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: batch("s2.s1", 2) }), false);
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: boot }), false);
  assert.equal(reads.mock.callCount(), 0);
  reads.mock.restore();
  assert.equal(state.historyUnsaved, null);
  assert.equal(logs.length, 1, "said once");

  // Start a new timeline: the block lifts and the worker resends its tape.
  await controller.startNewTimeline();
  assert.equal(state.historyBlocked, null);
  assert.deepEqual(nudges, ["retry"]);
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: boot }), true);
  assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: batch("s2.s1", 2) }), true);
  assert.equal((await loadGameHistory(key))?.segments.length, 1);
});

test("Try now reports Saving…, then the plain reason, then Saved once storage recovers", async (t) => {
  const booted = await bootSavedGame("timeline-retry");
  const state = historyState();
  // The worker's un-acked batches; a nudge resends the oldest, as it does.
  const sent: HistoryBatch[] = [];
  let resends = 0;
  const controller = useHistoryController({
    state,
    getBootedGame: () => booted,
    getProfile: () => "2.936",
    logAgent: () => {},
    retryWorker: () => {
      resends++;
      const oldest = sent[0];
      if (oldest)
        void controller.handleHistoryBatch({ epoch: 0, batch: oldest }).then((ok) => {
          if (ok) sent.splice(sent.indexOf(oldest), 1);
        });
    },
  });
  const refuse = t.mock.method(RECORDS, "set", () => {
    throw new Error("QuotaExceededError");
  });
  sent.push(batch("s3.s1", 1, { boot: BOOT }), batch("s3.s1", 2));
  for (const each of sent)
    assert.equal(await controller.handleHistoryBatch({ epoch: 0, batch: each }), false);
  assert.equal(state.historyUnsaved?.batches, 2);

  const failing = controller.retrySave();
  assert.deepEqual(state.historyRetry, { status: "saving" });
  await failing;
  assert.equal(state.historyRetry?.status, "failed");
  assert.match(
    (state.historyRetry as { reason: string }).reason,
    /storage/i,
    "a plain reason, not a stack",
  );

  refuse.mock.restore();
  await controller.retrySave();
  assert.deepEqual(state.historyRetry, { status: "saved" });
  assert.equal(state.historyUnsaved, null, "every owed batch landed");
  assert.equal(resends, 3, "one nudge per owed batch after the failed try");
});
