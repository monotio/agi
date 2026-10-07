import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { beginProviderTask, trackImageSpend } from "../src/agent/providerBudget.ts";
import { AgentRun } from "../src/agent/agentRun.ts";
beforeEach(() => beginProviderTask(5));
test("images charge actual usage without reserving or predicting a request", () => {
  const account = beginProviderTask(5);
  account.spent = 4;
  const first = trackImageSpend();
  const second = trackImageSpend();
  assert.equal(account.spent, 4);
  first(0.6);
  second(0.5);
  assert.equal(account.spent, 5.1);
  assert.equal(account.limit, 5);
});
test("image usage pauses an agent before its next paid request", async () => {
  const run = new AgentRun("gpt-6-sol", () => {}, 1);
  const result = run.run(async () => {
    trackImageSpend()(1.1);
    await run.checkpoint();
    return "kept";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.snapshot().status, "paused");
  assert.equal(run.snapshot().spent, 1.1);
  run.resume();
  assert.equal(await result, "kept");
});
test("starting an agent keeps an image request's account and usage", async () => {
  beginProviderTask(1);
  const settle = trackImageSpend();
  const run = new AgentRun("gpt-6-sol", () => {}, 1);
  await run.run(async () => {
    try {
      assert.doesNotThrow(() => trackImageSpend());
    } finally {
      settle(0.6);
    }
    assert.equal(run.snapshot().spent, 0.6);
  });
});
test("an agent request spends nothing while its response is pending", async () => {
  const run = new AgentRun("gpt-6-sol", () => {}, 1);
  let finish!: () => void;
  const response = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const result = run.run(() => run.request(async () => response));
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.doesNotThrow(() => trackImageSpend());
  } finally {
    finish();
    await result;
  }
});

test("unreported image requests mark usage incomplete and spend only reported charges", () => {
  const account = beginProviderTask(5);
  const settle = trackImageSpend();
  assert.equal(account.reportedSpent, 0);
  settle(null);
  assert.equal(account.reportedSpent, 0);
  assert.equal(account.usageIncomplete, true);
  assert.equal(account.spent, 0);
});

test("partial image usage counts only the reported charge", () => {
  const account = beginProviderTask(5);
  trackImageSpend()(null, 0.018);
  assert.equal(account.reportedSpent, 0.018);
  assert.equal(account.spent, 0.018);
  assert.equal(account.usageIncomplete, true);
});

test("starting an agent retains a completed image charge in the same task", async () => {
  beginProviderTask(1);
  trackImageSpend()(0.8);
  const run = new AgentRun("gpt-6-sol", () => {}, 1);
  await run.run(async () => {
    assert.equal(run.snapshot().spent, 0.8);
    assert.doesNotThrow(() => trackImageSpend());
  });
});

test("an image receipt updates the active task's visible spend immediately", async () => {
  const seen: number[] = [];
  const run = new AgentRun("gpt-6-sol", (state) => seen.push(state.spent));
  await run.run(async () => {
    trackImageSpend()(0.47);
    assert.equal(seen.at(-1), 0.47);
  });
});
