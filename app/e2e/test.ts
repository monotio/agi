import { test as base, devices, expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * Specs that import synthetic, uncatalogued games meet the interpreter-profile
 * picker before the game can be played. They are not about that choice, so an
 * automatic fixture keeps the detected default whenever the picker blocks an
 * action; e2e/profile-picker.spec.ts exercises the picker itself.
 */
export async function keepDetectedProfile(page: Page): Promise<void> {
  const picker = page.getByTestId("profile-picker-dialog");
  await page.addLocatorHandler(picker, async () => {
    await picker.getByTestId("profile-picker-keep").click();
  });
}

/**
 * After every test the page's pause matches the worker's: a game that is
 * frozen while the bar shows it running, or the reverse, fails the test that
 * left it so. The worker answers a state query after every earlier command,
 * so its reply is the pause the game really runs under; a pause still in
 * flight settles within the poll.
 */
async function pauseDisagreement(page: Page): Promise<string | null> {
  if (page.isClosed()) return null;
  let seen = "";
  try {
    await expect
      .poll(
        async () => {
          seen = await page.evaluate(async () => {
            const state = window.__AGI_STATE__;
            if (state?.phase !== "running") return "agree";
            const before = state.paused;
            const project = (
              window as unknown as {
                __AGI_PROJECT__?: {
                  query(type: "state"): Promise<{ runtime?: { paused: boolean } } | null>;
                };
              }
            ).__AGI_PROJECT__;
            if (!project) return "the running game has no project hook";
            const worker = (await project.query("state"))?.runtime;
            if (!worker) return "the running game has no worker state";
            if (state.paused !== before) return "the page's pause changed during the query";
            return worker.paused === before
              ? "agree"
              : `page ${before ? "paused" : "running"}, game ${worker.paused ? "paused" : "running"}`;
          });
          return seen;
        },
        { timeout: 3_000 },
      )
      .toBe("agree");
    return null;
  } catch {
    return seen || "the page did not answer the pause check";
  }
}

async function expectPauseAgreement(page: Page): Promise<void> {
  const problem = await pauseDisagreement(page);
  expect(problem, "the page shows the game's real pause").toBeNull();
}

export const test = base.extend<{
  keepDetectedProfile: void;
  keepDetectedProfileOption: boolean;
  cpuThrottle: void;
  pauseAgreement: void;
}>({
  // A spec about the picker itself, or one whose profile is the subject, sets
  // `test.use({ keepDetectedProfileOption: false })` to meet the picker as a user would.
  keepDetectedProfileOption: [true, { scope: "test", option: true }],
  pauseAgreement: [
    async ({ page, browser }, use) => {
      // Every page is checked once, just before it closes, while its worker can
      // still answer. Problems are reported after the test so an earlier failure
      // stays first. The fixture page is checked at the end, not here.
      const problems: string[] = [];
      const checked = new WeakSet<Page>([page]);
      const check = async (opened: Page) => {
        if (checked.has(opened)) return;
        checked.add(opened);
        const problem = await pauseDisagreement(opened);
        if (problem) problems.push(`${opened.url()}: ${problem}`);
      };
      const watch = (context: BrowserContext) => {
        const wrapClose = (opened: Page) => {
          const close = opened.close.bind(opened);
          opened.close = async (...closeArgs: Parameters<typeof close>) => {
            await check(opened);
            return close(...closeArgs);
          };
        };
        context.pages().forEach(wrapClose);
        context.on("page", wrapClose);
        const close = context.close.bind(context);
        context.close = async (...closeArgs: Parameters<typeof close>) => {
          for (const opened of context.pages()) await check(opened);
          return close(...closeArgs);
        };
      };
      watch(page.context());
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...args: Parameters<typeof newContext>) => {
        const context = await newContext(...args);
        watch(context);
        return context;
      };
      try {
        await use();
      } finally {
        browser.newContext = newContext;
      }
      for (const opened of page.context().pages()) await check(opened);
      expect(problems, "pages the test opened show the game's real pause").toEqual([]);
      await expectPauseAgreement(page);
    },
    { auto: true },
  ],
  cpuThrottle: [
    async ({ page, browserName }, use) => {
      const rate = Number(process.env["AGI_E2E_CPU_RATE"] ?? 1);
      if (rate > 1) {
        if (browserName !== "chromium") throw new Error("CPU throttling requires Chromium");
        const session = await page.context().newCDPSession(page);
        await session.send("Emulation.setCPUThrottlingRate", { rate });
      }
      await use();
    },
    { auto: true },
  ],
  keepDetectedProfile: [
    async ({ page, keepDetectedProfileOption }, use) => {
      if (keepDetectedProfileOption) await keepDetectedProfile(page);
      await use();
    },
    { auto: true },
  ],
});

export { devices, expect };

/** A review screenshot: to `$AGI_STUDIO_SHOTS/<name>.png` when that folder is set, else to the test's output folder. */
export function reviewShot(page: Page, name: string): Promise<Buffer> {
  const folder = process.env["AGI_STUDIO_SHOTS"];
  return page.screenshot({
    path: folder ? `${folder}/${name}.png` : test.info().outputPath(`${name}.png`),
    animations: "disabled",
  });
}
