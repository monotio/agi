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
import {
  beginProviderBudget,
  trackImageSpend,
  providerBudgetReached,
  extendProviderBudget,
} from "../../agent/providerBudget.ts";
import { imageReportedSpend } from "./imageSpend.ts";
import { DEFAULT_MODELS } from "../../../../src/agent/modelEffort.ts";
export function createImageGenerationMount(input: {
  session: ProjectSession;
  current(): boolean;
  use(image: ProjectImageInput): Promise<void>;
  openSettings(): void;
  provider?: OpenAiImageProvider;
}) {
  let account = beginProviderBudget(Number(localStorage.getItem("monotio_agi.taskBudget") ?? 5));
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
      continueBudget() {
        extendProviderBudget(account);
        return account.limit;
      },
      currentSpend() {
        return {
          amount: account.spent,
          budget: account.limit,
          priceKnown: true,
          incomplete: account.usageIncomplete,
        };
      },
      startRequest(summary) {
        account = beginProviderBudget(Number(localStorage.getItem("monotio_agi.taskBudget") ?? 5));
        if (providerBudgetReached(account))
          throw new GenerationRefusal(
            "budget",
            "Budget reached. Continue adds another task budget.",
          );
        const requestAccount = account;
        const settle = trackImageSpend(requestAccount);
        return (offer) => {
          const spend = imageReportedSpend(summary.model, offer?.usage);
          const budget = settle(spend.incomplete ? null : spend.amount, spend.amount);
          return {
            ...spend,
            amount: requestAccount.spent,
            incomplete: requestAccount.usageIncomplete,
            budget,
          };
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
