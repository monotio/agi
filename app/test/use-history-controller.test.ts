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

installIndexedDbFixture();

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
