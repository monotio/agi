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
import { DEFAULT_MODELS } from "../../../../src/agent/modelEffort.ts";
export function createImageGenerationMount(input: {
  session: ProjectSession;
  current(): boolean;
  use(image: ProjectImageInput): Promise<void>;
  openSettings(): void;
  provider?: OpenAiImageProvider;
}) {
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
      async stageGenerated(use) {
        if (!input.current())
          throw new GenerationRefusal("closed", "Open this project again to use the image.");
        await input.use({
          title: use.review.summary.prompt,
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
          origin: { kind: "generated", title: use.review.summary.prompt },
        };
        return record;
      },
    },
  });
}
