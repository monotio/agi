import type { Locator, Page } from "@playwright/test";
import { TARGET_PROPERTY } from "../src/ui/explain.ts";
import {
  closeWorkspaceEditor,
  enterCreateMode,
  isolateStorage,
  openWorkspacePicture,
  openWorkspaceView,
  textHook,
  workspaceSaved,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";

/**
 * The calm canvas on the real app: nothing covers the picture, not even the
 * selection's actions, at three window sizes; the tool's options and the
 * selection's actions dock in a bar above the canvas, folding into More
 * rather than running out of it, and the tool's help sits in the status bar; `?` lists every key and Esc puts the list away; ⌘\ (Ctrl+\
 * off a Mac, and labelled so) hides the side panels while Tab and Shift+Tab only move focus; and
 * Sprite Studio's drawing backdrop is view only, never the view's bytes.
 */

async function playTutorial(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await enterCreateMode(page);
}

async function openRoomStudio(page: Page, room: number): Promise<Locator> {
  await openWorkspacePicture(page, room);
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

async function openApprentice(page: Page): Promise<Locator> {
  await openWorkspaceView(page, 0);
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  return studio;
}

/**
 * Points on a grid over `target` (within the scrolling `stage`) where
 * something other than the picture is on top: `allowed` names what may be.
 */
async function coveredPoints(target: Locator, stage: Locator, allowed: string): Promise<string[]> {
  const [box, view] = await Promise.all([target.boundingBox(), stage.boundingBox()]);
  const x1 = Math.max(box!.x, view!.x);
  const y1 = Math.max(box!.y, view!.y);
  const x2 = Math.min(box!.x + box!.width, view!.x + view!.width);
  const y2 = Math.min(box!.y + box!.height, view!.y + view!.height);
  return target.page().evaluate(
    ({ x1, y1, x2, y2, allowed }) => {
      const covered: string[] = [];
      for (let i = 0; i <= 24; i++)
        for (let j = 0; j <= 12; j++) {
          const x = x1 + 1 + ((x2 - x1 - 2) * i) / 24;
          const y = y1 + 1 + ((y2 - y1 - 2) * j) / 12;
          const top = document.elementFromPoint(x, y);
          if (!top?.closest(allowed))
            covered.push(`${Math.round(x)},${Math.round(y)}: ${top?.className || top?.tagName}`);
        }
      return covered;
    },
    { x1, y1, x2, y2, allowed },
  );
}

for (const [width, height] of [
  [1440, 900],
  [1280, 720],
  [1024, 600],
] as const) {
  test(`at ${width}×${height} nothing covers the picture or the cel, an item selected or not`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await playTutorial(page);
    const studio = await openRoomStudio(page, 2);
    const stage = studio.getByRole("group", { name: /^Canvas/ });
    const pane = studio.locator(".studio-pane").last();
    // The picture's own layers: its pixels, its overlays in picture coordinates (selection,
    // handles, the tools' marks, the Walk lens's doors). Nothing else, however it is nested.
    const allowed =
      ".studio-pane__pixels, .studio-pane__overlay, .tool-overlay, .walk-overlay, .ghost";
    const bar = studio.getByTestId("studio-options-bar");
    /** The options bar fits its width: what it cannot show folds into More. */
    /** Measured as the bar folds (useFold.ts): an explainer's invisible target is not content. */
    const barFits = () =>
      bar.evaluate((element, property) => {
        element.style.setProperty(property, "0");
        const fits = [element, ...element.children].every(
          (child) => child.scrollWidth <= child.clientWidth + 1,
        );
        element.style.removeProperty(property);
        return fits;
      }, TARGET_PROPERTY);

    // Art lens: an item selected, the rect tool with its options (the owner's case).
    await studio.getByRole("treeitem", { name: /^West doorway/ }).click();
    await stage.focus();
    await page.keyboard.press("r");
    await expect(studio.getByTestId("studio-tool-filled")).toBeVisible();
    expect(await coveredPoints(pane, stage, allowed)).toEqual([]);
    // Select with the item: its actions dock in the options bar, off the picture.
    await page.keyboard.press("v");
    await expect(studio.getByTestId("studio-hint")).toHaveText(/^Arrows nudge/);
    expect(await coveredPoints(pane, stage, allowed)).toEqual([]);
    await expect(bar.getByTestId("studio-selection-bar")).toBeVisible();
    await expect(studio.getByRole("treeitem", { name: /^West doorway/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(bar.getByTestId("selection-priority")).toBeVisible();
    await expect.poll(barFits).toBe(true);
    // Ask is in the bar or, short of room, in its More menu.
    const ask = bar.getByTestId("selection-ask");
    if (!(await ask.isVisible())) await expect(bar.getByTestId("selection-more")).toBeVisible();
    // Depth and Walk: the view switch and the legend toggle sit in the options bar.
    for (const lens of ["2", "3"]) {
      await page.keyboard.press(lens);
      await expect(studio.getByRole("radiogroup", { name: "Lens", exact: true })).toBeVisible();
      expect(await coveredPoints(pane, stage, allowed)).toEqual([]);
      await expect.poll(barFits).toBe(true);
    }
    await closeWorkspaceEditor(page);
    await expect(studio).toBeHidden();

    // Sprite Studio, the pencil: the cel is clear too.
    const sprite = await openApprentice(page);
    const spriteStage = sprite.getByTestId("sprite-stage");
    await spriteStage.focus();
    await page.keyboard.press("b");
    expect(
      await coveredPoints(
        sprite.locator(".sprite-studio__canvas canvas"),
        spriteStage,
        ".sprite-studio__canvas",
      ),
    ).toEqual([]);
  });
}

// The labels follow the viewer's platform; both chords work on either.
for (const { platform } of [{ platform: "MacIntel" }, { platform: "Linux x86_64" }]) {
  test(`Focus hides the side panels and brings them back on ${platform}; Tab and Shift+Tab only move focus`, async ({
    page,
  }) => {
    await page.addInitScript((reported) => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => reported });
      Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
    }, platform);
    await page.setViewportSize({ width: 1440, height: 900 });
    await playTutorial(page);
    const studio = await openRoomStudio(page, 2);
    const canvas = studio.getByRole("group", { name: /^Canvas/ });
    const scene = studio.locator(".studio__scene");
    const toggle = page.getByTestId("workspace-focus");
    const pane = studio.locator(".studio-pane").last();
    const before = (await pane.boundingBox())!.width;
    await canvas.focus();
    await page.keyboard.press(platform === "MacIntel" ? "Meta+k" : "Control+k");
    await page.keyboard.press("z");
    await expect(scene).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await pane.boundingBox())!.width).toBeGreaterThan(before);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(scene).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await canvas.focus();
    // Tab and Shift+Tab are never taken: each moves focus off the canvas and back.
    await page.keyboard.press("Tab");
    await expect(canvas).not.toBeFocused();
    await expect(scene).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(canvas).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(canvas).not.toBeFocused();
    await expect(scene).toBeVisible();

    // The status bar's button does the same by pointer.
    await toggle.click();
    await expect(scene).toBeHidden();
    await toggle.click();
    await expect(scene).toBeVisible();
  });
}

