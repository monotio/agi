import { createApp, h } from "vue";
import CreativeGenerate from "../../src/studio/creative/CreativeGenerate.vue";
import { createCreativeGeneration } from "../../src/studio/creative/creativeGeneration.ts";
import { createOpenAiImageProvider } from "../../src/studio/creative/openaiImageProvider.ts";

/** Exercise the production review panel without a saved workspace or paid transport. */
export function mount() {
  const controller = createCreativeGeneration({
    provider: createOpenAiImageProvider({
      credentials: () => null,
      fetch: async () => {
        throw new Error("Review must never submit a provider request");
      },
    }),
    host: {
      context: async () => ({
        workspaceId: "review-fixture",
        closed: false,
        busy: false,
        lifetime: "review-fixture",
        generation: 0,
        revision: "initial",
        authoring: "initial",
        draftRevision: 0,
        workspaceVersion: 0,
      }),
      sources: () => [],
      board: () => [],
      material: async () => null,
      raster: async () => null,
      hasCredential: () => false,
      openSettings: () => {},
      stageGenerated: async () => {
        throw new Error("Review must never stage a generated source");
      },
    },
  });
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;inset:0;overflow:auto;background:white;padding:24px;z-index:9999";
  document.body.append(root);
  createApp({ render: () => h(CreativeGenerate, { controller }) }).mount(root);
}
