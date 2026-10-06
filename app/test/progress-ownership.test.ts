import assert from "node:assert/strict";
import { test } from "node:test";
import { createProgressOwnership } from "../src/saves/progressOwnership.ts";
import { progressWriterKey } from "../src/saves/progressWriter.ts";
import { projectProgressTarget } from "../src/project/progressTarget.ts";
import { testProjectId, testRevision } from "./identity.ts";

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
