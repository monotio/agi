/** Generation uses the same image intake as a dropped or chosen file. */
import type { ProjectSession } from "../../project/projectSession.ts";
import type { ProjectImageInput } from "../../../../src/creative/imageOperations.ts";
import { CREATIVE_SOURCE_FORMAT, type CreativeSource } from "../../../../src/creative/catalog.ts";
import {
  createCreativeGeneration,
  savedOpenAiCredential,
  GenerationRefusal,
} from "./creativeGeneration.ts";
import { createOpenAiImageProvider, type OpenAiImageProvider } from "./openaiImageProvider.ts";
import { loadAiSettings } from "../../settings/aiSettings.ts";
import { configureImageBudget, reserveImageBudget } from "../../agent/providerBudget.ts";
import { estimateImageOutputCost } from "./openaiImageProvider.ts";
import { DEFAULT_MODELS } from "../../../../src/agent/modelEffort.ts";
export function createImageGenerationMount(input: {
  session: ProjectSession;
  current(): boolean;
  use(image: ProjectImageInput): Promise<void>;
  openSettings(): void;
  provider?: OpenAiImageProvider;
}) {
  configureImageBudget(Number(localStorage.getItem("monotio_agi.taskBudget") ?? 5));
  const credential = savedOpenAiCredential(() =>
    loadAiSettings(localStorage, DEFAULT_MODELS, import.meta.env.MODE === "test"),
  );
  const context = () => ({
    workspaceId: input.session.runToken,
    closed: !input.current(),
    busy: false,
    lifetime: input.session.lifetime,
    generation: 0,
    revision: "images",
    authoring: "images",
    draftRevision: 0,
    workspaceVersion: 0,
  });
  return createCreativeGeneration({
    provider: input.provider ?? createOpenAiImageProvider({ credentials: credential }),
    host: {
      context: async () => context(),
      sources: () => [],
      board: () => [],
      material: async () => null,
      raster: async () => null,
      hasCredential: () => credential() !== null,
      openSettings: input.openSettings,
      reserveRequest(summary, approved) {
        const output = estimateImageOutputCost(summary.model, summary.quality, summary.size);
        // Input image usage varies by model; an unverified request asks for allowance.
        const estimate =
          output === null || summary.images.length
            ? null
            : output + (summary.promptCodeUnits * 5) / 1_000_000 + 0.009;
        let settle: ReturnType<typeof reserveImageBudget>;
        try {
          settle = reserveImageBudget(estimate, approved);
        } catch {
          throw new GenerationRefusal(
            "budget",
            "This request may pass your budget. Continue to allow this request.",
          );
        }
        return (offer) => {
          const usage = offer?.usage;
          const rate = summary.model === "gpt-image-2" ? 15 : 30;
          settle(
            usage?.outputTokens !== undefined &&
              usage.inputTextTokens !== undefined &&
              usage.inputImageTokens !== undefined
              ? (usage.outputTokens * rate +
                  usage.inputTextTokens * 5 +
                  usage.inputImageTokens * 8) /
                  1_000_000
              : null,
          );
        };
      },
      async stageGenerated(use) {
        if (!input.current())
          throw new GenerationRefusal("closed", "Open this project again to use the image.");
        await input.use({
          title: use.review.title ?? use.review.summary.prompt,
          mime: use.intake.encoded.mime,
          encoded: use.intake.encodedBytes,
          width: use.intake.normalized.width,
          height: use.intake.normalized.height,
          rgba: use.intake.pixels,
        });
        const record: CreativeSource = {
          format: CREATIVE_SOURCE_FORMAT,
          version: 1,
          identity: {
            id: use.intake.encoded.hash,
            incarnation: input.session.runToken,
            revision: 0,
          },
          encoded: use.intake.encoded,
          normalized: use.intake.normalized,
          availability: "original",
          origin: { kind: "generated", title: use.review.title ?? use.review.summary.prompt },
        };
        return record;
      },
    },
  });
}
