/**
 * A scripted model behind the real provider clients. `fetch` is replaced by
 * a responder that reads what the app's Anthropic or OpenAI request added
 * since the last one (a player message, tool results), asks the script for
 * the next turn and streams it back in the provider's own event shape. The
 * request bodies are captured verbatim, so a probe measures exactly the
 * bytes the app would send — no network, no key, no spend.
 *
 * Scripts are the same shape as the app's stub conversations (studioAssist.ts,
 * referenceStub.ts): sendUserMessage answers a player message, complete
 * answers tool results. `queueScript` builds one from a list of steps.
 */
import { providerSse } from "../../test/provider-stream.ts";
import type { AgentToolImage, AgentToolResult } from "../../src/agent/agentState.ts";
import type { LlmTurnResult, UnifiedConversation } from "../../app/src/agent/llmClient.ts";

export type ScriptProvider = "anthropic" | "openai";

/** One provider request, as the client built it. */
export interface CapturedRequest {
  readonly provider: ScriptProvider;
  readonly body: Record<string, unknown>;
}

/** What a scripted step answers: text, tool calls, or both. */
export interface ScriptedTurn {
  readonly text?: string;
  readonly calls?: readonly { name: string; input: Record<string, unknown> }[];
}

/** What a step sees: the player message that arrived, or the tool results. */
interface StepContext {
  readonly text?: string;
  readonly images?: number;
  readonly results?: readonly { name: string; result: AgentToolResult }[];
}

export type ScriptStep = ScriptedTurn | ((context: StepContext) => ScriptedTurn);

type Script = Pick<UnifiedConversation, "sendUserMessage" | "appendToolResults" | "complete">;

/**
 * A script that answers requests in order. Every step is consumed by the
 * next request whatever it carries; a step that needs the request reads it
 * from its context. The script throws once its steps run out, so a task
 * that keeps asking fails loudly instead of looping.
 */
export function queueScript(steps: readonly ScriptStep[]): Script {
  const queue = [...steps];
  const names = new Map<string, string>();
  let calls = 0;
  let pending: { name: string; result: AgentToolResult }[] = [];
  const answer = (context: StepContext): LlmTurnResult => {
    const step = queue.shift();
    if (step === undefined) throw new Error("The cache probe script ran out of steps.");
    const turn = typeof step === "function" ? step(context) : step;
    const toolCalls = (turn.calls ?? []).map((call) => {
      const id = `call_${++calls}`;
      names.set(id, call.name);
      return { id, name: call.name, input: call.input };
    });
    return { ...(turn.text !== undefined ? { text: turn.text } : {}), toolCalls };
  };
  return {
    async sendUserMessage(text, images) {
      return answer({ text, images: images?.length ?? 0 });
    },
    appendToolResults(results) {
      pending = results.map(({ toolCallId, result }) => ({
        name: names.get(toolCallId) ?? "?",
        result,
      }));
    },
    async complete() {
      const results = pending;
      pending = [];
      return answer({ results });
    },
  };
}

/** Stand-ins for a request's images; a script only counts them. */
function placeholders(count: number): AgentToolImage[] {
  return Array.from({ length: count }, () => ({ png: new Uint8Array(), caption: "" }));
}

function base64Bytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

/** A tool result block's JSON text and images, as the app serialised them. */
function parseToolResult(
  blocks: readonly Record<string, unknown>[],
  provider: ScriptProvider,
): AgentToolResult {
  const textType = provider === "anthropic" ? "text" : "input_text";
  const imageType = provider === "anthropic" ? "image" : "input_image";
  const texts = blocks.filter((block) => block["type"] === textType);
  const parsed = JSON.parse(String(texts[0]?.["text"] ?? "{}")) as AgentToolResult;
  const images: AgentToolImage[] = [];
  let caption = "";
  for (const block of blocks) {
    if (block["type"] === textType && block !== texts[0]) caption = String(block["text"]);
    if (block["type"] !== imageType) continue;
    const data =
      provider === "anthropic"
        ? String((block["source"] as { data: string }).data)
        : String(block["image_url"]).replace(/^data:[^,]*,/, "");
    images.push({ png: base64Bytes(data), caption });
  }
  return images.length ? { ...parsed, images } : parsed;
}

interface Consumed {
  turn: Promise<LlmTurnResult>;
}

