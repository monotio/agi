import { expect, test } from "./test.ts";
import type { Page } from "@playwright/test";
import {
  enterCreateMode,
  isolateStorage,
  openGameOptions,
  textHook,
  waitForCycles,
  openWorldRoom,
} from "./engineProbe.ts";

/**
 * The shell's design system, checked where a player meets it: one motion
 * recipe that reduced motion turns off, the brand drawn in the engine's own
 * font, standard dialogs, drawn switches, the Ask button clear of the stage,
 * and a World inspector with one primary action and its evidence folded away.
 */
test.use({ viewport: { width: 1440, height: 900 } });

async function playTutorial(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
}

const animation = (locator: ReturnType<Page["locator"]>) =>
  locator.evaluate((element) => getComputedStyle(element).animationName);

test("dialogs, sheets, menus and the Ask drawer share one entrance, and reduced motion stills it", async ({
  page,
}) => {
  await playTutorial(page);
  // Settings: a sheet slides from under the bar.
  await openGameOptions(page, "settings-menu");
  const sheet = page.getByTestId("settings-menu-menu");
  await expect(sheet).toBeVisible();
  expect(await animation(sheet)).toBe("ui-sheet-in-down");
  // A dialog scales up from 0.98; so does its scrim fade.
  await page.getByTestId("open-ai-settings").click();
  const dialog = page.getByTestId("ai-settings-dialog");
  await expect(dialog).toBeVisible();
  expect(await animation(dialog)).toBe("ui-dialog-in");
  await page.keyboard.press("Escape");
  // A menu moves 2px from its trigger.
  await page.getByTestId("help-menu").click();
  const menu = page.getByTestId("help-menu-menu");
  await expect(menu).toBeVisible();
  expect(await animation(menu)).toBe("ui-menu-in");
  await page.keyboard.press("Escape");
  // The Ask drawer slides in from its edge.
  await page.getByTestId("menu-assistant").click();
  const drawer = page.getByTestId("agent-bubble");
  await expect(drawer).toBeVisible();
  expect(await animation(drawer)).toBe("ui-sheet-in-left");
  await drawer.getByTestId("agent-bubble-close").click();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await openGameOptions(page, "settings-menu");
  expect(await animation(sheet)).toBe("none");
  await page.getByTestId("open-ai-settings").click();
  await expect(dialog).toBeVisible();
  expect(await animation(dialog)).toBe("none");
});

test("Help, Game controls and the map close with the standard × button", async ({ page }) => {
  await playTutorial(page);
  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-help-guide").click();
  const help = page.getByTestId("help-guide");
  await expect(help).toBeVisible();
  const helpClose = help.getByTestId("help-guide-close");
  await expect(helpClose).toHaveAccessibleName("Close Help");
  await expect(helpClose).toHaveText("");
  await helpClose.click();
  await expect(help).toBeHidden();

  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-game-controls").click();
  const controls = page.getByTestId("game-controls");
  await expect(controls.getByTestId("controls-close")).toHaveText("");
  await controls.getByTestId("controls-close").click();
  await expect(controls).toBeHidden();

  await page.getByTestId("btn-world-map").click();
  const map = page.getByTestId("world-map");
  await expect(map.getByTestId("map-close")).toHaveText("");
  await expect(map.getByRole("heading", { name: "Map" })).toBeVisible();
  await map.getByTestId("map-close").click();
  await expect(map).toHaveCount(0);
});

test("settings draw switches, and Developer activity is off every page", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await expect(page.getByTestId("hero-primary")).toBeVisible();
  await expect(page.getByTestId("agent-panel")).toBeHidden();
  await expect(page.getByTestId("developer-activity-summary")).toHaveCount(0);
  await expect(page.getByText("Copy debug bundle")).toBeHidden();

  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await openGameOptions(page, "settings-menu");
  for (const id of ["toggle-mute", "toggle-original-aspect", "toggle-touch-controls"]) {
    const row = page.getByTestId(id);
    await expect(row).toHaveRole("switch");
    await expect(row.locator(".ui-switch__track")).toBeVisible();
    // The state is drawn, not spelled: no trailing "On"/"Off" value text.
    await expect(row).not.toHaveText(/\b(On|Off)\s*$/);
  }
});

