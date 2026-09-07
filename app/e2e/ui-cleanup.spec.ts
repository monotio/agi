import { expect, test } from "@playwright/test";
import { isolateStorage, openCreateAdventure, openAiSettings } from "./engineProbe.ts";

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
});

test("the start page uses concise tutorial copy and readable primary actions", async ({ page }) => {
  await expect(page.getByText("Dream it. Play it. Remix it.")).toBeVisible();
  await expect(page.getByText("The future has 16 colors. And you can rewrite it.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Play the tutorial" })).toBeVisible();
  await expect(
    page.getByText("Learn pictures, sprites and priority in a three-room tutorial."),
  ).toBeVisible();

  await expect(page.getByTestId("create-adventure-disclosure")).toHaveAttribute("open", "");
  await openCreateAdventure(page);
  await page.getByTestId("cartridge-custom").click();
  await page.getByTestId("custom-cartridge-input").fill("A concise test adventure.");
  await openAiSettings(page);
  const dialog = page.getByTestId("ai-settings-dialog");
  const keyLink = dialog.getByRole("link", { name: "Get an API key" });
  await expect(keyLink).toHaveAttribute("href", "https://platform.openai.com/api-keys");
  await dialog.getByTestId("provider-select").selectOption("anthropic");
  await expect(keyLink).toHaveAttribute("href", "https://platform.claude.com/settings/keys");
  for (const select of [
    dialog.getByTestId("provider-select"),
    dialog.getByTestId("model-select"),
  ]) {
    expect((await select.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await dialog.getByTestId("ai-settings-cancel").click();
  for (const action of [
    page.getByTestId("catalog-play-adventure-department"),
    page.getByTestId("connect-create-ai"),
  ]) {
    const type = await action.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        family: style.fontFamily,
        size: Number.parseFloat(style.fontSize),
        weight: Number.parseInt(style.fontWeight, 10),
        height: element.getBoundingClientRect().height,
      };
    });
    expect(type.family).toContain("system-ui");
    expect(type.size).toBeGreaterThanOrEqual(14);
    expect(type.weight).toBeGreaterThanOrEqual(700);
    expect(type.height).toBeGreaterThanOrEqual(44);
  }

  await expect(page.getByTestId("catalog-play-adventure-department")).toBeEnabled();
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect(page.getByTestId("power-up")).toBeVisible();
  await page.getByTestId("power-up").click();
  await page.getByTestId("connect-assistant-ai").click();
  const remixKeyLink = dialog.getByRole("link", { name: "Get an API key" });
  await expect(remixKeyLink).toHaveAttribute("href", "https://platform.openai.com/api-keys");
  await dialog.getByTestId("provider-select").selectOption("anthropic");
  await expect(remixKeyLink).toHaveAttribute("href", "https://platform.claude.com/settings/keys");
  await dialog.getByTestId("ai-settings-cancel").click();
});

test("Add game is one keyboard-friendly menu with ZIP and folder choices", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Add game", exact: true });
  const zip = page.getByTestId("open-game-zip");
  const folder = page.getByTestId("open-game-folder");

  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(zip).toBeHidden();
  await expect(folder).toBeHidden();

  await trigger.focus();
  await trigger.press("ArrowDown");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(trigger).toHaveAttribute("data-testid", "open-game-menu");
  await expect(page.getByTestId("open-game-menu-menu")).toHaveRole("menu");
  await expect(zip).toBeFocused();
  await expect(folder).toBeVisible();
  await zip.press("ArrowDown");
  await expect(folder).toBeFocused();
  await folder.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByRole("heading", { name: "AGI IS HERE." }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});
