import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
});

test("the play strip says where the keys go and gives them back to the game", async ({ page }) => {
  await page.getByRole("button", { name: "Play the tutorial" }).click();
  await page.waitForURL(/#play\//);
  const command = page.locator("#game-command");
  const keys = page.getByTestId("game-keys");

  await command.focus();
  await expect(keys).toHaveText("Keys go to the game");
  await expect(keys).toHaveClass(/\bon\b/);
  await expect(page.locator("#game-input-help")).toBeVisible();

  await command.blur();
  await expect(keys).toHaveText("Click the game to play");
  await expect(keys).not.toHaveClass(/\bon\b/);
  await expect(page.locator("#game-input-help")).toBeHidden();

  await keys.click();
  await expect(command).toBeFocused();
  await expect(keys).toHaveText("Keys go to the game");
});
