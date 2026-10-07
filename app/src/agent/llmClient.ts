import { validateTranscript } from "../../../src/agent/transcript.ts";
import type { AgentRun } from "./agentRun.ts";
/**
 * BYOK LLM client supporting Anthropic (Claude Opus 5.5 / Sonnet 5.5 / Fable 5.1) and OpenAI
 * (GPT-6 Astra / Sol / Luna) directly from the browser with prompt caching.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessageParam,
  BetaUsage,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type OpenAI from "openai";
import type { AgentToolImage, AgentToolResult } from "../../../src/agent/agentState.ts";
import { AGENT_TOOLS, type ToolDefinition } from "../../../src/agent/tools.ts";
import {
  splitToolResult,
  openAiToolContent,
  anthropicToolContent,
  anthropicToolDefinitions,
  anthropicToolResult,
  type OpenAiToolBlock,
} from "../../../src/agent/toolTransport.ts";
import { AGI_SYSTEM_PROMPT } from "../../../src/agent/prompt.ts";
import {
  modelCapability,
  resolveModelEffort,
  type ModelEffort,
  DEFAULT_MODELS,
} from "../../../src/agent/modelEffort.ts";

export type ProviderType = "anthropic" | "openai" | "stub";

export interface LlmConfig {
  provider: ProviderType;
  apiKey: string;
  model: string;
  effort?: ModelEffort;
  /** Isolated evaluation override; ordinary app requests use the shipped prompt. */
  systemPrompt?: string;
  budgetUsd?: number;
  /**
   * With the stub provider, a scripted model instead of the offline author
   * (referenceStub.ts): tests and the reference eval's dry run.
   */
  stubScript?: ReferenceStubScript;
}

/** The scripted reference scenarios: one views a region and uses it, one never looks. */
export type ReferenceStubScript = "reference-region" | "reference-never";

interface ToolCallItem {
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
  readonly sessionId?: string;
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
  /** Share of this request's input served from the provider's prompt cache. */
  cacheHitShare?: number;
  /** True when the stream ended early or errored — usage may be partial, not exact. */
  usageIncomplete: boolean;
  /** Tool-result text bytes and image stats the model was sent before this request. */
  toolResultTextBytes: number;
  imageCount: number;
  imagePixels: number;
}
export class LlmResponseError extends Error {
  readonly usage: LlmUsage;
  readonly telemetry?: LlmRequestTelemetry | undefined;
  constructor(message: string, usage: LlmUsage, telemetry?: LlmRequestTelemetry) {
    super(message);
    this.name = "LlmResponseError";
    this.usage = usage;
    this.telemetry = telemetry;
  }
}

export class LlmRefusalError extends LlmResponseError {
  readonly outcome = "refused";
}

function userActionText(text: string): string {
  try {
    const event = JSON.parse(text) as Record<string, unknown>;
    if (event?.["format"] === "monotio.agi.user-action" && event["version"] === 1) return text;
  } catch {
    // Older callers supply an explanation; retain it in the structured event.
  }
  return JSON.stringify({
    format: "monotio.agi.user-action",
    version: 1,
    decision: "interruption",
    outcome: "interrupted",
    explanation: text,
  });
}

