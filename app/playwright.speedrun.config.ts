import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

export default defineConfig({
  ...base,
  testMatch: "walkthroughs.spec.ts",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
