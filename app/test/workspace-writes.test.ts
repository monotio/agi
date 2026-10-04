import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceWrites } from "../src/studio/workspace/workspaceWrites.ts";
test("typing coalesces while completed gestures keep their order; flush retains the last text", async () => {
  const calls: [string, string][] = [];
  const writes = createWorkspaceWrites({
    delay: 20,
    maximum: 50,
    async write(key, content) {
      calls.push([key, String(content)]);
    },
    changed() {},
    error(error) {
      throw error;
    },
  });
  writes.edit("logic:1", "p");
  writes.edit("logic:1", "print");
  writes.edit("picture:1", "red");
  writes.edit("logic:1", "print(m1);");
  await writes.flush();
  assert.deepEqual(calls, [
    ["picture:1", "red"],
    ["logic:1", "print(m1);"],
  ]);
  writes.edit("logic:1", "return;");
  writes.dispose();
  await writes.flush();
  assert.equal(calls.length, 2);
});

test("a refused live edit retains its text and retries it without holding Undo busy", async () => {
  let fail = true;
  let latest: Readonly<Record<string, string | Uint8Array>> = {};
  let busy = false;
  const writes = createWorkspaceWrites({
    async write() {
      if (fail) throw new Error("refused");
    },
    changed(drafts, next) {
      latest = drafts;
      busy = next;
    },
    error() {},
  });
  writes.edit("logic:1", "print(m1);");
  await assert.rejects(writes.flush(), /logic:1.*refused/);
  await assert.rejects(writes.retry(), /logic:1.*refused/);
  assert.equal(latest["logic:1"], "print(m1);");
  assert.equal(busy, false);
  fail = false;
  await writes.retry();
  assert.deepEqual(latest, {});
  writes.dispose();
});

test("flush includes arriving edits and refuses a failed second write", async () => {
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let fail = true;
  const writes = createWorkspaceWrites({
    async write(_key, content) {
      if (content === "first") {
        entered();
        await started;
      } else if (fail) throw new Error("second refused");
    },
    changed() {},
    error() {},
  });
  writes.edit("notes", "first");
  const barrier = writes.flush();
  await entering;
  writes.edit("logic:1", "second");
  release();
  await assert.rejects(barrier, /logic:1.*second refused/);
  fail = false;
  await writes.retry();
  await writes.flush();
  writes.dispose();
});

test("the workspace barrier includes edits arriving during durable persistence and rejects its failure", async () => {
  let release!: () => void;
  let started!: () => void;
  const entering = new Promise<void>((resolve) => {
    started = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  let durableCalls = 0;
  let fail = false;
  const writes = createWorkspaceWrites({
    async write(_key, content) {
      calls.push(String(content));
    },
    async durable() {
      if (++durableCalls === 1) {
        started();
        await waiting;
      }
      if (fail) throw new Error("durable storage refused");
    },
    changed() {},
    error() {},
  });
  writes.edit("notes", "first");
  const flush = writes.flush();
  await entering;
  writes.edit("logic:1", "arrived during save");
  release();
  await flush;
  assert.deepEqual(calls, ["first", "arrived during save"]);
  assert.equal(durableCalls, 2);
  fail = true;
  await assert.rejects(writes.flush(), /durable storage refused/);
  await assert.rejects(writes.retry(), /durable storage refused/);
  fail = false;
  await writes.retry();
  writes.dispose();
});

test("a save refusal uses one period before the next action", async () => {
  const writes = createWorkspaceWrites({
    async write() {
      throw new Error("Project session is closed for writes.");
    },
    changed() {},
    error() {},
  });
  writes.edit("notes", "local");
  await assert.rejects(writes.flush(), {
    message: "Could not save notes: Project session is closed for writes. Retry the save.",
  });
  writes.dispose();
});

test("Retry carries the exact retained resource bytes", async () => {
  const calls: Uint8Array[] = [];
  let fail = true;
  const writes = createWorkspaceWrites({
    async write(_key, content) {
      calls.push(content as Uint8Array);
      if (fail) throw new Error("refused gesture");
    },
    changed() {},
    error() {},
  });
  const bytes = Uint8Array.of(1);
  writes.edit("sound:1", bytes);
  await assert.rejects(writes.flush(), /refused gesture/);
  fail = false;
  await writes.retry();
  assert.deepEqual(calls, [bytes, bytes]);
  writes.dispose();
});
