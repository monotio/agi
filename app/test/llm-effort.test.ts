import assert from "node:assert/strict";
import { test } from "node:test";
import { providerSse } from "../../test/provider-stream.ts";
import {
  createAnthropicConversation,
  createGeminiConversation,
  createOpenAiConversation,
} from "../src/agent/llmClient.ts";

for (const provider of ["openai", "anthropic", "gemini"] as const) {
  test(`${provider} sends the selected effort with every conversation request`, async (t) => {
    const requests: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(
        providerSse(
          provider,
          provider === "openai"
            ? { id: `reply-${requests.length}`, output: [] }
            : provider === "gemini"
              ? {
                  responseId: `reply-${requests.length}`,
                  candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
                }
              : { id: `reply-${requests.length}`, content: [], stop_reason: "end_turn" },
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const config = {
      provider,
      model:
        provider === "openai"
          ? "gpt-6-sol"
          : provider === "gemini"
            ? "gemini-4-neon"
            : "claude-opus-5-5",
      apiKey: "test-placeholder",
      effort: "low" as const,
      systemPrompt: "Create the requested room and verify it.",
    };
    const conversation =
      provider === "openai"
        ? createOpenAiConversation(config)
        : provider === "gemini"
          ? createGeminiConversation(config)
          : createAnthropicConversation(config);
    await conversation.sendUserMessage("Inspect the room.");
    await conversation.sendUserMessage("Check the view.");
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.deepEqual(
        provider === "openai"
          ? request["instructions"]
          : provider === "gemini"
            ? (request["systemInstruction"] as { parts: { text: string }[] }).parts[0]?.text
            : (request["system"] as { text: string }[])[0]?.text,
        config.systemPrompt,
      );
      if (provider === "gemini") {
        assert.deepEqual(
          (request["generationConfig"] as { thinkingConfig?: unknown }).thinkingConfig,
          { thinkingLevel: "LOW" },
        );
      } else {
        assert.deepEqual(request[provider === "openai" ? "reasoning" : "output_config"], {
          effort: "low",
        });
      }
      if (provider === "anthropic")
        assert.deepEqual(request["cache_control"], { type: "ephemeral" });
    }
    if (provider === "anthropic") {
      const initialMessages = requests[0]!["messages"] as unknown[];
      const continuedMessages = requests[1]!["messages"] as unknown[];
      assert.ok(continuedMessages.length > initialMessages.length);
      assert.deepEqual(continuedMessages.slice(0, initialMessages.length), initialMessages);
    }
    if (provider === "gemini") {
      const initialContents = requests[0]!["contents"] as unknown[];
      const continuedContents = requests[1]!["contents"] as unknown[];
      assert.ok(continuedContents.length > initialContents.length);
      assert.deepEqual(continuedContents.slice(0, initialContents.length), initialContents);
    }
  });
}

for (const provider of ["openai", "anthropic", "gemini"] as const) {
  test(`${provider} retries a transient overload instead of failing the turn`, async (t) => {
    // Retries were disabled, so one 529, 503 or 429 ended a room or remix turn and
    // discarded its staged work. The client retries these with backoff.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      if (requests === 1)
        return new Response(
          JSON.stringify({ type: "error", error: { type: "overloaded_error" } }),
          {
            status: provider === "gemini" ? 503 : 529,
            headers: {
              "content-type": "application/json",
              ...(provider === "gemini" ? { "retry-after": "0" } : { "retry-after-ms": "10" }),
            },
          },
        );
      return new Response(
        providerSse(
          provider,
          provider === "openai"
            ? { id: "reply", output: [] }
            : provider === "gemini"
              ? {
                  responseId: "reply",
                  candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
                }
              : { id: "reply", content: [], stop_reason: "end_turn" },
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const config = {
      provider,
      model:
        provider === "openai"
          ? "gpt-6-sol"
          : provider === "gemini"
            ? "gemini-4-neon"
            : "claude-opus-5-5",
      apiKey: "test-placeholder",
    };
    const conversation =
      provider === "openai"
        ? createOpenAiConversation(config)
        : provider === "gemini"
          ? createGeminiConversation(config)
          : createAnthropicConversation(config);
    const turn = conversation.sendUserMessage("Inspect the room.");
    for (let i = 0; i < 20 && requests < 2; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1000);
    }
    await turn;
    assert.equal(requests, 2);
  });
}
