import assert from "node:assert/strict";
import { test } from "node:test";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import {
  loadAuthoredGame,
  saveAuthoredGame,
  setStoredRoomGeneration,
} from "../src/project/gameStorage.ts";

installIndexedDbFixture();
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  },
});

test("room generation is optional, persists per project and fences a second page's stale setting", async () => {
  const projectId = testProjectId("room-setting");
  await saveAuthoredGame(projectId, {
    title: "Rooms",
    files: { "VOL.0": Uint8Array.of(1, 2) },
    words: [],
  });
  const original = (await loadAuthoredGame(projectId))!;
  assert.equal(original.roomGeneration, undefined);
  await setStoredRoomGeneration(projectId, true, original.generation);
  const enabled = (await loadAuthoredGame(projectId))!;
  assert.equal(enabled.roomGeneration, true);
  assert.equal(enabled.library?.revision, original.library?.revision);
  assert.deepEqual(enabled.files, original.files);
  await assert.rejects(
    setStoredRoomGeneration(projectId, false, original.generation),
    /another window/,
  );
  assert.equal((await loadAuthoredGame(projectId))!.roomGeneration, true);
  await setStoredRoomGeneration(projectId, false, enabled.generation);
  assert.equal((await loadAuthoredGame(projectId))!.roomGeneration, false);
});
