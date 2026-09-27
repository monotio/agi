import { type Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";

/**
 * A phone held sideways: Play is sized from the visible height, so the top
 * bar, the screen beside the pad, and the transport strip all fit without
 * page scroll, and opening Keys scrolls the pad inside its own column.
 */
test.use({ hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 } });

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  // Whole-pixel tolerance for sub-pixel edges that merely touch.
  return (
    a.x + a.width - 1 > b.x &&
    b.x + b.width - 1 > a.x &&
    a.y + a.height - 1 > b.y &&
    b.y + b.height - 1 > a.y
  );
}

async function assertFits(page: Page, label: string): Promise<void> {
  const page_ = await page.evaluate(() => ({
    scroll: document.scrollingElement!.scrollHeight - window.innerHeight,
    scrollY: window.scrollY,
  }));
  expect(page_.scroll, `${label}: the page does not scroll`).toBeLessThanOrEqual(0);
  expect(page_.scrollY, `${label}: nothing scrolled the page`).toBe(0);
  const bar = (await page.locator(".play-bar").boundingBox())!;
  expect(bar.y, `${label}: the top bar is on screen`).toBeGreaterThanOrEqual(0);
  await expect(page.getByTestId("settings-menu")).toBeInViewport({ ratio: 1 });
  const strip = (await page.locator(".play-strip").boundingBox())!;
  expect(strip.y + strip.height, `${label}: the strip ends on screen`).toBeLessThanOrEqual(391);
  const pad = (await page.getByTestId("touch-controls").boundingBox())!;
  const screen = (await page.locator(".screen").boundingBox())!;
  expect(overlaps(pad, strip), `${label}: the pad clears the strip`).toBe(false);
  expect(overlaps(screen, strip), `${label}: the screen clears the strip`).toBe(false);
  expect(overlaps(screen, pad), `${label}: the screen clears the pad`).toBe(false);
}

test("phone landscape fits Play in the visible height, with Keys open too", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect
    .poll(async () => (await textHook(page)).frame, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect(page.getByTestId("touch-controls")).toBeVisible();
  await expect(page.getByTestId("history-timeline")).toBeVisible();
  await assertFits(page, "Play");
  await page.screenshot({ path: test.info().outputPath("phone-landscape.png") });

  await page.getByTestId("touch-controls").getByText("Keys", { exact: true }).tap();
  await expect(
    page.getByTestId("touch-controls").getByRole("button", { name: "F1", exact: true }),
  ).toBeVisible();
  await assertFits(page, "Keys open");
  await page.screenshot({ path: test.info().outputPath("phone-landscape-keys.png") });
});
