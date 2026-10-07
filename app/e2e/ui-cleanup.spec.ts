import { expect, test } from "@playwright/test";
import {
  enterCreateMode,
  isolateStorage,
  openAiSettings,
  openCreateAdventure,
  openWorkspaceAgent,
} from "./engineProbe.ts";

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
});

test("the start page uses concise tutorial copy and readable primary actions", async ({ page }) => {
  await expect(
    page.getByText("Play Sierra-style adventures and build your own.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByText("The future has 16 colors. And you can rewrite it.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play the tutorial" })).toBeVisible();
  await expect(
    page
      // First visit: the Continue card introduces the tutorial; shelf cards keep one meta line.
      .getByTestId("home-continue")
      .getByText("Learn pictures, views and depth in a three-room tutorial."),
  ).toBeVisible();

  await expect(page.getByTestId("create-adventure-disclosure")).not.toHaveAttribute("open");
  await openCreateAdventure(page);
  await expect(page.getByTestId("create-adventure-disclosure")).toHaveAttribute("open", "");
  await page.getByTestId("template-custom").click();
  await page.getByTestId("custom-adventure-input").fill("A concise test adventure.");
  await openAiSettings(page);
  const dialog = page.getByTestId("ai-settings-dialog");
  const keyLink = dialog.getByRole("link", { name: "Get an API key" });
  await expect(keyLink).toHaveAttribute("href", "https://platform.openai.com/api-keys");
  await dialog.getByTestId("provider-select").selectOption("anthropic");
  await expect(keyLink).toHaveAttribute("href", "https://platform.claude.com/settings/keys");
  // Selects meet the design system's control height for this pointer
  // (tokens.css: --control-h on a fine pointer, --control-h-touch on touch).
  const controlHeight = await page.evaluate(() =>
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        matchMedia("(pointer: coarse)").matches ? "--control-h-touch" : "--control-h",
      ),
    ),
  );
  expect(controlHeight).toBeGreaterThanOrEqual(40);
  for (const select of [
    dialog.getByTestId("provider-select"),
    dialog.getByTestId("model-select"),
  ]) {
    expect((await select.boundingBox())?.height).toBeGreaterThanOrEqual(controlHeight);
  }
  await dialog.getByTestId("ai-settings-cancel").click();
  await page.getByTestId("create-adventure-close").click();
  for (const action of [
    page.getByTestId("catalog-play-adventure-department"),
    page.getByTestId("create-adventure-toggle"),
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
    expect(type.family).toContain("AGI Geist");
    expect(type.size).toBeGreaterThanOrEqual(14);
    expect(type.weight).toBeGreaterThanOrEqual(700);
    // --control-h (40px) on fine pointers; UiButton grows to 44px under pointer: coarse.
    expect(type.height).toBeGreaterThanOrEqual(40);
  }

  await expect(page.getByTestId("catalog-play-adventure-department")).toBeEnabled();
  await page.getByTestId("catalog-play-adventure-department").click();
  await enterCreateMode(page);
  await openWorkspaceAgent(page);
  await page.locator(".agent-panel__model").click();
  const remixKeyLink = dialog.getByRole("link", { name: "Get an API key" });
  await expect(remixKeyLink).toHaveAttribute("href", "https://platform.openai.com/api-keys");
  await dialog.getByTestId("provider-select").selectOption("anthropic");
  await expect(remixKeyLink).toHaveAttribute("href", "https://platform.claude.com/settings/keys");
  await dialog.getByTestId("ai-settings-cancel").click();
});

test("Add game is one keyboard-friendly menu with ZIP, disk and folder choices", async ({
  page,
}) => {
  const trigger = page.getByRole("button", { name: "Add game", exact: true });
  const zip = page.getByTestId("open-game-zip");
  const disks = page.getByTestId("open-game-disks");
  const folder = page.getByTestId("open-game-folder");

  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(zip).toBeHidden();
  await expect(disks).toBeHidden();
  await expect(folder).toBeHidden();

  await trigger.focus();
  await trigger.press("ArrowDown");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(trigger).toHaveAttribute("data-testid", "open-game-menu");
  await expect(page.getByTestId("open-game-menu-menu")).toHaveRole("menu");
  await expect(zip).toBeFocused();
  await expect(disks).toBeVisible();
  await expect(folder).toBeVisible();
  await zip.press("ArrowDown");
  await expect(disks).toBeFocused();
  await disks.press("ArrowDown");
  await expect(folder).toBeFocused();
  await folder.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByRole("heading", { name: "AGI IS HERE." }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});
