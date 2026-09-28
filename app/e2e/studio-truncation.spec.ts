import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { enterCreateMode, isolateStorage, textHook } from "./engineProbe.ts";
import { clipped } from "./studioFit.ts";

/**
 * Studio's meaning-bearing lines are read whole: the tool's hint, the
 * status readout, a notice, a test walk's result, the fill's Why, the
 * scrubber's command and the sprite's subtitle either fit their box or wrap.
 * None is cut off with an ellipsis, at 1440 with the side panels open,
 * 1280 and 1024.
 */

async function playTutorial(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await enterCreateMode(page);
}

/** The screen point at the centre of logical cell x,y of the (last) pane. */
async function cell(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await page.locator(".studio-pane").last().boundingBox())!;
  const zoom = box.height / 168;
  return [box.x + (x + 0.5) * 2 * zoom, box.y + (y + 0.5) * zoom];
}

for (const [width, height] of [
  [1440, 900],
  [1280, 720],
  [1024, 600],
] as const) {
  test(`at ${width}×${height} Studio's lines of meaning are never cut short`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await playTutorial(page);
    const panel = page.getByTestId("world-panel");
    await panel.getByTestId("map-room-2").click();
    await panel.getByTestId("world-open-studio").click();
    const studio = page.getByTestId("room-studio");
    await expect(studio).toBeVisible();
    const seen: string[] = [];
    const look = async (name: string, target: Locator) => {
      await expect(target).toBeVisible();
      seen.push(...(await clipped(target)).map((line) => `${name}: ${line}`));
    };

    // The status readout of a pixel, the scrubber's command, the Select tool's hint.
    await studio.getByRole("treeitem", { name: /^West doorway/ }).click();
    await page.mouse.move(...(await cell(page, 80, 120)));
    await expect(studio.getByTestId("studio-status")).toContainText("x 80");
    await look("status", studio.getByTestId("studio-status"));
    await look("hint", studio.getByTestId("studio-hint"));
    await look("scrubber", studio.getByTestId("scrubber-command"));

    // A fill on coloured ground: its Why, and a notice.
    await studio.getByRole("group", { name: /^Canvas/ }).focus();
    await page.keyboard.press("f");
    await look("fill hint", studio.getByTestId("studio-hint"));
    await page.mouse.click(...(await cell(page, 80, 40)));
    await look("fill why", studio.getByTestId("bar-notice-summary"));
    await page.keyboard.press("v");
    await page.keyboard.press("ArrowLeft");
    await studio.getByRole("group", { name: /^Canvas/ }).focus();
    for (let k = 0; k < 30; k++) await page.keyboard.press("Shift+ArrowLeft");
    await look("notice", studio.getByTestId("studio-notice"));
    // It stays in the status line, off the picture, until it is closed.
    await expect(studio.locator(".studio__status").getByTestId("studio-notice")).toBeVisible();
    await page.waitForTimeout(5500);
    await expect(studio.getByTestId("studio-notice")).toBeVisible();
    await studio.getByTestId("studio-notice-close").click();
    await expect(studio.getByTestId("studio-notice")).toHaveCount(0);
    await expect(studio.getByTestId("studio-hint")).toBeVisible();

    // A test walk's result.
    await page.keyboard.press("3");
    await page.keyboard.press("t");
    await studio.locator('[data-role="door"][data-destination="1"] polygon').click();
    await page.mouse.click(...(await cell(page, 30, 140)));
    await expect(studio.getByTestId("walk-result-title")).toHaveText("Reached", {
      timeout: 30_000,
    });
    await look("walk", studio.getByTestId("walk-result"));
    await studio.getByTestId("studio-close").click();
    await expect(studio).toBeHidden();

    // The sprite's subtitle.
    await panel.getByTestId("map-room-1").click();
    await panel.getByTestId("world-open-sprite-0").click();
    const sprite = page.getByTestId("sprite-studio");
    await look("sprite subtitle", sprite.getByTestId("sprite-subtitle"));
    await look("sprite usage", sprite.getByTestId("sprite-usage"));
    await look("sprite hint", sprite.getByTestId("sprite-hint"));
    expect(seen).toEqual([]);
  });
}
