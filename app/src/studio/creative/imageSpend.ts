import type { ReportedSpend } from "../../agent/reportedSpend.ts";
import type { OpenAiImageUsage } from "./openaiImageProvider.ts";

/** The same token rates used to pause image requests at the shared budget. */
function imageTokenRates(model: string) {
  if (model === "gpt-image-2" || model.startsWith("gpt-image-2.5-"))
    return { text: 5, image: 8, cached: 2, output: 30 };
  return null;
}

export function imageReportedSpend(model: string, usage?: OpenAiImageUsage): ReportedSpend {
  const rate = imageTokenRates(model);
  const output = usage?.outputTokens ?? usage?.outputImageTokens;
  const cached = usage?.inputCachedTokens ?? 0;
  if (!rate) return { amount: 0, priceKnown: false, incomplete: true };
  return {
    amount:
      ((usage?.inputTextTokens ?? 0) * rate.text +
        Math.max(0, (usage?.inputImageTokens ?? 0) - cached) * rate.image +
        cached * rate.cached +
        (output ?? 0) * rate.output) /
      1_000_000,
    priceKnown: true,
    incomplete:
      output === undefined ||
      usage?.inputTextTokens === undefined ||
      usage.inputImageTokens === undefined,
  };
}
