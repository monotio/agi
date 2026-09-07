import { defineConfig } from "@playwright/test";

const remote = process.env["AGI_DEPLOY_URL"];
export default defineConfig({
  testDir: "./production",
  timeout: 60_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: remote ?? "http://localhost:5299",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  ...(remote
    ? {}
    : {
        webServer: {
          command: "node --experimental-strip-types ../scripts/serve-production.ts",
          url: "http://localhost:5299/",
          reuseExistingServer: false,
        },
      }),
});
