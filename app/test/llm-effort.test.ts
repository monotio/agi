import assert from "node:assert/strict";
import { test } from "node:test";
import { providerSse } from "../../test/provider-stream.ts";
import { createAnthropicConversation, createOpenAiConversation } from "../src/agent/llmClient.ts";

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider} sends the selected effort with every conversation request`, async (t) => {
    const requests: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(
        providerSse(
          provider,
          provider === "openai"
            ? { id: `reply-${requests.length}`, output: [] }
            : { id: `reply-${requests.length}`, content: [], stop_reason: "end_turn" },
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const config = {
      provider,
      model: provider === "openai" ? "gpt-5.6-sol" : "claude-opus-5",
      apiKey: "test-placeholder",
      effort: "low" as const,
      systemPrompt: "Create the requested room and verify it.",
    };
    const conversation =
      provider === "openai"
        ? createOpenAiConversation(config)
        : createAnthropicConversation(config);
    await conversation.sendUserMessage("Inspect the room.");
    await conversation.sendUserMessage("Check the sprite.");
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.deepEqual(
        provider === "openai"
          ? request["instructions"]
          : (request["system"] as { text: string }[])[0]?.text,
        config.systemPrompt,
      );
      assert.deepEqual(request[provider === "openai" ? "reasoning" : "output_config"], {
        effort: "low",
      });
      if (provider === "anthropic")
        assert.deepEqual(request["cache_control"], { type: "ephemeral" });
    }
    if (provider === "anthropic") {
      const initialMessages = requests[0]!["messages"] as unknown[];
      const continuedMessages = requests[1]!["messages"] as unknown[];
      assert.ok(continuedMessages.length > initialMessages.length);
      assert.deepEqual(continuedMessages.slice(0, initialMessages.length), initialMessages);
    }
  });
}
