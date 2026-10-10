import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { AgentRun } from "../src/agent/agentRun.ts";
import { beginProviderTask } from "../src/agent/providerBudget.ts";
import { MODEL_CAPABILITIES, defaultModelEffort } from "../../src/agent/modelEffort.ts";
import { createAnthropicConversation, createOpenAiConversation } from "../src/agent/llmClient.ts";
import { providerSse } from "../../test/provider-stream.ts";

beforeEach(() => beginProviderTask(5));

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("verified models expose input/output ceilings and multistep effort defaults", () => {
  for (const capability of Object.values(MODEL_CAPABILITIES)) {
    if (capability.provider === "stub") continue;
    assert.equal(capability.maxOutputTokens, 128000);
    assert.equal(capability.maxInputTokens, capability.provider === "openai" ? 922000 : 1000000);
  }
  assert.equal(defaultModelEffort("claude-sonnet-5-5"), "medium");
});

test("admitted requests keep the model output ceiling across remaining allowances", async () => {
  for (const budget of [0.5, 5]) {
    const run = new AgentRun("gpt-6-sol", () => {}, budget);
    await run.run(() => run.request(async (_signal, maxTokens) => assert.equal(maxTokens, 128000)));
  }
});

test("a small budget sends a request and pauses only after actual usage reaches it", async () => {
  const run = new AgentRun("gpt-6-sol", () => {}, 0.2);
  let sends = 0;
  const work = run.run(() =>
    run.request(async () => {
      sends++;
      run.recordUsage({ input: 0, output: 20_000, cachedInput: 0, cacheWriteInput: 0 });
    }),
  );
  await settle();
  assert.equal(sends, 1);
  assert.equal(run.snapshot().status, "paused");
  assert.match(run.snapshot().reason, /Budget reached/);
  run.resume();
  await work;
});

for (const change of ["revision", "image", "audio"] as const) {
  test(`repeat observations distinguish a changed ${change}`, async () => {
    const run = new AgentRun("gpt-6-sol", () => {});
    const work = run.run(async () => {
      for (let i = 0; i < 16; i++) {
        run.recordTool(
          "inspect",
          {},
          {
            success: true,
            images: [
              {
                png: Uint8Array.of(change === "image" ? i : 0),
                mime: "image/png",
                caption: "screen",
              },
            ],
            audio: [
              {
                wav: Uint8Array.of(change === "audio" ? i : 0),
                mimeType: "audio/wav",
                caption: "sound",
              },
            ],
          },
          change === "revision" ? `revision-${i}` : "same-revision",
        );
      }
      await run.checkpoint(false);
    });
    await settle();
    const status = run.snapshot().status;
    run.resume();
    await work;
    assert.notEqual(status, "paused");
  });
}

