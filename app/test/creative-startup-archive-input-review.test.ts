import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import type { RoomMapSidecar } from "../../src/agent/roomMap.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import type { BackupReport } from "../src/archive/historyBackup.ts";
import { collectProjectArchiveEntries } from "../src/archive/projectArchive.ts";
import type { GameProgress } from "../src/saves/gameProgress.ts";

function fixture(): { data: CachedGameData; save: Uint8Array } {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  const engine = new Engine(container, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  });
  engine.tick();
  return {
    data: {
      projectId: requireProjectId("00000000-0000-4000-8000-000000000091"),
      authoredAt: "2026-01-01T00:00:00.000Z",
      title: "Captured archive",
      provider: "stub",
      model: "offline-stub",
      files: Object.fromEntries(container.files),
      words: [],
    },
    save: engine.serialize(),
  };
}

test("lazy archive preparation captures offered save slots before yielding", async () => {
  const { data, save } = fixture();
  const offered = new Uint8Array(save);
  const progress: GameProgress = { saves: { "1": offered }, autosave: null };
  const pending = collectProjectArchiveEntries(data, progress);
  offered.fill(0);
  delete progress.saves["1"];
  const entries = await pending;
  const slot = entries.find((entry) => entry.name === "SAVES/SG.1");
  assert.ok(slot, "a caller changing progress cannot remove an already-offered slot");
  assert.deepEqual(slot.data, save, "the archive keeps the exact offered native save bytes");
});

test("lazy archive preparation captures offered map notes before yielding", async () => {
  const { data } = fixture();
  const map: RoomMapSidecar = {
    journal: [],
    discovered: { rooms: {}, edges: [] },
    layout: {},
    notes: { "1": "Offered note" },
    edgeNotes: {},
  };
  const pending = collectProjectArchiveEntries(data, undefined, map);
  map.notes["1"] = "Changed after offering";
  const entry = (await pending).find((item) => item.name === "MAP.JSON");
  assert.ok(entry);
  assert.equal(typeof entry.data, "string");
  const parsed = JSON.parse(entry.data as string) as { notes: Record<string, string> };
  assert.equal(parsed.notes["1"], "Offered note", "the map belongs to the frozen archive offer");
});

test("lazy archive preparation captures the offered backup report before yielding", async () => {
  const { data } = fixture();
  const report: BackupReport = {
    format: "monotio.agi.backup",
    version: 1,
    complete: false,
    notes: ["Offered recovery note"],
    recoveryBatches: [],
  };
  const pending = collectProjectArchiveEntries(data, undefined, undefined, undefined, report);
  report.notes[0] = "Changed after offering";
  report.complete = true;
  const entry = (await pending).find((item) => item.name === "BACKUP.JSON");
  assert.ok(entry);
  const parsed = JSON.parse(entry.data as string) as { notes: string[]; complete: boolean };
  assert.deepEqual(parsed.notes, ["Offered recovery note"]);
  assert.equal(parsed.complete, false);
});

test("archive offer capture faults retain the asynchronous writer contract", async () => {
  const { data } = fixture();
  data.authoringState = { malformedSource: () => {} };
  let pending: ReturnType<typeof collectProjectArchiveEntries> | undefined;
  assert.doesNotThrow(() => {
    pending = collectProjectArchiveEntries(data);
  }, "an invalid offer is a rejected archive promise, as before lazy loading");
  assert.ok(pending);
  await assert.rejects(pending, { name: "DataCloneError" });
});
