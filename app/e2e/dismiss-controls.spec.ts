import { test, expect } from "./test.ts";
import type { Page } from "@playwright/test";
import { isolateStorage, waitForRoom, openGameOptions } from "./engineProbe.ts";

for (const viewport of [
  { width: 1063, height: 815 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`dismiss controls and finishing Trace at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await isolateStorage(page);
    await page.goto("/#create-adventure");
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByTestId("local-create-submit").click();
    await waitForRoom(page, 1);
    const part = page.getByTestId("part-room:1:picture:1");
    if (viewport.width === 390 && !(await part.isVisible()))
      await page.getByTestId("workspace-parts").click();
    await expect(part).toBeVisible();
    await part.click();
    await page.getByRole("button", { name: "Trace an image", exact: true }).click();
    const trace = page.getByTestId("image-reference");
    await expect(trace).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath(`trace-${viewport.width}.png`),
    });
    await trace.locator("header button").click();
    const focus = page.getByTestId("workspace-focus");
    if ((await focus.getAttribute("aria-pressed")) === "true") await focus.click();
    const flag = page.getByRole("button", { name: "chime_done Flag 204", exact: true });
    if (viewport.width === 390 && !(await flag.isVisible()))
      await page.getByTestId("workspace-parts").click();
    await expect(flag).toBeVisible();
    await flag.click();
    const details = page.getByTestId("binding-details");
    await expect(details).toBeVisible();
    await details.locator("header button").scrollIntoViewIfNeeded();
    await expect(details.locator("header button")).toBeInViewport();
    const headerBox = (await details.locator("header").boundingBox())!;
    const closeBox = (await details.locator("header button").boundingBox())!;
    expect(closeBox.x + closeBox.width).toBeCloseTo(headerBox.x + headerBox.width, 0);
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath(`details-${viewport.width}.png`),
    });
    await details.locator("header button").click();
    await openGameOptions(page, "help-menu");
    await page.getByTestId("btn-help-guide").click();
    const help = page.getByTestId("help-guide");
    await expect(help).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath(`dialog-${viewport.width}.png`),
    });
    const close = help.getByRole("button", { name: "Close", exact: true });
    await expect(close).toBeVisible();
    await expect(close).toHaveText("");
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
    if (viewport.width === 390 && !(await part.isVisible()))
      await page.getByTestId("workspace-parts").click();
    await part.click();
    await page.getByRole("button", { name: "Trace an image", exact: true }).click();
    const done = trace.getByRole("button", { name: "Done", exact: true });
    await expect(done).toBeVisible();
    await done.click();
    await expect(trace).toBeHidden();
    if (viewport.width === 390 && !(await flag.isVisible()))
      await page.getByTestId("workspace-parts").click();
    await flag.click();
    await expect(details).toBeVisible();
    const detailsClose = details.getByRole("button", { name: "Close", exact: true });
    await expect(detailsClose).toBeVisible();
    await expect(detailsClose).toHaveText("");
    await detailsClose.focus();
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
  });
}

async function start(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByTestId("local-create-submit").click();
  await waitForRoom(page, 1);
}
test("name details closes with Escape from its Close control", async ({ page }) => {
  await start(page);
  const flag = page.getByRole("button", { name: "chime_done Flag 204", exact: true });
  await expect(flag).toBeVisible();
  await flag.click();
  const details = page.getByTestId("binding-details");
  await expect(details).toBeVisible();
  const close = details.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeVisible();
  await close.focus();
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
});
test("History, Problems and Inspector dismiss with × and Escape", async ({ page }) => {
  await start(page);
  await page.getByTestId("workspace-saved").click();
  const history = page.getByTestId("workspace-history");
  await expect(history).toBeVisible();
  const historyClose = history.locator("header button");
  await expect(historyClose).toBeVisible();
  await expect.soft(historyClose).toHaveAccessibleName("Close");
  await historyClose.focus();
  await page.keyboard.press("Escape");
  await expect.soft(history).toBeHidden();
  if (await history.isVisible()) await historyClose.click();
  await page.keyboard.press("ControlOrMeta+j");
  const problems = page.getByTestId("workspace-problems");
  await expect(problems).toBeVisible();
  const problemsClose = problems.getByRole("button", { name: "Close", exact: true });
  await expect(problemsClose).toBeVisible();
  await expect.soft(problemsClose).toHaveAccessibleName("Close");
  await problemsClose.focus();
  await page.keyboard.press("Escape");
  await expect.soft(problems).toBeHidden();
  if (await problems.isVisible()) await problemsClose.click();
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("settings-advanced").click();
  await page.getByTestId("settings-inspect").click();
  await page.keyboard.press("Escape");
  const inspector = page.getByRole("complementary", { name: "Game inspector", exact: true });
  await expect(inspector).toBeVisible();
  const inspectorClose = inspector.locator("header > button");
  await expect(inspectorClose).toBeVisible();
  await expect.soft(inspectorClose).toHaveAccessibleName("Close");
  await expect.soft(inspectorClose).toHaveText("×");
  await inspectorClose.focus();
  await page.keyboard.press("Escape");
  await expect(inspector).toBeHidden();
});

test("Share preview offers Cancel beside Download and its menu dismisses outside", async ({
  page,
}) => {
  await start(page);
  await page.getByTestId("part-room:1:picture:1").click();
  const share = page.getByTestId("studio-share");
  await share.click();
  const still = page.getByTestId("studio-share-still");
  await expect(still).toBeVisible();
  await page.getByTestId("workspace-focus").click();
  await expect(still).toBeHidden();
  await share.click();
  await expect(still).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(still).toBeHidden();
  await share.click();
  await still.click();
  const dialog = page.getByTestId("studio-share-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("studio-share-download")).toBeVisible();
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(dialog).toBeHidden();
});
