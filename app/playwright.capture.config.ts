import { defineConfig } from "@playwright/test";
import type { GpuStageOption } from "./e2e/test.ts";
import base from "./playwright.config.ts";

/** Small, provider-mocked scenarios using original resources for documentation captures. */
export default defineConfig<GpuStageOption>({
  ...base,
  testMatch: [
    "**/tutorial-playability.spec.ts",
    "**/catalog-remix-resume.spec.ts",
    "**/sound-feedback.spec.ts",
  ],
  outputDir: "../.captures/browser",
  workers: 1,
  use: {
    ...base.use,
    // Documentation shows the picture players see.
    gpuStage: true,
    viewport: { width: 1280, height: 900 },
    video: { mode: "on", size: { width: 1280, height: 900 } },
  },
});
