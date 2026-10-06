import assert from "node:assert/strict";
import { test } from "node:test";
import { autosaveKey, writeAutosave, type AutosaveRecord } from "../src/saves/gameProgress.ts";
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
