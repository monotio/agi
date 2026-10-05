import { scheduler as testScheduler } from "node:timers/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProjectAutosave } from "../src/project/projectAutosave.ts";

test("autosave serializes captures, retries the exact failed request, and fences newer content", async () => {
  const calls: number[] = [];
  let fail = true;
  let release: (() => void) | undefined;
  const saver = createProjectAutosave<number, number>({
    current: () => true,
    write: async (value) => {
      calls.push(value);
      if (fail) throw new Error("quota");
      await new Promise<void>((r) => {
        release = r;
      });
      return value;
    },
    saved: () => {},
    conflict: () => false,
  });
  saver.enqueue(1);
  await saver.flush();
  assert.equal(saver.status().message, "Could not save. Retry");
  saver.enqueue(2);
  fail = false;
  const retry = saver.retry();
  await testScheduler.yield();
  assert.deepEqual(calls, [1, 1]);
  release!();
  await testScheduler.yield();
  assert.deepEqual(calls, [1, 1, 2]);
  assert.equal(saver.status().state, "saving");
  release!();
  await retry;
  assert.equal(saver.status().state, "saved");
  saver.dispose();
});

test("autosave has a maximum interval during continuous editing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const written: number[] = [];
  const saver = createProjectAutosave<number, number>({
    current: () => true,
    write: async (n) => {
      written.push(n);
      return n;
    },
    saved: () => {},
    conflict: () => false,
  });
  for (let n = 0; n < 5; n++) {
    saver.enqueue(n);
    t.mock.timers.tick(400);
  }
  assert.deepEqual(written, [4]);
  await saver.flush();
  saver.dispose();
});

test("a CAS conflict stops queued writes and a disposed write publishes no saved receipt", async () => {
  let saved = 0;
  let resolve: ((receipt: number) => void) | undefined;
  const saver = createProjectAutosave<number, number>({
    current: () => true,
    write: () =>
      new Promise((r) => {
        resolve = r;
      }),
    saved: () => {
      saved++;
    },
    conflict: () => false,
  });
  saver.enqueue(1);
  const writing = saver.flush();
  saver.dispose();
  resolve!(1);
  await writing;
  assert.equal(saved, 0);
  let calls = 0;
  const conflict = createProjectAutosave<number, number>({
    current: () => true,
    write: async () => {
      calls++;
      throw new Error("CAS conflict");
    },
    saved: () => {
      saved++;
    },
    conflict: () => true,
  });
  conflict.enqueue(1);
  await conflict.flush();
  conflict.enqueue(2);
  await conflict.retry();
  assert.equal(conflict.status().state, "conflict");
  assert.equal(calls, 1);
  conflict.dispose();
});

test("an external conflict fences an in-flight write and preserves the unsaved state", async () => {
  let release: ((value: number) => void) | undefined;
  let saved = 0;
  const saver = createProjectAutosave<number, number>({
    current: () => true,
    write: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    saved: () => {
      saved++;
    },
    conflict: () => false,
  });
  saver.enqueue(1);
  const writing = saver.flush();
  saver.stop();
  release!(1);
  await writing;
  assert.equal(saver.status().state, "conflict");
  assert.equal(saved, 0);
  saver.dispose();
});

test("flush includes a capture queued as the active write finishes", async () => {
  const written: number[] = [];
  let queued = false;
  let finalFlush: Promise<void> | undefined;
  const saver = createProjectAutosave<number, number>({
    current: () => true,
    write: async (value) => {
      written.push(value);
      return value;
    },
    saved: () => {},
    conflict: () => false,
    changed: () => {
      if (!queued && saver.status().state === "saved") {
        queued = true;
        saver.enqueue(2);
        finalFlush = saver.flush();
      }
    },
  });
  saver.enqueue(1);
  await saver.flush();
  await finalFlush;
  assert.deepEqual(written, [1, 2]);
  assert.equal(saver.status().state, "saved");
  saver.dispose();
});
