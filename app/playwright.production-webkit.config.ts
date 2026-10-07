import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.production.config.ts";

// The production suite in desktop WebKit. Same built app and real worker;
// its own output directory so artifacts never collide with the Chromium
// production run (serve port comes from AGI_E2E_PORT in the base config).
export default defineConfig({
  ...base,
  outputDir: "./test-results/production-webkit",
  projects: [{ name: "desktop-webkit", use: { ...devices["Desktop Safari"] } }],
});
