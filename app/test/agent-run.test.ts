import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRun } from "../src/agent/agentRun.ts";

test("budget pauses before another request and Continue preserves the task", async () => {
  const run = new AgentRun("gpt-6-sol", () => {}, 1);
  const result = run.run(async () => {
    // 100,000 output tokens at $10/M.
    run.recordUsage({ input: 0, cachedInput: 0, cacheWriteInput: 0, output: 100_000 });
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
  const run = new AgentRun("gpt-6-sol", () => {});
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
  const run = new AgentRun("gpt-6-sol", () => {});
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

test("cache reads use the per-model rate, and 10% of input where none is listed", () => {
  const fable = new AgentRun("claude-fable-5-1", () => {});
  fable.run(async () => {
    fable.recordUsage({ input: 1_000_000, cachedInput: 1_000_000, cacheWriteInput: 0, output: 0 });
  });
  assert.equal(fable.snapshot().spent, 0.25);
  // Opus 5.5 lists $0.20/M; 10% of its $4 input would be $0.40.
  const opus = new AgentRun("claude-opus-5-5", () => {});
  opus.run(async () => {
    opus.recordUsage({ input: 1_000_000, cachedInput: 1_000_000, cacheWriteInput: 0, output: 0 });
  });
  assert.equal(opus.snapshot().spent, 0.2);
  // GPT-6 Sol lists no cache rate: 100,000 reads at 10% of $2/M, below the long-context threshold.
  const sol = new AgentRun("gpt-6-sol", () => {});
  sol.run(async () => {
    sol.recordUsage({ input: 100_000, cachedInput: 100_000, cacheWriteInput: 0, output: 0 });
  });
  assert.equal(sol.snapshot().spent, 0.02);
});

test("a long task and a long request run on without a wall-clock stop", async (t) => {
  // A 15-minute pause and a 10-minute request abort used to stop unattended
  // work that was still progressing; Opus 5.5 at high effort already takes
  // five minutes for one response. The budget and Stop remain the controls.
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const run = new AgentRun("gpt-6-sol", () => {});
  let aborted = false;
  let pausedAfter16Minutes = false;
  const result = run.run(async () => {
    t.mock.timers.tick(16 * 60_000);
    const checked = run.checkpoint();
    pausedAfter16Minutes = run.snapshot().status === "paused";
    run.resume();
    await checked;
    return run.request(async (signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      t.mock.timers.tick(11 * 60_000);
      return "streamed";
    });
  });
  // Resume any later pause so the old behaviour fails instead of hanging.
  let pausedLater = false;
  for (let turn = 0; turn < 100; turn++) {
    await Promise.resolve();
    if (run.snapshot().status === "paused") {
      pausedLater = true;
      run.resume();
    }
  }
  const answer = await result;
  assert.equal(pausedAfter16Minutes, false, "no pause at 15 minutes");
  assert.equal(pausedLater, false, "no pause after a long request");
  assert.equal(aborted, false, "no abort at 10 minutes");
  assert.equal(answer, "streamed");
});
