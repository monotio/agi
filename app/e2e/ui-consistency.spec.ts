import { expect, test } from "@playwright/test";
import {
  isolateStorage,
  openSavedGameDetails,
  savedGameCard,
  textHook,
  openAiSettings,
} from "./engineProbe.ts";

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
});

const appearance = (element: Element) => {
  const style = getComputedStyle(element);
  return {
    color: style.color,
    background: style.backgroundColor,
    border: style.border,
    radius: style.borderRadius,
    font: style.font,
    padding: style.padding,
  };
};

test("the hero and Save settings share the one filled primary; card actions stay quiet", async ({
  page,
}) => {
  // Controls animate colours on enable; the capture must see the settled
  // style, not a mid-transition frame.
  await page.addStyleTag({
    content: "*, ::before, ::after { transition-duration: 0s !important }",
  });
  const hero = page.getByTestId("hero-primary");
  await expect(hero).toBeEnabled();
  const primary = await hero.evaluate(appearance);
  const play = page.getByTestId("catalog-play-adventure-department");
  await expect(play).toBeEnabled();
  const cardAction = await play.evaluate(appearance);
  // A card's Play is the shared secondary action, never a second filled primary.
  expect(cardAction).toEqual(
    await page.getByRole("button", { name: "Add game", exact: true }).evaluate(appearance),
  );
  expect(cardAction.background).not.toEqual(primary.background);
  await play.click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const secondary = await page.getByTestId("settings-menu").evaluate(appearance);
  // btn-exit still uses the legacy classes until GameHeader migrates; the tint
  // that marks it as a secondary action already matches the tokenised variant.
  const exit = await page.getByTestId("btn-exit").evaluate(appearance);
  expect({ color: exit.color, background: exit.background, radius: exit.radius }).toEqual({
    color: secondary.color,
    background: secondary.background,
    radius: secondary.radius,
  });
  // UiButton's fine-pointer height is --control-h (40px); touch gets 44px via
  // the pointer:coarse media query.
  for (const action of await page
    .locator(".game-nav > button, .game-nav summary, .game-nav .action-menu > button")
    .all()) {
    expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  }
  await page.getByTestId("btn-exit").click();
  const card = savedGameCard(page, "Adventure Department");
  const resume = card.getByRole("button", { name: "Resume", exact: true });
  await expect(resume).toBeVisible();
  expect(await resume.evaluate(appearance)).toEqual(cardAction);
  await openAiSettings(page);
  expect(await page.getByTestId("ai-settings-save").evaluate(appearance)).toEqual(primary);
  await page.screenshot({
    animations: "disabled",
    path: test.info().outputPath("ai-settings.png"),
  });
  await page.getByTestId("provider-select").selectOption("stub");
  await page.getByTestId("ai-settings-save").click();
  await resume.click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("power-up").click();
  for (const action of await page.locator(".agent-mode-switch button, .remix-close").all()) {
    expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  // The bubble's send button still uses the legacy classes until AgentBubble
  // migrates; the fill that marks it as the primary action already matches.
  const send = await page.getByTestId("agent-bubble-send").evaluate(appearance);
  expect({ color: send.color, background: send.background, radius: send.radius }).toEqual({
    color: primary.color,
    background: primary.background,
    radius: primary.radius,
  });
  await page.screenshot({ animations: "disabled", path: test.info().outputPath("assistant.png") });
});

test("the hero's two calls to action match and open creation from the keyboard", async ({
  page,
}) => {
  const play = page.getByTestId("hero-primary");
  const create = page.getByTestId("create-adventure-toggle");
  const control = (element: Element) => {
    const style = getComputedStyle(element);
    return { font: style.font, padding: style.padding, radius: style.borderRadius };
  };
  expect(await play.evaluate(control)).toEqual(await create.evaluate(control));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 });
    expect(
      Math.abs((await play.boundingBox())!.height - (await create.boundingBox())!.height),
    ).toBeLessThan(2);
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath(`hero-${width}.png`),
      fullPage: true,
    });
  }
  const panel = page.getByTestId("create-adventure-disclosure");
  await create.focus();
  await page.keyboard.press("Enter");
  await expect(panel).toHaveAttribute("open");
  await page.keyboard.press("Escape");
  await expect(panel).not.toHaveAttribute("open");
  await expect(create).toBeFocused();
  await page.keyboard.press("Space");
  await expect(panel).toHaveAttribute("open");
});

test("library details stay concise and Add game is a secondary action", async ({ page }) => {
  const add = page.getByRole("button", { name: "Add game", exact: true });
  await expect(add).toBeVisible();
  expect(await add.evaluate(appearance)).toEqual(
    await page.getByTestId("settings-menu").evaluate(appearance),
  );
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("btn-exit").click();
  const card = savedGameCard(page, "Adventure Department");
  const height = (await card.boundingBox())!.height;
  const details = await openSavedGameDetails(card);
  await expect(details).toContainText("Monotio");
  await expect(details).not.toContainText(
    /Later rooms|Opening checked|Interpreter|Project keeps|Ready to play/,
  );
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  expect((await card.boundingBox())!.height, "details never resize the card").toBe(height);
  // UiButton's fine-pointer height is --control-h (40px); touch gets 44px via
  // the pointer:coarse media query.
  for (const action of await card.locator("button").all()) {
    expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  }
  await add.click();
  await expect(page.getByRole("menu", { name: "Add game", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "ZIP file", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await card.screenshot({
      animations: "disabled",
      path: test.info().outputPath(`game-card-${width}.png`),
    });
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath(`library-${width}.png`),
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test("keyboard focus draws one ring on page buttons and dialog buttons alike", async ({ page }) => {
  const ring = (element: Element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      width: style.outlineWidth,
      style: style.outlineStyle,
      color: style.outlineColor,
    };
  };
  const focusColor = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--ui-focus)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  const expected = { focusVisible: true, width: "3px", style: "solid", color: focusColor };
  const play = page.getByTestId("catalog-play-adventure-department");
  await expect(play).toBeEnabled();
  await play.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(play).toBeFocused();
  expect(await play.evaluate(ring), "a page button").toEqual(expected);
  const create = page.getByTestId("create-adventure-toggle");
  await page.getByTestId("hero-primary").focus();
  await page.keyboard.press("Tab");
  await expect(create).toBeFocused();
  expect(await create.evaluate(ring), "a hero button").toEqual(expected);
  await openAiSettings(page);
  await page.getByTestId("task-budget").focus();
  await page.keyboard.press("Tab");
  const cancel = page.getByTestId("ai-settings-cancel");
  await expect(cancel).toBeFocused();
  expect(await cancel.evaluate(ring), "a dialog button").toEqual(expected);
  await page.keyboard.press("Escape");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("game-menu").focus();
  await page.keyboard.press("Tab");
  const eject = page.getByTestId("btn-exit");
  await expect(eject).toBeFocused();
  expect(await eject.evaluate(ring), "a game header button").toEqual(expected);
});
