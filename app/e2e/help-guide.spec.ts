import { expect, test } from "@playwright/test";
import { isolateStorage, openGameOptions, textHook } from "./engineProbe.ts";

/**
 * The Help guide opens from every screen, and each "Show me" opens the real
 * control it describes — or is absent where that control cannot open.
 */
test("the home screen's Help opens the guide and Go to Create opens Create", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("btn-help").click();
  const guide = page.getByTestId("help-guide");
  await expect(guide).toBeVisible();
  await expect(guide.getByRole("heading", { name: "Walking and talking" })).toBeVisible();
  // In-game controls cannot open from the home screen.
  await expect(guide.getByTestId("help-action-controls")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("help-home.png") });

  await guide.getByTestId("help-section-creating").click();
  await guide.getByTestId("help-action-create").click();
  await expect(guide).toBeHidden();
  await expect(page.getByTestId("create-adventure-disclosure")).toHaveAttribute("open", "");
});

test("in a game, the guide's Show me opens the controls and the map", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect
    .poll(async () => (await textHook(page)).frame, { timeout: 30_000 })
    .toBeGreaterThan(0);

  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-help-guide").click();
  const guide = page.getByTestId("help-guide");
  await guide.getByTestId("help-action-controls").click();
  await expect(page.getByTestId("game-controls")).toBeVisible();
  await page.getByTestId("controls-close").click();

  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-help-guide").click();
  await guide.getByTestId("help-action-map").first().click();
  await expect(page.getByTestId("world-map")).toBeVisible();
});

test("the guide fits a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("btn-help").click();
  const guide = page.getByTestId("help-guide");
  await expect(guide).toBeVisible();
  const box = (await guide.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath("help-phone.png") });
});
