import { expect, test } from "@playwright/test";
import { isolateStorage, savedGameCard, textHook } from "./engineProbe.ts";

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
});

test("first visit has one route per action and aligned sections", async ({ page }) => {
  await expect(page.locator(".welcome button, .welcome a")).toHaveCount(0);
  await expect(page.getByTestId("create-adventure-disclosure")).toContainText(
    "Connect your AI provider to generate a game.",
  );
  await expect(page.getByText(/AI for this adventure|Not configured/)).toHaveCount(0);
  await expect(page.getByTestId("connect-create-ai")).toHaveText("Connect AI");
  await expect(page.getByTestId("boot-cartridge")).toBeHidden();
  await expect(page.locator(".create-pane input[type=number]")).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const sections = await Promise.all(
      ["#tutorial", "#create-adventure", "#your-games"].map((selector) =>
        page.locator(selector).boundingBox(),
      ),
    );
    for (const section of sections.slice(1)) {
      expect(Math.abs(section!.x - sections[0]!.x)).toBeLessThan(1);
      expect(Math.abs(section!.width - sections[0]!.width)).toBeLessThan(1);
    }
    await page.screenshot({
      path: test.info().outputPath(`first-visit-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
});

test("one Settings menu owns AI and budget while Remix stays compact", async ({ page }) => {
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(page.getByRole("button", { name: "AI settings", exact: true })).toHaveCount(0);
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("open-ai-settings").click();
  const dialog = page.getByTestId("ai-settings-dialog");
  await dialog.getByTestId("provider-select").selectOption("stub");
  await dialog.getByTestId("task-budget").fill("3");
  await dialog.getByTestId("ai-settings-save").click();
  await page.getByTestId("power-up").click();
  const composer = page.getByTestId("agent-bubble");
  await expect(composer.getByTestId("agent-bubble-input")).toBeEnabled();
  await expect(composer.getByTestId("connect-assistant-ai")).toHaveCount(0);
  await expect(composer.locator("input[type=number]")).toHaveCount(0);
  await expect(composer).not.toContainText(/Change AI settings|Task budget|Not configured/);
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("open-ai-settings").click();
  await expect(dialog.getByTestId("task-budget")).toHaveValue("3");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-menu")).toBeFocused();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: test.info().outputPath(`remix-${width}.png`),
      animations: "disabled",
    });
  }
});

test("library puts rename inline and secondary actions into menus", async ({ page }) => {
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("btn-eject").click();
  const card = savedGameCard(page, "Adventure Department");
  const rename = card.getByTestId("rename-game");
  await expect(rename).toBeVisible();
  const titleBox = (await card.getByTestId("saved-game-title").boundingBox())!;
  const renameBox = (await rename.boundingBox())!;
  expect(
    Math.abs(titleBox.y + titleBox.height / 2 - renameBox.y - renameBox.height / 2),
  ).toBeLessThan(2);
  await rename.click();
  await card.getByRole("textbox", { name: "Game name" }).fill("My tutorial");
  await card.getByRole("button", { name: "Save name" }).click();
  const renamed = savedGameCard(page, "My tutorial");
  await expect(renamed).toBeVisible();
  await expect(page.getByTestId("start-library-game-over")).toBeHidden();
  await expect(page.getByTestId("btn-save-project")).toBeHidden();
  await renamed.getByRole("button", { name: "Game actions", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Game actions", exact: true });
  await expect(menu.getByRole("menuitem", { name: "Start over", exact: true })).toBeVisible();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Remove game", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(renamed.getByRole("button", { name: "Game actions", exact: true })).toBeFocused();
  await expect(renamed.getByRole("button", { name: "Download", exact: true })).toHaveCount(0);
  await renamed.getByRole("button", { name: "Game actions", exact: true }).click();
  await expect(menu.getByTestId("btn-export-agi-zip")).toBeVisible();
  await expect(menu.getByTestId("btn-save-project")).toBeVisible();
  await expect(menu.getByRole("separator")).toHaveCount(2);
  const items = await menu.getByRole("menuitem").allInnerTexts();
  expect(items[0]).toBe("Start over");
  expect(items.at(-1)).toBe("Remove game");
  expect(items.indexOf("Make a copy")).toBeLessThan(items.findIndex((t) => /Game export/.test(t)));
  for (const width of [1440, 390]) {
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width, height: 900 });
    await renamed.screenshot({
      path: test.info().outputPath(`game-card-${width}.png`),
      animations: "disabled",
    });
    await renamed.getByRole("button", { name: "Game actions", exact: true }).click();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: test.info().outputPath(`game-actions-${width}.png`),
      animations: "disabled",
    });
  }
});
