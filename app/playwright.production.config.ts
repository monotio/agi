import { defineConfig } from "@playwright/test";

const remote = process.env["AGI_DEPLOY_URL"];
export default defineConfig({
  testDir: "./production",
  timeout: 60_000,
  workers: 1,
  // WebKit on the Linux runner is a different build from Safari's on macOS and
  // occasionally stalls on a first paint; one retry there marks a stall as
  // flaky instead of failing the run. Locally a stall stays a failure.
  retries: process.env["CI"] ? 1 : 0,
  use: { baseURL: remote ?? "http://localhost:5299", headless: true },
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