test("Ask docks in the play strip, clear of the stage, and steps away while its drawer is open", async ({
  page,
}) => {
  await playTutorial(page);
  const ask = page.getByTestId("menu-assistant");
  const screen = (await page.locator(".screen").boundingBox())!;
  const strip = (await page.locator(".play-strip").boundingBox())!;
  const box = (await ask.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(strip.y);
  expect(box.y + box.height).toBeLessThanOrEqual(strip.y + strip.height);
  expect(box.y).toBeGreaterThanOrEqual(screen.y + screen.height);
  await ask.click();
  await expect(page.getByTestId("agent-bubble")).toBeVisible();
  await expect(ask).toBeHidden();
  await expect(ask).toHaveAttribute("aria-expanded", "true");
  await page.getByTestId("agent-bubble-close").click();
  await expect(ask).toBeVisible();
});

test("the home hero draws the wordmark in the engine's font with a cyan full stop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const heading = page.getByRole("heading", { name: "AGI IS HERE." });
  await expect(heading).toBeVisible();
  const canvas = heading.locator("canvas");
  await expect(canvas).toBeVisible();
  // The full stop sits in the last glyph cell, rows 5–6, columns 3–4, of a
  // canvas with a one-glyph margin: it is painted in the action colour, and
  // the cell's first row is dark.
  const pixels = await canvas.evaluate((element: HTMLCanvasElement) => {
    const ctx = element.getContext("2d")!;
    const cell = 8 + 11 * 8;
    const at = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
    return {
      width: element.width,
      stop: at(cell + 3, 8 + 5),
      blank: at(cell + 3, 8),
      action: getComputedStyle(element).getPropertyValue("--action").trim(),
    };
  });
  expect(pixels.width).toBe(12 * 8 + 16);
  const hex = `#${pixels.stop
    .slice(0, 3)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
  expect(hex).toBe(pixels.action);
  expect(pixels.blank[3]).toBe(0);
  // The same square is the favicon, in SVG with PNG and ICO fallbacks.
  const icons = await page
    .locator("link[rel~='icon'], link[rel='apple-touch-icon']")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(icons.map((href) => href?.split("/").pop())).toEqual(
    expect.arrayContaining([
      "favicon.svg",
      "favicon-32.png",
      "favicon.ico",
      "apple-touch-icon.png",
    ]),
  );
  // The header lockup carries the mark and links home to Monotio.
  const lockup = page.getByRole("link", { name: "MONOTIO / AGI" });
  await expect(lockup).toHaveAttribute("href", "https://monotio.com");
  await expect(lockup.locator(".brand-mark")).toBeVisible();
});

test("the library notes the verified games in one line and Help holds the full list", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const hint = page.getByTestId("verified-games-hint");
  await hint.scrollIntoViewIfNeeded();
  const lineHeight = await hint.evaluate((element) =>
    parseFloat(getComputedStyle(element).lineHeight),
  );
  expect((await hint.boundingBox())!.height).toBeLessThan(lineHeight * 1.5);
  await hint.getByTestId("verified-games-help").click();
  const help = page.getByTestId("help-guide");
  await expect(help).toBeVisible();
  await expect(help.getByTestId("help-section-games")).toHaveAttribute("aria-current", "true");
  await expect(help).toContainText("Leisure Suit Larry I");
  await expect(help).toContainText("Apple IIgs: Space Quest II");
});

test("the World inspector leads with one primary action and folds its evidence away", async ({
  page,
}) => {
  await playTutorial(page);
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, 2);
  const detail = panel.getByTestId("map-detail");
  await expect(detail.getByRole("heading", { level: 3 })).toHaveText("Room 2");
  await expect(detail.locator(".ui-btn--primary")).toHaveCount(1);
  await expect(detail.locator(".ui-btn--primary")).toHaveText("Open in Studio");
  // No bare glyph buttons: every control has a name, none reads "×" or "⏮".
  for (const button of await detail.getByRole("button").all()) {
    await expect(button).not.toHaveText(/^[×⏮]$/);
  }
  // Reference art is a quiet action, not the largest control in the card.
  const attach = detail.getByTestId("map-attach-reference");
  if (await attach.count()) await expect(attach).toHaveClass(/ui-btn--ghost/);
  // The evidence is under Details, closed until asked for.
  const facts = detail.getByTestId("map-facts");
  await expect(facts).not.toHaveAttribute("open");
  await expect(facts.locator("li").first()).toBeHidden();
  await facts.locator("summary").click();
  await expect(facts.locator("li").first()).toBeVisible();
  // Nothing in the card spills past its edge.
  const card = (await detail.boundingBox())!;
  for (const box of await detail
    .locator("button, input, textarea")
    .evaluateAll((all) => all.map((el) => el.getBoundingClientRect().toJSON()))) {
    if (box.width === 0) continue;
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
  }
});

test("graph exit words read at the same size at any zoom", async ({ page }) => {
  await playTutorial(page);
  await enterCreateMode(page);
  const graph = page.getByTestId("world-panel").getByTestId("map-graph");
  const label = graph.locator(".edge-label").first();
  await expect(label).toBeVisible();
  const onScreen = () =>
    label.evaluate((element) => (element as SVGTextElement).getBoundingClientRect().height);
  const at75 = await onScreen();
  await page.getByTestId("world-panel").getByTestId("map-zoom-in").click();
  const zoomedIn = await onScreen();
  expect(at75).toBeGreaterThanOrEqual(11);
  expect(Math.abs(zoomedIn - at75)).toBeLessThan(1.5);
});

test("the Inspect tab groups its views as one segmented control with a caption", async ({
  page,
}) => {
  await playTutorial(page);
  await enterCreateMode(page);
  await page.getByTestId("dock-tab-inspect").click();
  const views = page.getByRole("radiogroup", { name: "Inspector view" });
  await expect(views.getByRole("radio")).toHaveCount(5);
  await expect(views.getByRole("radio", { name: "Game" })).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("dbg-mode-priority").click();
  await expect(views.getByRole("radio", { name: "Priority" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("dbg-mode-note")).toContainText("Depth values");
  await expect(page.getByTestId("dbg-overlay-toggle")).toHaveRole("switch");
  await expect(page.getByTestId("dbg-inspect-toggle")).toHaveRole("switch");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("Play keeps its hint on one line, Ask in the strip and Keys a compact control", async ({
    page,
  }) => {
    await isolateStorage(page);
    await page.addInitScript(() => localStorage.setItem("monotio_agi.touchControls", "on"));
    await page.goto("/");
    await page.getByTestId("catalog-play-adventure-department").tap();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await waitForCycles(page, 2);
    const help = page.locator("#game-input-help");
    const lineHeight = await help.evaluate((element) =>
      parseFloat(getComputedStyle(element).lineHeight),
    );
    expect((await help.boundingBox())!.height).toBeLessThan(lineHeight * 1.5);
    const keys = page.getByTestId("touch-controls").getByText("Keys", { exact: true });
    expect((await keys.boundingBox())!.width).toBeLessThan(160);
    // Ask sits in the strip, not over the canvas's bottom text rows.
    const screen = (await page.locator(".screen").boundingBox())!;
    const ask = (await page.getByTestId("menu-assistant").boundingBox())!;
    expect(ask.y).toBeGreaterThanOrEqual(screen.y + screen.height);
  });
});
