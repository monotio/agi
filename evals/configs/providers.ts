/**
 * Promptfoo Provider Matrix for AGI authoring lanes.
 * Modeled on the author's eval architecture: central model IDs, dual-provider lanes
 * for OpenAI Responses API (GPT-6) and Anthropic Messages API.
 */

import { AGENT_TOOLS } from "../../src/agent/tools.ts";
import { modelEffortOptions, resolveModelEffort } from "../../src/agent/modelEffort.ts";
import { assertLiveEnv, LiveRunRefused } from "../lib/live-guard.ts";
import {
  anthropicToolDefinitions,
  type AnthropicToolDefinition,
} from "../../src/agent/toolTransport.ts";

export const MODEL_IDS = {
  gpt61Sol: "gpt-6.1-sol",
  gpt6Astra: "gpt-6-astra",
  gpt6Sol: "gpt-6-sol",
  gpt6Luna: "gpt-6-luna",
  claudeOpus55: "claude-opus-5-5",
  claudeSonnet55: "claude-sonnet-5-5",
  claudeFable51: "claude-fable-5-1",
};

export function variantOpenAiTools() {
  return AGENT_TOOLS.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: true,
  }));
}

export function variantAnthropicTools(): AnthropicToolDefinition[] {
  return anthropicToolDefinitions(AGENT_TOOLS);
}

/** One promptfoo provider descriptor built by the matrix. */
export interface ProviderLane {
  id: string;
  label: string;
  config: Record<string, unknown>;
}

export interface ProviderMatrixOptions {
  effort?: string;
  openaiConfig?: Record<string, unknown>;
  anthropicConfig?: Record<string, unknown>;
  /** GPT-6.1 Sol, the app default, benchmarked as its own lane. */
  includeSol61?: boolean;
  /** The original GPT-6 Sol; toggled separately so both can be compared. */
  includeSol?: boolean;
  includeAstra?: boolean;
  includeAnthropic?: boolean;
}

/**
 * One OpenAI Responses lane. The effort sent to the model must be one it
 * accepts: an openaiConfig reasoning object contributes the effective effort,
 * which is validated before the descriptor exists; an unsupported pair
 * refuses the lane instead of shipping a rejected request. The resolved
 * effort is written into the final reasoning after the openaiConfig spread so
 * an override without effort (say {summary:"auto"}) keeps its fields without
 * silently dropping it.
 */
function openAiLane(
  model: string,
  effort: string,
  openaiConfig: Record<string, unknown>,
): ProviderLane {
  const override = openaiConfig["reasoning"];
  if (override !== undefined && (override === null || typeof override !== "object"))
    throw new Error(`Invalid reasoning override for ${model}: expected an object.`);
  const fields = (override ?? {}) as Record<string, unknown>;
  const selected = fields["effort"] ?? effort;
  const supported = modelEffortOptions(model).find((level) => level === selected);
  if (supported === undefined)
    throw new Error(`Reasoning effort ${String(selected)} is not supported by ${model}.`);
  const resolved = resolveModelEffort(model, supported, "openai");
  const config: Record<string, unknown> = {
    reasoning: { effort: resolved },
    tools: variantOpenAiTools(),
    ...openaiConfig,
  };
  config["reasoning"] = { ...fields, effort: resolved };
  return {
    id: `openai:responses:${model}`,
    label: `openai:${model}@${resolved}`,
    config,
  };
}

export function providerMatrix({
  effort = "medium",
  openaiConfig = {},
  anthropicConfig = {},
  includeSol61 = true,
  includeSol = true,
  includeAstra = true,
  includeAnthropic = true,
}: ProviderMatrixOptions = {}): ProviderLane[] {
  const env = process.env;
  // Keys alone start nothing: the lanes need EVAL_LIVE=1 and a budget.
  try {
    assertLiveEnv(env, "EVAL_RUN_BUDGET_USD", "the promptfoo genesis lanes");
  } catch (error) {
    if (!(error instanceof LiveRunRefused)) throw error;
    console.error(`[evals] ${error.message}`);
    return [];
  }
  const hasOpenAi = Boolean(env["OPENAI_API_KEY"]);
  const hasAnthropic = Boolean(env["ANTHROPIC_API_KEY"]);

  const providers: ProviderLane[] = [];
  if (hasOpenAi) {
    if (includeSol61) providers.push(openAiLane(MODEL_IDS.gpt61Sol, effort, openaiConfig));
    if (includeSol) providers.push(openAiLane(MODEL_IDS.gpt6Sol, effort, openaiConfig));
    if (includeAstra) providers.push(openAiLane(MODEL_IDS.gpt6Astra, effort, openaiConfig));
  } else {
    console.error("[evals] Skipping OpenAI lanes: OPENAI_API_KEY not set");
  }

  if (hasAnthropic && includeAnthropic) {
    providers.push({
      id: `anthropic:messages:${MODEL_IDS.claudeOpus55}`,
      label: `anthropic:${MODEL_IDS.claudeOpus55}`,
      config: {
        tools: variantAnthropicTools(),
        ...anthropicConfig,
      },
    });
  } else if (!hasAnthropic && includeAnthropic) {
    console.error("[evals] Skipping Anthropic lanes: ANTHROPIC_API_KEY not set");
  }

  return providers;
}
