/**
 * Promptfoo Provider Matrix for AGI authoring lanes.
 * Modeled on the author's eval architecture: central model IDs, dual-provider lanes
 * for OpenAI Responses API (GPT-6) and Anthropic Messages API.
 */

import { AGENT_TOOLS } from "../../src/agent/tools.ts";
import {
  anthropicToolDefinitions,
  type AnthropicToolDefinition,
} from "../../src/agent/toolTransport.ts";

export const MODEL_IDS = {
  gpt6Astra: "gpt-6-astra",
  gpt6Sol: "gpt-6-sol",
  gpt6Luna: "gpt-6-luna",
  claudeOpus55: "claude-opus-5-5",
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
  includeSol?: boolean;
  includeAstra?: boolean;
  includeAnthropic?: boolean;
}

export function providerMatrix({
  effort = "medium",
  openaiConfig = {},
  anthropicConfig = {},
  includeSol = true,
  includeAstra = true,
  includeAnthropic = true,
}: ProviderMatrixOptions = {}): ProviderLane[] {
  const env = process.env;
  const hasOpenAi = Boolean(env["OPENAI_API_KEY"]);
  const hasAnthropic = Boolean(env["ANTHROPIC_API_KEY"]);

  const providers: ProviderLane[] = [];
  if (hasOpenAi) {
    if (includeSol) {
      providers.push({
        id: `openai:responses:${MODEL_IDS.gpt6Sol}`,
        label: `openai:${MODEL_IDS.gpt6Sol}@${effort}`,
        config: {
          reasoning: { effort },
          tools: variantOpenAiTools(),
          ...openaiConfig,
        },
      });
    }
    if (includeAstra) {
      providers.push({
        id: `openai:responses:${MODEL_IDS.gpt6Astra}`,
        label: `openai:${MODEL_IDS.gpt6Astra}@${effort}`,
        config: {
          reasoning: { effort },
          tools: variantOpenAiTools(),
          ...openaiConfig,
        },
      });
    }
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
