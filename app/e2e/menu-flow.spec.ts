import { expect, test } from "@playwright/test";
import {
  enterCreateMode,
  isolateStorage,
  openLibraryActions,
  openPlayMore,
  openWorkspaceAgent,
  savedGameCard,
  textHook,
} from "./engineProbe.ts";

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
});

test("first visit has one route per action and aligned sections", async ({ page }) => {
  const hero = page.locator(".hero");
  await expect(hero).toBeVisible();
  await expect(hero.getByRole("button").nth(0)).toBeVisible();
  await expect(hero.getByRole("button").nth(1)).toBeVisible();
  await expect(hero.getByRole("button")).toHaveText(["Play the tutorial", "Make a new game"]);
  await expect(hero.locator(".hero-line")).toBeVisible();
  await expect(hero.locator(".hero-line")).toHaveText(
    "Play Sierra-style adventures and build your own.",
  );
  for (const [width, height] of [
    [1440, 900],
    [1063, 815],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(hero.locator(".hero-line")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`home-hero-${width}.png`),
      animations: "disabled",
    });
  }
  await page.getByTestId("create-adventure-toggle").click();
  await expect(page.getByTestId("create-adventure-disclosure")).toBeVisible();
  await expect(page.getByTestId("local-create-submit")).toBeHidden();
  await page.getByTestId("local-create-kind-starter").click();
  await expect(page.getByTestId("local-create-submit")).toBeVisible();
  await expect(page.getByTestId("local-create-submit")).toHaveText("Start building");
  await expect(page.getByText(/AI for this adventure|Not configured/)).toHaveCount(0);
  await expect(page.getByTestId("connect-create-ai")).toBeHidden();
  await expect(page.getByTestId("boot-game")).toBeHidden();
  await expect(page.locator(".create-pane input[type=number]")).toHaveCount(0);
  for (const [width, height] of [
    [1440, 900],
    [1063, 815],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    const bounds = (await page.locator("#create-adventure").boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await expect(
      page.getByRole("radiogroup", { name: "Starting point" }).getByRole("radio"),
    ).toHaveCount(4);
    await page.screenshot({
      path: test.info().outputPath(`first-visit-${width}.png`),
      animations: "disabled",
    });
  }
});

test("the featured opening image does not move the controls below it", async ({ page }) => {
  for (const width of [390, 700]) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const opening = "**/catalog/adventure-department.png";
    await page.route(opening, async (route) => {
      await held;
      await route.continue();
    });
    await page.setViewportSize({ width, height: 844 });
    await page.reload({ waitUntil: "domcontentloaded" });
    const card = page.getByTestId("catalog-adventure-department");
    await expect(card.getByRole("img")).toBeVisible();
    const before = await page.getByTestId("catalog-play-adventure-department").boundingBox();
    release();
    await expect(card.getByRole("img")).toBeVisible();
    const after = await page.getByTestId("catalog-play-adventure-department").boundingBox();
    expect(after!.y - before!.y, `${width}px`).toBe(0);
    // Only this hold: the empty fixture list from beforeEach stays in place.
    await page.unroute(opening);
  }
});

test("Settings keeps the AI budget and the agent drawer stays compact", async ({ page }) => {
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(page.getByRole("button", { name: "AI settings", exact: true })).toHaveCount(0);
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("open-ai-settings").click();
  const dialog = page.getByTestId("ai-settings-dialog");
  await dialog.getByTestId("provider-select").selectOption("stub");
  await dialog.getByTestId("task-budget").fill("3");
  await dialog.getByTestId("ai-settings-save").click();
  await enterCreateMode(page);
  await openWorkspaceAgent(page);
  const composer = page.getByTestId("workspace-agent-panel");
  await expect(composer).toBeVisible();
  await expect(composer.getByTestId("agent-message")).toBeEnabled();
  await expect(composer.getByTestId("connect-assistant-ai")).toHaveCount(0);
  await expect(composer.locator("input[type=number]")).toHaveCount(0);
  await expect(composer).not.toContainText(/Change AI settings|Task budget|Not configured/);
  const close = composer.getByTestId("agent-panel-close");
  await expect(close).toBeVisible();
  await close.click();
  await expect(composer).toBeHidden();
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("open-ai-settings").click();
  await expect(dialog.getByTestId("task-budget")).toBeVisible();
  await expect(dialog.getByTestId("task-budget")).toHaveValue("3");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-menu")).toBeFocused();
  await openWorkspaceAgent(page);
  await expect(composer).toBeVisible();
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
  await page.getByTestId("btn-exit").click();
  const card = savedGameCard(page, "Adventure Department");
  // Rename lives in the ⋯ menu and edits the title in place on the card.
  await openLibraryActions(page, card);
  await page.getByTestId("rename-game").click();
  const nameInput = card.getByRole("textbox", { name: "Game name" });
  await expect(nameInput).toBeFocused();
  await expect(card.getByTestId("saved-game-title")).toBeHidden();
  await nameInput.fill("My tutorial");
  await card.getByRole("button", { name: "Rename" }).click();
  const renamed = savedGameCard(page, "My tutorial");
  await expect(renamed).toBeVisible();
  await expect(page.getByTestId("start-library-game-over")).toBeHidden();
  await openLibraryActions(page, renamed);
  const menu = page.getByRole("menu", { name: "Game actions", exact: true });
  await expect(menu.getByRole("menuitem", { name: "Edit in Create", exact: true })).toBeVisible();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Remove game…", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(renamed.getByRole("button", { name: "Game actions", exact: true })).toBeFocused();
  await expect(renamed.getByRole("button", { name: "Download", exact: true })).toHaveCount(0);
  // Start over and the walkthrough moved to the play button's ▾ half.
  const more = await openPlayMore(page, renamed);
  await expect(more.getByRole("menuitem", { name: "Start over", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await openLibraryActions(page, renamed);
  await expect(menu.getByTestId("open-game-download")).toBeVisible();
  await expect(menu.getByRole("separator")).toHaveCount(2);
  const items = await menu.getByRole("menuitem").allInnerTexts();
  // The ⋯ menu is the flat list: edit, rename, copy, then download and
  // details, then remove.
  expect(items).toEqual([
    "Edit in Create",
    "Rename…",
    "Make a copy",
    "Download…",
    "Details…",
    "Remove game…",
  ]);
  for (const width of [1440, 390]) {
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width, height: 900 });
    await renamed.screenshot({
      path: test.info().outputPath(`game-card-${width}.png`),
      animations: "disabled",
    });
    await openLibraryActions(page, renamed);
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: test.info().outputPath(`game-actions-${width}.png`),
      animations: "disabled",
    });
  }
});
