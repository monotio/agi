import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import {
  isolateStorage,
  openGameOptions,
  surfaceBox,
  waitForCycles,
  waitForRoom,
} from "./engineProbe.ts";

/**
 * Original proportions shows the 320×200 frame the way a monitor of the day
 * did: the same width, and as tall as that monitor's pixels made it — the
 * 4:3 tested here, wider still on a PAL Amiga. It is display only — the
 * frame, and the mapping from a click to a frame pixel, are unchanged.
 */
async function screenRatio(page: Page): Promise<number> {
  const box = await surfaceBox(page);
  return box.width / box.height;
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`${viewport.name}: Original proportions stretches the screen and persists`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await isolateStorage(page);
    await page.goto("/");
    await page.getByTestId("catalog-play-adventure-department").click();
    await waitForRoom(page, 1, { coldBoot: true });
    await waitForCycles(page, 2);
    expect(await screenRatio(page)).toBeCloseTo(1.6, 1);

    await openGameOptions(page, "settings-menu");
    const toggle = page.getByTestId("toggle-original-aspect");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await page.screenshot({ path: test.info().outputPath(`settings-${viewport.name}.png`) });
    await toggle.click();
    await expect.poll(() => screenRatio(page)).toBeCloseTo(4 / 3, 1);
    expect(await page.evaluate(() => localStorage.getItem("monotio_agi.originalAspect"))).toBe(
      "on",
    );
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: test.info().outputPath(`original-aspect-${viewport.name}.png`),
      fullPage: true,
    });

    // Choosing square pixels again restores 8:5, and the choice persists.
    await openGameOptions(page, "settings-menu");
    await page.getByTestId("toggle-original-aspect").click();
    await expect.poll(() => screenRatio(page)).toBeCloseTo(1.6, 1);
    await page.reload();
    await expect(page.locator(".app-container")).not.toHaveClass(/original-aspect/);
  });
}
