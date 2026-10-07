import { expect, test } from "./test.ts";
import { canvasColors, isolateStorage, waitForRoom } from "./engineProbe.ts";

test("Problems opens its debugger when requested before the workspace loads", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/CreateWorkspace.vue*", async (route) => {
    requested.resolve();
    await release.promise;
    await route.continue();
  });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByTestId("local-create-submit").click();
  await waitForRoom(page, 1);
  await requested.promise;
  await expect(page.locator(".focus-zone-announcement")).toBeAttached();
  const modifier = await page.evaluate(async () => {
    const path = "/src/ui/keyLabel.ts";
    const { isApplePlatform } = await import(path);
    return isApplePlatform(navigator) ? "Meta" : "Control";
  });
  try {
    await page.keyboard.press(`${modifier}+j`);
    await expect(page.getByTestId("workspace-problems")).toHaveCount(0);
  } finally {
    release.resolve();
  }
  // Problems is a workspace tab now: its tab and view both appear.
  await expect(page.getByTestId("project-tab-problems")).toBeVisible();
  await expect(page.getByTestId("workspace-problems")).toBeVisible();
});

test("Problems stays dismissible while its panel module loads", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/WorkspaceDebugPanel.vue*", async (route) => {
    requested.resolve();
    await release.promise;
    await route.continue();
  });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByTestId("local-create-submit").click();
  await waitForRoom(page, 1);
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.locator(".focus-zone-announcement")).toBeAttached();
  const modifier = await page.evaluate(async () => {
    const path = "/src/ui/keyLabel.ts";
    const { isApplePlatform } = await import(path);
    return isApplePlatform(navigator) ? "Meta" : "Control";
  });
  await page.keyboard.press(`${modifier}+j`);
  // The tab opens at once, even while the problems view loads.
  const tab = page.getByTestId("project-tab-problems");
  await expect(tab).toBeVisible();
  await requested.promise;
  try {
    if (process.env["AGI_E2E_REVIEW_SHOTS"] === "1") {
      await expect.poll(() => canvasColors(page)).toBeGreaterThan(3);
      for (const viewport of [
        { width: 1063, height: 815 },
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await expect(tab).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`problems-${viewport.width}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = (await page.getByTestId("workspace-editor").boundingBox())!;
    expect(bounds.x).toBe(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Tabs close with their × only.
    const close = page.getByTestId("project-tab-close-problems");
    await expect(close).toBeVisible();
    await close.click();
    await expect(tab).toHaveCount(0);
    await page.keyboard.press(`${modifier}+j`);
    await expect(tab).toBeVisible();
    release.resolve();
    const panel = page.getByTestId("workspace-problems");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveText(
      "first_room · LOGIC 1: 'ego_view' names VIEW 0 in this project and shadows built-in Variable 16.".repeat(
        2,
      ),
    );
  } finally {
    release.resolve();
  }
  await page.keyboard.press(`${modifier}+j`);
  await expect(page.getByTestId("workspace-problems")).toBeHidden();
});
