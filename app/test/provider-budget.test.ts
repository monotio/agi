import { test } from "node:test";
import assert from "node:assert/strict";
import { beginProviderBudget, reserveImageBudget } from "../src/agent/providerBudget.ts";
import { AgentRun } from "../src/agent/agentRun.ts";
test("image reservations share agent allowance and require approval before crossing it", () => {
  const account = beginProviderBudget(5);
  account.spent = 4;
  const settle = reserveImageBudget(0.8);
  assert.throws(() => reserveImageBudget(0.3), /may pass your budget/);
  settle(0.6);
  assert.equal(account.spent, 4.6);
  assert.equal(account.reserved, 0);
  reserveImageBudget(1, true)(1);
  assert.ok(account.limit >= account.spent);
});
test("image usage pauses an agent before its next paid request", async () => {
  const run = new AgentRun("gpt-6-sol", () => {}, 1);
  const result = run.run(async () => {
    reserveImageBudget(0.9)(0.9);
    await run.checkpoint();
    return "kept";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.snapshot().status, "paused");
  assert.equal(run.snapshot().spent, 0.9);
  run.resume();
  assert.equal(await result, "kept");
});
test("starting an agent keeps an image request's reservation and usage", async () => {
  beginProviderBudget(5);
  const settle = reserveImageBudget(0.8);
  const run = new AgentRun("gpt-6-sol", () => {}, 1);
  await run.run(async () => {
    try {
      assert.throws(() => reserveImageBudget(0.3), /may pass your budget/);
    } finally {
      settle(0.6);
    }
    assert.equal(run.snapshot().spent, 0.6);
  });
});
test("an agent request reserves allowance while its response is pending", async () => {
  const run = new AgentRun("gpt-6-sol", () => {}, 1);
  let finish!: () => void;
  const response = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const result = run.run(() => run.request(async () => response));
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.throws(() => reserveImageBudget(0.9), /may pass your budget/);
  } finally {
    finish();
    await result;
  }
});

test("unreported image requests keep a budget hold without reporting it as spent", () => {
  const account = beginProviderBudget(5);
  const settle = reserveImageBudget(0.8);
  assert.equal(account.reportedSpent, 0);
  settle(null);
  assert.equal(account.reportedSpent, 0);
  assert.equal(account.usageIncomplete, true);
  assert.equal(account.spent, 0.8);
});

test("partial image usage holds at least the reported charge against the budget", () => {
  const account = beginProviderBudget(5);
  reserveImageBudget(0.01)(null, 0.018);
  assert.equal(account.reportedSpent, 0.018);
  assert.equal(account.spent, 0.018);
  assert.equal(account.usageIncomplete, true);
});
