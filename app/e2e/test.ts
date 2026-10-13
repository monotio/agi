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

/** The option a test or config sets to create the GPU stage in Chromium and desktop WebKit. */
export type GpuStageOption = { gpuStage: boolean };

export const test = base.extend<
  {
    keepDetectedProfile: void;
    keepDetectedProfileOption: boolean;
    throttle: void;
    pauseAgreement: void;
    flatPictureUnlessStage: void;
  } & GpuStageOption
>({
  // A spec about the picker itself, or one whose profile is the subject, sets
  // `test.use({ keepDetectedProfileOption: false })` to meet the picker as a user would.
  keepDetectedProfileOption: [true, { scope: "test", option: true }],
  pauseAgreement: [
    async ({ page, browser }, use) => {
      // Every page, the fixture page included, is checked once: just before it
      // closes, while its worker can still answer, or at the end of the test.
      // Problems are reported after the test so an earlier failure stays first.
      const problems: string[] = [];
      const checked = new WeakSet<Page>();
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
      expect(problems, "every page shows the game's real pause").toEqual([]);
    },
    { auto: true },
  ],
  // Diagnostic CPU and request slowdowns for reproducing load races (docs/testing.md).
  throttle: [
    async ({ page, browserName }, use) => {
      const rate = Number(process.env["AGI_E2E_CPU_RATE"] ?? 1);
      const latency = Number(process.env["AGI_E2E_LATENCY_MS"] ?? 0);
      if ((rate > 1 || latency > 0) && browserName !== "chromium")
        throw new Error("Throttling requires Chromium");
      if (rate > 1) {
        const session = await page.context().newCDPSession(page);
        await session.send("Emulation.setCPUThrottlingRate", { rate });
      }
      if (latency > 0) {
        const session = await page.context().newCDPSession(page);
        await session.send("Network.enable");
        await session.send("Network.emulateNetworkConditions", {
          offline: false,
          latency,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
      }
      await use();
    },
    { auto: true },
  ],
  // The GPU stage draws the picture players see, but most tests read the flat
  // frame copy (engineProbe.ts). Chromium creates the stage only for a test
  // that sets `test.use({ gpuStage: true })` and for the timing budgets (@perf);
  // so does desktop WebKit, while phone WebKit always creates it. Test mode reads
  // the flag; builds ignore it.
  gpuStage: [false, { scope: "test", option: true }],
  flatPictureUnlessStage: [
    async ({ context, browser, browserName, gpuStage }, use, testInfo) => {
      // Phone WebKit (iphone-webkit) keeps the stage in every test.
      const flatProject = browserName === "chromium" || testInfo.project.name === "desktop-webkit";
      if (!flatProject || gpuStage || testInfo.tags.includes("@perf")) {
        await use();
        return;
      }
      const flat = () => {
        (globalThis as { __AGI_SKIP_GPU_STAGE__?: boolean }).__AGI_SKIP_GPU_STAGE__ = true;
      };
      await context.addInitScript(flat);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...args: Parameters<typeof newContext>) => {
        const opened = await newContext(...args);
        await opened.addInitScript(flat);
        return opened;
      };
      try {
        await use();
      } finally {
        browser.newContext = newContext;
      }
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
