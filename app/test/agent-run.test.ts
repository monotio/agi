import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRun } from "../src/agent/agentRun.ts";

test("budget pauses before another request and Continue preserves the task", async () => {
  const run = new AgentRun("gpt-5.6-sol", () => {}, 1);
  const result = run.run(async () => {
    run.recordUsage({ input: 0, cachedInput: 0, cacheWriteInput: 0, output: 50000 });
    await run.checkpoint();
    return 42;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.snapshot().status, "paused");
  assert.equal(run.snapshot().spent, 1);
  run.resume();
  assert.equal(await result, 42);
});

test("productive runs can exceed old turn counts; repeated failures pause", async () => {
  const run = new AgentRun("gpt-5.6-sol", () => {});
  await run.run(async () => {
    for (let i = 0; i < 40; i++) {
      run.recordTool("read_logic", { num: i }, { success: true });
      await run.checkpoint();
    }
  });
  const stalled = run.run(async () => {
    for (let i = 0; i < 8; i++)
      run.recordTool(
        "write_logic_source",
        { source: "bad" },
        { success: false, error: "unknown action" },
      );
    await run.checkpoint();
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.snapshot().status, "paused");
  assert.match(run.snapshot().reason, /repeating/i);
  run.resume();
  await stalled;
});

test("Stop aborts an in-flight request, waits, then resumes without losing the task", async () => {
  const run = new AgentRun("gpt-5.6-sol", () => {});
  let attempts = 0;
  const result = run.run(() =>
    run.request(async (signal) => {
      if (++attempts > 1) return "kept";
      return await new Promise<string>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  run.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.snapshot().status, "paused");
  assert.equal(attempts, 1);
  run.resume();
  assert.equal(await result, "kept");
  assert.equal(run.snapshot().usageIncomplete, true);
});
