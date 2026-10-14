import { defineConfig } from "@playwright/test";

// Override the port when running alongside a development server.
const PORT = Number(process.env["AGI_E2E_PORT"] ?? 5199);

export default defineConfig({
  testDir: "./e2e",
  // Runs on separate ports must not clear each other's screenshots and traces.
  outputDir: `./test-results/${PORT}`,
  timeout: 60_000,
  retries: 0,
  // Tests are independent; files that need their order say so with a serial describe.
  fullyParallel: true,
  ...(process.env["CI"] ? { workers: Number(process.env["PLAYWRIGHT_WORKERS"] ?? 2) } : {}),
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    // Snapshots copy every dev-server module per page load and cost a fifth of test CPU; a failure
    // trace keeps the actions, console and network. Rerun with --trace=on for a DOM-level diagnosis.
    trace: { mode: "retain-on-failure", snapshots: false },
  },
  // Chromium emulates reduced motion, so clicks do not wait out entrance animations; the WebKit
  // config replaces `projects` and sets motion per project. A test whose rule needs motion opts
  // out with page.emulateMedia({ reducedMotion: "no-preference" }) and says why.
  projects: [{ name: "chromium", use: { reducedMotion: "reduce" } }],
  // Each run owns its server; keep source files stable during verification.
  webServer: {
    command: `npx vite --mode test --port ${PORT}`,
    // No file watching: a late watcher event under load reloads pages mid-test.
    env: { AGI_E2E_NO_WATCH: "1" },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
    // Vite's own lines (ready, dependency re-bundling, restarts) go into the run's log, so a
    // failure while the server re-bundles or restarts can be told apart from a test fault.
    stdout: "pipe",
  },
});
