/** Provider-supported effort levels, shared by the app and authoring evaluations. */
export type ModelEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_LEVELS: readonly ModelEffort[] = ["low", "medium", "high", "xhigh", "max"];
const OPTIONAL_REASONING_LEVELS: readonly ModelEffort[] = ["none", ...REASONING_LEVELS];

/**
 * The app pins an explicit effort for every model instead of leaving the provider default:
 * Sol low (it reduced cost on both stored Genesis briefs), claude-* high, other OpenAI medium.
 */
export function defaultModelEffort(model: string): ModelEffort {
  if (model === "gpt-5.6-sol") return "low";
  return model.startsWith("claude-") ? "high" : "medium";
}

export function modelEffortOptions(model: string): readonly ModelEffort[] {
  return ["gpt-5.6-sol", "gpt-5.6-terra"].includes(model)
    ? OPTIONAL_REASONING_LEVELS
    : REASONING_LEVELS;
}

export function resolveModelEffort(model: string, effort?: ModelEffort): ModelEffort {
  const selected = effort ?? defaultModelEffort(model);
  if (!modelEffortOptions(model).includes(selected))
    throw new Error(`Reasoning effort ${selected} is not supported by ${model}.`);
  return selected;
}
