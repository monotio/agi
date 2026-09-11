import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MODEL_CAPABILITIES,
  defaultModelEffort,
  modelCapability,
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

test("the capability table covers every shipped model with provider-verified fields", () => {
  for (const [model, capability] of Object.entries(MODEL_CAPABILITIES)) {
    assert.ok(capability.effort.includes(capability.defaultEffort), `${model} default is offered`);
    assert.equal(
      capability.caching === "breakpoint",
      capability.provider === "anthropic",
      `${model} caching matches its provider`,
    );
    assert.equal(
      capability.strictSchema,
      capability.provider === "openai",
      `${model} strict-schema matches its provider`,
    );
    if (capability.provider !== "stub")
      assert.ok(capability.price && capability.price.input > 0, `${model} has a tested price`);
  }
});

test("unlisted models get provider-derived policy, not name-prefix guesses", () => {
  assert.equal(modelCapability("claude-kept", "anthropic").defaultEffort, "high");
  assert.equal(modelCapability("gpt-retired", "openai").defaultEffort, "medium");
  assert.equal(modelCapability("anything", "openai").strictSchema, true);
  assert.equal(modelCapability("anything", "anthropic").caching, "breakpoint");
  assert.equal(modelCapability("claude-kept").price, undefined);
});
