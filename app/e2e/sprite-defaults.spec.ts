import type { Locator, Page } from "@playwright/test";
import { VOCABULARY } from "../../src/vocabulary.ts";
import {
  closeWorkspaceEditor,
  enterCreateMode,
  openWorkspaceView,
  waitForRoom,
} from "./engineProbe.ts";
import { expect, reviewShot, test } from "./test.ts";

/**
 * Sprite Studio's defaults: the side panel opens at its essentials (Palette,
 * the cel with its mirror chip, Details closed, Preview, In room, Ask folded)
 * and keeps both previews reachable at 1440×900 and 1024×600; Details is
 * remembered per viewer; the Onion menu holds Before, After and how many
 * cels; and the mirror chip's Edit both edits the pair.
 */

async function playTutorial(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await enterCreateMode(page);
}

async function openApprentice(page: Page): Promise<Locator> {
  await openWorkspaceView(page, 0);
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  return studio;
}

/** The side panel's sections, top to bottom, by their test ids. */
function sections(panel: Locator): Promise<(string | null)[]> {
  return panel.evaluate((element) =>
    [...element.children].map(
      (child) =>
        (child as HTMLElement).dataset["testid"] ??
        child.querySelector<HTMLElement>("[data-testid]")?.dataset["testid"] ??
        null,
    ),
  );
}

for (const [width, height] of [
  [1440, 900],
  [1024, 600],
] as const)
  test(`at ${width}×${height} the side panel opens its essentials and keeps both previews reachable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await playTutorial(page);
    const studio = await openApprentice(page);
    const panel = studio.getByRole("complementary", { name: "Cel, previews and linked loops" });
    await expect(panel).toBeVisible();
    expect(await sections(panel)).toEqual([
      "sprite-palette",
      "sprite-cel-panel",
      "sprite-cel-details",
      "sprite-preview",
      "sprite-room-preview",
    ]);
    await expect(studio.getByTestId("sprite-palette").locator("h3")).toBeVisible();
    await expect(studio.getByTestId("sprite-palette").locator("h3")).toHaveText("Palette");
    await expect(studio.getByTestId("sprite-transparent")).toBeVisible();
    await expect(studio.getByTestId("sprite-transparent")).toHaveText("Transparent colour");
    await expect(studio.getByTestId("sprite-cel-summary")).toBeVisible();
    await expect(studio.getByTestId("sprite-cel-summary")).toHaveText("Cel 0 · Loop 0");
    await expect(studio.getByTestId("sprite-cel-size")).toBeVisible();
    await expect(studio.getByTestId("sprite-cel-size")).toHaveText("10 × 32");
    await expect(studio.getByTestId("sprite-mirror-text")).toBeVisible();
    await expect(studio.getByTestId("sprite-mirror-text")).toHaveText("Loop 1 mirrors this");
    await expect(studio.getByTestId("sprite-propagate")).toBeVisible();
    await expect(studio.getByTestId("sprite-propagate")).toHaveText("Edit both");
    await expect(studio.getByTestId("sprite-cel-details")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(studio.getByTestId("sprite-cel-details-body")).toHaveCount(0);
    await expect(studio.getByTestId("sprite-tool-options")).toBeVisible();
    await expect(studio.getByTestId("sprite-tool-options")).toHaveText(/^Pencil\s*11 light cyan/);
    // Byte size sits quietly in the shared status bar.
    await expect(page.getByTestId("workspace-status")).toContainText(/^[\s\S]*[\d,]+ bytes/);

    // Both previews remain reachable in the shared panel at each height.
    for (const id of ["sprite-preview", "sprite-room-preview"]) {
      const preview = studio.getByTestId(id);
      await expect(preview).toBeVisible();
      await preview.scrollIntoViewIfNeeded();
      await expect(preview).toBeInViewport();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await reviewShot(page, `sprite-${width}-pencil`);
  });

test("Details is remembered per viewer across a reopen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await playTutorial(page);
  let studio = await openApprentice(page);
  await studio.getByTestId("sprite-cel-details").click();
  const body = studio.getByTestId("sprite-cel-details-body");
  await expect(body).toBeVisible();
  await expect(body.getByTestId("sprite-resize-width")).toHaveValue("10");
  await expect(body.getByTestId("sprite-feet")).toHaveText("bottom row");
  await closeWorkspaceEditor(page);
  await expect(studio).toBeHidden();
  studio = await openApprentice(page);
  await expect(studio.getByTestId("sprite-cel-details")).toHaveAttribute("aria-expanded", "true");
  await expect(studio.getByTestId("sprite-cel-details-body")).toBeVisible();
  // Closed again, it stays closed on the next open.
  await studio.getByTestId("sprite-cel-details").click();
  await closeWorkspaceEditor(page);
  studio = await openApprentice(page);
  await expect(studio.getByTestId("sprite-cel-details-body")).toHaveCount(0);
});

test("the transparent colour's ⓘ says what it is, and Choose another… opens it in Details", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await playTutorial(page);
  const studio = await openApprentice(page);
  await studio.getByTestId("sprite-transparent").getByTestId("explain-transparent").click();
  const pop = page.getByTestId("explain-pop");
  await expect(pop).toHaveAttribute("data-term", "transparent");
  await expect(pop.getByTestId("explain-says")).toHaveText(VOCABULARY.transparentColour.help);
  await pop.evaluate((element) => Promise.all(element.getAnimations().map((a) => a.finished)));
  await reviewShot(page, "sprite-transparent-explainer");
  await pop.getByTestId("sprite-transparent-choose").click();
  await expect(pop).toHaveCount(0);
  await expect(studio.getByTestId("sprite-cel-details")).toHaveAttribute("aria-expanded", "true");
  await expect(studio.getByTestId("sprite-transparent-colour")).toBeFocused();
});

test("Onion ▾ holds Before, After and how many cels, and Esc closes it first", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await playTutorial(page);
  const studio = await openApprentice(page);
  const onion = studio.getByTestId("sprite-onion");
  const canvas = studio.getByTestId("sprite-canvas");
  /** How many onion skins the canvas draws. */
  const skins = () => canvas.getAttribute("data-onion");
  await expect(onion).toHaveText("Onion skin");
  await expect(canvas).toHaveAttribute("data-onion", "2");
  await onion.click();
  const menu = studio.getByTestId("sprite-onion-menu");
  await expect(menu).toBeVisible();
  const before = menu.getByTestId("sprite-onion-prev");
  const after = menu.getByTestId("sprite-onion-next");
  await expect(before).toBeChecked();
  await expect(after).toBeChecked();
  await before.uncheck();
  expect(await skins()).toBe("1");
  await menu.getByRole("radio", { name: "3" }).click();
  expect(await skins()).toBe("3");
  await after.uncheck();
  expect(await skins()).toBe("0");
  // Esc closes the menu, back on its button; Studio stays open.
  await after.focus();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(onion).toBeFocused();
  await expect(studio).toBeVisible();
});
