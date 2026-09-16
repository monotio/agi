import { providerSse } from "../../test/provider-stream.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MODEL_OPTIONS,
  createAnthropicConversation,
  createOpenAiConversation,
} from "../src/agent/llmClient.ts";
import { MODEL_CAPABILITIES } from "../../src/agent/modelEffort.ts";

test("every selectable model has a tested capability entry", () => {
  for (const option of Object.values(MODEL_OPTIONS).flat())
    assert.ok(MODEL_CAPABILITIES[option.id], `missing capability for ${option.id}`);
});

test("OpenAI reports usage, keeps stable tools and refuses truncated calls before execution", async (t) => {
  const requests: Record<string, unknown>[] = [];
  let count = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    count++;
    return new Response(
      providerSse(
        "openai",
        count === 1
          ? {
              id: "one",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              usage: {
                input_tokens: 120,
                output_tokens: 15,
                input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
              },
              output: [
                {
                  type: "function_call",
                  call_id: "partial",
                  name: "write_view",
                  arguments: '{"num":',
                },
              ],
            }
          : {
              id: "two",
              status: "completed",
              usage: {
                input_tokens: 10,
                output_tokens: 2,
                input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              },
              output: [],
            },
      ),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const conversation = createOpenAiConversation({
    provider: "openai",
    model: "test",
    apiKey: "placeholder",
  });
  conversation.setAvailableTools(["read_view"]);
  await assert.rejects(conversation.sendUserMessage("draw"), /output limit/i);
  assert.deepEqual(conversation.getUsage?.(), {
    input: 120,
    output: 15,
    cachedInput: 80,
    cacheWriteInput: 20,
    ordinaryInput: 20,
  });
  conversation.setAvailableTools(["write_view"]);
  await conversation.sendUserMessage("try a smaller cel");
  assert.deepEqual(requests[0]?.["tools"], requests[1]?.["tools"]);
  assert.deepEqual(requests[0]?.["tool_choice"], {
    type: "allowed_tools",
    mode: "auto",
    tools: [{ type: "function", name: "read_view" }],
  });
  assert.match(JSON.stringify(requests[1]?.["input"]), /not executed/i);
  assert.deepEqual(conversation.getUsage?.(), {
    input: 130,
    output: 17,
    cachedInput: 80,
    cacheWriteInput: 20,
    ordinaryInput: 30,
  });
});

test("Anthropic reports total input including cache and closes unfinished tool turns", async (t) => {
  const requests: Record<string, unknown>[] = [];
  let count = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    count++;
    return new Response(
      providerSse("anthropic", {
        id: String(count),
        type: "message",
        role: "assistant",
        stop_reason: count === 1 ? "max_tokens" : "end_turn",
        content:
          count === 1
            ? [{ type: "tool_use", id: "partial", name: "write_view", input: { num: 0 } }]
            : [],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 20,
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const conversation = createAnthropicConversation({
    provider: "anthropic",
    model: "test",
    apiKey: "placeholder",
  });
  await assert.rejects(conversation.sendUserMessage("draw"), /output limit/i);
  assert.deepEqual(conversation.getUsage?.(), {
    input: 60,
    output: 5,
    cachedInput: 30,
    cacheWriteInput: 20,
    ordinaryInput: 10,
  });
  await conversation.sendUserMessage("smaller");
  assert.match(JSON.stringify(requests[1]?.["messages"]), /not executed/i);
  const tools = requests[0]?.["tools"] as { name: string; strict?: boolean }[];
  assert.ok(tools.length > 20);
  // Anthropic strict tools are limited to 20 tools and 16 union parameters and
  // reject numeric constraints; this catalog is sent unconstrained instead.
  assert.ok(tools.every((tool) => !("strict" in tool)));
  assert.match(JSON.stringify(tools), /"maximum":255/);
});

test("Anthropic keeps the full catalog and an annotation-free transcript across phases", async (t) => {
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(
      providerSse("anthropic", {
        id: String(requests.length),
        type: "message",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const conversation = createAnthropicConversation({
    provider: "anthropic",
    model: "test",
    apiKey: "placeholder",
  });
  conversation.setAvailableTools(["read_view"]);
  await conversation.sendUserMessage("look around");
  await conversation.sendUserMessage("keep looking");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const tools = request["tools"] as { name: string }[];
    assert.ok(tools.length > 20, "the advertised catalog never narrows");
    assert.ok(
      tools.every((tool) => !("cache_control" in tool)),
      "tool definitions carry no markers",
    );
    const messages = JSON.stringify(request["messages"]);
    assert.ok(!messages.includes("cache_control"), "history is never annotated");
  }
  // One explicit checkpoint at the end of the static prefix, plus the
  // top-level automatic breakpoint that rolls over the conversation tail.
  const system = requests[0]?.["system"] as { cache_control?: unknown }[];
  assert.deepEqual(system[0]?.cache_control, { type: "ephemeral" });
  assert.deepEqual(requests[0]?.["cache_control"], { type: "ephemeral" });
});

test("Anthropic refusal surfaces the category and closes the pending tool call", async (t) => {
  const requests: Record<string, unknown>[] = [];
  let count = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    count++;
    return new Response(
      providerSse("anthropic", {
        id: String(count),
        type: "message",
        role: "assistant",
        stop_reason: count === 1 ? "refusal" : "end_turn",
        stop_details:
          count === 1 ? { type: "refusal", category: "cyber", explanation: "declined" } : null,
        content:
          count === 1
            ? [{ type: "tool_use", id: "refused", name: "write_view", input: { num: 0 } }]
            : [],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const conversation = createAnthropicConversation({
    provider: "anthropic",
    model: "test",
    apiKey: "placeholder",
  });
  await assert.rejects(conversation.sendUserMessage("draw"), /declined this request \(cyber\)/);
  await conversation.sendUserMessage("try again");
  const messages = requests[1]?.["messages"] as { role: string; content: unknown }[];
  const closing = messages.find(
    (m) => Array.isArray(m.content) && JSON.stringify(m.content).includes('"tool_result"'),
  );
  assert.ok(closing, "the refused tool_use is closed with a tool_result");
  assert.match(JSON.stringify(closing.content), /"tool_use_id":"refused"/);
  assert.match(JSON.stringify(closing.content), /nothing was executed/i);
});

test("uploaded reference art reaches both providers as image blocks", async (t) => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const b64 = "iVBORwECAwQ="; // base64 of the bytes above
  const images = [{ png, caption: "Player-supplied reference for view 0 — red jacket." }];

  const anthropicRequests: Record<string, unknown>[] = [];
  const openAiRequests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body));
    if (url.includes("anthropic")) anthropicRequests.push(body);
    else openAiRequests.push(body);
    return url.includes("anthropic")
      ? new Response(
          providerSse("anthropic", {
            id: "a1",
            type: "message",
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "done" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      : new Response(
          providerSse("openai", {
            id: "o1",
            status: "completed",
            output: [],
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
  });

  const anthropic = createAnthropicConversation({
    provider: "anthropic",
    model: "test",
    apiKey: "placeholder",
  });
  await anthropic.sendUserMessage("make the character look like this", images);
  const aMessages = anthropicRequests[0]?.["messages"] as {
    role: string;
    content: { type: string; text?: string; source?: { type: string; data: string } }[];
  }[];
  const aUser = aMessages.at(-1)!;
  assert.equal(aUser.role, "user");
  const aImage = aUser.content.find((block) => block.type === "image");
  assert.ok(aImage, "Anthropic user message carries an image block");
  assert.equal(aImage.source?.type, "base64");
  assert.equal(aImage.source?.data, b64);
  const aCaption = aUser.content.find(
    (block) => block.type === "text" && block.text?.includes("reference"),
  );
  assert.ok(aCaption, "the caption rides beside the image");

  const openAi = createOpenAiConversation({
    provider: "openai",
    model: "test",
    apiKey: "placeholder",
  });
  await openAi.sendUserMessage("make the character look like this", images);
  const oInput = openAiRequests[0]?.["input"] as {
    role: string;
    content: { type: string; text?: string; image_url?: string }[];
  }[];
  const oUser = oInput.at(-1)!;
  assert.equal(oUser.role, "user");
  const oImage = oUser.content.find((block) => block.type === "input_image");
  assert.ok(oImage, "OpenAI user message carries an input_image block");
  assert.equal(oImage.image_url, `data:image/png;base64,${b64}`);
  const oCaption = oUser.content.find(
    (block) => block.type === "input_text" && block.text?.includes("reference"),
  );
  assert.ok(oCaption, "the caption rides beside the image");
});

test("malformed complete tool arguments do not turn into an empty successful call", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        providerSse("openai", {
          id: "bad",
          status: "completed",
          output: [{ type: "function_call", call_id: "bad", name: "write_view", arguments: "{" }],
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const conversation = createOpenAiConversation({
    provider: "openai",
    model: "test",
    apiKey: "placeholder",
  });
  await assert.rejects(conversation.sendUserMessage("draw"), /invalid JSON/i);
  assert.match(JSON.stringify(conversation.getTranscript()), /not executed/i);
});
