import assert from "node:assert/strict";
import { test } from "node:test";
import { providerSse } from "../../test/provider-stream.ts";
import { createAnthropicConversation, createOpenAiConversation } from "../src/agent/llmClient.ts";

function offeredTool() {
  return {
    name: "read_document",
    description: "Read captured source",
    parameters: {
      type: "object" as const,
      additionalProperties: false as const,
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  };
}

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider} owns nested custom schemas for every request in a conversation`, async (t) => {
    const requests: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const payload =
        provider === "openai"
          ? {
              id: "resp_review",
              status: "completed",
              output: [],
              usage: { input_tokens: 1, output_tokens: 1 },
            }
          : {
              id: "msg_review",
              type: "message",
              role: "assistant",
              content: [],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
      return new Response(providerSse(provider, payload), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const tool = offeredTool();
    const config = { provider, model: "gpt-6.1-sol", apiKey: "synthetic" };
    const conversation =
      provider === "openai"
        ? createOpenAiConversation(config, undefined, undefined, undefined, [tool])
        : createAnthropicConversation(config, undefined, undefined, [tool]);
    await conversation.sendUserMessage("first");
    tool.parameters.properties.key.type = "number";
    tool.parameters.required.length = 0;
    await conversation.sendUserMessage("second");
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests[1]!["tools"],
      requests[0]!["tools"],
      "caller mutation cannot rewrite the cached catalog or its argument authority",
    );
  });
}

test("OpenAI custom availability uses owned tool identities after caller mutation", async (t) => {
  let body: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      providerSse("openai", {
        id: "resp_identity",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const tool = offeredTool();
  const conversation = createOpenAiConversation(
    { provider: "openai", model: "gpt-6.1-sol", apiKey: "synthetic" },
    undefined,
    undefined,
    undefined,
    [tool],
  );
  tool.name = "unadvertised_tool";
  conversation.setAvailableTools(["read_document", "unadvertised_tool"]);
  await conversation.sendUserMessage("read");
  assert.deepEqual(body?.["tool_choice"], {
    type: "allowed_tools",
    mode: "auto",
    tools: [{ type: "function", name: "read_document" }],
  });
});
