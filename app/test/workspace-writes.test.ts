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
  await writes.flush();
  assert.equal(latest["logic:1"], "print(m1);");
  assert.equal(busy, false);
  fail = false;
  await writes.retry();
  assert.deepEqual(latest, {});
  writes.dispose();
});
