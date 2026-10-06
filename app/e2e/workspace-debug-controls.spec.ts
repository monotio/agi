import { test, expect } from "./test.ts";
import { isolateStorage, waitForRoom } from "./engineProbe.ts";
import type { Page } from "@playwright/test";

async function starter(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
}
async function parts(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-editor")).toBeAttached();
  const show = page.getByTestId("workspace-show-game");
  if (await show.isVisible()) await show.click();
  if (page.viewportSize()!.width <= 600 && !(await page.getByTestId("parts-list").isVisible()))
    await page.getByTestId("workspace-parts").click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
}

test("debug controls follow LOGIC and a paused session @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page.getByTestId("part-room:1:picture:1").click();
  await expect(page.getByTestId("room-studio")).toBeVisible();
  const header = page.locator(".workspace-context");
  await expect(header.getByRole("group", { name: "Debug controls" })).toHaveCount(0);
  await page.getByTestId("part-room:1:logic").click();
  await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
  await expect(page.getByTestId("workspace-update")).toBeVisible();
  await page.getByTestId("workspace-logic-editor").locator("textarea.inputarea").focus();
  await page.keyboard.press("F5");
  await expect(header.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.getByTestId("part-room:1:picture:1").click();
  await expect(page.getByTestId("room-studio")).toBeVisible();
  await expect(header.getByRole("group", { name: "Debug controls" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByTestId("workspace-problems")).toBeVisible();
  // Pause stays in the context row; the running session shows it on LOGIC.
  await page.getByTestId("project-tab-logic:1").click();
  await expect(header.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await header.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByTestId("workspace-debug-status")).toBeVisible();
  await expect(page.getByTestId("workspace-debug-status")).toContainText("Paused");
  // While the session is stopped the controls stay on every tab's context row.
  await parts(page);
  await page.getByTestId("part-room:1:picture:1").click();
  await expect(page.getByTestId("room-studio")).toBeVisible();
  await expect(header.getByRole("button", { name: "Step over (F10)", exact: true })).toBeVisible();
  await expect(header.getByTestId("debug-stop")).toBeVisible();
  await header.getByTestId("debug-stop").click();
  await expect(header.getByRole("group", { name: "Debug controls" })).toHaveCount(0);
});

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test(`picture debugger layout at ${width} @webkit-desktop`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await starter(page);
    await parts(page);
    await page.getByTestId("part-room:1:logic").click();
    await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
    await page.getByTestId("workspace-logic-editor").locator("textarea.inputarea").focus();
    await page.keyboard.press("F5");
    await expect(page.locator(".workspace-context").getByTestId("debug-stop")).toBeVisible();
    await parts(page);
    await page.getByTestId("part-room:1:picture:1").click();
    await expect(page.getByTestId("room-studio")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`picture-${width}.png`),
      animations: "disabled",
    });
  });
}
