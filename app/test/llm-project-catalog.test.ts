import { providerSse } from "../../test/provider-stream.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnthropicConversation, createOpenAiConversation } from "../src/agent/llmClient.ts";
import { AGENT_TOOLS } from "../../src/agent/tools.ts";
import {
  PROJECT_ASSIST_TOOLS,
  PROJECT_ASSIST_TOOL_NAMES,
} from "../src/agent/projectAssistTools.ts";

const OPENAI_COMPLETED = {
  id: "resp-1",
  status: "completed",
  usage: { input_tokens: 10, output_tokens: 2 },
  output: [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ],
};

const ANTHROPIC_COMPLETED = {
  id: "msg-1",
  type: "message",
  role: "assistant",
  stop_reason: "end_turn",
  content: [{ type: "text", text: "done" }],
  usage: { input_tokens: 10, output_tokens: 2 },
};

function mockSse(
  t: { mock: { method: (target: object, name: string, impl: unknown) => void } },
  provider: "openai" | "anthropic",
  requests: Record<string, unknown>[],
): void {
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(
      providerSse(provider, provider === "openai" ? OPENAI_COMPLETED : ANTHROPIC_COMPLETED),
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  });
}

test("OpenAI sends only the custom catalog and filters allowed_tools against it", async (t) => {
  const requests: Record<string, unknown>[] = [];
  mockSse(t, "openai", requests);
  const conversation = createOpenAiConversation(
    { provider: "openai", model: "test", apiKey: "placeholder" },
    undefined,
    undefined,
    undefined,
    PROJECT_ASSIST_TOOLS,
  );
  // A default-catalog name plus an invented name must both be filtered out.
  conversation.setAvailableTools(["read_document", "write_view", "not_a_tool"]);
  await conversation.sendUserMessage("inspect the room");
  await conversation.sendUserMessage("again");
  assert.equal(requests.length, 2);

  const tools = requests[0]!["tools"] as {
    type: string;
    name: string;
    strict?: boolean;
    parameters: unknown;
  }[];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...PROJECT_ASSIST_TOOL_NAMES],
  );
  assert.ok(tools.every((tool) => tool.type === "function" && tool.strict === true));
  // None of the default gameplay catalog leaked in.
  for (const name of tools.map((tool) => tool.name))
    assert.ok(PROJECT_ASSIST_TOOL_NAMES.includes(name), name);
  // The schema reaches the wire: read_document carries its documented fields.
  const readDoc = tools.find((tool) => tool.name === "read_document")!;
  assert.deepEqual(readDoc.parameters, {
    type: "object",
    additionalProperties: false,
    properties: {
      key: { type: "string", maxLength: 64 },
      offset: { type: ["integer", "null"], minimum: 0 },
      limit: { type: ["integer", "null"], minimum: 1, maximum: 131072 },
    },
    required: ["key", "offset", "limit"],
  });
  assert.deepEqual(requests[0]!["tool_choice"], {
    type: "allowed_tools",
    mode: "auto",
    tools: [{ type: "function", name: "read_document" }],
  });
  assert.deepEqual(
    requests[0]!["tools"],
    requests[1]!["tools"],
    "the catalog is stable across calls",
  );
});

test("OpenAI custom catalog survives the caller mutating the source array", async (t) => {
  const requests: Record<string, unknown>[] = [];
  mockSse(t, "openai", requests);
  const catalog = [...PROJECT_ASSIST_TOOLS];
  const conversation = createOpenAiConversation(
    { provider: "openai", model: "test", apiKey: "placeholder" },
    undefined,
    undefined,
    undefined,
    catalog,
  );
  catalog.length = 0;
  catalog.push(AGENT_TOOLS.find((tool) => tool.name === "write_view")!);
  await conversation.sendUserMessage("hello");
  const tools = requests[0]!["tools"] as { name: string }[];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...PROJECT_ASSIST_TOOL_NAMES],
  );
});

test("OpenAI without a catalog keeps the full default list and its allowed_tools semantics", async (t) => {
  const requests: Record<string, unknown>[] = [];
  mockSse(t, "openai", requests);
  const conversation = createOpenAiConversation({
    provider: "openai",
    model: "test",
    apiKey: "placeholder",
  });
  // write_view is a default tool; it must still be admitted for legacy callers.
  conversation.setAvailableTools(["write_view", "read_project_context", "bogus"]);
  await conversation.sendUserMessage("draw");
  const tools = requests[0]!["tools"] as { name: string }[];
  assert.equal(tools.length, AGENT_TOOLS.length);
  assert.deepEqual(requests[0]!["tool_choice"], {
    type: "allowed_tools",
    mode: "auto",
    tools: [{ type: "function", name: "write_view" }],
  });
});

test("Anthropic sends only the custom catalog through the existing converter", async (t) => {
  const requests: Record<string, unknown>[] = [];
  mockSse(t, "anthropic", requests);
  const conversation = createAnthropicConversation(
    {
      provider: "anthropic",
      model: "test",
      apiKey: "placeholder",
      systemPrompt: "You assist one captured AGI project draft. Propose, never apply.",
    },
    undefined,
    undefined,
    PROJECT_ASSIST_TOOLS,
  );
  conversation.setAvailableTools(["read_document"]); // no Anthropic field; dispatcher denies
  await conversation.sendUserMessage("look at the room source");
  await conversation.sendUserMessage("and words");
  const tools = requests[0]!["tools"] as { name: string; strict?: boolean }[];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...PROJECT_ASSIST_TOOL_NAMES],
  );
  assert.ok(tools.every((tool) => !("strict" in tool)));
  assert.deepEqual(requests[0]!["tools"], requests[1]!["tools"], "the catalog is stable");
  const system = requests[0]!["system"] as { text: string }[];
  assert.match(system[0]!.text, /captured AGI project draft/);
  // The instruction text travels verbatim.
  const messages = requests[0]!["messages"] as { role: string; content: string }[];
  assert.equal(messages.at(-1)!.content, "look at the room source");
});

test("Anthropic without a catalog keeps the default list unchanged", async (t) => {
  const requests: Record<string, unknown>[] = [];
  mockSse(t, "anthropic", requests);
  const conversation = createAnthropicConversation({
    provider: "anthropic",
    model: "test",
    apiKey: "placeholder",
  });
  await conversation.sendUserMessage("hello");
  const tools = requests[0]!["tools"] as { name: string }[];
  assert.equal(tools.length, AGENT_TOOLS.length);
});
