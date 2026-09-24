import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_TOOLS } from "../../src/agent/tools.ts";
import { anthropicToolDefinitions } from "../../src/agent/toolTransport.ts";
import { bodyText, requestWithBody, runGenesisSession } from "../providers/genesis-session.ts";

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
      model: "gpt-6-sol",
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
    // An unfinished run still keeps what it built, as a Project archive.
    const project = readFileSync(report.artifacts.project!);
    assert.ok(project.includes("PROJECT.JSON"));
    assert.ok(project.includes("timeout"));
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("captures the actual Anthropic Genesis turn with the full tool catalog", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "agi-effort-anthropic-"));
  try {
    const report = await runGenesisSession({
      provider: "anthropic",
      model: "claude-opus-5-5",
      promptVariant: "lean",
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
    const catalog = anthropicToolDefinitions(AGENT_TOOLS);
    assert.deepEqual(
      body.tools.map((tool: { name: string }) => tool.name),
      catalog.map((tool) => tool.name),
      "Anthropic advertises the full stable catalog; availability is host-enforced",
    );
    // Genesis is one flow: the first request is the single genesis turn that
    // records the world through update_world and builds the opening room.
    assert.equal(body.messages[0].content.startsWith("### GENESIS:"), true);
    assert.equal(body.messages[0].content.endsWith("# Tiny template\n---"), true);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
