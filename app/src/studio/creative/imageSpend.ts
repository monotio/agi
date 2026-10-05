import type { ReportedSpend } from "../../agent/reportedSpend.ts";
import type { OpenAiImageUsage } from "./openaiImageProvider.ts";

/** The same token rates used to pause image requests at the shared budget. */
export function imageTokenRates(model: string) {
  if (model === "gpt-image-2") return { text: 5, image: 8, output: 15 };
  if (model.startsWith("gpt-image-2.5-")) return { text: 5, image: 8, output: 30 };
  return null;
}

export function imageReportedSpend(model: string, usage?: OpenAiImageUsage): ReportedSpend {
  const rate = imageTokenRates(model);
  const output = usage?.outputTokens ?? usage?.outputImageTokens;
  if (!rate) return { amount: 0, priceKnown: false, incomplete: true };
  return {
    amount:
      ((usage?.inputTextTokens ?? 0) * rate.text +
        (usage?.inputImageTokens ?? 0) * rate.image +
        (output ?? 0) * rate.output) /
      1_000_000,
    priceKnown: true,
    incomplete:
      output === undefined ||
      usage?.inputTextTokens === undefined ||
      usage.inputImageTokens === undefined,
  };
}