test("unpriced models send without inventing spend or reserving a budget", async () => {
  const run = new AgentRun("unpriced", () => {});
  await run.run(() => run.request(async () => "sent"));
  assert.equal(run.snapshot().requests, 1);
  assert.equal(run.snapshot().spent, 0);
  assert.equal(run.snapshot().priceKnown, false);
});

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider} configures counted-input compaction and preserves the audit`, async (t) => {
    const bodies: Record<string, unknown>[] = [];
    const headers: Headers[] = [];
    let countedInput = 0;
    const threshold = provider === "openai" ? 691500 : 750000;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      headers.push(new Headers(init?.headers));
      countedInput = bodies.length === 1 ? threshold - 1 : threshold;
      const compact = countedInput >= threshold;
      return new Response(
        providerSse(
          provider,
          provider === "openai"
            ? {
                id: "one",
                output: compact
                  ? [{ type: "compaction", id: "c", encrypted_content: "opaque" }]
                  : [
                      {
                        type: "message",
                        id: "m",
                        role: "assistant",
                        status: "completed",
                        content: [{ type: "output_text", text: "Working.", annotations: [] }],
                      },
                    ],
              }
            : {
                id: "one",
                type: "message",
                role: "assistant",
                stop_reason: "end_turn",
                content: compact
                  ? [{ type: "compaction", content: "summary", encrypted_content: "opaque" }]
                  : [{ type: "text", text: "Working." }],
                usage: { input_tokens: countedInput, output_tokens: 10 },
              },
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const config = {
      provider,
      model: provider === "openai" ? "gpt-6-sol" : "claude-opus-5-5",
      apiKey: "placeholder",
    };
    const conversation =
      provider === "openai"
        ? createOpenAiConversation(config)
        : createAnthropicConversation(config);
    await conversation.sendUserMessage("Keep this audit entry.");
    const before = conversation.getTranscript();
    await conversation.sendUserMessage("Continue.");
    const atThreshold = conversation.getTranscript();
    await conversation.sendUserMessage("After compaction.");
    const management = bodies[0]?.["context_management"];
    assert.deepEqual(
      management,
      provider === "openai"
        ? [{ type: "compaction", compact_threshold: 691500 }]
        : {
            edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 750000 } }],
          },
    );
    assert.deepEqual(conversation.getTranscript().slice(0, before.length), before);
    assert.deepEqual(conversation.getTranscript().slice(0, atThreshold.length), atThreshold);
    const atBoundary = bodies[1]?.[provider === "openai" ? "input" : "messages"];
    assert.match(JSON.stringify(atBoundary), /Keep this audit entry/);
    assert.doesNotMatch(JSON.stringify(atBoundary), /opaque/);
    const context = bodies[2]?.[provider === "openai" ? "input" : "messages"];
    assert.match(JSON.stringify(context), /opaque/);
    assert.doesNotMatch(JSON.stringify(context), /Keep this audit entry/);
    if (provider === "anthropic") {
      assert.equal(bodies[0]?.["fallbacks"], "default");
      assert.match(headers[0]?.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
      assert.match(headers[0]?.get("anthropic-beta") ?? "", /compact-2026-01-12/);
    }
  });
}

test("Claude Haiku 5.5 requests leave out the server-side fallback it does not have", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const headers: Headers[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    headers.push(new Headers(init?.headers));
    return new Response(
      providerSse("anthropic", {
        id: "one",
        type: "message",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Working." }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const conversation = createAnthropicConversation({
    provider: "anthropic",
    model: "claude-haiku-5-5",
    apiKey: "placeholder",
  });
  await conversation.sendUserMessage("Inspect the room.");
  assert.equal(bodies[0]?.["model"], "claude-haiku-5-5");
  assert.equal("fallbacks" in (bodies[0] ?? {}), false);
  assert.doesNotMatch(headers[0]?.get("anthropic-beta") ?? "", /server-side-fallback/);
  assert.match(headers[0]?.get("anthropic-beta") ?? "", /compact-2026-01-12/);
});

test("a final Anthropic refusal ends the active task with a distinct cause", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        providerSse("anthropic", {
          id: "refused",
          type: "message",
          role: "assistant",
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber" },
          content: [],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const run = new AgentRun("claude-opus-5-5", () => {});
  const conversation = createAnthropicConversation(
    { provider: "anthropic", model: "claude-opus-5-5", apiKey: "placeholder" },
    undefined,
    run,
  );
  await assert.rejects(
    run.run(() => conversation.sendUserMessage("Inspect the room.")),
    (error: unknown) => {
      assert.equal((error as { outcome: string }).outcome, "refused");
      assert.match(String(error), /declined this request \(cyber\)/);
      return true;
    },
  );
  assert.equal(run.snapshot().status, "idle");
});

test("fallback usage is charged at the serving model's verified price", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        providerSse("anthropic", {
          id: "fallback",
          type: "message",
          role: "assistant",
          stop_reason: "end_turn",
          content: [],
          usage: {
            input_tokens: 0,
            output_tokens: 1000,
            iterations: [
              {
                type: "message",
                model: "claude-opus-5-5",
                input_tokens: 0,
                output_tokens: 0,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_creation: null,
              },
              {
                type: "fallback_message",
                model: "claude-sonnet-5-5",
                input_tokens: 0,
                output_tokens: 1000,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_creation: null,
              },
            ],
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const run = new AgentRun("claude-opus-5-5", () => {});
  const conversation = createAnthropicConversation(
    { provider: "anthropic", model: "claude-opus-5-5", apiKey: "placeholder" },
    undefined,
    run,
  );
  await run.run(() => conversation.sendUserMessage("Continue."));
  assert.equal(run.snapshot().spent, 0.01);
});
