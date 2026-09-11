import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_TOOLS } from "../../src/agent/tools.ts";
import {
  bodyText,
  applyBaselineOverride,
  requestWithBody,
  runGenesisSession,
  type RequestTool,
} from "../providers/genesis-session.ts";

const captured = {
  instructions: "Historical system prompt",
  input: [
    {
      role: "user",
      content: "### GENESIS PHASE: Historical instructions\n---\n---\nname: old\n---\n# Old\n---",
    },
  ],
  tools: AGENT_TOOLS.map((tool) => ({
    type: "function",
    name: tool.name,
    description: `Historical ${tool.name}`,
    parameters: structuredClone(tool.parameters),
    strict: true,
  })),
};

function writeBaseline(directory: string) {
  const path = join(directory, "baseline.json");
  writeFileSync(path, JSON.stringify(captured), "utf8");
  return path;
}

test("baseline replay restores complete OpenAI and Anthropic tool schemas and Genesis user text", () => {
  const userPrompt = "OLD GENESIS\n---\nnew template";
  const variant = { tools: captured.tools, userPrompt };
  const changed = structuredClone(captured.tools);
  changed[0]!.description = "short";
  const nestedTool = changed.find((tool) =>
    Object.values(tool.parameters?.properties ?? {}).some(
      (property): property is { description: string } =>
        typeof property === "object" &&
        property !== null &&
        "description" in property &&
        typeof property.description === "string",
    ),
  );
  assert.ok(nestedTool);
  const nestedProperty = Object.values(nestedTool.parameters.properties).find(
    (property): property is { description: string } =>
      typeof property === "object" &&
      property !== null &&
      "description" in property &&
      typeof property.description === "string",
  );
  assert.ok(nestedProperty);
  nestedProperty.description = "short nested";
  const openai = applyBaselineOverride(
    { tools: changed, input: [{ role: "user", content: "### GENESIS PHASE: CURRENT" }] },
    variant,
    "openai",
  );
  assert.deepEqual(openai.tools, captured.tools);
  assert.ok(Array.isArray(openai.input));
  assert.equal(openai.input[0]?.content, userPrompt);

  const anthropicTools: RequestTool[] = changed.map(({ name, description, parameters }) => ({
    name,
    description,
    input_schema: parameters,
  }));
  anthropicTools.at(-1)!.cache_control = { type: "ephemeral" };
  const anthropic = applyBaselineOverride(
    {
      tools: anthropicTools,
      messages: [{ role: "user", content: "### GENESIS PHASE: CURRENT" }],
    },
    variant,
    "anthropic",
  );
  assert.deepEqual(anthropic.tools?.[0]?.input_schema, captured.tools[0]!.parameters);
  assert.equal(anthropic.messages?.[0]?.content, userPrompt);
  assert.deepEqual(anthropic.tools?.at(-1)?.cache_control, { type: "ephemeral" });

  const subset = applyBaselineOverride(
    { tools: anthropicTools.slice(2, 5), messages: [] },
    variant,
    "anthropic",
  );
  assert.ok(subset.tools);
  assert.deepEqual(
    subset.tools.map((tool) => tool.name),
    anthropicTools.slice(2, 5).map((tool) => tool.name),
  );
});

test("captures and reconstructs a Request body without losing request metadata", async () => {
  const original = new Request("https://example.test/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({ original: true }),
  });
  assert.equal(await bodyText(original), '{"original":true}');
  const [rewritten, init] = requestWithBody(original, undefined, '{"rewritten":true}');
  assert.equal(init, undefined);
  assert.ok(rewritten instanceof Request);
  assert.equal(rewritten.method, "POST");
  assert.equal(rewritten.headers.get("authorization"), "Bearer secret");
  assert.equal(await rewritten.text(), '{"rewritten":true}');
});

test("rewrites an init body while preserving the original input and options", () => {
  const input = "https://example.test/v1/messages";
  const init = { method: "POST", headers: { "x-test": "yes" }, body: "old" };
  const [rewrittenInput, rewrittenInit] = requestWithBody(input, init, "new");
  assert.equal(rewrittenInput, input);
  assert.deepEqual(rewrittenInit, { ...init, body: "new" });
  assert.equal(init.body, "old");
});

test("timeout cancels a production session and marks its usage incomplete", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "agi-effort-timeout-"));
  try {
    const report = await runGenesisSession({
      provider: "openai",
      model: "gpt-5.6-sol",
      effort: "medium",
      promptVariant: "lean",
      templateText: "# Tiny template",
      caseName: "timeout",
      outputRoot,
      timeoutMs: 30,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason), {
            once: true,
          });
        }),
    });
    assert.equal(report.completion, false);
    assert.equal(report.usageIncomplete, true);
    assert.match(report.error ?? "", /^Evaluation timed out after 30 ms\.$/);
    assert.equal(report.providerRequests, 1);
    assert.equal(report.effectiveEffort, "medium");
    assert.match(report.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(report.firstRequestSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(report.latency.providerFetchMs.length, 0);
    assert.match(report.latency.providerFetchDefinition, /fetch resolves/);
    const captured = readFileSync(report.artifacts.firstRequest, "utf8");
    assert.ok(captured.includes("Tiny template"));
    assert.ok(!captured.includes("test-placeholder"));
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("captures the actual Anthropic Genesis startup subset with baseline schemas", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "agi-effort-anthropic-"));
  try {
    const report = await runGenesisSession({
      provider: "anthropic",
      model: "claude-opus-5",
      promptVariant: "baseline",
      baselineRequestPath: writeBaseline(outputRoot),
      templateText: "  # Tiny template\n",
      caseName: "anthropic-snapshot",
      outputRoot,
      timeoutMs: 30,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason), {
            once: true,
          });
        }),
    });
    const body = JSON.parse(readFileSync(report.artifacts.firstRequest, "utf8"));
    const catalog = captured.tools;
    const catalogByName = new Map(catalog.map((tool) => [tool.name, tool]));
    assert.ok(body.tools.length < catalog.length, "Anthropic should send the selected tool subset");
    for (const tool of body.tools)
      assert.deepEqual(tool.input_schema, catalogByName.get(tool.name)!.parameters);
    assert.equal(body.messages[0].content.startsWith("### GENESIS PHASE:"), true);
    assert.equal(body.messages[0].content.endsWith("# Tiny template\n---"), true);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("reports a missing baseline artifact without attempting a provider request", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "agi-effort-missing-baseline-"));
  let fetchCalls = 0;
  try {
    const report = await runGenesisSession({
      provider: "openai",
      model: "gpt-5.6-sol",
      promptVariant: "baseline",
      baselineRequestPath: join(outputRoot, "absent.json"),
      templateText: "# Tiny template",
      caseName: "missing-baseline",
      outputRoot,
      fetchImpl: async () => {
        fetchCalls++;
        throw new Error("must not fetch");
      },
    });
    assert.equal(report.completion, false);
    assert.equal(report.usageIncomplete, true);
    assert.match(report.error ?? "", /Baseline request capture is missing/);
    assert.equal(fetchCalls, 0);
    assert.ok(readFileSync(report.artifacts.report, "utf8").includes("missing-baseline"));
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
