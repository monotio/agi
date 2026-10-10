import assert from "node:assert/strict";
import test from "node:test";
import { taskSpendLabel } from "../src/agent/agentTaskPresentation.ts";

test("task spend separates reported charges from a budget and missing usage", () => {
  assert.equal(
    taskSpendLabel({
      spent: 0,
      budget: 5,
      priceKnown: true,
      usageIncomplete: false,
      requests: 1,
      status: "running",
    }),
    "$5 budget · usage pending",
  );
  assert.equal(
    taskSpendLabel({
      spent: 2,
      budget: 5,
      priceKnown: true,
      usageIncomplete: false,
      requests: 1,
      status: "idle",
    }),
    "$2 / $5 spent",
  );
  assert.equal(
    taskSpendLabel({
      spent: 0,
      budget: 5,
      priceKnown: true,
      usageIncomplete: true,
      requests: 1,
      status: "idle",
    }),
    "$5 budget · usage pending",
  );
  assert.equal(
    taskSpendLabel({
      spent: 0.019,
      budget: 5,
      priceKnown: true,
      usageIncomplete: true,
      requests: 1,
      status: "idle",
    }),
    "$0.01+ / $5 spent",
  );
  assert.equal(
    taskSpendLabel({
      spent: 0,
      budget: 5,
      priceKnown: false,
      usageIncomplete: true,
      requests: 0,
      status: "idle",
    }),
    "$5 budget",
  );
  assert.equal(
    taskSpendLabel({
      spent: 0,
      budget: 5,
      priceKnown: false,
      usageIncomplete: true,
      requests: 1,
      status: "idle",
    }),
    "$5 budget · usage unavailable",
  );
});
