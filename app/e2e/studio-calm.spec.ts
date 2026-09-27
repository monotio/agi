import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { enterCreateMode, isolateStorage, textHook } from "./engineProbe.ts";

/**
 * The calm canvas on the real app: nothing covers the picture but what the
 * artist is handling (the selection's bar, a menu), at three window sizes;
 * the tool's options dock in a bar above the canvas and its help in the
 * status bar; `?` lists every key and Esc puts the list away; Tab on the
 * canvas hides the side panels while Shift+Tab still moves focus on; and
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
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId(`map-room-${room}`).click();
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

async function openApprentice(page: Page): Promise<Locator> {
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId("map-room-1").click();
  await panel.getByTestId("world-open-sprite-0").click();
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
  test(`at ${width}×${height} nothing covers the picture or the cel but what is being handled`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await playTutorial(page);
    const studio = await openRoomStudio(page, 2);
    const stage = studio.getByRole("group", { name: /^Canvas/ });
    const pane = studio.locator(".studio-pane").last();
    const allowed = ".studio-pane, [data-testid='studio-context-bar']";

    // Art lens: an item selected, the rect tool with its options (the owner's case).
    await studio.getByRole("treeitem", { name: /^West doorway/ }).click();
    await stage.focus();
    await page.keyboard.press("r");
    await expect(studio.getByTestId("studio-tool-filled")).toBeVisible();
    expect(await coveredPoints(pane, stage, allowed)).toEqual([]);
    // Select with the item: its bar is what the artist handles, and only it may sit on the picture.
    await page.keyboard.press("v");
    await expect(studio.getByTestId("studio-context-bar")).toBeVisible();
    expect(await coveredPoints(pane, stage, allowed)).toEqual([]);
    // Depth and Walk: the view switch and the legend toggle sit in the options bar.
    for (const lens of ["2", "3"]) {
      await page.keyboard.press(lens);
      await expect(studio.getByRole("toolbar", { name: "View" })).toBeVisible();
      expect(await coveredPoints(pane, stage, allowed)).toEqual([]);
    }
    await studio.getByTestId("studio-close").click();
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

test("Tab on the canvas hides the side panels and brings them back; Shift+Tab still moves on", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await playTutorial(page);
  const studio = await openRoomStudio(page, 2);
  const canvas = studio.getByRole("group", { name: /^Canvas/ });
  const scene = studio.locator(".studio__scene");
  const inspector = studio.locator(".studio__inspector");
  const toggle = studio.getByRole("button", { name: "Focus mode" });
  const hint = studio.getByTestId("studio-hint");
  const pane = studio.locator(".studio-pane").last();
  await expect(canvas).toHaveAttribute("aria-label", /Tab hides the side panels/);
  const before = (await pane.boundingBox())!.width;

  await canvas.focus();
  await page.keyboard.press("Tab");
  await expect(scene).toBeHidden();
  await expect(inspector).toBeHidden();
  await expect(canvas).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(studio.locator('[data-role="announce"]')).toHaveText("Side panels hidden");
  // The first time, the status bar says how to get them back; nothing lands on the canvas.
  await expect(hint).toHaveText("Side panels hidden · Tab on the canvas brings them back");
  await expect.poll(async () => (await pane.boundingBox())!.width).toBeGreaterThan(before);

  await page.keyboard.press("Tab");
  await expect(scene).toBeVisible();
  await expect(inspector).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(canvas).toBeFocused();
  // The tip is a first-time one: the next toggle leaves the tool's own line.
  await page.keyboard.press("Tab");
  await expect(hint).not.toContainText("Side panels hidden");
  await page.keyboard.press("Tab");
  await expect(scene).toBeVisible();

  // Shift+Tab is never taken: focus leaves the canvas, and Tab brings it back.
  await page.keyboard.press("Shift+Tab");
  await expect(canvas).not.toBeFocused();
  await expect(scene).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(canvas).toBeFocused();
  await expect(scene).toBeVisible();

  // The status bar's button does the same by pointer.
  await toggle.click();
  await expect(scene).toBeHidden();
  await toggle.click();
  await expect(scene).toBeVisible();
});

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
  const button = studio.getByRole("button", { name: "Keyboard shortcuts" });
  await expect(button).toHaveAttribute("aria-keyshortcuts", "?");
  await button.click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(button).toBeFocused();
  await expect(studio).toBeVisible();

  // Sprite Studio has its own.
  await studio.getByTestId("studio-close").click();
  const sprite = await openApprentice(page);
  await sprite.getByTestId("sprite-stage").focus();
  await page.keyboard.press("?");
  const spriteSheet = page.getByRole("dialog", { name: "Sprite Studio keys" });
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
  const backdrop = sprite.getByTestId("sprite-backdrop");
  /** The canvas colour at the cel's top-left pixel, transparent in the apprentice's first cel. */
  const corner = () =>
    sprite
      .locator(".sprite-studio__canvas canvas")
      .evaluate((canvas: HTMLCanvasElement) => [
        ...canvas.getContext("2d")!.getImageData(2, 2, 1, 1).data.slice(0, 3),
      ]);
  await expect(sprite.getByTestId("sprite-transparent")).toContainText("in-game transparent");

  const seen: string[] = [];
  for (const choice of ["checker-light", "colour-14", "room", "checker-dark"]) {
    await backdrop.selectOption(choice);
    seen.push((await corner()).join(","));
    await expect(sprite.getByTestId("studio-draft-status")).toHaveText("No changes");
    expect(await bytes()).toEqual(original);
  }
  // Each backdrop shows behind the transparent pixel: yellow (14) is 255,255,85.
  expect(seen[1]).toBe("255,255,85");
  expect(new Set(seen).size).toBe(4);

  // Remembered for this viewer: the next Sprite Studio opens on the same backdrop.
  await backdrop.selectOption("checker-light");
  await sprite.getByTestId("studio-close").click();
  await expect(sprite).toBeHidden();
  sprite = await openApprentice(page);
  await expect(sprite.getByTestId("sprite-backdrop")).toHaveValue("checker-light");
  expect(await bytes()).toEqual(original);
});
