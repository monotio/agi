import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultModelEffort,
  modelEffortOptions,
  resolveModelEffort,
} from "../src/agent/modelEffort.ts";

test("every model gets an explicit pinned default effort", () => {
  assert.equal(defaultModelEffort("gpt-5.6-sol"), "low");
  assert.equal(defaultModelEffort("claude-opus-5"), "high");
  assert.equal(defaultModelEffort("gpt-6-astra"), "medium");
});

test("effort none is offered only where the shipped OpenAI models accept it", () => {
  assert.deepEqual(modelEffortOptions("gpt-5.6-sol"), [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(modelEffortOptions("gpt-5.6-terra"), modelEffortOptions("gpt-5.6-sol"));
  // Ids outside the shipped catalog, retired ones included, get the mandatory levels.
  for (const model of ["gpt-6-astra", "gpt-5.6-luna", "claude-opus-5"])
    assert.deepEqual(modelEffortOptions(model), ["low", "medium", "high", "xhigh", "max"], model);
});

test("resolveModelEffort applies the pinned default and rejects unsupported pairs", () => {
  assert.equal(resolveModelEffort("gpt-5.6-sol"), "low");
  assert.equal(resolveModelEffort("gpt-5.6-sol", "none"), "none");
  assert.equal(resolveModelEffort("claude-opus-5"), "high");
  assert.throws(() => resolveModelEffort("claude-opus-5", "none"), /none is not supported/);
});
