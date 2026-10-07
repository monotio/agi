import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";
export default defineConfig({
  ...base,
  projects: [{ name: process.env["STATE_LIST_PHONE"] ? "iphone-webkit" : "desktop-webkit", use: { browserName: "webkit", ...(process.env["STATE_LIST_PHONE"] ? { viewport: { width: 390, height: 844 }, hasTouch: true } : {}) } }],
});
