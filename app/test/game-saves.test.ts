import assert from "node:assert/strict";
import { test } from "node:test";
import { readGameSaves, writeGameSave } from "../src/gameSaves.ts";

test("numbered saves preserve other slots, isolate games, and leave legacy images intact", () => {
  const values = new Map<string, string>([["monotio_agi.save", "legacy"]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  assert.deepEqual(readGameSaves(storage, "first"), { "1": "legacy" });
  assert.equal(writeGameSave(storage, "first", 2, "before-cliff"), true);
  assert.equal(writeGameSave(storage, "first", 3, "after-cliff"), true);
  assert.equal(writeGameSave(storage, "second", 2, "different-game"), true);
  assert.deepEqual(readGameSaves(storage, "first"), {
    "1": "legacy",
    "2": "before-cliff",
    "3": "after-cliff",
  });
  assert.deepEqual(readGameSaves(storage, "second"), { "1": "legacy", "2": "different-game" });
  assert.equal(values.get("monotio_agi.save"), "legacy");
  assert.equal(writeGameSave(storage, "first", 13, "bad-slot"), false);
  storage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  assert.equal(writeGameSave(storage, "first", 2, "lost-write"), false);
  assert.equal(readGameSaves(storage, "first")["2"], "before-cliff");
  values.set("monotio_agi.saves.broken", "not json");
  assert.equal(writeGameSave(storage, "broken", 1, "overwrite"), false);
  assert.equal(values.get("monotio_agi.saves.broken"), "not json");
});
