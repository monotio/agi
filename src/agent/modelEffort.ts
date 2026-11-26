/** Provider-supported effort levels, shared by the app and authoring evaluations. */
export type ModelEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type ModelProvider = "anthropic" | "openai" | "gemini" | "stub";

/** The model each provider starts with, in the app and in the evaluation scripts. */
export const DEFAULT_MODELS: Record<ModelProvider, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-6.2-sol",
  gemini: "gemini-4-neon",
  stub: "offline-stub",
};

/**
 * The models the AI settings dialog offers, by provider. It lives beside the
 * defaults, not in the LLM client, so the settings UI can list them without
 * loading the provider SDKs on the Play boot path.
 */
export const MODEL_OPTIONS: Record<ModelProvider, { id: string; label: string }[]> = {
  anthropic: [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "claude-fable-5-2", label: "Claude Fable 5.2" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  ],
  openai: [
    { id: "gpt-6.2-sol", label: "GPT-6.2 Sol" },
    { id: "gpt-6.2-astra", label: "GPT-6.2 Astra" },
    { id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
    { id: "gpt-6-luna", label: "GPT-6 Luna" },
  ],
  gemini: [
    { id: "gemini-4-neon", label: "Gemini 4 Neon" },
    { id: "gemini-4-carbon", label: "Gemini 4 Carbon" },
    { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" },
  ],
  stub: [{ id: "offline-stub", label: "Demo" }],
};

const PROVIDER_USAGE_URLS: Record<Exclude<ModelProvider, "stub">, string> = {
  openai: "https://platform.openai.com/usage",
  anthropic: "https://console.anthropic.com/settings/usage",
  gemini: "https://aistudio.google.com/usage",
};

/** Billing and usage dashboard URL for one provider. */
export function providerUsageUrl(provider?: string): string {
  if (provider === "anthropic" || provider === "gemini" || provider === "openai")
    return PROVIDER_USAGE_URLS[provider];
  return PROVIDER_USAGE_URLS.openai;
}

const REASONING_LEVELS: readonly ModelEffort[] = ["low", "medium", "high", "xhigh", "max"];
const OPTIONAL_REASONING_LEVELS: readonly ModelEffort[] = ["none", ...REASONING_LEVELS];
const GEMINI_EXTENDED_LEVELS: readonly ModelEffort[] = ["low", "medium", "high", "xhigh"];
const GEMINI_STANDARD_LEVELS: readonly ModelEffort[] = ["low", "medium", "high"];

/** USD per million tokens: provider list prices at the time of this release. */
interface ModelPrice {
  input: number;
  output: number;
  /** The higher rate card for a request whose prompt exceeds `above` tokens. */
  longContext?: { above: number; inputFactor: number; outputFactor: number };
  /** Cache-read price override; the default is 10% of input. */
  cacheRead?: number;
}

/** USD per million tokens for one request, on the rate card its prompt length selects. */
export function requestRates(
  price: ModelPrice,
  promptTokens: number,
): { input: number; cacheRead: number; output: number } {
  const long =
    price.longContext && promptTokens > price.longContext.above ? price.longContext : null;
  const inputFactor = long?.inputFactor ?? 1;
  return {
    input: price.input * inputFactor,
    cacheRead: (price.cacheRead ?? price.input * 0.1) * inputFactor,
    output: price.output * (long?.outputFactor ?? 1),
  };
}

/** OpenAI's long-context rates: double input and 1.5x output above 272K prompt tokens. */
const OPENAI_LONG_CONTEXT = { above: 272000, inputFactor: 2, outputFactor: 1.5 };

/** What the provider can honor for one model id — verified, not inferred. */
export interface ModelCapability {
  provider: ModelProvider;
  /** Effort levels the model accepts; selecting anything else is an error. */
  effort: readonly ModelEffort[];
  defaultEffort: ModelEffort;
  /** Documented request ceilings, including reasoning in the output allowance. */
  maxOutputTokens: number;
  maxInputTokens: number;
  /** Prefix-cache mechanism: explicit/auto breakpoints, implicit routing-key reuse, or none. */
  caching: "breakpoint" | "implicit" | "none";
  /** Whether tool schemas may be sent under the provider's strict-grammar mode. */
  strictSchema: boolean;
  /**
   * Anthropic adaptive thinking whose notes between tool calls come back
   * empty unless a display is requested (Opus 5.5, Sonnet 5.5, Fable 5.1).
   * https://platform.claude.com/docs/en/models/opus-5-5/migration-guide#text-between-tool-calls
   */
  summarizedThinking?: true;
  /**
   * Anthropic reruns a declined request on another model (`fallbacks: "default"`).
   * Haiku 5.5 has no server-side fallback, so its requests leave the parameter out.
   */
  serverFallback?: true;
  price?: ModelPrice;
}

/**
 * The tested capability table. Prices are the providers' standard API list
 * prices in USD per million tokens at the time of this release.
 * https://developers.openai.com/api/docs/models/gpt-6.2-sol
 * https://developers.openai.com/api/docs/models/gpt-6.2-astra
 * https://developers.openai.com/api/docs/models/gpt-6.1-terra
 * https://developers.openai.com/api/docs/models/gpt-6-luna
 * https://developers.openai.com/api/docs/pricing
 * https://platform.claude.com/docs/en/about-claude/pricing
 * https://platform.claude.com/docs/en/models/opus-5-5/overview
 * https://platform.claude.com/docs/en/models/sonnet-5-5/overview
 * https://platform.claude.com/docs/en/models/fable-5-2/overview
 * https://platform.claude.com/docs/en/models/haiku-5-5/overview
 */
export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  // Anthropic's default, and in the 1.0.0 Genesis benchmark medium matched
  // high on both briefs for less.
  "claude-opus-5-5": {
    provider: "anthropic",
    maxOutputTokens: 128000,
    maxInputTokens: 1000000,
    effort: REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "breakpoint",
    strictSchema: false,
    summarizedThinking: true,
    serverFallback: true,
    price: { input: 4, output: 20, cacheRead: 0.2 },
  },
  // Anthropic guidance starts multistep tool work at medium.
  // It takes no forced tool_choice and binds thinking blocks to the
  // conversation; this client forces no tool and keeps history append-only.
  "claude-sonnet-5-5": {
    provider: "anthropic",
    maxOutputTokens: 128000,
    maxInputTokens: 1000000,
    effort: REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "breakpoint",
    strictSchema: false,
    summarizedThinking: true,
    serverFallback: true,
    price: { input: 2, output: 10, cacheRead: 0.1 },
  },
  "claude-fable-5-2": {
    provider: "anthropic",
    maxOutputTokens: 128000,
    maxInputTokens: 1000000,
    effort: REASONING_LEVELS,
    defaultEffort: "high",
    caching: "breakpoint",
    strictSchema: false,
    summarizedThinking: true,
    serverFallback: true,
    price: { input: 8, output: 40, cacheRead: 0.2 },
  },
  // Superseded in the picker by Fable 5.2; kept for historical transcripts and eval snapshots.
  "claude-fable-5-1": {
    provider: "anthropic",
    maxOutputTokens: 128000,
    maxInputTokens: 1000000,
    effort: REASONING_LEVELS,
    defaultEffort: "high",
    caching: "breakpoint",
    strictSchema: false,
    summarizedThinking: true,
    serverFallback: true,
    price: { input: 10, output: 50, cacheRead: 0.25 },
  },
  // Haiku 5.5 bills prompts over 100K tokens at five times its base rates.
  // Thinking text stays empty without a display, and the panel shows none.
  "claude-haiku-5-5": {
    provider: "anthropic",
    maxOutputTokens: 128000,
    maxInputTokens: 1000000,
    effort: REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "breakpoint",
    strictSchema: false,
    price: {
      input: 0.1,
      output: 0.5,
      longContext: { above: 100000, inputFactor: 5, outputFactor: 5 },
    },
  },
  // The app's OpenAI default. Like 6.1 Sol it always reasons — none is not
  // offered — and its listed cache-read rate is $0.10/M (5% of input).
  "gpt-6.2-sol": {
    provider: "openai",
    maxOutputTokens: 128000,
    maxInputTokens: 922000,
    effort: REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "implicit",
    strictSchema: true,
    price: { input: 2, output: 10, longContext: OPENAI_LONG_CONTEXT, cacheRead: 0.1 },
  },
  "gpt-6.2-astra": {
    provider: "openai",
    maxOutputTokens: 128000,
    maxInputTokens: 922000,
    effort: REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "implicit",
    strictSchema: true,
    price: { input: 8, output: 40, longContext: OPENAI_LONG_CONTEXT, cacheRead: 0.4 },
  },
  "gpt-6.1-terra": {
    provider: "openai",
    maxOutputTokens: 128000,
    maxInputTokens: 922000,
    effort: OPTIONAL_REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "implicit",
    strictSchema: true,
    price: { input: 1, output: 5, longContext: OPENAI_LONG_CONTEXT, cacheRead: 0.05 },
  },
  // Superseded in the picker by 6.2 Sol / 6.2 Astra; kept for historical transcripts and evals.
  "gpt-6.1-sol": {
    provider: "openai",
    maxOutputTokens: 128000,
    maxInputTokens: 922000,
    effort: REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "implicit",
    strictSchema: true,
    price: { input: 2, output: 10, longContext: OPENAI_LONG_CONTEXT, cacheRead: 0.1 },
  },
  "gpt-6-astra": {
    provider: "openai",
    maxOutputTokens: 128000,
    maxInputTokens: 922000,
    effort: REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "implicit",
    strictSchema: true,
    price: { input: 10, output: 50, longContext: OPENAI_LONG_CONTEXT },
  },
  "gpt-6-sol": {
    provider: "openai",
    maxOutputTokens: 128000,
    maxInputTokens: 922000,
    effort: OPTIONAL_REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "implicit",
    strictSchema: true,
    price: { input: 2, output: 10, longContext: OPENAI_LONG_CONTEXT },
  },
  "gpt-6-luna": {
    provider: "openai",
    maxOutputTokens: 128000,
    maxInputTokens: 922000,
    effort: OPTIONAL_REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "implicit",
    strictSchema: true,
    price: { input: 0.1, output: 0.5, longContext: OPENAI_LONG_CONTEXT },
  },
  // Gemini 4 shares a 1M (1,048,576) unified context window with 65,536
  // synchronous output tokens and automatic 95%-discount implicit caching.
  // https://ai.google.dev/gemini-api/docs/models
  // https://ai.google.dev/gemini-api/docs/pricing
  "gemini-4-neon": {
    provider: "gemini",
    maxOutputTokens: 65536,
    maxInputTokens: 983040,
    effort: GEMINI_EXTENDED_LEVELS,
    defaultEffort: "high",
    caching: "implicit",
    strictSchema: false,
    price: { input: 3, output: 15, cacheRead: 0.15 },
  },
  "gemini-4-carbon": {
    provider: "gemini",
    maxOutputTokens: 65536,
    maxInputTokens: 983040,
    effort: GEMINI_STANDARD_LEVELS,
    defaultEffort: "medium",
    caching: "implicit",
    strictSchema: false,
    price: { input: 4, output: 20, cacheRead: 0.2 },
  },
  "gemini-4-hydrogen": {
    provider: "gemini",
    maxOutputTokens: 65536,
    maxInputTokens: 983040,
    effort: GEMINI_EXTENDED_LEVELS,
    defaultEffort: "high",
    caching: "implicit",
    strictSchema: false,
    price: { input: 1.5, output: 7.5, cacheRead: 0.075 },
  },
  "offline-stub": {
    provider: "stub",
    maxOutputTokens: 128000,
    maxInputTokens: 922000,
    effort: REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "none",
    strictSchema: false,
    price: { input: 0, output: 0 },
  },
};

/**
 * Capability for one model id. Listed ids come from the tested table; unlisted
 * ids get a conservative provider-derived policy (mandatory effort levels, the
 * provider's own caching mode, no known price) rather than a name-prefix guess.
 */
export function modelCapability(model: string, provider?: ModelProvider): ModelCapability {
  const listed = MODEL_CAPABILITIES[model];
  if (listed) return listed;
  return {
    provider: provider ?? "stub",
    maxOutputTokens: provider === "gemini" ? 65536 : 128000,
    maxInputTokens: provider === "anthropic" ? 1000000 : provider === "gemini" ? 983040 : 922000,
    effort: provider === "gemini" ? GEMINI_STANDARD_LEVELS : REASONING_LEVELS,
    defaultEffort: provider === "anthropic" ? "high" : "medium",
    caching:
      provider === "anthropic"
        ? "breakpoint"
        : provider === "openai" || provider === "gemini"
          ? "implicit"
          : "none",
    strictSchema: provider === "openai",
    ...(provider === "anthropic" ? { serverFallback: true as const } : {}),
  };
}

/**
 * The app pins an explicit effort for every model instead of leaving the provider default:
 * GPT-6, Opus and Sonnet use medium; Fable uses high. The player can choose
 * any supported effort for the task.
 */
export function defaultModelEffort(model: string, provider?: ModelProvider): ModelEffort {
  return modelCapability(model, provider).defaultEffort;
}

export function modelEffortOptions(model: string): readonly ModelEffort[] {
  return MODEL_CAPABILITIES[model]?.effort ?? REASONING_LEVELS;
}

export function resolveModelEffort(
  model: string,
  effort?: ModelEffort,
  provider?: ModelProvider,
): ModelEffort {
  const selected = effort ?? defaultModelEffort(model, provider);
  if (!modelEffortOptions(model).includes(selected))
    throw new Error(`Reasoning effort ${selected} is not supported by ${model}.`);
  return selected;
}
