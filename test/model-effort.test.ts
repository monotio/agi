import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MODELS,
  MODEL_CAPABILITIES,
  defaultModelEffort,
  modelCapability,
  modelEffortOptions,
  providerUsageUrl,
  resolveModelEffort,
} from "../src/agent/modelEffort.ts";

test("every model gets an explicit pinned default effort", () => {
  assert.equal(defaultModelEffort("gpt-6.2-sol"), "medium");
  assert.equal(defaultModelEffort("gpt-6.2-astra"), "medium");
  assert.equal(defaultModelEffort("gpt-6.1-terra"), "medium");
  assert.equal(defaultModelEffort("gpt-6.1-sol"), "medium");
  assert.equal(defaultModelEffort("gpt-6-sol"), "medium");
  // Medium supports multistep Opus/Sonnet work; Fable starts at high.
  assert.equal(defaultModelEffort("claude-opus-5-5"), "medium");
  assert.equal(defaultModelEffort("claude-sonnet-5-5"), "medium");
  assert.equal(defaultModelEffort("claude-fable-5-2"), "high");
  assert.equal(defaultModelEffort("claude-fable-5-1"), "high");
  assert.equal(defaultModelEffort("gpt-6-astra"), "medium");
  assert.equal(DEFAULT_MODELS.gemini, "gemini-4-neon");
  assert.equal(defaultModelEffort("gemini-4-neon"), "high");
  assert.equal(defaultModelEffort("gemini-4-carbon"), "medium");
  assert.equal(defaultModelEffort("gemini-4-hydrogen"), "high");
});

test("effort none is offered only where the shipped OpenAI models accept it", () => {
  assert.deepEqual(modelEffortOptions("gpt-6.1-terra"), [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(modelEffortOptions("gpt-6-luna"), modelEffortOptions("gpt-6.1-terra"));
  assert.deepEqual(modelEffortOptions("gpt-6-sol"), modelEffortOptions("gpt-6.1-terra"));
  // Models that require reasoning, and ids outside the shipped catalog (retired
  // ones included), get the mandatory levels. GPT-6.2 Sol and Astra accept no none.
  for (const model of [
    "gpt-6.2-sol",
    "gpt-6.2-astra",
    "gpt-6.1-sol",
    "gpt-6-astra",
    "claude-opus-5-5",
    "claude-fable-5-2",
    "gpt-5.6-sol",
  ])
    assert.deepEqual(modelEffortOptions(model), ["low", "medium", "high", "xhigh", "max"], model);
});

test("resolveModelEffort applies the pinned default and rejects unsupported pairs", () => {
  assert.equal(resolveModelEffort("gpt-6.2-sol"), "medium");
  assert.throws(() => resolveModelEffort("gpt-6.2-sol", "none"), /none is not supported/);
  assert.equal(resolveModelEffort("gpt-6.1-terra"), "medium");
  assert.equal(resolveModelEffort("gpt-6.1-terra", "none"), "none");
  assert.equal(resolveModelEffort("claude-opus-5-5"), "medium");
  assert.throws(() => resolveModelEffort("claude-opus-5-5", "none"), /none is not supported/);
  assert.deepEqual(modelEffortOptions("gemini-4-neon"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(modelEffortOptions("gemini-4-hydrogen"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(modelEffortOptions("gemini-4-carbon"), ["low", "medium", "high"]);
  assert.equal(resolveModelEffort("gemini-4-neon"), "high");
  assert.equal(resolveModelEffort("gemini-4-neon", "xhigh"), "xhigh");
  assert.throws(() => resolveModelEffort("gemini-4-carbon", "xhigh"), /xhigh is not supported/);
  assert.throws(() => resolveModelEffort("gemini-4-neon", "max"), /max is not supported/);
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
  assert.equal(modelCapability("gemini-future", "gemini").defaultEffort, "medium");
  assert.equal(modelCapability("gemini-future", "gemini").caching, "implicit");
  assert.equal(modelCapability("anything", "openai").strictSchema, true);
  assert.equal(modelCapability("anything", "anthropic").caching, "breakpoint");
  assert.equal(modelCapability("claude-kept").price, undefined);
  assert.equal(providerUsageUrl("anthropic"), "https://console.anthropic.com/settings/usage");
  assert.equal(providerUsageUrl("gemini"), "https://aistudio.google.com/usage");
  assert.equal(providerUsageUrl("openai"), "https://platform.openai.com/usage");
});
