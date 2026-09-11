import type { AgentRun } from "./agentRun.ts";
/**
 * BYOK LLM client supporting Anthropic (Claude Opus 5 / Fable 5 / Fable 5.1) and
 * OpenAI (GPT-5.6 / Terra / Sol) directly from the browser with prompt caching.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { AGENT_TOOLS, type AgentToolResult } from "../../../src/agent/tools.ts";
import {
  splitToolResult,
  openAiToolContent,
  anthropicToolDefinitions,
  anthropicToolResult,
} from "../../../src/agent/toolTransport.ts";
import { AGI_SYSTEM_PROMPT } from "../../../src/agent/prompt.ts";
import { resolveModelEffort, type ModelEffort } from "../../../src/agent/modelEffort.ts";

export type ProviderType = "anthropic" | "openai" | "stub";

export interface LlmConfig {
  provider: ProviderType;
  apiKey: string;
  model: string;
  effort?: ModelEffort;
  /** Isolated evaluation override; ordinary app requests use the shipped prompt. */
  systemPrompt?: string;
  budgetUsd?: number;
}

export interface ToolCallItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmUsage {
  /** Total input tokens, including cache reads and writes. */
  input: number;
  output: number;
  cachedInput: number;
  cacheWriteInput: number;
  /** Input billed at the ordinary rate: total minus reads and writes. */
  ordinaryInput?: number;
  /** Cache writes by entry TTL, where the provider reports the split. */
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  /** Output spent on provider-internal reasoning, where reported. */
  reasoningOutput?: number;
  /** Provider accounting tier, where reported. */
  serviceTier?: string;
}

/** One provider request, measured — never assumed complete on a failed stream. */
export interface LlmRequestTelemetry {
  provider: ProviderType;
  model: string;
  /** Provider-assigned response/request id, when delivered. */
  requestId?: string;
  /** 1-based provider request count within this conversation. */
  requestIndex: number;
  /** Non-cryptographic fingerprints of the static prefix for divergence diagnosis. */
  promptHash: string;
  catalogHash: string;
  /** ms from request start to the first stream event; absent when nothing streamed. */
  timeToFirstEventMs?: number;
  /** ms for the complete provider response. */
  responseMs: number;
  usage?: LlmUsage;
  /** True when the stream ended early or errored — usage may be partial, not exact. */
  usageIncomplete: boolean;
  /** Tool-result text bytes and image stats the model was sent before this request. */
  toolResultTextBytes: number;
  imageCount: number;
  imagePixels: number;
}
export class LlmResponseError extends Error {
  readonly usage: LlmUsage;
  readonly telemetry?: LlmRequestTelemetry;
  constructor(message: string, usage: LlmUsage, telemetry?: LlmRequestTelemetry) {
    super(message);
    this.name = "LlmResponseError";
    this.usage = usage;
    this.telemetry = telemetry;
  }
}

function anthropicUsage(usage: Anthropic.Usage | undefined): LlmUsage {
  const input =
    (usage?.input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0);
  return {
    input,
    output: usage?.output_tokens ?? 0,
    cachedInput: usage?.cache_read_input_tokens ?? 0,
    cacheWriteInput: usage?.cache_creation_input_tokens ?? 0,
    ordinaryInput: usage?.input_tokens ?? 0,
    ...(usage?.cache_creation
      ? {
          cacheWrite5m: usage.cache_creation.ephemeral_5m_input_tokens,
          cacheWrite1h: usage.cache_creation.ephemeral_1h_input_tokens,
        }
      : {}),
    ...(usage?.output_tokens_details
      ? { reasoningOutput: usage.output_tokens_details.thinking_tokens }
      : {}),
    ...(usage?.service_tier ? { serviceTier: usage.service_tier } : {}),
  };
}

function recordUsage(usage: LlmUsage, total: LlmUsage, run?: AgentRun): void {
  run?.recordUsage(usage);
  for (const key of Object.keys(usage) as (keyof LlmUsage)[]) {
    const value = usage[key];
    if (typeof value !== "number") continue;
    const bucket = total as Record<string, number | undefined>;
    bucket[key] = (bucket[key] ?? 0) + value;
  }
}

