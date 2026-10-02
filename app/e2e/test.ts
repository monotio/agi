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

export const test = base.extend<{
  keepDetectedProfile: void;
}>({
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
