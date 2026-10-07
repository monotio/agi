import type { Locator, Page } from "@playwright/test";
import { test, expect, reviewShot } from "./test.ts";
import { start, open } from "./pictureWorkspaceShared.ts";

const sizes = [
  { width: 1063, height: 815 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

async function box(locator: Locator) {
  await expect(locator).toBeVisible();
  return (await locator.boundingBox())!;
}

async function capture(page: Page, name: string) {
  await reviewShot(page, `${process.env["AGI_LAYOUT_PHASE"] ?? "layout"}-${name}`);
}

for (const size of sizes) {
  if (size.width > 600) {
    test(`picture draw order stays usable side by side at ${size.width} @webkit-desktop`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await start(page);
      await open(page, "part-room:1:picture:1");
      await page.getByTestId("workspace-layout").click();
      const track = page.getByRole("slider", { name: "Draw order", exact: true });
      await expect(track).toBeAttached();
      const bounds = (await track.boundingBox())!;
      await capture(page, `side-picture-${size.width}`);
      // A full-height track with room to seek several shapes by pointer.
      expect.soft(bounds.height).toBeGreaterThanOrEqual(48);
      expect.soft(bounds.width).toBeGreaterThanOrEqual(96);
      const editor = await box(page.getByTestId("workspace-editor"));
      expect.soft(bounds.x + bounds.width).toBeLessThanOrEqual(editor.x + editor.width);
      await track.click({ position: { x: 1, y: bounds.height / 2 } });
      await expect(track).toHaveAttribute("aria-valuenow", "0");
      await track.press("Home");
      await expect(track).toHaveAttribute("aria-valuenow", "0");
      await track.press("End");
      await expect(track).toHaveAttribute(
        "aria-valuenow",
        (await track.getAttribute("aria-valuemax"))!,
      );
    });
  }

  test(`stacked editors and game keep usable space at ${size.width} @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await start(page);
    await open(page, "part-room:1:picture:1");
    const editor = await box(page.getByTestId("workspace-editor"));
    const picture = await box(page.locator(".studio-pane canvas:visible").first());
    await capture(page, `stack-picture-${size.width}`);
    expect.soft(editor.y + editor.height).toBeLessThanOrEqual(size.height);
    expect.soft(picture.width).toBeGreaterThanOrEqual(size.width > 600 ? 320 : 240);
    expect.soft(picture.height).toBeGreaterThanOrEqual(size.width > 600 ? 168 : 126);
    if (size.width > 600) expect.soft(editor.height).toBeGreaterThanOrEqual(440);

    await open(page, "part-sound:255");
    const soundEditor = await box(page.getByTestId("workspace-editor"));
    const grid = await box(page.getByTestId("sound-grid"));
    await capture(page, `stack-sound-${size.width}`);
    // The first six pitch rows are visible immediately, without scrolling the panel.
    expect.soft(grid.y + 120).toBeLessThanOrEqual(soundEditor.y + soundEditor.height);
    if (size.width <= 600) await page.getByRole("button", { name: "Game", exact: true }).click();
    const screen = page.locator(".game-surface:visible");
    await expect
      .poll(async () => {
        const bounds = await box(screen);
        return bounds.width / bounds.height;
      })
      .toBeCloseTo(1.6, 1);
    const game = await box(screen);
    const stage = await box(page.locator(".play-area .stage"));
    expect.soft(game.width).toBeGreaterThanOrEqual(256);
    expect.soft(game.height).toBeGreaterThanOrEqual(160);
    expect.soft(game.y + game.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
    expect.soft(game.x + game.width).toBeLessThanOrEqual(size.width);
    await capture(page, `stack-game-${size.width}`);
  });

  test(`stage chip stays inside the stage beneath History at ${size.width} @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await start(page);
    await open(page, "part-room:1:picture:1");
    if (size.width <= 600) await page.getByRole("button", { name: "Game", exact: true }).click();
    const chip = await box(page.getByTestId("workspace-live"));
    const stage = await box(page.locator(".play-area .stage"));
    expect.soft(chip.x).toBeGreaterThanOrEqual(stage.x);
    expect.soft(chip.y).toBeGreaterThanOrEqual(stage.y);
    expect.soft(chip.x + chip.width).toBeLessThanOrEqual(stage.x + stage.width);
    expect.soft(chip.y + chip.height).toBeLessThanOrEqual(stage.y + stage.height);
    await page.getByTestId("workspace-saved").click();
    const history = await box(page.getByTestId("workspace-history"));
    await capture(page, `history-${size.width}`);
    const left = Math.max(chip.x, history.x);
    const top = Math.max(chip.y, history.y);
    const right = Math.min(chip.x + chip.width, history.x + history.width);
    const bottom = Math.min(chip.y + chip.height, history.y + history.height);
    if (right > left && bottom > top) {
      // Panels may cover the stage, but the chip must never paint over them.
      expect(
        await page.evaluate(
          ({ x, y }) =>
            !!document.elementFromPoint(x, y)?.closest('[data-testid="workspace-history"]'),
          { x: (left + right) / 2, y: (top + bottom) / 2 },
        ),
      ).toBe(true);
    }
    await page
      .getByTestId("workspace-history")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(page.getByTestId("workspace-live")).toBeVisible();
  });
}
