import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentRun } from "../src/agent/agentRun.ts";
import { createAnthropicConversation, createOpenAiConversation } from "../src/agent/llmClient.ts";
import { sseEvent, providerSse } from "../../test/provider-stream.ts";

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider} Stop aborts the stream and Continue retries without keeping a draft`, async (t) => {
    let requests = 0;
    let aborted = false;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      requests++;
      if (requests > 1)
        return new Response(
          providerSse(
            provider,
            provider === "openai"
              ? {
                  id: "finished",
                  output: [],
                  usage: { input_tokens: 4, output_tokens: 2 },
                }
              : {
                  id: "finished",
                  type: "message",
                  role: "assistant",
                  content: [],
                  usage: { input_tokens: 4, output_tokens: 2 },
                },
          ),
          { headers: { "content-type": "text/event-stream" } },
        );
      return new Response(
        new ReadableStream({
          start(controller) {
            init.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                controller.error(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
            const events =
              provider === "openai"
                ? [{ type: "response.output_text.delta", delta: "Discard this draft" }]
                : [
                    {
                      type: "message_start",
                      message: {
                        id: "partial",
                        role: "assistant",
                        content: [],
                        usage: { input_tokens: 10, output_tokens: 1 },
                      },
                    },
                    {
                      type: "content_block_start",
                      index: 0,
                      content_block: { type: "text", text: "" },
                    },
                    {
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "text_delta", text: "Discard this draft" },
                    },
                    {
                      type: "message_delta",
                      delta: { stop_reason: null },
                      usage: { output_tokens: 2 },
                    },
                    {
                      type: "message_delta",
                      delta: { stop_reason: null },
                      usage: { output_tokens: 3 },
                    },
                  ];
            controller.enqueue(new TextEncoder().encode(events.map(sseEvent).join("")));
            started();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    let paused!: () => void;
    const pause = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const run = new AgentRun(provider === "openai" ? "gpt-5.6-sol" : "claude-opus-5", (state) => {
      if (state.status === "paused") paused();
    });
    const config = { provider, apiKey: "placeholder", model: "test" };
    const conversation =
      provider === "openai"
        ? createOpenAiConversation(config, undefined, undefined, run)
        : createAnthropicConversation(config, undefined, run);
    const work = run.run(() => conversation.sendUserMessage("Hello"));
    void work.catch(() => {});
    try {
      await Promise.race([ready, work]);
      // Drain queued provider events before stopping the still-open response.
      for (let i = 0; i < 10; i++) await new Promise(setImmediate);
      assert.equal(run.snapshot().progress?.text, "Discard this draft");
      run.stop();
      await Promise.race([pause, work]);
      assert.equal(aborted, true);
      assert.equal(requests, 1);
      assert.equal(run.snapshot().progress, null);
      assert.equal(run.snapshot().usageIncomplete, true);
      assert.doesNotMatch(JSON.stringify(conversation.getTranscript()), /Discard this draft/);
      run.resume();
      await work;
      assert.equal(requests, 2);
      assert.deepEqual(conversation.getUsage?.(), {
        input: provider === "anthropic" ? 14 : 4,
        output: provider === "anthropic" ? 5 : 2,
        cachedInput: 0,
        cacheWriteInput: 0,
      });
    } finally {
      run.cancel();
      await work.catch(() => {});
    }
  });

  test(`${provider} streams text before completion and only stores the final response`, async (t) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = new AgentRun(provider === "openai" ? "gpt-5.6-sol" : "claude-opus-5", () => {});
    const config = { provider, apiKey: "placeholder", model: "test" };
    let request: Record<string, unknown> = {};
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      request = JSON.parse(String(init.body));
      return new Response(
        new ReadableStream({
          start(c) {
            controller = c;
            started();
          },
        }),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const conversation =
      provider === "openai"
        ? createOpenAiConversation(config, undefined, undefined, run)
        : createAnthropicConversation(config, undefined, run);
    const work = run.run(() => conversation.sendUserMessage("Hello"));
    void work.catch(() => {});
    await Promise.race([ready, work]);
    const events =
      provider === "openai"
        ? [
            { type: "response.created", response: { id: "r", status: "in_progress", output: [] } },
            { type: "response.output_text.delta", delta: "Hello, café" },
          ]
        : [
            {
              type: "message_start",
              message: {
                id: "r",
                role: "assistant",
                type: "message",
                content: [],
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Hello, café" },
            },
          ];
    try {
      // Every byte is a separate chunk, including the multi-byte é and SSE delimiters.
      for (const byte of new TextEncoder().encode(events.map(sseEvent).join("")))
        controller.enqueue(Uint8Array.of(byte));
      for (let i = 0; i < 30 && run.snapshot().progress?.text !== "Hello, café"; i++)
        await new Promise(setImmediate);
      assert.equal(request["stream"], true);
      assert.equal(run.snapshot().progress?.text, "Hello, café");
      assert.equal(conversation.getTranscript().length, 1, "draft output must not enter history");
      const ending =
        provider === "openai"
          ? providerSse(provider, {
              id: "r",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Hello, café" }],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 3 },
            })
          : [
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 3 },
              },
              { type: "message_stop" },
            ]
              .map(sseEvent)
              .join("");
      controller.enqueue(new TextEncoder().encode(ending));
      controller.close();
      const result = await work;
      assert.equal(result.text, "Hello, café");
      assert.deepEqual(result.toolCalls, []);
      assert.equal(run.snapshot().requests, 1);
      assert.equal(run.snapshot().progress, null);
      assert.equal(conversation.getUsage?.().output, 3);
    } finally {
      run.cancel();
      try {
        controller.close();
      } catch {
        /* Already closed or aborted. */
      }
      await work.catch(() => {});
    }
  });

  test(`${provider} rejects a dropped stream without executing or persisting partial tools`, async (t) => {
    const events =
      provider === "openai"
        ? [
            {
              type: "response.output_item.added",
              item: {
                type: "function_call",
                id: "tool",
                call_id: "call",
                name: "write_words",
                arguments: "",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: "tool",
              delta: '{"words":["lost"]}',
            },
          ]
        : [
            {
              type: "message_start",
              message: {
                id: "r",
                type: "message",
                role: "assistant",
                content: [],
                usage: { input_tokens: 10, output_tokens: 1 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "call", name: "write_words", input: {} },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '{"words":["lost"]}' },
            },
          ];
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(events.map(sseEvent).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const run = new AgentRun("gpt-5.6-sol", () => {});
    const config = { provider, apiKey: "placeholder", model: "test" };
    const conversation =
      provider === "openai"
        ? createOpenAiConversation(config, undefined, undefined, run)
        : createAnthropicConversation(config, undefined, run);
    await assert.rejects(
      run.run(() => conversation.sendUserMessage("Write")),
      /stream|message/i,
    );
    assert.equal(conversation.getTranscript().length, 1);
    assert.equal(run.snapshot().usageIncomplete, true);
    if (provider === "anthropic") assert.equal(conversation.getUsage?.().input, 10);
  });
}