test("? lists every key in a dialog, and Esc puts it away without leaving Studio", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await playTutorial(page);
  const studio = await openRoomStudio(page, 2);
  const canvas = studio.getByRole("group", { name: /^Canvas/ });
  const sheet = page.getByRole("dialog", { name: "Room Studio keys" });

  await canvas.focus();
  await page.keyboard.press("l");
  await page.keyboard.press("?");
  await expect(sheet).toBeVisible();
  // The sheet speaks of the tool in hand.
  await expect(sheet).toContainText("On the canvas · Line");
  await expect(sheet).toContainText(
    "Click at the cursor: adds a point; on the last point, finishes",
  );
  await expect(sheet).toContainText("Hide or show the side panels (focus mode)");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(studio).toBeVisible();
  await expect(canvas).toBeFocused();
  await expect(studio.getByTestId("studio-tool-options")).toHaveAttribute("data-tool", "line");

  // The status bar's ? button opens it too, and focus returns to the button.
  const button = studio.getByRole("button", { name: "Keys", exact: true });
  await expect(button).toHaveAttribute("aria-keyshortcuts", "?");
  await button.click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(button).toBeFocused();
  await expect(studio).toBeVisible();

  // Sprite Studio has its own.
  await closeWorkspaceEditor(page);
  const sprite = await openApprentice(page);
  await sprite.getByTestId("sprite-stage").focus();
  await page.keyboard.press("?");
  const spriteSheet = page.getByRole("dialog", { name: "VIEW editor keys" });
  await expect(spriteSheet).toContainText("Previous or next loop");
  await page.keyboard.press("Escape");
  await expect(spriteSheet).toBeHidden();
  await expect(sprite).toBeVisible();
});

test("the drawing backdrop is view only: it never changes the view's bytes, and is remembered", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await playTutorial(page);
  let sprite = await openApprentice(page);
  const bytes = () => page.evaluate(() => [...window.__AGI_SPRITE__!.bytes()]);
  const original = await bytes();
  await page.getByTestId("workspace-focus").click();
  const backdrop = sprite.getByTestId("sprite-backdrop");
  /** The canvas colour at the cel's top-left pixel, transparent in the apprentice's first cel. */
  const corner = () =>
    sprite
      .locator(".sprite-studio__canvas canvas")
      .evaluate((canvas: HTMLCanvasElement) => [
        ...canvas.getContext("2d")!.getImageData(2, 2, 1, 1).data.slice(0, 3),
      ]);
  await expect(sprite.getByTestId("sprite-transparent")).toContainText("Transparent colour");

  const seen: string[] = [];
  for (const choice of ["checker-light", "colour-14", "colour-1", "checker-dark"]) {
    await backdrop.selectOption(choice);
    seen.push((await corner()).join(","));
    await workspaceSaved(page);
    expect(await bytes()).toEqual(original);
  }
  // Each backdrop shows behind the transparent pixel: yellow (14) is 255,255,85.
  expect(seen[1]).toBe("255,255,85");
  expect(new Set(seen).size).toBe(4);

  // Remembered for this viewer: the next Sprite Studio opens on the same backdrop.
  await backdrop.selectOption("checker-light");
  await closeWorkspaceEditor(page);
  await expect(sprite).toBeHidden();
  sprite = await openApprentice(page);
  await page.getByTestId("workspace-focus").click();
  await expect(sprite.getByTestId("sprite-backdrop")).toHaveValue("checker-light");
  expect(await bytes()).toEqual(original);
});
