import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autosaveKey,
  writeAutosave,
  storeImportedProgress,
  readGameProgress,
  type AutosaveRecord,
} from "../src/saves/gameProgress.ts";
import { projectProgressTarget } from "../src/project/progressTarget.ts";
import { testProjectId, testRevision } from "./identity.ts";
import { readGameSaves, writeGameSave } from "../src/saves/gameSaves.ts";

test("a stale progress writer cannot overwrite the newest tab's physical checkpoint", () => {
  const target = projectProgressTarget(
    testProjectId("writer-game"),
    testRevision("writer"),
    "initial",
  )!;
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const record: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    image: "new",
    cycle: 100,
    room: 1,
    savedAt: 1,
    game: { installed: false, identity: target.identity },
    writerGeneration: 2,
  };
  values.set(
    `monotio_agi.writer.${target.locator}`,
    JSON.stringify({ generation: 2, owner: "new-tab" }),
  );
  assert.ok(writeAutosave(storage, target, record));
  const bytes = values.get(autosaveKey(target.locator));
  assert.equal(
    writeAutosave(storage, target, { ...record, cycle: 5, image: "stale", writerGeneration: 1 }),
    null,
  );
  assert.equal(values.get(autosaveKey(target.locator)), bytes);
  assert.ok(writeGameSave(storage, target, 1, "new slot", "ntsc", 2));
  const slots = JSON.stringify(readGameSaves(storage, target));
  assert.equal(writeGameSave(storage, target, 1, "stale slot", "ntsc", 1), false);
  assert.equal(writeGameSave(storage, target, 2, "another stale slot", "ntsc", 1), false);
  assert.equal(JSON.stringify(readGameSaves(storage, target)), slots);
});

test("archive re-import claims the played project's writer and reports refused progress", () => {
  const target = projectProgressTarget(
    testProjectId("import-writer"),
    testRevision("import"),
    "initial",
  )!;
  const values = new Map<string, string>();
  let refuse = false;
  let refuseWriter = false;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (refuseWriter && key.includes(".writer.")) throw new Error("writer quota");
      if (refuse && (key.includes(".saves.") || key.includes(".autosave.")))
        throw new Error("quota");
      values.set(key, value);
    },
  };
  values.set(
    `monotio_agi.writer.${target.locator}`,
    JSON.stringify({ generation: 7, owner: "played-tab" }),
  );
  const progress = {
    saves: { "1": Uint8Array.of(1, 2, 3), "7": Uint8Array.of(7, 8) },
    autosave: {
      format: "monotio.agi.autosave" as const,
      version: 1 as const,
      image: "imported",
      cycle: 5,
      room: 1,
      savedAt: 2,
      game: { installed: false, identity: target.identity },
      writerGeneration: 2,
    },
  };
  const report = storeImportedProgress(storage, target, progress);
  assert.deepEqual(report.slots, [1, 7]);
  assert.deepEqual(report.failedSlots, []);
  assert.equal(report.autosave?.image, "imported");
  assert.deepEqual(readGameProgress(storage, target).saves, progress.saves);
  assert.equal(readGameProgress(storage, target).autosave?.image, "imported");
  assert.equal(writeGameSave(storage, target, 1, "stale", "ntsc", 7), false);
  refuse = true;
  const refused = storeImportedProgress(storage, target, progress);
  assert.deepEqual(refused, { slots: [], failedSlots: [1, 7], autosave: null });
  refuse = false;
  refuseWriter = true;
  const prior = [...values.entries()];
  assert.deepEqual(storeImportedProgress(storage, target, progress), {
    slots: [],
    failedSlots: [1, 7],
    autosave: null,
  });
  assert.deepEqual([...values.entries()], prior);
});
