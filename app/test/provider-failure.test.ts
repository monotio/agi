import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createAnthropicConversation, createOpenAiConversation } from "../src/agent/llmClient.ts";
import {
  ProviderRequestError,
  providerFailureDetail,
  providerFailureMessage,
  toProviderError,
  type ProviderFailureKind,
  type ProviderName,
} from "../src/agent/providerFailure.ts";

const headers = new Headers();

function anthropicApiError(status: number, type: string, message = "raw words"): Error {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message } },
    undefined,
    headers,
  );
}
function openAiApiError(status: number, code: string | null, message = "raw words"): Error {
  return OpenAI.APIError.generate(
    status,
    { error: { message, type: "invalid_request_error", code } },
    undefined,
    headers,
  );
}

const CASES: [string, ProviderName, () => Error, ProviderFailureKind][] = [
  ["anthropic 401", "anthropic", () => anthropicApiError(401, "authentication_error"), "key"],
  ["anthropic 403", "anthropic", () => anthropicApiError(403, "permission_error"), "permission"],
  ["anthropic 402", "anthropic", () => anthropicApiError(402, "billing_error"), "billing"],
  ["anthropic 404", "anthropic", () => anthropicApiError(404, "not_found_error"), "model"],
  ["anthropic 413", "anthropic", () => anthropicApiError(413, "request_too_large"), "too-large"],
  ["anthropic 429", "anthropic", () => anthropicApiError(429, "rate_limit_error"), "rate-limit"],
  ["anthropic 500", "anthropic", () => anthropicApiError(500, "api_error"), "unavailable"],
  ["anthropic 529", "anthropic", () => anthropicApiError(529, "overloaded_error"), "unavailable"],
  ["anthropic 400", "anthropic", () => anthropicApiError(400, "invalid_request_error"), "general"],
  [
    "anthropic offline",
    "anthropic",
    () => new Anthropic.APIConnectionError({ cause: new TypeError("Failed to fetch") }),
    "offline",
  ],
  ["anthropic timeout", "anthropic", () => new Anthropic.APIConnectionTimeoutError(), "timeout"],
  ["openai 401", "openai", () => openAiApiError(401, "invalid_api_key"), "key"],
  ["openai 403", "openai", () => openAiApiError(403, null), "permission"],
  ["openai quota as 429", "openai", () => openAiApiError(429, "insufficient_quota"), "billing"],
  ["openai 429", "openai", () => openAiApiError(429, "rate_limit_exceeded"), "rate-limit"],
  ["openai 404", "openai", () => openAiApiError(404, "model_not_found"), "model"],
  [
    "openai context length",
    "openai",
    () => openAiApiError(400, "context_length_exceeded"),
    "too-large",
  ],
  ["openai 503", "openai", () => openAiApiError(503, null), "unavailable"],
  ["openai 400", "openai", () => openAiApiError(400, null), "general"],
  [
    "openai offline",
    "openai",
    () => new OpenAI.APIConnectionError({ cause: new TypeError("Failed to fetch") }),
    "offline",
  ],
  ["openai timeout", "openai", () => new OpenAI.APIConnectionTimeoutError(), "timeout"],
];

for (const [name, provider, make, kind] of CASES)
  test(`${name} becomes a plain ${kind} message and keeps the raw text`, () => {
    const original = make();
    const sdk = provider === "anthropic" ? Anthropic : OpenAI;
    const mapped = toProviderError(original, provider, sdk);
    assert.ok(mapped instanceof ProviderRequestError, String(mapped));
    assert.equal(mapped.kind, kind);
    assert.equal(mapped.message, providerFailureMessage(kind, provider));
    assert.equal(mapped.raw, original.message);
    assert.equal(mapped.cause, original);
    assert.doesNotMatch(mapped.message, /\d{3}|\{|authentication_error|raw words/);
    assert.match(providerFailureDetail(mapped), /./);
  });

test("the messages say the cause and the next action", () => {
  assert.equal(
    providerFailureMessage("key", "openai"),
    "OpenAI did not accept your API key. Check it in AI settings.",
  );
  assert.match(providerFailureMessage("key", "anthropic"), /^Anthropic did not accept/);
});

test("Stop, local errors and already-mapped errors pass through unchanged", () => {
  const abort = new Anthropic.APIUserAbortError();
  assert.equal(toProviderError(abort, "anthropic", Anthropic), abort);
  const local = new Error("Agent task cancelled.");
  assert.equal(toProviderError(local, "openai", OpenAI), local);
  const mapped = new ProviderRequestError("key", "openai", "raw");
  assert.equal(toProviderError(mapped, "openai", OpenAI), mapped);
});

test("a 401 from each provider reaches the caller as a plain error", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
  );
  for (const [create, provider] of [
    [createAnthropicConversation, "anthropic"],
    [createOpenAiConversation, "openai"],
  ] as const) {
    const conversation = create({ provider, model: "test", apiKey: "bad" });
    await assert.rejects(conversation.sendUserMessage("Hello"), (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.kind, "key");
      assert.equal(error.status, 401);
      assert.match(error.raw, /401/);
      assert.doesNotMatch(error.message, /401|invalid x-api-key/);
      return true;
    });
  }
});
