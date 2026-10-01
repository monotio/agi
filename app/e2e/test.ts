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
 * The Studios' first-run tour (app/src/studio/useStudioTour.ts) marks the
 * Studios toured, so it stays out of specs that open a Studio for other
 * reasons; `isolateStorage` keeps the record through its clear.
 * The standalone editor harness can use `studioTour: "fresh"` to meet it.
 */
export const STUDIO_TOUR_KEY = "monotio_agi.studioTour";
export async function seeStudioTours(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    try {
      if (localStorage.getItem(key) === null)
        localStorage.setItem(key, JSON.stringify({ version: 1, seen: ["room", "sprite"] }));
    } catch {
      /* blocked storage shows the tour; no spec runs there */
    }
  }, STUDIO_TOUR_KEY);
}

/** Pages from `browser.newContext()` call `keepDetectedProfile` and `seeStudioTours` themselves. */
export const test = base.extend<{
  keepDetectedProfile: void;
  studioTour: "seen" | "fresh";
  seedStudioTour: void;
}>({
  keepDetectedProfile: [
    async ({ page }, use) => {
      await keepDetectedProfile(page);
      await use();
    },
    { auto: true },
  ],
  studioTour: ["seen", { option: true }],
  seedStudioTour: [
    async ({ page, studioTour }, use) => {
      if (studioTour === "seen") await seeStudioTours(page);
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
