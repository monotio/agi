import { expect, test } from "@playwright/test";
import {
  enterCreateMode,
  isolateStorage,
  openLibraryActions,
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
  await expect(hero.getByRole("button")).toHaveText(["Play the tutorial", "Make a new game"]);
  await expect(hero.getByRole("link")).toHaveCount(1);
  await expect(hero.getByRole("link")).toHaveAttribute(
    "href",
    "https://en.wikipedia.org/wiki/Adventure_Game_Interpreter",
  );
  await page.getByTestId("create-adventure-toggle").click();
  await expect(page.getByTestId("create-adventure-disclosure")).toContainText(
    "Opens with the game running. Everything you change is saved as you go.",
  );
  await expect(page.getByText(/AI for this adventure|Not configured/)).toHaveCount(0);
  await expect(page.getByTestId("connect-create-ai")).toBeHidden();
  await expect(page.getByTestId("boot-game")).toBeHidden();
  await expect(page.locator(".create-pane input[type=number]")).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = (await page.locator("#create-adventure").boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await expect(
      page.getByRole("radiogroup", { name: "Starting point" }).getByRole("radio"),
    ).toHaveCount(4);
    await page.screenshot({
      path: test.info().outputPath(`first-visit-${width}.png`),
      fullPage: true,
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
  await enterCreateMode(page);
  await openWorkspaceAgent(page);
  const composer = page.getByTestId("workspace-agent-panel");
  await expect(composer.getByTestId("agent-message")).toBeEnabled();
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
  await page.getByTestId("btn-exit").click();
  const card = savedGameCard(page, "Adventure Department");
  // Rename lives in the ⋯ menu and edits the title in place on the card.
  await openLibraryActions(page, card);
  await page.getByTestId("rename-game").click();
  const nameInput = card.getByRole("textbox", { name: "Game name" });
  await expect(nameInput).toBeFocused();
  await expect(card.getByTestId("saved-game-title")).toBeHidden();
  await nameInput.fill("My tutorial");
  await card.getByRole("button", { name: "Save name" }).click();
  const renamed = savedGameCard(page, "My tutorial");
  await expect(renamed).toBeVisible();
  await expect(page.getByTestId("start-library-game-over")).toBeHidden();
  await expect(page.getByTestId("download-library-game")).toBeHidden();
  await openLibraryActions(page, renamed);
  const menu = page.getByRole("menu", { name: "Game actions", exact: true });
  await expect(menu.getByRole("menuitem", { name: "Start over", exact: true })).toBeVisible();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Remove game…", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(renamed.getByRole("button", { name: "Game actions", exact: true })).toBeFocused();
  await expect(renamed.getByRole("button", { name: "Download", exact: true })).toHaveCount(0);
  await openLibraryActions(page, renamed);
  await expect(menu.getByTestId("export-library-game")).toBeVisible();
  await expect(menu.getByTestId("download-library-game")).toBeVisible();
  await expect(menu.getByRole("separator")).toHaveCount(2);
  const items = await menu.getByRole("menuitem").allInnerTexts();
  // A saved copy of the tutorial keeps its walkthrough action at the top.
  expect(items[0]).toMatch(/^Run walkthrough/);
  expect(items).toContain("Start over");
  expect(items.at(-1)).toBe("Remove game…");
  expect(items.indexOf("Make a copy")).toBeLessThan(items.findIndex((t) => /Export game/.test(t)));
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
