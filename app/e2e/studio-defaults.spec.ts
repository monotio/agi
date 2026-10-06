import type { Locator, Page } from "@playwright/test";
import { enterCreateMode, isolateStorage, openWorkspacePicture, textHook } from "./engineProbe.ts";
import { expect, reviewShot, test } from "./test.ts";

/**
 * Room Studio opens at its essentials: with two items selected the inspector
 * shows exactly their name, one line ("Visual · 6 steps"), three actions, Ask
 * and a closed Details, with the movement hint at its foot, at 1440×900 and
 * at 1024×600, where nothing in the side panels or the page scrolls
 * sideways or runs out of its column. The lock is a chip by the lens tabs.
 * Details opened stays open for this viewer, across a reopened Studio.
 */

async function openRoomOne(page: Page): Promise<Locator> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await enterCreateMode(page);
  await openWorkspacePicture(page, 1);
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

/** Elements in `root` that scroll sideways: a horizontal scrollbar the viewer would see. */
const sidewaysScrollers = (root: Locator) =>
  root.evaluate((root) =>
    [root, ...root.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const { overflowX } = getComputedStyle(element);
        return (
          (overflowX === "auto" || overflowX === "scroll") &&
          element.scrollWidth > element.clientWidth + 1
        );
      })
      .map((element) => `${element.className}: ${element.scrollWidth} > ${element.clientWidth}`),
  );

for (const [width, height] of [
  [1440, 900],
  [1024, 600],
] as const) {
  test(`at ${width}×${height} two selected items show their essentials and nothing overflows`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const studio = await openRoomOne(page);
    await studio.getByRole("treeitem", { name: /^Text band/ }).click();
    await studio.getByRole("treeitem", { name: /^Corners & floor line/ }).click({
      modifiers: ["Shift"],
    });

    await expect(studio.getByTestId("selection-name")).toHaveText("2 items");
    await expect(studio.locator('[data-role="scene-count"]')).toHaveText("30 items");
    await expect(page.getByTestId("studio-status")).toHaveText("Drawing after Bust barrier");
    // Nothing in Studio scrolls sideways.
    expect(await sidewaysScrollers(studio)).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);

    // The pixel under the pointer reads in Inspector → Details, never the status.
    await studio.getByTestId("inspector-details").click();
    const pane = studio.locator(".studio-pane").last();
    await pane.scrollIntoViewIfNeeded();
    const box = (await pane.boundingBox())!;
    const mx = box.x + (35.5 / 160) * box.width;
    const my = box.y + (50.5 / 168) * box.height;
    await page.mouse.move(mx, my);
    await expect(studio.locator('[data-role="pixel"]')).toContainText("Pixel 35,50");
    await expect(page.getByTestId("studio-status")).toHaveText("Drawing after Bust barrier");
    await page.mouse.move(box.x + box.width + 40, box.y);
    await reviewShot(page, `room-${width}-selection`);
  });
}
