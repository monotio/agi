import { defineConfig } from "@playwright/test";

/**
 * Documentation screenshots, run by `npm run media:capture` (scripts/capture-media.ts),
 * never by `check` or the e2e suite. One Chromium worker drives the real app in test
 * mode, with the stub provider for any AI state, at a fixed 1440×900 viewport and
 * device scale 2. Reduced motion holds animated previews on their first cel.
 */
const PORT = Number(process.env["AGI_MEDIA_PORT"] ?? 5871);

export default defineConfig({
  testDir: "./e2e/media",
  testMatch: "*.media.ts",
  outputDir: "../.captures/media/results",
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npx vite --mode test --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
