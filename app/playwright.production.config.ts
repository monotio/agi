import { defineConfig } from "@playwright/test";

const remote = process.env["AGI_DEPLOY_URL"];
// Override the port when another server holds the default.
const PORT = Number(process.env["AGI_E2E_PORT"] ?? 5299);
export default defineConfig({
  testDir: "./production",
  outputDir: `./test-results/production-${PORT}`,
  timeout: 60_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: remote ?? `http://localhost:${PORT}`,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  ...(remote
    ? {}
    : {
        webServer: {
          command: "node --experimental-strip-types ../scripts/serve-production.ts",
          url: `http://localhost:${PORT}/`,
          reuseExistingServer: false,
        },
      }),
});
