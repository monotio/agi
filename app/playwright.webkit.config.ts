import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config.ts";

/**
 * Every WebKit run, selected by tag so a test runs once in each project it names:
 *
 * - desktop-webkit runs the tests tagged @webkit-desktop: desktop Studio in Safari's engine
 *   (an edit kept, reloaded and exported, keyboard-only editing, the unkept-changes dialog, popovers,
 *   the first-run tour and its focus moves, Start over undone) at the Desktop Safari device scale.
 * - iphone-webkit runs the tests tagged @phone: the touch-only AGI input contract plus the menu,
 *   settings and dialog specs whose WebKit pointer, focus and Escape handling must match Safari's
 *   engine, not only Chromium.
 *
 * `npm --prefix app run e2e:webkit` runs both projects; `e2e:webkit-desktop` and `e2e:phone` run one.
 */
export default defineConfig({
  ...base,
  // Comparable performance trends need an isolated run: `@perf` belongs to
  // `e2e:perf`, which runs alone on one worker, whatever other tags a test adds.
  grepInvert: /@perf/,
  projects: [
    {
      name: "desktop-webkit",
      grep: /@webkit-desktop/,
      use: {
        ...devices["Desktop Safari"],
        // Entrance animations are not waited out; phone WebKit keeps full motion, and a test
        // whose rule needs motion opts out with page.emulateMedia({ reducedMotion: "no-preference" }).
        reducedMotion: "reduce",
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
    { name: "iphone-webkit", grep: /@phone/, use: { browserName: "webkit" } },
  ],
});
