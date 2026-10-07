import type { Locator, Page } from "@playwright/test";
import {
  closeWorkspaceEditor,
  enterCreateMode,
  isolateStorage,
  openWorkspacePicture,
  openWorkspaceView,
  textHook,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";

/**
 * The calm canvas, as a rule over every element: in Room Studio and Sprite
 * Studio, with the probe, the control-line legend, the values popover and a
 * selection open, anything positioned over the picture that takes the
 * pointer and says something is a menu or a dialog the creator opened, or
 * carries its own close button or drag handle. Everything else docks
 * beside the canvas.
 */

async function playTutorial(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await enterCreateMode(page);
}

/**
 * Elements inside `root` placed over a picture (`pictures`) with
 * `position: absolute|fixed`, taking the pointer and showing text, that are
 * neither inside a menu or dialog nor carry a close button or drag handle.
 */
function strays(root: Locator, pictures: string): Promise<string[]> {
  return root.evaluate((root, pictures) => {
    const boxes = [...root.querySelectorAll(pictures)].map((e) => e.getBoundingClientRect());
    const found: string[] = [];
    for (const element of root.querySelectorAll<HTMLElement>("*")) {
      const style = getComputedStyle(element);
      if (style.position !== "absolute" && style.position !== "fixed") continue;
      // The stage and the panes hold the picture: they frame it.
      if (element.querySelector(pictures)) continue;
      if (style.pointerEvents === "none" || style.visibility === "hidden") continue;
      const text = element.innerText?.trim();
      if (!text) continue;
      const r = element.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      const over = boxes.some(
        (p) => r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top,
      );
      if (!over) continue;
      if (element.closest('[role="menu"], [role="dialog"]')) continue;
      if (element.querySelector('[data-role="drag-handle"], button[aria-label="Close"]')) continue;
      found.push(`${element.className || element.tagName}: ${text.slice(0, 48)}`);
    }
    return found;
  }, pictures);
}

for (const [width, height] of [
  [1440, 900],
  [1280, 720],
  [1024, 600],
] as const) {
  test(`at ${width}×${height} nothing stray lies over the picture or the cel`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await playTutorial(page);
    await openWorkspacePicture(page, 2);
    const studio = page.getByTestId("room-studio");
    await expect(studio).toBeVisible();
    const pictures = ".studio-pane__pixels, .game-surface";
    /** Every stray, by the step that showed it: all of them are reported at once. */
    const seen: string[] = [];
    const look = async (step: string, root: Locator, over: string) =>
      seen.push(...(await strays(root, over)).map((stray) => `${step}: ${stray}`));

    // A selection and the probe, in the Art lens.
    await studio.getByRole("treeitem", { name: /^West doorway/ }).click();
    await studio.getByRole("group", { name: /^Canvas/ }).focus();
    await page.keyboard.press("g");
    await expect(studio.getByTestId("ghost-probe")).toBeVisible();
    await look("art", studio, pictures);

    // The Priority lens with its room panel showing.
    await page.keyboard.press("2");
    await look("priority", studio, pictures);
    await closeWorkspaceEditor(page);
    await expect(studio).toBeHidden();

    // Sprite Studio: a selection on the cel.
    await openWorkspaceView(page, 0);
    const sprite = page.getByTestId("sprite-studio");
    await expect(sprite).toBeVisible();
    await sprite.getByTestId("sprite-stage").focus();
    await page.keyboard.press("m");
    const cel = (await sprite.locator(".sprite-studio__canvas canvas").boundingBox())!;
    await page.mouse.move(cel.x + cel.width * 0.3, cel.y + cel.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(cel.x + cel.width * 0.7, cel.y + cel.height * 0.6, { steps: 4 });
    await page.mouse.up();
    await look("sprite", sprite, ".sprite-studio__canvas canvas");
    expect(seen).toEqual([]);
  });
}
