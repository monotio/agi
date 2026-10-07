import { expect, test } from "./test.ts";
import { configureAi, isolateStorage, waitForRoom, workspaceUpdated } from "./engineProbe.ts";

const SAYS =
  "Saves, items and progress here are for testing. Play keeps your own game. Your edits stay.";

/** Create's game bar marks the game as a test run; Play shows no chip. */
for (const [width, height] of [
  [1440, 900],
  [1063, 815],
  [390, 844],
] as const)
  test(`Create's game bar says it is a test run at ${width} @webkit-desktop`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await isolateStorage(page);
    await page.goto("/");
    await configureAi(page, { provider: "stub" });
    await page.getByTestId("create-adventure-toggle").click();
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByTestId("local-create-submit").click();
    await waitForRoom(page, 1);
    await workspaceUpdated(page);
    const bar = page.getByTestId("workspace-game-bar");
    if (width <= 600) {
      // The phone shows the game on its Game tab once a part is open.
      await page.getByTestId("workspace-parts").click();
      await page.getByTestId("part-room:1:picture:1").click();
      await page.getByRole("button", { name: "Game", exact: true }).click();
    }
    const chip = bar.getByRole("button", { name: "Test run", exact: true });
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAccessibleDescription(SAYS);
    // It fits the bar beside the room name.
    const [chipBox, barBox] = [(await chip.boundingBox())!, (await bar.boundingBox())!];
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(barBox.x + barBox.width);
    expect(chipBox.y).toBeGreaterThanOrEqual(barBox.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    // Keyboard focus shows the words; Esc puts them away.
    const tip = page.getByRole("tooltip");
    await chip.focus();
    await expect(tip).toHaveText(SAYS);
    await expect(tip).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: test.info().outputPath(`test-run-chip-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
    // A tap or click shows them too.
    await chip.click();
    await expect(tip).toBeVisible();
    // Play has no chip.
    await page.getByRole("radio", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Test run", exact: true })).toHaveCount(0);
  });
