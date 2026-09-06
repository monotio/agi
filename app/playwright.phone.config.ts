import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

/**
 * Both browser engines must support the same touch-only AGI input contract. The menu and
 * settings specs run here too so their WebKit pointer, focus and Escape handling is checked
 * in Safari's engine, not only in Chromium.
 */
export default defineConfig({
  ...base,
  testMatch: [
    "phone-input.spec.ts",
    "kq-phone.spec.ts",
    "ai-settings.spec.ts",
    "menu-flow.spec.ts",
  ],
  projects: [
    { name: "android-chromium", use: { browserName: "chromium" } },
    { name: "iphone-webkit", use: { browserName: "webkit" } },
  ],
});