/** Feed the Anthropic messages added since `seen` to the script. */
function consumeAnthropic(
  messages: readonly Record<string, unknown>[],
  seen: number,
  script: Script,
): Consumed {
  let turn: Promise<LlmTurnResult> | null = null;
  for (const message of messages.slice(seen)) {
    if (message["role"] !== "user") continue;
    const content = message["content"];
    if (typeof content === "string") {
      turn = script.sendUserMessage(content);
      continue;
    }
    const blocks = content as Record<string, unknown>[];
    const results = blocks.filter((block) => block["type"] === "tool_result");
    if (results.length) {
      script.appendToolResults(
        results.map((block) => ({
          toolCallId: String(block["tool_use_id"]),
          result:
            typeof block["content"] === "string"
              ? { success: false, error: String(block["content"]) }
              : parseToolResult(block["content"] as Record<string, unknown>[], "anthropic"),
        })),
      );
      turn = null;
    } else {
      const text = blocks
        .filter((block) => block["type"] === "text")
        .map((block) => String(block["text"]))
        .join("\n");
      const images = blocks.filter((block) => block["type"] === "image").length;
      turn = script.sendUserMessage(text, images ? placeholders(images) : undefined);
    }
  }
  return { turn: turn ?? script.complete() };
}

/** Feed the OpenAI input items added since `seen` to the script. */
function consumeOpenAi(
  input: readonly Record<string, unknown>[],
  seen: number,
  script: Script,
): Consumed {
  let turn: Promise<LlmTurnResult> | null = null;
  let outputs: { toolCallId: string; result: AgentToolResult }[] = [];
  const flush = () => {
    if (!outputs.length) return;
    script.appendToolResults(outputs);
    outputs = [];
    turn = null;
  };
  for (const item of input.slice(seen)) {
    if (item["type"] === "function_call_output") {
      const output = item["output"];
      outputs.push({
        toolCallId: String(item["call_id"]),
        result:
          typeof output === "string"
            ? (JSON.parse(output) as AgentToolResult)
            : parseToolResult(output as Record<string, unknown>[], "openai"),
      });
      continue;
    }
    flush();
    if (item["role"] !== "user") continue;
    const content = item["content"];
    if (typeof content === "string") {
      turn = script.sendUserMessage(content);
      continue;
    }
    const blocks = content as Record<string, unknown>[];
    const text = blocks
      .filter((block) => block["type"] === "input_text")
      .map((block) => String(block["text"]))
      .join("\n");
    const images = blocks.filter((block) => block["type"] === "input_image").length;
    turn = script.sendUserMessage(text, images ? placeholders(images) : undefined);
  }
  flush();
  return { turn: turn ?? script.complete() };
}

/** The provider's streamed response for one scripted turn. */
function render(provider: ScriptProvider, turn: LlmTurnResult, index: number): string {
  if (provider === "anthropic") {
    const content: Record<string, unknown>[] = [
      // Opus 5.5 and Fable 5.1 return their notes between tool calls as
      // thinking blocks; the transcript carries them, so the probe does too.
      { type: "thinking", thinking: `Step ${index}.`, signature: `sig-${index}` },
    ];
    if (turn.text) content.push({ type: "text", text: turn.text });
    for (const call of turn.toolCalls)
      content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
    return providerSse("anthropic", {
      id: `msg_${index}`,
      type: "message",
      role: "assistant",
      model: "scripted",
      content,
      stop_reason: turn.toolCalls.length ? "tool_use" : "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }
  const output: Record<string, unknown>[] = [
    { type: "reasoning", id: `rs_${index}`, summary: [], encrypted_content: `enc-${index}` },
  ];
  if (turn.text)
    output.push({
      type: "message",
      id: `msg_${index}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: turn.text, annotations: [] }],
    });
  for (const call of turn.toolCalls)
    output.push({
      type: "function_call",
      id: `fc_${call.id}`,
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.input),
    });
  return providerSse("openai", {
    id: `resp_${index}`,
    model: "scripted",
    status: "completed",
    output,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });
}

export interface ScriptedProvider {
  /** Every request the client sent, in order. */
  readonly requests: CapturedRequest[];
  /** Answer the following requests with this script (a new task, a new script). */
  use(script: Script): void;
  /** Put the real fetch back. */
  restore(): void;
}

/**
 * Install the responder. Every provider request reaches the current script;
 * the previous request's own items are skipped by count, so a rewrite of an
 * earlier message changes the captured bytes but never what the script sees.
 */
export function installScriptedProvider(provider: ScriptProvider): ScriptedProvider {
  const requests: CapturedRequest[] = [];
  const original = globalThis.fetch;
  let script: Script | null = null;
  let seen = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (!script) throw new Error("The cache probe received a request before a script was set.");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ provider, body });
    const index = requests.length;
    const items = (provider === "anthropic" ? body["messages"] : body["input"]) as Record<
      string,
      unknown
    >[];
    const { turn } =
      provider === "anthropic"
        ? consumeAnthropic(items, seen, script)
        : consumeOpenAi(items, seen, script);
    const result = await turn;
    // The client appends its own response before the next request: one
    // assistant message, or one reasoning item plus one per text and call.
    seen =
      items.length +
      (provider === "anthropic" ? 1 : 1 + (result.text ? 1 : 0) + result.toolCalls.length);
    return new Response(render(provider, result, index), {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return {
    requests,
    use(next) {
      script = next;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}
