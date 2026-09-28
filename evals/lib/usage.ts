/** Provider usage priced at a model's MODEL_CAPABILITIES rates, for the budgeted eval lanes. */
import type { LlmUsage } from "../../app/src/agent/llmClient.ts";
import { MODEL_CAPABILITIES } from "../../src/agent/modelEffort.ts";

/** USD for one request's usage at the model's rates; null without a price. */
export function requestCost(model: string, usage: LlmUsage): number | null {
  const rate = MODEL_CAPABILITIES[model]?.price;
  if (!rate) return null;
  const long = rate.longContext && usage.input > 272000;
  const input = rate.input * (long ? 2 : 1);
  const cacheRead = (rate.cacheRead ?? rate.input * 0.1) * (long ? 2 : 1);
  const output = rate.output * (long ? 1.5 : 1);
  const reads = Math.min(usage.input, usage.cachedInput);
  const writes = Math.min(usage.input - reads, usage.cacheWriteInput);
  return (
    ((usage.input - reads - writes) * input + reads * cacheRead + writes * input * 1.25) / 1e6 +
    (usage.output * output) / 1e6
  );
}
