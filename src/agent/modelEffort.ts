/** Provider-supported effort levels, shared by the app and authoring evaluations. */
export type ModelEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type ModelProvider = "anthropic" | "openai" | "stub";

/** The model each provider starts with, in the app and in the evaluation scripts. */
export const DEFAULT_MODELS: Record<ModelProvider, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-6.1-sol",
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
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
  ],
  openai: [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { id: "gpt-6-astra", label: "GPT-6 Astra" },
    { id: "gpt-6-sol", label: "GPT-6 Sol" },
    { id: "gpt-6-luna", label: "GPT-6 Luna" },
  ],
  stub: [{ id: "offline-stub", label: "Offline Deterministic Stub" }],
};

const REASONING_LEVELS: readonly ModelEffort[] = ["low", "medium", "high", "xhigh", "max"];
const OPTIONAL_REASONING_LEVELS: readonly ModelEffort[] = ["none", ...REASONING_LEVELS];

/** USD per million tokens: provider list prices at the time of this release. */
interface ModelPrice {
  input: number;
  output: number;
  /** True when input pricing doubles above the provider's long-context threshold. */
  longContext: boolean;
  /** Cache-read price override; the default is 10% of input. */
  cacheRead?: number;
}

/** What the provider can honor for one model id — verified, not inferred. */
export interface ModelCapability {
  provider: ModelProvider;
  /** Effort levels the model accepts; selecting anything else is an error. */
  effort: readonly ModelEffort[];
  defaultEffort: ModelEffort;
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
  price?: ModelPrice;
}

/**
 * The tested capability table. Prices are the providers' standard API list
 * prices in USD per million tokens at the time of this release.
 * https://developers.openai.com/api/docs/models/gpt-6.1-sol
 * https://developers.openai.com/api/docs/pricing
 * https://developers.openai.com/api/docs/models/gpt-6-astra
 * https://developers.openai.com/api/docs/models/gpt-6-sol
 * https://developers.openai.com/api/docs/models/gpt-6-luna
 * https://platform.claude.com/docs/en/about-claude/pricing
 * https://platform.claude.com/docs/en/models/opus-5-5/overview
 * https://platform.claude.com/docs/en/models/sonnet-5-5/overview
 */
export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  // Anthropic's default, and in the 1.0.0 Genesis benchmark medium matched
  // high on both briefs for less.
  "claude-opus-5-5": {
    provider: "anthropic",
    effort: REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "breakpoint",
    strictSchema: false,
    summarizedThinking: true,
    price: { input: 4, output: 20, longContext: false, cacheRead: 0.2 },
  },
  // Anthropic's default effort is high. Its agentic guidance starts
  // well-specified multistep tool work at medium; the player can choose it.
  // It takes no forced tool_choice and binds thinking blocks to the
  // conversation; this client forces no tool and keeps history append-only.
  "claude-sonnet-5-5": {
    provider: "anthropic",
    effort: REASONING_LEVELS,
    defaultEffort: "high",
    caching: "breakpoint",
    strictSchema: false,
    summarizedThinking: true,
    price: { input: 2, output: 10, longContext: false },
  },
  "claude-fable-5-1": {
    provider: "anthropic",
    effort: REASONING_LEVELS,
    defaultEffort: "high",
    caching: "breakpoint",
    strictSchema: false,
    summarizedThinking: true,
    price: { input: 10, output: 50, longContext: false, cacheRead: 0.25 },
  },
  // The app's OpenAI default. Unlike the original Sol it always reasons —
  // none is not offered — and its listed cache-read rate is $0.10/M, not 10%
  // of input. Tool calling needs the Responses API, which this client uses.
  "gpt-6.1-sol": {
    provider: "openai",
    effort: REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "implicit",
    strictSchema: true,
    price: { input: 2, output: 10, longContext: true, cacheRead: 0.1 },
  },
  "gpt-6-astra": {
    provider: "openai",
    effort: REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "implicit",
    strictSchema: true,
    price: { input: 10, output: 50, longContext: true },
  },
  "gpt-6-sol": {
    provider: "openai",
    effort: OPTIONAL_REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "implicit",
    strictSchema: true,
    price: { input: 2, output: 10, longContext: true },
  },
  "gpt-6-luna": {
    provider: "openai",
    effort: OPTIONAL_REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "implicit",
    strictSchema: true,
    price: { input: 0.1, output: 0.5, longContext: true },
  },
  "offline-stub": {
    provider: "stub",
    effort: REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "none",
    strictSchema: false,
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
    effort: REASONING_LEVELS,
    defaultEffort: provider === "anthropic" ? "high" : "medium",
    caching: provider === "anthropic" ? "breakpoint" : provider === "openai" ? "implicit" : "none",
    strictSchema: provider === "openai",
  };
}

/**
 * The app pins an explicit effort for every model instead of leaving the provider default:
 * GPT-5.6 Sol low (it reduced cost on both stored Genesis briefs), claude-* high, other
 * OpenAI medium, the provider default for the GPT-6 family until an effort sweep says otherwise.
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
