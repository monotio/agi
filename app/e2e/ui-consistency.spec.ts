import { expect, test } from "@playwright/test";
import { isolateStorage, openSavedGameDetails, savedGameCard, textHook } from "./engineProbe.ts";

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

test("Play, Resume and Save settings share one primary action style", async ({ page }) => {
  const primary = await page.getByTestId("hero-play-now").evaluate(appearance);
  expect(await page.getByTestId("catalog-play-adventure-department").evaluate(appearance)).toEqual(
    primary,
  );
  await page.getByTestId("hero-play-now").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const secondary = await page.getByTestId("open-ai-settings").evaluate(appearance);
  expect(await page.getByTestId("btn-eject").evaluate(appearance)).toEqual(secondary);
  for (const action of await page.locator(".game-nav > button, .game-nav summary").all()) {
    expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByTestId("btn-eject").click();
  const card = savedGameCard(page, "Adventure Department");
  const resume = card.getByRole("button", { name: "Resume", exact: true });
  await expect(resume).toBeVisible();
  expect(await resume.evaluate(appearance)).toEqual(primary);
  await page.getByTestId("open-ai-settings").click();
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
  expect(await page.getByTestId("agent-bubble-send").evaluate(appearance)).toEqual(primary);
  await page.screenshot({ animations: "disabled", path: test.info().outputPath("assistant.png") });
});

test("tutorial and creation use matching disclosure controls with remembered state", async ({
  page,
}) => {
  const tutorial = page.getByTestId("tutorial-toggle");
  const create = page.getByTestId("create-adventure-toggle");
  const control = (element: Element) => {
    const style = getComputedStyle(element);
    return {
      before: getComputedStyle(element, "::before").content,
      after: getComputedStyle(element, "::after").content,
      font: style.font,
      padding: style.padding,
      display: style.display,
      marker: style.listStyleType,
    };
  };
  expect(await tutorial.evaluate(control)).toEqual(await create.evaluate(control));
  await tutorial.click();
  await create.click();
  await page.reload();
  await expect(page.getByTestId("tutorial-disclosure")).not.toHaveAttribute("open");
  await expect(page.getByTestId("create-adventure-disclosure")).not.toHaveAttribute("open");
  expect(await tutorial.evaluate(control)).toEqual(await create.evaluate(control));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 });
    expect(
      Math.abs((await tutorial.boundingBox())!.height - (await create.boundingBox())!.height),
    ).toBeLessThan(2);
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath(`disclosures-${width}.png`),
      fullPage: true,
    });
  }
  await tutorial.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tutorial-disclosure")).toHaveAttribute("open");
  await create.focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("create-adventure-disclosure")).toHaveAttribute("open");
});

test("library details stay concise and Add game is a secondary action", async ({ page }) => {
  const add = page.getByRole("button", { name: "Add game", exact: true });
  await expect(add).toBeVisible();
  expect(await add.evaluate(appearance)).toEqual(
    await page.getByRole("link", { name: "Create an adventure", exact: true }).evaluate(appearance),
  );
  await page.getByTestId("hero-play-now").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("btn-eject").click();
  const card = savedGameCard(page, "Adventure Department");
  await openSavedGameDetails(card);
  await expect(card).not.toContainText(
    /Later rooms|Opening checked|Interpreter|Save project keeps|Ready to play/,
  );
  for (const id of [
    "rename-game",
    "copy-library-game",
    "btn-export-agi-zip",
    "btn-save-project",
    "remove-library-game",
  ]) {
    const action = card.getByTestId(id);
    expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(
      Number(
        await action.evaluate((element) => getComputedStyle(element).fontSize.replace("px", "")),
      ),
    ).toBeGreaterThanOrEqual(14);
  }
  await add.click();
  await expect(page.getByRole("menu", { name: "Add game", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "ZIP file", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 });
    const actions = await card.locator(".saved-world-actions > button").all();
    for (let index = 0; index + 1 < actions.length; index += 2) {
      const left = (await actions[index]!.boundingBox())!;
      const right = (await actions[index + 1]!.boundingBox())!;
      expect(Math.abs(left.height - right.height)).toBeLessThan(1);
    }
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
