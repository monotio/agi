/**
 * The eval lanes name real, capability-tested model ids. GPT-6.1 Sol is its
 * own id beside the original GPT-6 Sol: the matrices select each
 * independently, and no generated lane carries an effort its model cannot
 * honor. Env and the shipped tables only — no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MODELS,
  MODEL_CAPABILITIES,
  MODEL_OPTIONS,
  modelEffortOptions,
  type ModelEffort,
} from "../../src/agent/modelEffort.ts";
import { MODEL_IDS, providerMatrix } from "../configs/providers.ts";
import { requestCost } from "../lib/usage.ts";

function fakeLiveEnv(t: { after: (fn: () => void) => void }) {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  process.env["EVAL_LIVE"] = "1";
  process.env["OPENAI_API_KEY"] = "sk-test-placeholder";
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-placeholder";
}

test("GPT-6.1 Sol is the distinct default id beside the original Sol", () => {
  assert.equal(MODEL_IDS.gpt61Sol, "gpt-6.1-sol");
  assert.notEqual(MODEL_IDS.gpt61Sol, MODEL_IDS.gpt6Sol);
  assert.equal(DEFAULT_MODELS.openai, MODEL_IDS.gpt61Sol);
  assert.equal(MODEL_OPTIONS.openai[0]?.id, MODEL_IDS.gpt61Sol);
  const capability = MODEL_CAPABILITIES[MODEL_IDS.gpt61Sol];
  assert.ok(capability, "gpt-6.1-sol has a capability entry");
  assert.equal(capability.provider, "openai");
  assert.equal(capability.caching, "implicit");
  assert.equal(capability.strictSchema, true);
  // Low through max, default medium; none and minimal are not supported.
  assert.deepEqual(capability.effort, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(capability.defaultEffort, "medium");
  assert.deepEqual(capability.price, {
    input: 2,
    output: 10,
    longContext: true,
    cacheRead: 0.1,
  });
  // The original Sol keeps its optional-none capability and stays selectable.
  assert.ok(MODEL_OPTIONS.openai.some((option) => option.id === MODEL_IDS.gpt6Sol));
  assert.deepEqual(MODEL_CAPABILITIES[MODEL_IDS.gpt6Sol]?.effort, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("the genesis lanes select each Sol id independently", (t) => {
  fakeLiveEnv(t);
  process.env["EVAL_RUN_BUDGET_USD"] = "1";
  const ids = (lanes: ReturnType<typeof providerMatrix>) => lanes.map((lane) => lane.id);
  assert.deepEqual(ids(providerMatrix()), [
    `openai:responses:${MODEL_IDS.gpt61Sol}`,
    `openai:responses:${MODEL_IDS.gpt6Sol}`,
    `openai:responses:${MODEL_IDS.gpt6Astra}`,
    `anthropic:messages:${MODEL_IDS.claudeOpus55}`,
  ]);
  assert.deepEqual(ids(providerMatrix({ includeSol61: false })), [
    `openai:responses:${MODEL_IDS.gpt6Sol}`,
    `openai:responses:${MODEL_IDS.gpt6Astra}`,
    `anthropic:messages:${MODEL_IDS.claudeOpus55}`,
  ]);
  assert.deepEqual(ids(providerMatrix({ includeSol: false })), [
    `openai:responses:${MODEL_IDS.gpt61Sol}`,
    `openai:responses:${MODEL_IDS.gpt6Astra}`,
    `anthropic:messages:${MODEL_IDS.claudeOpus55}`,
  ]);
  // Every generated lane sends an effort its model accepts.
  for (const lane of providerMatrix({ effort: "low" })) {
    const model = lane.id.split(":").at(-1)!;
    const effort = (lane.config["reasoning"] as { effort?: ModelEffort } | undefined)?.effort;
    if (effort !== undefined)
      assert.ok(modelEffortOptions(model).includes(effort), `${model} honors effort ${effort}`);
  }
});

test("a lane refuses an effort its model cannot honor instead of sending it", (t) => {
  fakeLiveEnv(t);
  process.env["EVAL_RUN_BUDGET_USD"] = "1";
  // GPT-6.1 Sol accepts no none: the descriptor is never built.
  assert.throws(
    () =>
      providerMatrix({
        effort: "none",
        includeAstra: false,
        includeSol: false,
        includeAnthropic: false,
      }),
    /none is not supported by gpt-6\.1-sol/,
  );
  // An openaiConfig reasoning override is the effective effort and is checked too.
  assert.throws(
    () =>
      providerMatrix({
        includeAstra: false,
        includeSol: false,
        includeAnthropic: false,
        openaiConfig: { reasoning: { effort: "none" } },
      }),
    /none is not supported by gpt-6\.1-sol/,
  );
  // The original Sol still runs effort none on its own.
  const solOnly = providerMatrix({
    effort: "none",
    includeSol61: false,
    includeAstra: false,
    includeAnthropic: false,
  });
  assert.deepEqual(
    solOnly.map((lane) => lane.id),
    [`openai:responses:${MODEL_IDS.gpt6Sol}`],
  );
  assert.deepEqual(solOnly[0]?.config["reasoning"], { effort: "none" });
});

test("a reasoning override keeps its fields and the label still names the sent effort", (t) => {
  fakeLiveEnv(t);
  process.env["EVAL_RUN_BUDGET_USD"] = "1";
  // {summary:"auto"} contributes no effort: the lane's own effort applies, and
  // the descriptor's reasoning carries it — the label must match what is sent.
  const lanes = providerMatrix({
    effort: "low",
    includeSol: false,
    includeAstra: false,
    includeAnthropic: false,
    openaiConfig: { reasoning: { summary: "auto" } },
  });
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0]!.label, `openai:${MODEL_IDS.gpt61Sol}@low`);
  assert.deepEqual(lanes[0]!.config["reasoning"], { summary: "auto", effort: "low" });
  // Malformed reasoning (null or non-object) refuses rather than mislabels.
  for (const reasoning of [null, "auto"])
    assert.throws(
      () =>
        providerMatrix({
          includeSol: false,
          includeAstra: false,
          includeAnthropic: false,
          openaiConfig: { reasoning },
        }),
      /reasoning/i,
    );
});

test("the effort matrix runs both Sol ids at only their supported efforts", async (t) => {
  fakeLiveEnv(t);
  process.env["EVAL_EFFORT_RUN_BUDGET_USD"] = "1";
  const { default: config } = await import("../configs/effort.ts");
  const lanes = (config.providers ?? []) as {
    label: string;
    config: Record<string, unknown>;
  }[];
  for (const model of [MODEL_IDS.gpt61Sol, MODEL_IDS.gpt6Sol])
    assert.ok(
      lanes.some((lane) => lane.config["model"] === model),
      `${model} has effort lanes`,
    );
  for (const lane of lanes) {
    const model = String(lane.config["model"]);
    const effort = lane.config["effort"] as ModelEffort | undefined;
    if (effort !== undefined)
      assert.ok(
        modelEffortOptions(model).includes(effort),
        `${lane.label} sends an effort ${model} does not support`,
      );
  }
});

test("the cost calculator prices GPT-6.1 Sol at its listed rates", () => {
  // $2/M input, $10/M output; cache reads at the listed $0.10/M, not 10%.
  assert.equal(
    requestCost(MODEL_IDS.gpt61Sol, {
      input: 100_000,
      output: 10_000,
      cachedInput: 100_000,
      cacheWriteInput: 0,
    }),
    0.11,
  );
  // The original Sol reads the same cache at 10% of input ($0.20/M).
  assert.equal(
    requestCost(MODEL_IDS.gpt6Sol, {
      input: 100_000,
      output: 0,
      cachedInput: 100_000,
      cacheWriteInput: 0,
    }),
    0.02,
  );
  // Past 272K input tokens: 2x input and cache reads, 1.5x output.
  assert.equal(
    requestCost(MODEL_IDS.gpt61Sol, {
      input: 300_000,
      output: 10_000,
      cachedInput: 0,
      cacheWriteInput: 0,
    })?.toFixed(4),
    "1.3500",
  );
});
