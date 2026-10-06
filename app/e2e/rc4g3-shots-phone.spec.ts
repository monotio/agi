import { devices, expect } from "@playwright/test";
import {
  enterCreateMode,
  isolateStorage,
  openWorkspacePicture,
  waitForRoom,
} from "./engineProbe.ts";
import { test } from "./test.ts";

/**
 * Throwaway phone screenshot run for the shell seam cleanup (not committed):
 * the Create workspace with a PICTURE editor open at 390×844 in WebKit.
 */
test.use({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 } });

test("picture editor at 390x844 @webkit-desktop", async ({ page }, info) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await enterCreateMode(page);
  await page.getByTestId("workspace-parts").click();
  await page.locator('[data-testid^="part-room:1:picture:"]').first().click();
  const studio = page.getByTestId("room-studio").filter({ visible: true });
  await expect(studio).toBeVisible();
  await page.screenshot({ path: info.outputPath("phone-390.png"), fullPage: true });
});
