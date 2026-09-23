/** Provider-supported effort levels, shared by the app and authoring evaluations. */
export type ModelEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type ModelProvider = "anthropic" | "openai" | "stub";

const REASONING_LEVELS: readonly ModelEffort[] = ["low", "medium", "high", "xhigh", "max"];
const OPTIONAL_REASONING_LEVELS: readonly ModelEffort[] = ["none", ...REASONING_LEVELS];

/** USD per million tokens, checked September 23, 2026 (see docs for provider price pages). */
export interface ModelPrice {
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
  price?: ModelPrice;
}

/**
 * The tested capability table. Prices are standard API USD per million tokens,
 * checked September 23, 2026. The app offers the current models; the earlier
 * ones stay for the evaluation lanes that measured them.
 * https://developers.openai.com/api/docs/models/gpt-6-astra
 * https://developers.openai.com/api/docs/models/gpt-6-sol
 * https://developers.openai.com/api/docs/models/gpt-6-luna
 * https://developers.openai.com/api/docs/models/gpt-5.6-sol
 * https://developers.openai.com/api/docs/models/gpt-5.6-terra
 * https://platform.claude.com/docs/en/about-claude/pricing
 * https://platform.claude.com/docs/en/models/opus-5-5/overview
 */
export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  "claude-opus-5-5": {
    provider: "anthropic",
    effort: REASONING_LEVELS,
    defaultEffort: "high",
    caching: "breakpoint",
    strictSchema: false,
    price: { input: 4, output: 20, longContext: false, cacheRead: 0.2 },
  },
  "claude-opus-5": {
    provider: "anthropic",
    effort: REASONING_LEVELS,
    defaultEffort: "high",
    caching: "breakpoint",
    strictSchema: false,
    price: { input: 5, output: 25, longContext: false },
  },
  "claude-fable-5": {
    provider: "anthropic",
    effort: REASONING_LEVELS,
    defaultEffort: "high",
    caching: "breakpoint",
    strictSchema: false,
    price: { input: 10, output: 50, longContext: false },
  },
  "claude-fable-5-1": {
    provider: "anthropic",
    effort: REASONING_LEVELS,
    defaultEffort: "high",
    caching: "breakpoint",
    strictSchema: false,
    price: { input: 10, output: 50, longContext: false, cacheRead: 0.25 },
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
  "gpt-5.6-sol": {
    provider: "openai",
    effort: OPTIONAL_REASONING_LEVELS,
    defaultEffort: "low",
    caching: "implicit",
    strictSchema: true,
    price: { input: 4, output: 20, longContext: true },
  },
  "gpt-5.6-terra": {
    provider: "openai",
    effort: OPTIONAL_REASONING_LEVELS,
    defaultEffort: "medium",
    caching: "implicit",
    strictSchema: true,
    price: { input: 2, output: 12, longContext: true },
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
