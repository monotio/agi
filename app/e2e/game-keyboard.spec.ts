import { expect, test } from "@playwright/test";
import { textHook } from "./engineProbe.ts";

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
  await expect(keys).toBeVisible();
  await expect(keys).toHaveText("Keys go to the game");
  await expect(keys).toHaveClass(/\bon\b/);
  await keys.hover();
  await expect(page.locator("#game-input-help")).toBeVisible();
  await expect(page.locator("#game-input-help")).toContainText("leaves the game");
  await page.mouse.move(0, 0);

  // A keyboard user on the timeline's controls types nothing into the game.
  const pause = page.getByRole("button", { name: "Pause" });
  await pause.focus();
  await expect(keys).toHaveText("Click the game to play");
  await expect(keys).not.toHaveClass(/\bon\b/);
  await page.keyboard.type("look");
  await expect(pause).toBeFocused();
  await expect(command).toHaveValue("");

  // The light opens key help; clicking the screen hands the keys back.
  await keys.click();
  await expect(page.getByTestId("game-key-help")).toBeVisible();
  await page.locator(".screen").click();
  await expect(command).toBeFocused();
  await expect(keys).toHaveText("Keys go to the game");

  // Tab opens the tutorial inventory and keeps the keyboard in the game.
  await page.keyboard.press("Tab");
  await expect.poll(async () => (await textHook(page)).modal).toBe("inventory");
  await expect(command).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();

  await command.focus();

  // Shift+Tab leaves the game; the page itself still passes keys in Play.
  await page.keyboard.press("Shift+Tab");
  await expect(command).not.toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(keys).toHaveText("Keys go to the game");
});
