import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config.ts";

/**
 * Desktop Studio in Safari's engine. The phone suite covers WebKit's touch
 * input; this project runs the desktop scenarios tagged @webkit-desktop:
 * a Room Studio edit kept, reloaded and exported, an export reimported in a
 * fresh browser, a Sprite Studio repair of a mirrored cel, a test walk and
 * Play here, keyboard-only editing, and the unkept-changes dialog.
 */
export default defineConfig({
  ...base,
  grep: /@webkit-desktop/,
  projects: [{ name: "desktop-webkit", use: { ...devices["Desktop Safari"] } }],
});