function anthropicUsage(usage: Partial<BetaUsage> | undefined): LlmUsage {
  const input =
    (usage?.input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0);
  const total: LlmUsage = {
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
  // The API excludes compaction iterations from top-level message usage.
  for (const iteration of usage?.iterations ?? []) {
    if (iteration.type !== "compaction") continue;
    total.input +=
      iteration.input_tokens +
      iteration.cache_read_input_tokens +
      iteration.cache_creation_input_tokens;
    total.output += iteration.output_tokens;
    total.cachedInput += iteration.cache_read_input_tokens;
    total.cacheWriteInput += iteration.cache_creation_input_tokens;
    total.ordinaryInput = (total.ordinaryInput ?? 0) + iteration.input_tokens;
    if (iteration.cache_creation) {
      total.cacheWrite5m =
        (total.cacheWrite5m ?? 0) + iteration.cache_creation.ephemeral_5m_input_tokens;
      total.cacheWrite1h =
        (total.cacheWrite1h ?? 0) + iteration.cache_creation.ephemeral_1h_input_tokens;
    }
  }
  return total;
}

function recordUsage(usage: LlmUsage, total: LlmUsage): void {
  for (const key of Object.keys(usage) as (keyof LlmUsage)[]) {
    const value = usage[key];
    if (typeof value !== "number") continue;
    const bucket = total as unknown as Record<string, number | undefined>;
    bucket[key] = (bucket[key] ?? 0) + value;
  }
}

function recordAnthropicStreamUsage(
  usage: BetaUsage,
  run: AgentRun | undefined,
  model: string,
): void {
  if (!run) return;
  if (usage.iterations?.length) {
    const totals: Record<string, LlmUsage> = {};
    for (const iteration of usage.iterations) {
      const serving = "model" in iteration ? (iteration.model ?? model) : model;
      const total = (totals[serving] ??= {
        input: 0,
        output: 0,
        cachedInput: 0,
        cacheWriteInput: 0,
      });
      recordUsage(anthropicUsage(iteration), total);
    }
    for (const [serving, total] of Object.entries(totals)) run.recordStreamUsage(total, serving);
  } else run.recordStreamUsage(anthropicUsage(usage), model);
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

/** Cached input over total input; undefined until a request reports input. */
function cacheHitShare(usage: LlmUsage): number | undefined {
  return usage.input > 0 ? Math.min(1, usage.cachedInput / usage.input) : undefined;
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

interface AssistantMessage {
  readonly id?: string;
  readonly phase?: "commentary" | "final_answer";
  readonly status?: string;
  readonly text: string;
}
export interface LlmTurnResult {
  assistantMessages?: readonly AssistantMessage[];
  stopReason?: string;
  outcome?: "completed";
  usage?: LlmUsage;
  telemetry?: LlmRequestTelemetry;

  text?: string;
  toolCalls: ToolCallItem[];
}

export interface UnifiedConversation {
  /**
   * Availability policy for this phase: which advertised tools may execute.
   * The advertised catalog itself stays stable for the life of the conversation
   * so the cached prefix survives phase changes. OpenAI restricts it
   * server-side via `allowed_tools`; elsewhere the host dispatcher remains the
   * deny-by-default authority. Omit names to make the full catalog available.
   */
  setAvailableTools(names?: readonly string[]): void;
  /**
   * Send one player turn. `images` travel as provider image blocks on the
   * same message — the upload path's reference art reaches the model the way
   * rendered tool previews do.
   */
  sendUserMessage(text: string, images?: readonly AgentToolImage[]): Promise<LlmTurnResult>;
  /**
   * Record tool results into the transcript without a provider request —
   * every call produced beside a terminal finish must land here too, even
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

/**
 * Creates an Anthropic multi-turn conversation with strict prompt caching.
 * Anthropic's cache order is tools -> system -> messages, so two of the four
 * breakpoints do the whole job: one explicit marker on the system block ends
 * the static prefix (the catalog and the prompt, identical for every
 * session) and the top-level cache_control rolls an automatic breakpoint over
 * the growing tail. The static marker keeps a 1-hour entry because a player
 * often plays for more than five minutes between turns: it costs 2x instead
 * of 1.25x to write once an hour and saves a full re-write of the catalog and
 * prompt on every turn that follows a pause. The tail stays on the default
 * 5-minute entry, refreshed by every request of a turn (a longer entry must
 * precede a shorter one, and this order satisfies that). No marker sits
 * between them: a breakpoint mid-history would only duplicate the automatic
 * one within its 20-block lookback.
 *
 * Transcript history is strictly append-only and carries no cache
 * annotations — markers are transport metadata applied to the outbound
 * request only. Nothing rewrites an earlier message: a rewrite invalidates
 * every cached block after it, and on models with preserved thinking it is
 * a history edit the API may reject. evals/cache-probe.ts measures the prefix
 * each request shares with its predecessor.
 */
export function createAnthropicConversation(
  config: LlmConfig,
  initialTranscript?: unknown[],
  run?: AgentRun,
  /**
   * A narrower catalog for a scoped session (e.g. the Logic Studio project
   * assist). Copied at creation and stable for the conversation's life; the
   * default stays the full AGENT_TOOLS for every existing caller.
   */
  catalog?: readonly ToolDefinition[],
  initialSessionId?: string,
): UnifiedConversation {
  let client: Promise<Anthropic> | undefined;
  let requestSignal: AbortSignal | undefined;
  const getClient = () =>
    (client ??= import("@anthropic-ai/sdk").then(
      ({ default: Anthropic }) =>
        new Anthropic({
          apiKey: config.apiKey,
          baseURL: getDevBaseUrl("/api/anthropic"),
          dangerouslyAllowBrowser: true,
          // The SDK's own retries (twice, with backoff and retry-after) absorb a
          // transient 429, 5xx or overload before the turn and its staged work fail.
          maxRetries: 2,
          timeout: 600000,
          // Keep Stop attached to the response body for the whole stream.
          fetch: async (url, init) => {
            const signal =
              requestSignal && init?.signal
                ? AbortSignal.any([requestSignal, init.signal])
                : (requestSignal ?? init?.signal);
            const response = await fetch(url, { ...init, signal: signal ?? null });
            if (!response.body || !signal) return response;
            return new Response(response.body.pipeThrough(new TransformStream(), { signal }), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          },
        }),
    ));

  // A custom catalog is detached completely — names, descriptions and nested
  // schemas — so caller mutation afterwards cannot rewrite the cached prefix.
  const tools = anthropicToolDefinitions(
    catalog ? catalog.map((tool) => structuredClone(tool)) : AGENT_TOOLS,
  ) as unknown as Anthropic.Tool[];
  const totalUsage: LlmUsage = { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0 };
  const catalogHash = fnv1a(JSON.stringify(tools));
  const promptHash = fnv1a(config.systemPrompt ?? AGI_SYSTEM_PROMPT);
  let requestCount = 0;
  let pendingToolContent = { textBytes: 0, imageCount: 0, imagePixels: 0 };

  const messages: BetaMessageParam[] = Array.isArray(initialTranscript)
    ? JSON.parse(JSON.stringify(validateTranscript(initialTranscript, config.provider, true)))
    : [];

  const sessionId = initialSessionId || crypto.randomUUID();
  let contextStart = Math.max(
    0,
    messages.findLastIndex(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === "compaction" && block.content != null),
    ),
  );

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
    validateTranscript(messages, "anthropic");
    const requestIndex = ++requestCount;
    const toolContent = pendingToolContent;
    pendingToolContent = { textBytes: 0, imageCount: 0, imagePixels: 0 };
    let firstEventMs: number | undefined;
    let responseMs = 0;
    let usageIncomplete = false;
    const send = async (
      signal?: AbortSignal,
      maxTokens = modelCapability(config.model, config.provider).maxOutputTokens,
    ) => {
      const startedAt = performance.now();
      requestSignal = signal;
      // Official SDK accumulation preserves thinking signatures and complete tool inputs.
      // https://platform.claude.com/docs/en/build-with-claude/streaming
      const stream = (await getClient()).beta.messages.stream(
        {
          model: config.model || DEFAULT_MODELS.anthropic,
          // Cache the growing tool/result history as well as the static prefix.
          cache_control: { type: "ephemeral" },
          metadata: { user_id: sessionId },
          output_config: {
            effort: resolveModelEffort(
              config.model || DEFAULT_MODELS.anthropic,
              config.effort,
              "anthropic",
            ) as Exclude<ModelEffort, "none">,
          },
          max_tokens: maxTokens,
          betas: [
            "server-side-fallback-2026-07-01",
            "compact-2026-01-12",
            "thinking-display-updates-2026-08-18",
          ],
          fallbacks: "default",
          context_management: {
            edits: [
              {
                type: "compact_20260112",
                trigger: {
                  type: "input_tokens",
                  value: Math.floor(
                    modelCapability(config.model || DEFAULT_MODELS.anthropic, "anthropic")
                      .maxInputTokens * 0.75,
                  ),
                },
              },
            ],
          },
          // The notes Opus 5.5 and Sonnet 5.5 write between tool calls arrive as thinking
          // blocks, empty without a display; the agent panel shows them.
          ...(modelCapability(config.model || DEFAULT_MODELS.anthropic, "anthropic")
            .summarizedThinking
            ? { thinking: { type: "adaptive" as const, display: "updates" as const } }
            : {}),
          system: [
            {
              type: "text",
              text: config.systemPrompt ?? AGI_SYSTEM_PROMPT,
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
          tools,
          messages: messages.slice(contextStart),
        },
        { ...(signal ? { signal } : {}) },
      );
      let usage: BetaUsage | undefined;
      try {
        for await (const event of stream) {
          if (firstEventMs === undefined) firstEventMs = performance.now() - startedAt;
          run?.updateProgress();
          if (event.type === "message_start") usage = { ...event.message.usage };
          if (event.type === "message_delta") usage = { ...usage, ...event.usage } as BetaUsage;
          if ((event.type === "message_start" || event.type === "message_delta") && usage)
            recordAnthropicStreamUsage(usage, run, config.model || DEFAULT_MODELS.anthropic);
          if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use")
              run?.updateProgress("tool", "", event.content_block.name);
            else if (event.content_block.type === "thinking") run?.updateProgress("thinking");
          }
          if (event.type === "content_block_delta" && event.delta.type === "text_delta")
            run?.updateProgress("text", event.delta.text);
          if (event.type === "content_block_delta" && event.delta.type === "thinking_delta")
            run?.updateProgress("thinking", event.delta.thinking);
        }
        const response = await stream.finalMessage();
        responseMs = performance.now() - startedAt;
        recordUsage(anthropicUsage(response.usage), totalUsage);
        return response;
      } catch (error) {
        usageIncomplete = true;
        responseMs = performance.now() - startedAt;
        if (usage) {
          recordUsage(anthropicUsage(usage), totalUsage);
        }
        run?.markUsageIncomplete();
        throw error;
      } finally {
        requestSignal = undefined;
      }
    };
    const response = await (run ? run.request(send) : send());

    const usage = anthropicUsage(response.usage);
    const hitShare = cacheHitShare(usage);
    const telemetry: LlmRequestTelemetry = {
      provider: "anthropic",
      sessionId,
      model: response.model ?? config.model,
      requestId: response.id,
      requestIndex,
      promptHash,
      catalogHash,
      ...(firstEventMs !== undefined ? { timeToFirstEventMs: firstEventMs } : {}),
      responseMs,
      usage,
      ...(hitShare === undefined ? {} : { cacheHitShare: hitShare }),
      usageIncomplete,
      toolResultTextBytes: toolContent.textBytes,
      imageCount: toolContent.imageCount,
      imagePixels: toolContent.imagePixels,
    };

    // Save assistant response to conversation history
    if (response.content.some((block) => block.type === "compaction" && block.content !== null))
      contextStart = messages.length;
    messages.push({ role: "assistant", content: response.content });

    if (!["end_turn", "tool_use", "stop_sequence"].includes(response.stop_reason ?? "")) {
      const reason =
        response.stop_reason === "max_tokens"
          ? "The provider response reached its output limit before completion. Partial tool arguments were not executed."
          : response.stop_reason === "refusal"
            ? `The model declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}. Rephrase the request or choose another model; nothing was executed.`
            : `The model stopped before completing the turn (${response.stop_reason}).`;
      closePending(reason);
      if (response.stop_reason === "refusal") {
        const explanation = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        throw new LlmRefusalError(
          `${reason} ${explanation || response.stop_details?.explanation || ""}`.trim(),
          usage,
          telemetry,
        );
      }
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

    return {
      text: text.trim(),
      toolCalls,
      usage,
      telemetry,
      assistantMessages: [
        { id: response.id, text: text.trim(), status: response.stop_reason ?? "" },
      ],
      stopReason: response.stop_reason ?? "",
      outcome: "completed",
    };
  }

  return {
    setAvailableTools(_names) {
      // Anthropic has no allowed-tools request field; the advertised catalog
      // stays stable and the host dispatcher denies unavailable tools.
    },
    async sendUserMessage(
      text: string,
      images?: readonly AgentToolImage[],
    ): Promise<LlmTurnResult> {
      closePending("the previous turn ended before the harness executed it.");
      messages.push({
        role: "user",
        content: images?.length ? anthropicToolContent({ text, images }) : text,
      });
      return step();
    },
    appendToolResults(results): void {
      const content: BetaToolResultBlockParam[] = [];
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
      messages.push({ role: "user", content: userActionText(text) });
    },
    getTranscript(): unknown[] {
      return JSON.parse(JSON.stringify(messages));
    },
    getSessionId(): string {
      return sessionId;
    },
    getUsage(): LlmUsage {
      return { ...totalUsage };
    },
  };
}

/**
 * Creates an OpenAI multi-turn conversation using the modern Responses API
 * with a stable cache routing key and automatic cache breakpoints, plus an
 * explicit breakpoint at every turn's tail (see appendToolResults). The tool
 * catalog is advertised whole for the life of the conversation; a task's
 * narrower list travels as `tool_choice.allowed_tools`, which restricts what
 * the model may call without changing the cached tool definitions. Transcript
 * history is strictly append-only: nothing rewrites an earlier item.
 */
export function createOpenAiConversation(
  config: LlmConfig,
  initialTranscript?: unknown[],
  initialSessionId?: string,
  run?: AgentRun,
  /**
   * A narrower catalog for a scoped session (e.g. the Logic Studio project
   * assist). Copied at creation and stable for the conversation's life;
   * `setAvailableTools` filters against this list, not the global catalog.
   */
  catalog?: readonly ToolDefinition[],
): UnifiedConversation {
  let client: Promise<OpenAI> | undefined;
  const getClient = () =>
    (client ??= import("openai").then(
      ({ default: OpenAI }) =>
        new OpenAI({
          apiKey: config.apiKey,
          baseURL: getDevBaseUrl("/api/openai/v1"),
          dangerouslyAllowBrowser: true,
          // The SDK's own retries (twice, with backoff and retry-after) absorb a
          // transient 429, 5xx or overload before the turn and its staged work fail.
          maxRetries: 2,
          timeout: 600000,
        }),
    ));

  // One captured snapshot drives both the advertised wire tools and the
  // allowed-tools name lookup for the whole conversation; caller mutation of
  // the offered records cannot rename or reshape either.
  const catalogForSession = catalog ? catalog.map((tool) => structuredClone(tool)) : AGENT_TOOLS;
  const tools: OpenAI.Responses.Tool[] = catalogForSession.map((t) => ({
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
    ? JSON.parse(JSON.stringify(validateTranscript(initialTranscript, config.provider, true)))
    : [];
  const sessionId = initialSessionId || crypto.randomUUID();

  let contextStart = Math.max(
    0,
    input.findLastIndex((item) => item.type === "compaction"),
  );

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

  async function step(commentaryTurns = 0): Promise<LlmTurnResult> {
    validateTranscript(input, "openai");
    const requestIndex = ++requestCount;
    const toolContent = pendingToolContent;
    pendingToolContent = { textBytes: 0, imageCount: 0, imagePixels: 0 };
    let firstEventMs: number | undefined;
    let responseMs = 0;
    let usageIncomplete = false;
    const send = async (
      signal?: AbortSignal,
      maxTokens = modelCapability(config.model, config.provider).maxOutputTokens,
    ) => {
      const startedAt = performance.now();
      // Use typed SSE events for presentation; only a terminal response may enter history.
      // https://developers.openai.com/api/docs/guides/streaming-responses
      const stream = await (
        await getClient()
      ).responses.create(
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
          input: input.slice(contextStart),
          context_management: [
            {
              type: "compaction",
              compact_threshold: Math.floor(
                modelCapability(config.model || DEFAULT_MODELS.openai, "openai").maxInputTokens *
                  0.75,
              ),
            },
          ],
          include: ["reasoning.encrypted_content"],
          store: false,
        },
        { ...(signal ? { signal } : {}) },
      );
      try {
        for await (const event of stream) {
          if (firstEventMs === undefined) firstEventMs = performance.now() - startedAt;
          run?.updateProgress();
          if (
            "response" in event &&
            event.response &&
            "usage" in event.response &&
            event.response.usage
          )
            run?.recordStreamUsage(openAiUsage(event.response.usage));
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
            if (!event.response.usage) run?.markUsageIncomplete();
            recordUsage(openAiUsage(event.response.usage), totalUsage);
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
    const hitShare = cacheHitShare(usage);
    const telemetry: LlmRequestTelemetry = {
      provider: "openai",
      sessionId,
      model: response.model ?? config.model,
      requestId: response.id,
      requestIndex,
      promptHash,
      catalogHash,
      ...(firstEventMs !== undefined ? { timeToFirstEventMs: firstEventMs } : {}),
      responseMs,
      usage,
      ...(hitShare === undefined ? {} : { cacheHitShare: hitShare }),
      usageIncomplete,
      toolResultTextBytes: toolContent.textBytes,
      imageCount: toolContent.imageCount,
      imagePixels: toolContent.imagePixels,
    };
    for (const item of response.output) {
      if (item.type === "compaction") contextStart = input.length;
      input.push(item as OpenAI.Responses.ResponseInputItem);
    }
    if (response.status !== "completed") {
      const reason =
        response.incomplete_details?.reason === "max_output_tokens"
          ? "The provider response reached its output limit before completion. Partial tool arguments were not executed."
          : `The model stopped before completing the turn (${response.incomplete_details?.reason ?? response.status}). ${response.error?.message ?? ""}`;
      closePending(reason);
      throw new LlmResponseError(reason, usage, telemetry);
    }
    const assistantMessages: AssistantMessage[] = [];
    const refusals: string[] = [];
    const toolCalls: ToolCallItem[] = [];

    for (const item of response.output) {
      // Retain all output items verbatim into input (reasoning, function_call, message)
      // Reasoning and tool linkage travel verbatim into the next request.
      if (item.type === "message" && item.role === "assistant") {
        const text = item.content
          .filter((content) => content.type === "output_text")
          .map((content) => content.text)
          .join("\n");
        assistantMessages.push({
          ...(item.id ? { id: item.id } : {}),
          ...(item.phase ? { phase: item.phase } : {}),
          ...(item.status ? { status: item.status } : {}),
          text,
        });
        for (const content of item.content)
          if (content.type === "refusal") refusals.push(content.refusal);
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

    if (refusals.length) {
      const reason = refusals.join("\n");
      closePending(reason);
      throw new LlmRefusalError(reason, usage, telemetry);
    }
    if (
      !toolCalls.length &&
      assistantMessages.length &&
      assistantMessages.every((message) => message.phase === "commentary")
    ) {
      if (commentaryTurns >= 3)
        throw new LlmResponseError(
          "The model returned commentary without a final answer after four responses. Retry the task.",
          usage,
          telemetry,
        );
      const next = await step(commentaryTurns + 1);
      return {
        ...next,
        assistantMessages: [...assistantMessages, ...(next.assistantMessages ?? [])],
      };
    }
    const text = assistantMessages
      .filter((message) => message.phase !== "commentary")
      .map((message) => message.text)
      .join("\n")
      .trim();
    return { text, assistantMessages, toolCalls, usage, telemetry, outcome: "completed" };
  }

  return {
    setAvailableTools(names) {
      allowedNames = names
        ? [...names].filter((name) => catalogForSession.some((tool) => tool.name === name))
        : undefined;
    },
    async sendUserMessage(
      text: string,
      images?: readonly AgentToolImage[],
    ): Promise<LlmTurnResult> {
      closePending("the previous turn ended before the harness executed it.");
      const content: (OpenAiToolBlock & {
        prompt_cache_breakpoint?: { mode: "explicit" };
      })[] = openAiToolContent({ text, images: images ?? [] });
      content[content.length - 1]!.prompt_cache_breakpoint = { mode: "explicit" };
      input.push({ role: "user", content });
      return step();
    },
    appendToolResults(results): void {
      let textBytes = 0;
      let imageCount = 0;
      let imagePixels = 0;
      let lastOutput: OpenAI.Responses.ResponseInputItem.FunctionCallOutput | undefined;
      for (const r of results) {
        const split = splitToolResult(r.result);
        textBytes += split.text.length;
        for (const image of split.images) {
          imageCount++;
          imagePixels += pngPixels(image.png);
        }
        lastOutput = {
          type: "function_call_output",
          call_id: r.toolCallId,
          output: openAiToolContent(split),
        };
        input.push(lastOutput);
      }
      // Explicit breakpoint at each turn's tail: implicit caching looks back
      // only ~20 eligible message endings, so a turn with many tool calls
      // pushes the last stable prefix out of the window and the cache sticks
      // at the first request. A marked boundary is always a lookup point
      // (latest 50 explicit breakpoints are always checked) and always writes.
      if (lastOutput && Array.isArray(lastOutput.output) && lastOutput.output.length) {
        lastOutput.output[lastOutput.output.length - 1]!.prompt_cache_breakpoint = {
          mode: "explicit",
        };
      }
      pendingToolContent = { textBytes, imageCount, imagePixels };
    },
    complete(): Promise<LlmTurnResult> {
      return step();
    },
    recordInterruption(text: string): void {
      closePending(text);
      input.push({ role: "user", content: userActionText(text) });
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
