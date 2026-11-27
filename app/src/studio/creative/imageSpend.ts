import type { ReportedSpend } from "../../agent/reportedSpend.ts";
import type { OpenAiImageUsage } from "./openaiImageProvider.ts";

/** The same token rates used to pause image requests at the shared budget. */
function imageTokenRates(model: string) {
  if (
    model === "gpt-image-2" ||
    model.startsWith("gpt-image-2.5-") ||
    model.startsWith("gpt-image-2.6-")
  )
    return { text: 5, image: 8, cached: 2, outputImage: 30, outputText: 30 };
  // Gemini image generation list prices per 1M tokens:
  // Nano Banana 2: $0.50 input, $3 text/thinking output, $60 image output.
  if (model === "gemini-3.1-flash-image")
    return { text: 0.5, image: 0.5, cached: 0.5, outputImage: 60, outputText: 3 };
  // Nano Banana Pro: $2 input, $12 text/thinking output, $120 image output.
  if (model === "gemini-3-pro-image")
    return { text: 2, image: 2, cached: 2, outputImage: 120, outputText: 12 };
  return null;
}

export function imageReportedSpend(model: string, usage?: OpenAiImageUsage): ReportedSpend {
  const rate = imageTokenRates(model);
  if (!rate) return { amount: 0, priceKnown: false, incomplete: true };
  const cached = usage?.inputCachedTokens ?? 0;
  const outputImage =
    usage?.outputImageTokens ??
    (usage?.outputTextTokens === undefined ? usage?.outputTokens : undefined);
  const outputText = usage?.outputTextTokens ?? 0;
  const inputText = usage?.inputTextTokens;
  const inputImage = usage?.inputImageTokens;
  return {
    amount:
      ((inputText ?? 0) * rate.text +
        Math.max(0, (inputImage ?? 0) - cached) * rate.image +
        cached * rate.cached +
        (outputImage ?? 0) * rate.outputImage +
        outputText * rate.outputText) /
      1_000_000,
    priceKnown: true,
    incomplete: outputImage === undefined || inputText === undefined || inputImage === undefined,
  };
}
