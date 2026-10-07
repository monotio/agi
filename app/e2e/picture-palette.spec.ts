import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { test, expect } from "./test.ts";
import { isolateStorage, workspaceSaved, workspaceUpdated } from "./engineProbe.ts";

const HINT = "Pick a drawing tool to paint, or select a shape to recolour it";
async function picture(page: Page) {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  if (page.viewportSize()!.width <= 600) await page.getByTestId("workspace-parts").click();
  await page.getByTestId("part-room:1:picture:1").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}
async function history(page: Page) {
  return page.evaluate(() => {
    const session = (
      window as unknown as {
        __AGI_PROJECT__: { getSession(): ProjectSession };
      }
    ).__AGI_PROJECT__.getSession();
    return {
      commits: session.capture().history.commits.length,
      source: session.model.capture().read("picture:1")!.content,
    };
  });
}
for (const width of [1063, 1440, 390]) {
  test.describe(`${width} palette`, () => {
    test.use({
      viewport: { width, height: width === 1063 ? 815 : width === 1440 ? 900 : 844 },
      hasTouch: width === 390,
    });
    test("palette review screenshots", async ({ page }) => {
      const studio = await picture(page);
      await expect(studio.getByTestId("studio-scrubber")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: test.info().outputPath(`select-${width}.png`),
        animations: "disabled",
      });
      await studio.locator('button[data-tool="brush"]').click();
      await expect(studio.getByRole("radiogroup", { name: "Palette", exact: true })).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath(`drawing-${width}.png`),
        animations: "disabled",
      });
    });
    test("palette follows the tool and selection with one Undo step", async ({ page }) => {
      const studio = await picture(page);
      const strip = studio.locator(".workspace-palette");
      await expect(strip).toBeVisible();
      const hint = strip.getByText(HINT, { exact: true });
      await expect(hint).toBeVisible();
      await expect(hint).toHaveText(HINT);
      await expect(strip.getByRole("radio")).toHaveCount(0);
      await expect(studio.getByTestId("studio-value-visual")).toBeDisabled();
      const initialBox = (await strip.boundingBox())!;
      await studio.locator('button[data-tool="brush"]').click();
      await expect(strip.getByRole("radiogroup", { name: "Palette", exact: true })).toBeVisible();
      expect((await strip.boundingBox())!.height).toBe(initialBox.height);
      const scrubber = studio.getByTestId("studio-scrubber");
      await expect(scrubber).toBeVisible();
      const box = (await strip.boundingBox())!;
      expect((await scrubber.boundingBox())!.y).toBeGreaterThanOrEqual(box.y + box.height);
      await studio.locator('button[data-tool="select"]').click();
      await studio.getByRole("radio", { name: "Items", exact: true }).click();
      const sun = studio.locator('[role="treeitem"][data-row="sun"]');
      await expect(sun).toBeVisible();
      await sun.click();
      await workspaceSaved(page);
      const before = await history(page);
      const red = strip.getByRole("radio", { name: "Colour 4: red", exact: true });
      await expect(red).toBeVisible();
      await red.click();
      await expect(red).toHaveAttribute("aria-checked", "true");
      expect(await history(page)).toEqual(before);
      await workspaceUpdated(page);
      const after = await history(page);
      expect(after.source).not.toEqual(before.source);
      expect(after.commits).toBe(before.commits + 1);
      if (width <= 600) await page.getByRole("button", { name: "Edit", exact: true }).click();
      await red.press("ControlOrMeta+z");
      await workspaceSaved(page);
      expect((await history(page)).source).toEqual(before.source);
      await expect(hint).toBeHidden();
      await studio
        .getByTestId("studio-options-bar")
        .getByRole("radio", { name: "Priority", exact: true })
        .click();
      const beforeRefusal = await history(page);
      const band = strip.getByRole("radio", { name: /^Depth 8:/ });
      await expect(band).toBeVisible();
      await band.click();
      const notice = page.locator(".workspace-status").getByTestId("studio-notice");
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(
        "Sun has no priority. Give it a Priority pen in the Inspector, or select a shape with one.",
      );
      expect(await history(page)).toEqual(beforeRefusal);
    });
  });
}

test("lenses, rail wells and colour keys share the selection context", async ({ page }) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  const studio = await picture(page);
  const strip = studio.locator(".workspace-palette");
  const options = studio.getByTestId("studio-options-bar");
  await studio.locator('button[data-tool="brush"]').click();
  await options.getByRole("radio", { name: "Priority", exact: true }).click();
  // Priority: the four control lines, then the distance bands 4–15.
  const bands = strip.getByRole("radiogroup", { name: "Priority", exact: true });
  await expect(bands).toBeVisible();
  await expect(bands.getByRole("radio")).toHaveCount(16);
  await page.screenshot({ path: test.info().outputPath("depth-1063.png"), animations: "disabled" });
  await bands.getByRole("radio", { name: /^Depth 8:/ }).click();
  const well = studio.getByTestId("studio-value-priority");
  await expect(well).toBeVisible();
  await expect(well).toHaveAttribute("data-value", "8");
  await well.click();
  const depthPicker = studio.getByRole("dialog", {
    name: "Priority for new shapes",
    exact: true,
  });
  await expect(depthPicker).toBeVisible();
  // The picker offers the control lines beside the bands.
  await expect(
    depthPicker.getByRole("radiogroup", { name: "Wall, gate, trigger or water for new shapes" }),
  ).toBeVisible();
  await depthPicker.getByRole("radio", { name: /^Depth 9,/ }).click();
  await expect(well).toHaveAttribute("data-value", "9");
  await bands.getByRole("radio", { name: /^Water:/ }).click();
  await expect(well).toHaveAttribute("data-value", "3");
  await options.getByRole("radio", { name: "Visual", exact: true }).click();
  await studio.locator('button[data-tool="select"]').click();
  await studio.getByRole("radio", { name: "Items", exact: true }).click();
  const sun = studio.locator('[role="treeitem"][data-row="sun"]');
  await expect(sun).toBeVisible();
  await sun.click();
  const artWell = studio.getByTestId("studio-value-visual");
  await artWell.click();
  const artPicker = studio.getByRole("dialog", { name: "Visual for selection", exact: true });
  await expect(artPicker).toBeVisible();
  await artPicker.getByRole("radio", { name: /^Colour 4,/ }).click();
  await workspaceUpdated(page);
  await expect(artWell).toHaveAttribute("data-value", "4");
  const beforeKey = await history(page);
  const red = strip.getByRole("radio", { name: "Colour 4: red", exact: true });
  await expect(red).toBeVisible();
  await red.press("ArrowRight");
  await expect(strip.getByRole("radio", { name: /^Colour 5:/ })).toBeFocused();
  expect(await history(page)).toEqual(beforeKey);
  await workspaceUpdated(page);
  expect((await history(page)).commits).toBe(beforeKey.commits + 1);
  await page.keyboard.press("ControlOrMeta+z");
  await workspaceSaved(page);
  expect((await history(page)).source).toEqual(beforeKey.source);
  await options.getByRole("radio", { name: "Priority", exact: true }).click();
  const beforeRefusal = await history(page);
  await bands.getByRole("radio", { name: /^Depth 8:/ }).click();
  const notice = page.locator(".workspace-status").getByTestId("studio-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(
    "Sun has no priority. Give it a Priority pen in the Inspector, or select a shape with one.",
  );
  expect(await history(page)).toEqual(beforeRefusal);
});
