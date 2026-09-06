import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

/** Both browser engines must support the same touch-only AGI input contract. */
export default defineConfig({
  ...base,
  testMatch: ["phone-input.spec.ts", "kq-phone.spec.ts"],
  projects: [
    { name: "android-chromium", use: { browserName: "chromium" } },
    { name: "iphone-webkit", use: { browserName: "webkit" } },
  ],
});
