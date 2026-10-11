import { test as base, expect, type Page } from "@playwright/test";

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
 * After every test the page's pause matches the interpreter's: a game that is
 * frozen while the bar shows it running, or the reverse, fails the test that
 * left it so. The pause may still be in flight, so the check polls briefly.
 */
async function expectPauseAgreement(page: Page): Promise<void> {
  if (page.isClosed()) return;
  const read = () =>
    page
      .evaluate(() => {
        const state = window.__AGI_STATE__;
        const engine = window.__AGI_TEXT__;
        return state?.phase === "running" && engine
          ? { page: state.paused, engine: engine.paused }
          : null;
      })
      .catch(() => null);
  await expect
    .poll(
      async () => {
        const seen = await read();
        return seen === null || seen.page === seen.engine ? "agree" : JSON.stringify(seen);
      },
      { message: "the page shows the interpreter's real pause state", timeout: 3_000 },
    )
    .toBe("agree");
}

export const test = base.extend<{
  keepDetectedProfile: void;
  cpuThrottle: void;
  pauseAgreement: void;
}>({
  pauseAgreement: [
    async ({ page }, use) => {
      await use();
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
    async ({ page }, use) => {
      await keepDetectedProfile(page);
      await use();
    },
    { auto: true },
  ],
});

export { expect };

/** A review screenshot: to `$AGI_STUDIO_SHOTS/<name>.png` when that folder is set, else to the test's output folder. */
export function reviewShot(page: Page, name: string): Promise<Buffer> {
  const folder = process.env["AGI_STUDIO_SHOTS"];
  return page.screenshot({
    path: folder ? `${folder}/${name}.png` : test.info().outputPath(`${name}.png`),
    animations: "disabled",
  });
}
