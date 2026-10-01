import { expect, test } from "./test.ts";
import { prepareIsolatedPage } from "./logicDebugShared.ts";

test("the focused Studio tab can close from the keyboard @webkit-desktop", async ({ page }) => {
  await prepareIsolatedPage(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const url: string = "/e2e/fixtures/studioFrameTabsReview.ts";
    await (await import(url)).mount();
  });
  const selected = page.getByTestId("project-tab-picture:1");
  await selected.focus();
  await expect(selected).toBeFocused();
  await selected.press("Delete");
  await expect(selected).toHaveCount(0);
  await expect(page.getByTestId("project-tab-sound:1")).toBeFocused();
  await expect(page.getByTestId("project-tab-sound:1")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("project-tab-logic:1")).toHaveCount(1);
});
