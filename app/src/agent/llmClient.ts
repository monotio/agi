import type { AgentRun } from "./agentRun.ts";
/**
 * BYOK LLM client supporting Anthropic (Claude Opus-5 / Fable-5) and
 * OpenAI (GPT-5.6 / Terra / Sol) directly from the browser with prompt caching.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { AGENT_TOOLS, type AgentToolResult } from "../../../src/agent/tools.ts";
import {
  splitToolResult,
  openAiToolContent,
  anthropicToolContent,
} from "../../../src/agent/toolTransport.ts";
import { AGI_SYSTEM_PROMPT } from "../../../src/agent/prompt.ts";

export type ProviderType = "anthropic" | "openai" | "stub";

export interface LlmConfig {
  provider: ProviderType;
  apiKey: string;
  model: string;
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
}
export class LlmResponseError extends Error {
  readonly usage: LlmUsage;
  constructor(message: string, usage: LlmUsage) {
    super(message);
    this.name = "LlmResponseError";
    this.usage = usage;
  }
}

export interface LlmTurnResult {
  usage?: LlmUsage;

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
  /** Advertise only tools usable in this phase; omitted names restore the full catalog. */
  setTools(names?: readonly string[]): void;
  sendUserMessage(text: string): Promise<LlmTurnResult>;
  sendToolResults(
    results: { toolCallId: string; result: AgentToolResult }[],
  ): Promise<LlmTurnResult>;
  getTranscript(): unknown[];
  recordInterruption?(text: string): void;
  getSessionId?(): string;
  getUsage?(): LlmUsage;
}

/**
 * Creates an Anthropic multi-turn conversation with strict prompt caching.
 * The system prompt and tool definitions carry cache_control: { type: "ephemeral" }.
 * Transcript history is strictly append-only.
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

  const tools: Anthropic.Tool[] = AGENT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as unknown as Anthropic.Tool.InputSchema,
    strict: true,
  }));
  let selectedTools = tools;
  const totalUsage: LlmUsage = { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0 };

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
    const send = (signal?: AbortSignal, maxTokens = 128000) =>
      client.messages.create(
        {
          model: config.model || DEFAULT_MODELS.anthropic,
          max_tokens: maxTokens,
          system: [
            {
              type: "text",
              text: AGI_SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          tools: selectedTools.map((tool, index) => ({
            ...tool,
            ...(index === selectedTools.length - 1
              ? { cache_control: { type: "ephemeral" as const } }
              : {}),
          })),
          messages,
        },
        { ...(signal ? { signal } : {}) },
      );
    const response = await (run ? run.request(send) : send());

    const usage: LlmUsage = {
      input:
        (response.usage?.input_tokens ?? 0) +
        (response.usage?.cache_read_input_tokens ?? 0) +
        (response.usage?.cache_creation_input_tokens ?? 0),
      output: response.usage?.output_tokens ?? 0,
      cachedInput: response.usage?.cache_read_input_tokens ?? 0,
      cacheWriteInput: response.usage?.cache_creation_input_tokens ?? 0,
    };
    run?.recordUsage(usage);
    for (const key of Object.keys(totalUsage) as (keyof LlmUsage)[]) totalUsage[key] += usage[key];

    // Save assistant response to conversation history
    messages.push({
      role: "assistant",
      content: response.content,
    });

    if (
      response.stop_reason &&
      !["end_turn", "tool_use", "stop_sequence"].includes(response.stop_reason)
    ) {
      const reason =
        response.stop_reason === "max_tokens"
          ? "The provider response reached its output limit before completion. Partial tool arguments were not executed."
          : `The model stopped before completing the turn (${response.stop_reason}).`;
      closePending(reason);
      throw new LlmResponseError(reason, usage);
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
          );
        }
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }

    return { text: text.trim(), toolCalls, usage };
  }

  return {
    setTools(names) {
      selectedTools = names ? tools.filter((tool) => names.includes(tool.name)) : tools;
    },
    async sendUserMessage(text: string): Promise<LlmTurnResult> {
      closePending("the previous turn ended before the harness executed it.");
      messages.push({ role: "user", content: text });
      return step();
    },
    async sendToolResults(results): Promise<LlmTurnResult> {
      const content: Anthropic.ToolResultBlockParam[] = results.map((r) => {
        return {
          type: "tool_result",
          tool_use_id: r.toolCallId,
          is_error: !r.result.success,
          content: anthropicToolContent(splitToolResult(r.result)),
        };
      });
      messages.push({ role: "user", content });
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

  const input: OpenAI.Responses.ResponseInputItem[] = Array.isArray(initialTranscript)
    ? JSON.parse(JSON.stringify(initialTranscript))
    : [];
  const sessionId = initialSessionId || Math.random().toString(36).slice(2, 10);

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
    const send = (signal?: AbortSignal, maxTokens = 128000) =>
      client.responses.create(
        {
          max_output_tokens: maxTokens,
          model: config.model || DEFAULT_MODELS.openai,
          instructions: AGI_SYSTEM_PROMPT,
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
    const response = await (run ? run.request(send) : send());

    const usage: LlmUsage = {
      input: response.usage?.input_tokens ?? 0,
      output: response.usage?.output_tokens ?? 0,
      cachedInput: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      cacheWriteInput: response.usage?.input_tokens_details?.cache_write_tokens ?? 0,
    };
    run?.recordUsage(usage);
    for (const key of Object.keys(totalUsage) as (keyof LlmUsage)[]) totalUsage[key] += usage[key];
    for (const item of response.output) input.push(item as OpenAI.Responses.ResponseInputItem);
    if (response.status && response.status !== "completed") {
      const reason =
        response.incomplete_details?.reason === "max_output_tokens"
          ? "The provider response reached its output limit before completion. Partial tool arguments were not executed."
          : `The model stopped before completing the turn (${response.incomplete_details?.reason ?? response.status}).`;
      closePending(reason);
      throw new LlmResponseError(reason, usage);
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
          );
        }
        toolCalls.push({
          id: item.call_id || item.id || "",
          name: item.name,
          input: parsedInput,
        });
      }
    }

    return { text: text.trim(), toolCalls, usage };
  }

  return {
    setTools(names) {
      allowedNames = names
        ? [...names].filter((name) => AGENT_TOOLS.some((tool) => tool.name === name))
        : undefined;
    },
    async sendUserMessage(text: string): Promise<LlmTurnResult> {
      closePending("the previous turn ended before the harness executed it.");
      input.push({ role: "user", content: text });
      return step();
    },
    async sendToolResults(results): Promise<LlmTurnResult> {
      for (const r of results) {
        input.push({
          type: "function_call_output",
          call_id: r.toolCallId,
          output: openAiToolContent(splitToolResult(r.result)),
        });
      }
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
