import assert from "node:assert/strict";
import { test } from "node:test";
import { createProgressOwnership } from "../src/saves/progressOwnership.ts";
import { progressWriterKey, progressWriterMatches } from "../src/saves/progressWriter.ts";
import { projectProgressTarget } from "../src/project/progressTarget.ts";
import { testProjectId, testRevision } from "./identity.ts";
import { autosaveKey, writeAutosave, type AutosaveRecord } from "../src/saves/gameProgress.ts";
import { readGameSaves, writeGameSave } from "../src/saves/gameSaves.ts";

for (const initialGeneration of [1, 3]) {
  test(`a copy retires the original claim and fences stale copy writes (generation ${initialGeneration})`, async () => {
    const original = projectProgressTarget(
      testProjectId("original"),
      testRevision("original"),
      "initial",
    )!;
    const copy = projectProgressTarget(testProjectId("copy"), testRevision("copy"), "initial")!;
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const lock = async <T>(_key: string, action: () => T) => action();
    const notices: boolean[] = [];
    const first = createProgressOwnership({
      storage,
      owner: "first",
      lock,
      changed: (lost) => notices.push(lost),
    });
    const second = createProgressOwnership({ storage, owner: "second", lock, changed: () => {} });
    for (let i = 0; i < initialGeneration; i++) await first.acquire(original);
    await first.acquire(copy);
    assert.equal(progressWriterMatches(storage, original.locator, initialGeneration), false);
    const copyGeneration = first.generation();
    assert.equal(copyGeneration, 1);
    const checkpoint: AutosaveRecord = {
      format: "monotio.agi.autosave",
      version: 1,
      image: "copy",
      cycle: 10,
      room: 1,
      savedAt: 1,
      game: { installed: false, identity: copy.identity },
      writerGeneration: copyGeneration,
    };
    assert.ok(writeAutosave(storage, copy, checkpoint));
    assert.ok(writeGameSave(storage, copy, 1, "copy slot", "ntsc", copyGeneration));
    await second.acquire(copy);
    first.observe(progressWriterKey(copy.locator));
    assert.equal(first.generation(), undefined);
    assert.equal(progressWriterMatches(storage, copy.locator, copyGeneration), false);
    const newer = { ...checkpoint, image: "second page", writerGeneration: second.generation()! };
    assert.ok(writeAutosave(storage, copy, newer));
    assert.ok(writeGameSave(storage, copy, 1, "second page slot", "ntsc", second.generation()));
    const bytes = storage.getItem(autosaveKey(copy.locator));
    const slots = JSON.stringify(readGameSaves(storage, copy));
    assert.equal(writeAutosave(storage, copy, checkpoint), null);
    assert.equal(writeGameSave(storage, copy, 1, "stale copy slot", "ntsc", copyGeneration), false);
    assert.equal(storage.getItem(autosaveKey(copy.locator)), bytes);
    assert.equal(JSON.stringify(readGameSaves(storage, copy)), slots);
    const count = notices.length;
    first.observe(progressWriterKey(original.locator));
    assert.equal(notices.length, count);
  });
}

test("the newest tab pauses the older owner, which can take the game back", async () => {
  const target = projectProgressTarget(testProjectId("tab-game"), testRevision("tabs"), "initial")!;
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const notices: boolean[] = [];
  const lock = async <T>(_key: string, action: () => T) => action();
  const first = createProgressOwnership({
    storage,
    owner: "first",
    lock,
    changed: (lost) => notices.push(lost),
  });
  const second = createProgressOwnership({ storage, owner: "second", lock, changed: () => {} });
  await first.acquire(target);
  await second.acquire(target);
  first.observe(progressWriterKey(target.locator));
  assert.deepEqual(notices, [false, true]);
  assert.equal(first.generation(), undefined);
  await first.takeBack();
  assert.equal(first.generation(), 3);
  assert.deepEqual(notices, [false, true, false]);
});

test("closing while an ownership claim waits does not publish a writer", async () => {
  const target = projectProgressTarget(
    testProjectId("close-game"),
    testRevision("close"),
    "initial",
  )!;
  const values = new Map<string, string>();
  let release: (() => void) | undefined;
  const lock = <T>(_key: string, action: () => T): Promise<T> =>
    new Promise((resolve) => {
      release = () => resolve(action());
    });
  const owner = createProgressOwnership({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
    owner: "closing",
    lock,
    changed: () => assert.fail("closed owner published"),
  });
  const pending = owner.acquire(target);
  owner.close();
  release!();
  await pending;
  assert.equal(values.size, 0);
});