function openAiUsage(usage: OpenAI.Responses.ResponseUsage | null | undefined): LlmUsage {
  const input = usage?.input_tokens ?? 0;
  const cachedInput = usage?.input_tokens_details?.cached_tokens ?? 0;
  const cacheWriteInput = usage?.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    input,
    output: usage?.output_tokens ?? 0,
    cachedInput,
    cacheWriteInput,
    ordinaryInput: input - cachedInput - cacheWriteInput,
    ...(usage?.output_tokens_details
      ? { reasoningOutput: usage.output_tokens_details.reasoning_tokens }
      : {}),
  };
}

/** FNV-1a fingerprint: cheap, dependency-free identity for static request sections. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** PNG width x height from the IHDR header; 0x0 for anything else. */
function pngPixels(png: Uint8Array): number {
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) return 0;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return view.getUint32(16) * view.getUint32(20);
}

export interface LlmTurnResult {
  usage?: LlmUsage;
  telemetry?: LlmRequestTelemetry;

  text?: string;
  toolCalls: ToolCallItem[];
}

export const DEFAULT_MODELS: Record<ProviderType, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-6-astra",
  stub: "offline-stub",
};

export const MODEL_OPTIONS: Record<ProviderType, { id: string; label: string }[]> = {
  anthropic: [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
  ],
  openai: [
    { id: "gpt-6-astra", label: "GPT-6 Astra" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  ],
  stub: [{ id: "offline-stub", label: "Offline Deterministic Stub" }],
};

export interface UnifiedConversation {
  /**
   * Availability policy for this phase: which advertised tools may execute.
   * The advertised catalog itself stays stable for the life of the conversation
   * so the cached prefix survives phase changes. OpenAI restricts it
   * server-side via `allowed_tools`; elsewhere the host dispatcher remains the
   * deny-by-default authority. Omit names to make the full catalog available.
   */
  setAvailableTools(names?: readonly string[]): void;
  sendUserMessage(text: string): Promise<LlmTurnResult>;
  /**
   * Record tool results into the transcript without a provider request —
   * every call produced beside a terminal handover must land here too, even
   * when no next response will be requested.
   */
  appendToolResults(results: { toolCallId: string; result: AgentToolResult }[]): void;
  /** Request the next model response after appendToolResults. */
  complete(): Promise<LlmTurnResult>;
  getTranscript(): unknown[];
  recordInterruption?(text: string): void;
  getSessionId?(): string;
  getUsage?(): LlmUsage;
}

/**
 * Creates an Anthropic multi-turn conversation with strict prompt caching.
 * One explicit checkpoint ends the static prefix (Anthropic's cache order is
 * tools -> system -> messages, so the system-block marker covers the catalog);
 * the top-level cache_control rolls an automatic breakpoint over the tail.
 * Transcript history is strictly append-only and carries no cache annotations —
 * markers are transport metadata applied to the outbound request only.
 */
function getDevBaseUrl(path: string): string | undefined {
  if (
    typeof import.meta !== "undefined" &&
    Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV)
  ) {
    const origin =
      typeof globalThis.location !== "undefined" && globalThis.location?.origin
        ? globalThis.location.origin
        : "http://localhost:5199";
    return `${origin}${path}`;
  }
  return undefined;
}

