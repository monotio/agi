import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

/**
 * Both browser engines must support the same touch-only AGI input contract. The menu and
 * settings specs run here too so their WebKit pointer, focus and Escape handling is checked
 * in Safari's engine, not only in Chromium; dialog-fit holds every dialog's buttons on a
 * phone screen in both engines.
 */
export default defineConfig({
  ...base,
  testMatch: [
    "agent-drawer.spec.ts",
    "workspace-debug-controls.spec.ts",
    "workspace-launch.spec.ts",
    "workspace-frame.spec.ts",
    "workspace-images.spec.ts",
    "logic-names.spec.ts",
    "words-phone.spec.ts",
    "workspace-picture.spec.ts",
    "workspace-stage.spec.ts",
    "workspace-layout.spec.ts",
    "workspace-phone-controls.spec.ts",
    "workspace-polish.spec.ts",
    "workspace-parity.spec.ts",
    "picture-palette.spec.ts",
    "studio-picture-s3.spec.ts",
    "workspace-readonly.spec.ts",
    "project-progress.spec.ts",
    "phone-input.spec.ts",
    "phone-landscape.spec.ts",
    "history-transport.spec.ts",
    "kq-phone.spec.ts",
    "ai-settings.spec.ts",
    "menu-flow.spec.ts",
    "crt-amount.spec.ts",
    "amiga-region.spec.ts",
    "reference-art.spec.ts",
    "reported-spend.spec.ts",
    "synthetic-walkthrough.spec.ts",
    "dialog-fit.spec.ts",
    "disk-import.spec.ts",
  ],
  projects: [
    { name: "android-chromium", use: { browserName: "chromium" } },
    { name: "iphone-webkit", use: { browserName: "webkit" } },
  ],
});
