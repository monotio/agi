import { expect, test } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

/**
 * A phone keyboard shrinks the visible viewport at an unchanged width. The
 * game screen must keep its size and scroll to the top of what stays
 * visible — it draws the command line itself, so the whole screen is what
 * the player needs to see while typing.
 */
test("opening the keyboard keeps the game screen full width and in view", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect
    .poll(async () => (await textHook(page)).frame, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const screen = page.locator(".screen");
  const before = (await screen.boundingBox())!;
  expect(before.width).toBeGreaterThan(340);

  await page.getByTestId("input-line").focus();
  // A keyboard and its suggestion bar on a small phone leave about 300 px:
  // less than the header and screen together, so the screen must scroll up.
  await page.setViewportSize({ width: 390, height: 300 });
  await expect.poll(async () => (await screen.boundingBox())!.width).toBe(before.width);
  await expect
    .poll(async () => {
      const box = (await screen.boundingBox())!;
      // Sub-pixel rounding of the scrolled border edge is allowed.
      return box.y > -1 && box.y + box.height < 301;
    })
    .toBe(true);
});
