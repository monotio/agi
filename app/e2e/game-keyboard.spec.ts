import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
});

test("page controls keep their keys and the play strip says where keys go", async ({ page }) => {
  await page.getByRole("button", { name: "Play the tutorial" }).click();
  await page.waitForURL(/#play\//);
  const command = page.locator("#game-command");
  const keys = page.getByTestId("game-keys");

  await command.focus();
  await expect(keys).toHaveText("Keys go to the game");
  await expect(keys).toHaveClass(/\bon\b/);
  await expect(page.locator("#game-input-help")).toContainText("leaves the game");

  // A keyboard user on the timeline's controls types nothing into the game.
  const pause = page.getByRole("button", { name: "Pause" });
  await pause.focus();
  await expect(keys).toHaveText("Click the game to play");
  await expect(keys).not.toHaveClass(/\bon\b/);
  await page.keyboard.type("look");
  await expect(pause).toBeFocused();
  await expect(command).toHaveValue("");

  // The light is a button that hands the keys back.
  await keys.click();
  await expect(command).toBeFocused();
  await expect(keys).toHaveText("Keys go to the game");

  // Tab is a game key and keeps the keyboard in the game (workspace.spec checks the inventory).
  await page.keyboard.press("Tab");
  await expect(command).toBeFocused();

  await command.focus();

  // Shift+Tab leaves the game; the page itself still passes keys in Play.
  await page.keyboard.press("Shift+Tab");
  await expect(command).not.toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(keys).toHaveText("Keys go to the game");
});
