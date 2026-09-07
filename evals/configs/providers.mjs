/**
 * Promptfoo Provider Matrix for AGI authoring lanes.
 * Modeled on the author's eval architecture: central model IDs, dual-provider lanes
 * for OpenAI Responses API (GPT-5.6 Sol/Terra) and Anthropic Messages API.
 */

import { AGENT_TOOLS } from "../../src/agent/tools.ts";
import { anthropicToolDefinitions } from "../../src/agent/toolTransport.ts";

export const MODEL_IDS = {
  gpt56Sol: "gpt-5.6-sol",
  gpt56Terra: "gpt-5.6-terra",
  claudeOpus5: "claude-opus-5",
  claudeFable5: "claude-fable-5",
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

export function variantAnthropicTools() {
  return anthropicToolDefinitions(AGENT_TOOLS);
}

export function providerMatrix({
  effort = "medium",
  openaiConfig = {},
  anthropicConfig = {},
  includeSol = true,
  includeTerra = true,
  includeAnthropic = true,
} = {}) {
  const env = process.env;
  const hasOpenAi = Boolean(env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY);

  const providers = [];

  if (hasOpenAi) {
    if (includeSol) {
      providers.push({
        id: `openai:responses:${MODEL_IDS.gpt56Sol}`,
        label: `openai:${MODEL_IDS.gpt56Sol}@${effort}`,
        config: {
          reasoning: { effort },
          tools: variantOpenAiTools(),
          ...openaiConfig,
        },
      });
    }
    if (includeTerra) {
      providers.push({
        id: `openai:responses:${MODEL_IDS.gpt56Terra}`,
        label: `openai:${MODEL_IDS.gpt56Terra}@${effort}`,
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
      id: `anthropic:messages:${MODEL_IDS.claudeOpus5}`,
      label: `anthropic:${MODEL_IDS.claudeOpus5}`,
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
