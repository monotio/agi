import { defineConfig } from "@playwright/test";

// Override the port when running alongside a development server.
const PORT = Number(process.env["AGI_E2E_PORT"] ?? 5199);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  ...(process.env["CI"] ? { workers: 2 } : {}),
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    trace: "retain-on-failure",
  },
  // Each run owns its server; keep source files stable during verification.
  webServer: {
    command: `npx vite --mode test --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