export function createAnthropicConversation(
  config: LlmConfig,
  initialTranscript?: unknown[],
  run?: AgentRun,
): UnifiedConversation {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: getDevBaseUrl("/api/anthropic"),
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    timeout: 600000,
  });

  const tools = anthropicToolDefinitions(AGENT_TOOLS) as unknown as Anthropic.Tool[];
  const totalUsage: LlmUsage = { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0 };
  const catalogHash = fnv1a(JSON.stringify(tools));
  const promptHash = fnv1a(config.systemPrompt ?? AGI_SYSTEM_PROMPT);
  let requestCount = 0;
  let pendingToolContent = { textBytes: 0, imageCount: 0, imagePixels: 0 };

  const messages: Anthropic.MessageParam[] = Array.isArray(initialTranscript)
    ? JSON.parse(JSON.stringify(initialTranscript))
    : [];

  function closePending(reason: string): void {
    const pending = new Set<string>();
    for (const message of messages)
      if (Array.isArray(message.content))
        for (const block of message.content) {
          if (block.type === "tool_use") pending.add(block.id);
          else if (block.type === "tool_result") pending.delete(block.tool_use_id);
        }
    if (pending.size)
      messages.push({
        role: "user",
        content: [...pending].map((id) => ({
          type: "tool_result" as const,
          tool_use_id: id,
          is_error: true,
          content: `Tool call was not executed: ${reason}`,
        })),
      });
  }

  async function step(): Promise<LlmTurnResult> {
    const requestIndex = ++requestCount;
    const toolContent = pendingToolContent;
    pendingToolContent = { textBytes: 0, imageCount: 0, imagePixels: 0 };
    let firstEventMs: number | undefined;
    let responseMs = 0;
    let usageIncomplete = false;
    const send = async (signal?: AbortSignal, maxTokens = 128000) => {
      const startedAt = performance.now();
      // Official SDK accumulation preserves thinking signatures and complete tool inputs.
      // https://platform.claude.com/docs/en/build-with-claude/streaming
      const stream = client.messages.stream(
        {
          model: config.model || DEFAULT_MODELS.anthropic,
          // Cache the growing tool/result history as well as the static prefix.
          cache_control: { type: "ephemeral" },
          output_config: {
            effort: resolveModelEffort(
              config.model || DEFAULT_MODELS.anthropic,
              config.effort,
              "anthropic",
            ) as Exclude<ModelEffort, "none">,
          },
          max_tokens: maxTokens,
          system: [
            {
              type: "text",
              text: config.systemPrompt ?? AGI_SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          tools,
          messages,
        },
        { ...(signal ? { signal } : {}) },
      );
      let usage: Anthropic.Usage | undefined;
      try {
        for await (const event of stream) {
          if (firstEventMs === undefined) firstEventMs = performance.now() - startedAt;
          run?.updateProgress();
          if (event.type === "message_start") usage = { ...event.message.usage };
          if (event.type === "message_delta")
            usage = { ...usage, ...event.usage } as Anthropic.Usage;
          if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use")
              run?.updateProgress("tool", "", event.content_block.name);
            else if (event.content_block.type === "thinking") run?.updateProgress("thinking");
          }
          if (event.type === "content_block_delta" && event.delta.type === "text_delta")
            run?.updateProgress("text", event.delta.text);
        }
        const response = await stream.finalMessage();
        responseMs = performance.now() - startedAt;
        recordUsage(anthropicUsage(response.usage), totalUsage, run);
        return response;
      } catch (error) {
        usageIncomplete = true;
        responseMs = performance.now() - startedAt;
        if (usage) {
          const partial = anthropicUsage(usage);
          recordUsage(partial, totalUsage, run);
        }
        run?.markUsageIncomplete();
        throw error;
      }
    };
    const response = await (run ? run.request(send) : send());

    const usage = anthropicUsage(response.usage);
    const telemetry: LlmRequestTelemetry = {
      provider: "anthropic",
      model: response.model ?? config.model,
      requestId: response.id,
      requestIndex,
      promptHash,
      catalogHash,
      ...(firstEventMs !== undefined ? { timeToFirstEventMs: firstEventMs } : {}),
      responseMs,
      usage,
      usageIncomplete,
      toolResultTextBytes: toolContent.textBytes,
      imageCount: toolContent.imageCount,
      imagePixels: toolContent.imagePixels,
    };

    // Save assistant response to conversation history
    messages.push({
      role: "assistant",
      content: response.content,
    });

    if (!["end_turn", "tool_use", "stop_sequence"].includes(response.stop_reason ?? "")) {
      const reason =
        response.stop_reason === "max_tokens"
          ? "The provider response reached its output limit before completion. Partial tool arguments were not executed."
          : response.stop_reason === "refusal"
            ? `The model declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}. Rephrase the request or choose another model; nothing was executed.`
            : `The model stopped before completing the turn (${response.stop_reason}).`;
      closePending(reason);
      throw new LlmResponseError(reason, usage, telemetry);
    }
    let text = "";
    const toolCalls: ToolCallItem[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        if (!block.input || typeof block.input !== "object" || Array.isArray(block.input)) {
          closePending("The model returned invalid tool arguments.");
          throw new LlmResponseError(
            `Invalid tool arguments for ${block.name}; expected an object.`,
            usage,
            telemetry,
          );
        }
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }

    return { text: text.trim(), toolCalls, usage, telemetry };
  }

  return {
    setAvailableTools(_names) {
      // Anthropic has no allowed-tools request field; the advertised catalog
      // stays stable and the host dispatcher denies unavailable tools.
    },
    async sendUserMessage(text: string): Promise<LlmTurnResult> {
      closePending("the previous turn ended before the harness executed it.");
      messages.push({ role: "user", content: text });
      return step();
    },
    appendToolResults(results): void {
      const content: Anthropic.ToolResultBlockParam[] = [];
      let textBytes = 0;
      let imageCount = 0;
      let imagePixels = 0;
      for (const r of results) {
        const split = splitToolResult(r.result);
        textBytes += split.text.length;
        for (const image of split.images) {
          imageCount++;
          imagePixels += pngPixels(image.png);
        }
        content.push(anthropicToolResult(r.toolCallId, r.result));
      }
      pendingToolContent = { textBytes, imageCount, imagePixels };
      messages.push({ role: "user", content });
    },
    complete(): Promise<LlmTurnResult> {
      return step();
    },
    recordInterruption(text: string): void {
      closePending(text);
      messages.push({ role: "user", content: text });
    },
    getTranscript(): unknown[] {
      return JSON.parse(JSON.stringify(messages));
    },
    getUsage(): LlmUsage {
      return { ...totalUsage };
    },
  };
}

