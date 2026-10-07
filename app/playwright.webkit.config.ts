import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config.ts";

/**
 * Desktop Studio in Safari's engine. The phone suite covers WebKit's touch
 * input; this project runs the desktop scenarios tagged @webkit-desktop:
 * a Room Studio edit kept, reloaded and exported, an export reimported in a
 * fresh browser, a Sprite Studio repair of a mirrored cel, a test walk and
 * Play here, keyboard-only editing, the unkept-changes dialog, an
 * explainer's popover (Unlock for now, Learn more into Help), the
 * first-run tour with its focus moves, and Start over from Home undone back
 * to the earlier session.
 */
export default defineConfig({
  ...base,
  grep: /@webkit-desktop/,
  projects: [
    {
      name: "desktop-webkit",
      use: {
        ...devices["Desktop Safari"],
        // Desktop Safari advertises macOS even on Linux. Monaco derives its
        // shortcuts from that identity; the shell and Playwright use the host OS.
        ...(process.platform === "linux"
          ? {
              userAgent: devices["Desktop Safari"].userAgent.replace(
                "Macintosh; Intel Mac OS X 10_15_7",
                "X11; Linux x86_64",
              ),
            }
          : {}),
      },
    },
  ],
});
