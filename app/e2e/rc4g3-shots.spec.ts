import { devices, expect } from "@playwright/test";
import {
  enterCreateMode,
  isolateStorage,
  openWorkspacePicture,
  waitForRoom,
} from "./engineProbe.ts";
import { test } from "./test.ts";

/**
 * Throwaway screenshot run for the shell seam cleanup (not committed): the
 * Create workspace with a PICTURE editor open, normal and Focus, at desktop
 * and phone sizes.
 */

async function boot(page: import("@playwright/test").Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await enterCreateMode(page);
}

test.describe("desktop", () => {
  for (const size of [
    { width: 1063, height: 815 },
    { width: 1440, height: 900 },
  ]) {
    test(`picture editor and focus at ${size.width}x${size.height}`, async ({ page }, info) => {
      await page.setViewportSize(size);
      await boot(page);
      await openWorkspacePicture(page, 1);
      const studio = page.getByTestId("room-studio").filter({ visible: true });
      await expect(studio).toBeVisible();
      await page.screenshot({ path: info.outputPath(`editor-${size.width}.png`) });
      const focus = page.getByTestId("workspace-focus");
      if ((await focus.getAttribute("aria-pressed")) !== "true") await focus.click();
      await expect(page.locator(".play-area")).toBeHidden();
      await page.screenshot({ path: info.outputPath(`focus-${size.width}.png`) });
      await page.getByTestId("workspace-focus").click();
      await expect(page.locator(".play-area")).toBeVisible();
    });
  }
});

test.describe("phone", () => {
  test.use({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 } });
  test("picture editor at 390x844", async ({ page }, info) => {
    await boot(page);
    await openWorkspacePicture(page, 1);
    await page.screenshot({ path: info.outputPath("phone-390.png"), fullPage: true });
  });
});