/**
 * Creates an OpenAI multi-turn conversation using the modern Responses API
 * with a stable cache routing key and automatic cache breakpoints.
 * Transcript history is strictly append-only.
 */
export function createOpenAiConversation(
  config: LlmConfig,
  initialTranscript?: unknown[],
  initialSessionId?: string,
  run?: AgentRun,
): UnifiedConversation {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: getDevBaseUrl("/api/openai/v1"),
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    timeout: 600000,
  });

  const tools: OpenAI.Responses.Tool[] = AGENT_TOOLS.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: true,
  }));
  let allowedNames: readonly string[] | undefined;
  const totalUsage: LlmUsage = { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0 };
  const catalogHash = fnv1a(JSON.stringify(tools));
  const promptHash = fnv1a(config.systemPrompt ?? AGI_SYSTEM_PROMPT);
  let requestCount = 0;
  let pendingToolContent = { textBytes: 0, imageCount: 0, imagePixels: 0 };

  const input: OpenAI.Responses.ResponseInputItem[] = Array.isArray(initialTranscript)
    ? JSON.parse(JSON.stringify(initialTranscript))
    : [];
  const sessionId = initialSessionId || crypto.randomUUID();

  function closePending(reason: string): void {
    const pending = new Set<string>();
    for (const item of input) {
      if (item.type === "function_call") pending.add(item.call_id);
      else if (item.type === "function_call_output" && item.call_id) pending.delete(item.call_id);
    }
    for (const call_id of pending)
      input.push({
        type: "function_call_output",
        call_id,
        output: JSON.stringify({ success: false, error: `Tool call was not executed: ${reason}` }),
      });
  }

  async function step(): Promise<LlmTurnResult> {
    const requestIndex = ++requestCount;
    const toolContent = pendingToolContent;
    pendingToolContent = { textBytes: 0, imageCount: 0, imagePixels: 0 };
    let firstEventMs: number | undefined;
    let responseMs = 0;
    let usageIncomplete = false;
    const send = async (signal?: AbortSignal, maxTokens = 128000) => {
      const startedAt = performance.now();
      // Use typed SSE events for presentation; only a terminal response may enter history.
      // https://developers.openai.com/api/docs/guides/streaming-responses
      const stream = await client.responses.create(
        {
          stream: true,
          max_output_tokens: maxTokens,
          model: config.model || DEFAULT_MODELS.openai,
          reasoning: {
            effort: resolveModelEffort(
              config.model || DEFAULT_MODELS.openai,
              config.effort,
              "openai",
            ),
          },
          instructions: config.systemPrompt ?? AGI_SYSTEM_PROMPT,
          prompt_cache_key: `monotio_agi.session.${sessionId}`,
          prompt_cache_options: {
            mode: "implicit",
            ttl: "30m",
          },
          tools,
          ...(allowedNames
            ? {
                tool_choice: allowedNames.length
                  ? {
                      type: "allowed_tools" as const,
                      mode: "auto" as const,
                      tools: allowedNames.map((name) => ({ type: "function", name })),
                    }
                  : ("none" as const),
              }
            : {}),
          input,
          include: ["reasoning.encrypted_content"],
          store: false,
        },
        { ...(signal ? { signal } : {}) },
      );
      try {
        for await (const event of stream) {
          if (firstEventMs === undefined) firstEventMs = performance.now() - startedAt;
          run?.updateProgress();
          if (event.type === "response.output_text.delta") run?.updateProgress("text", event.delta);
          if (event.type === "response.output_item.added") {
            if (event.item.type === "function_call")
              run?.updateProgress("tool", "", event.item.name);
            else if (event.item.type === "reasoning") run?.updateProgress("thinking");
          }
          if (
            event.type === "response.completed" ||
            event.type === "response.incomplete" ||
            event.type === "response.failed"
          ) {
            responseMs = performance.now() - startedAt;
            recordUsage(openAiUsage(event.response.usage), totalUsage, run);
            return event.response;
          }
          if (event.type === "error") throw new Error(event.message);
        }
        throw new Error(
          "The provider stream ended before completing the response. No partial tools were executed.",
        );
      } catch (error) {
        usageIncomplete = true;
        responseMs = performance.now() - startedAt;
        run?.markUsageIncomplete();
        throw error;
      }
    };
    const response = await (run ? run.request(send) : send());

    const usage = openAiUsage(response.usage);
    const telemetry: LlmRequestTelemetry = {
      provider: "openai",
      model: response.model ?? config.model,
      requestId: response.id,
      requestIndex,
      promptHash,
      catalogHash,
      ...(firstEventMs !== undefined ? { timeToFirstEventMs: firstEventMs } : {}),
      responseMs,
      usage,
      usageIncomplete,
      toolResultTextBytes: toolContent.textBytes,
      imageCount: toolContent.imageCount,
      imagePixels: toolContent.imagePixels,
    };
    for (const item of response.output) input.push(item as OpenAI.Responses.ResponseInputItem);
    if (response.status !== "completed") {
      const reason =
        response.incomplete_details?.reason === "max_output_tokens"
          ? "The provider response reached its output limit before completion. Partial tool arguments were not executed."
          : `The model stopped before completing the turn (${response.incomplete_details?.reason ?? response.status}).`;
      closePending(reason);
      throw new LlmResponseError(reason, usage, telemetry);
    }
    let text = "";
    const toolCalls: ToolCallItem[] = [];

    for (const item of response.output) {
      // Retain all output items verbatim into input (reasoning, function_call, message)
      // GPT-5.6 reasoning models require the reasoning item immediately before the function_call
      if (item.type === "message" && item.role === "assistant") {
        for (const content of item.content) {
          if (content.type === "output_text") {
            text += content.text;
          }
        }
      } else if (item.type === "function_call") {
        let parsedInput: Record<string, unknown>;
        try {
          parsedInput = JSON.parse(item.arguments);
          if (!parsedInput || typeof parsedInput !== "object" || Array.isArray(parsedInput))
            throw new Error("expected an object");
        } catch {
          closePending(`Invalid JSON arguments for ${item.name}.`);
          throw new LlmResponseError(
            `The model returned invalid JSON arguments for ${item.name}. No tools from this response were executed.`,
            usage,
            telemetry,
          );
        }
        toolCalls.push({
          id: item.call_id || item.id || "",
          name: item.name,
          input: parsedInput,
        });
      }
    }

    return { text: text.trim(), toolCalls, usage, telemetry };
  }

  return {
    setAvailableTools(names) {
      allowedNames = names
        ? [...names].filter((name) => AGENT_TOOLS.some((tool) => tool.name === name))
        : undefined;
    },
    async sendUserMessage(text: string): Promise<LlmTurnResult> {
      closePending("the previous turn ended before the harness executed it.");
      input.push({ role: "user", content: text });
      return step();
    },
    appendToolResults(results): void {
      let textBytes = 0;
      let imageCount = 0;
      let imagePixels = 0;
      for (const r of results) {
        const split = splitToolResult(r.result);
        textBytes += split.text.length;
        for (const image of split.images) {
          imageCount++;
          imagePixels += pngPixels(image.png);
        }
        input.push({
          type: "function_call_output",
          call_id: r.toolCallId,
          output: openAiToolContent(split),
        });
      }
      pendingToolContent = { textBytes, imageCount, imagePixels };
    },
    complete(): Promise<LlmTurnResult> {
      return step();
    },
    recordInterruption(text: string): void {
      closePending(text);
      input.push({ role: "user", content: text });
    },
    getTranscript(): unknown[] {
      return JSON.parse(JSON.stringify(input));
    },
    getSessionId(): string {
      return sessionId;
    },
    getUsage(): LlmUsage {
      return { ...totalUsage };
    },
  };
}
