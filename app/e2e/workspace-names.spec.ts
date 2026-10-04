import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import {
  textHook,
  configureAi,
  isolateStorage,
  waitForRoom,
  workspaceSaved,
} from "./engineProbe.ts";
import {
  focusWorkspaceLogic,
  openWorkspaceLogic,
  replaceWorkspaceDocument,
  workspaceDocument,
} from "./workspaceShared.ts";

test.use({ viewport: { width: 1440, height: 900 } });
async function start(page: Page) {
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.getByTestId("create-adventure-toggle").click();
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByTestId("local-create-submit").click();
  await waitForRoom(page, 1);
  await workspaceSaved(page);
}
async function findWord(page: Page, word: string): Promise<void> {
  await focusWorkspaceLogic(page);
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByRole("textbox", { name: "Find", exact: true });
  await expect(find).toBeVisible();
  await find.fill(word);
  await find.press("Escape");
  await page.keyboard.press("ArrowLeft");
}
test("names open resources, peek game state and rename all authored uses @webkit-desktop", async ({
  page,
}) => {
  await start(page);
  const parts = page.getByTestId("parts-list");
  await expect(parts.getByRole("heading", { name: "Game state", exact: true })).toBeVisible();
  await parts.getByRole("button", { name: "chime_done · Flag 204", exact: true }).click();
  const details = page.getByTestId("binding-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText("Set · LOGIC 1");
  await details.getByRole("button", { name: "Rename", exact: true }).click();
  await details.getByLabel("Name", { exact: true }).fill("birdsong_done");
  await details.getByRole("button", { name: "Save name", exact: true }).click();
  await workspaceSaved(page);
  expect(await workspaceDocument(page, "bindings")).toContain("birdsong_done");
  expect(await workspaceDocument(page, "logic:1")).toContain("sound(chime_sound, birdsong_done)");
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await replaceWorkspaceDocument(
    page,
    "logic:1",
    "load.sound(chime_sound);\nif (isset(birdsong_done)) { reset(birdsong_done); }\nreturn;",
  );
  await findWord(page, "chime_sound");
  await page.keyboard.press("F12");
  await expect(page.getByTestId("workspace-sound")).toBeVisible();
  await expect(page.getByTestId("project-tab-sound:1")).toHaveAttribute("aria-selected", "true");
  await openWorkspaceLogic(page);
  await findWord(page, "birdsong_done");
  await page.keyboard.press("F12");
  await expect(details).toBeVisible();
  await expect(details).toContainText("birdsong_done · Flag 204");
  await expect(page.locator(".monaco-editor")).not.toContainText("bindings.json");
  await expect(page.locator(".reference-zone-widget")).toHaveCount(0);
  for (const viewport of [
    { width: 1063, height: 815 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    if (viewport.width === 390) {
      const part = page.getByTestId("part-room:1:logic");
      if (!(await part.isVisible())) await page.getByTestId("workspace-parts").click();
      await expect(part).toBeVisible();
      await part.click();
    }
    await expect(details).toBeVisible();
    await expect(page.getByTestId("workspace-logic-editor").locator(".view-lines")).toBeVisible();
    const sourceLine = page
      .getByTestId("workspace-logic-editor")
      .locator(".view-lines")
      .getByText("load.sound", { exact: true });
    await expect(sourceLine).toBeVisible();
    await expect(sourceLine).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath(`names-peek-${viewport.width}.png`),
      scale: "css",
    });
  }
});
test("Create agent keeps reading position and jumps to latest", async ({ page }) => {
  await start(page);
  await page.getByTestId("workspace-agent").click();
  const panel = page.getByTestId("workspace-agent-panel");
  await expect(panel).toBeVisible();
  for (let index = 0; index < 3; index++) {
    await page.getByTestId("agent-message").fill("Add a welcome sign that answers look at sign");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("agent-review")).toBeVisible();
    await page.getByTestId("agent-reject").click();
    await expect(page.getByTestId("agent-review")).toBeHidden();
  }
  const feed = panel.locator(".agent-panel__feed");
  await feed.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(panel.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  const top = await feed.evaluate((node) => node.scrollTop);
  await page.getByTestId("agent-message").fill("Tell me about this room");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  expect(await feed.evaluate((node) => node.scrollTop)).toBe(top);
  await panel.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect
    .poll(() => feed.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeLessThan(24);
  await page.screenshot({ path: test.info().outputPath("agent-latest.png") });
});

test("Create game owns F5 and F6 while the editor owns Run", async ({ page }) => {
  await start(page);
  await openWorkspaceLogic(page);
  const input = page.getByTestId("input-line");
  await input.focus();
  await page.keyboard.press("F6");
  await expect(input).toBeFocused();
  await page.keyboard.press("F5");
  await expect.poll(async () => (await textHook(page)).modal).toBe("save");
  await expect(page.getByTestId("debug-stop")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await focusWorkspaceLogic(page);
  await page.keyboard.press("F5");
  await expect(page.getByTestId("debug-stop")).toBeVisible();
  await expect(page.getByTestId("debug-stop")).toBeEnabled();
  await page.keyboard.press("Shift+F5");
  await expect(page.getByTestId("debug-stop")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByTestId("debug-stop")).toBeVisible();
});

test("name hover opens resources and message actions keep readable text @webkit-desktop", async ({
  page,
}) => {
  await start(page);
  await replaceWorkspaceDocument(
    page,
    "logic:1",
    '#message 1 "Hello there"\nload.sound(chime_sound);\nif (isset(chime_done)) { print(m1); }\nreturn;',
  );
  await focusWorkspaceLogic(page);
  const editor = page.getByTestId("workspace-logic-editor");
  await editor.locator(".view-lines").getByText("chime_sound", { exact: true }).hover();
  const hover = page.locator(".monaco-hover:not(.hidden)");
  await expect(hover).toBeVisible();
  await expect(hover).toContainText("chime_sound · SOUND 1 · used in 1 places");
  await expect(hover.getByRole("link", { name: "Rename", exact: true })).toBeVisible();
  await hover.getByRole("link", { name: "Rename", exact: true }).click();
  const details = page.getByTestId("binding-details");
  await expect(details).toBeVisible();
  await details.getByLabel("Name", { exact: true }).fill("birdsong");
  await details.getByRole("button", { name: "Save name", exact: true }).click();
  await workspaceSaved(page);
  await expect(details).toContainText("load.sound(birdsong);");
  await expect(details.getByRole("button", { name: "Rename", exact: true })).toBeVisible();
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await editor.locator(".view-lines").getByText("birdsong", { exact: true }).hover();
  await expect(hover).toBeVisible();
  await expect(hover).toContainText("birdsong · SOUND 1 · used in 1 places");
  await hover.getByRole("link", { name: "Open", exact: true }).click();
  await expect(page.getByTestId("workspace-sound")).toBeVisible();
  await openWorkspaceLogic(page);
  await focusWorkspaceLogic(page);
  for (const viewport of [
    { width: 1063, height: 815 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    if (viewport.width === 390) {
      const part = page.getByTestId("part-room:1:logic");
      if (!(await part.isVisible())) await page.getByTestId("workspace-parts").click();
      await expect(part).toBeVisible();
      await part.click();
    }
    await expect(editor).toBeVisible();
    await expect(editor.locator(".view-lines")).toContainText(/m1\s+"Hello\s+there"/);
    await page.screenshot({
      path: test.info().outputPath(`message-hints-${viewport.width}.png`),
      scale: "css",
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await findWord(page, "m1");
  await page.keyboard.press("ControlOrMeta+.");
  const inline = page.getByText("Put text inline", { exact: true });
  await expect(inline).toBeVisible();
  await inline.click();
  await workspaceSaved(page);
  expect(await workspaceDocument(page, "logic:1")).toContain('print("Hello there")');
  await focusWorkspaceLogic(page);
  await page.keyboard.press("ControlOrMeta+.");
  const numbered = page.getByText("Move text to #message", { exact: true });
  await expect(numbered).toBeVisible();
  await numbered.click();
  await workspaceSaved(page);
  expect(await workspaceDocument(page, "logic:1")).toContain('#message 2 "Hello there"');
  expect(await workspaceDocument(page, "logic:1")).toContain("print(m2)");
});

test("Home cards offer one Create and neutral entries clear an AI pick", async ({ page }) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  await isolateStorage(page);
  await page.goto("/");
  const button = page.getByTestId("shelf-template-custom");
  await button.scrollIntoViewIfNeeded();
  const card = button.locator("xpath=ancestor::article");
  await expect(card).toBeVisible();
  await expect(card).toContainText("New game");
  await expect(card).toContainText("Starter, Boilerplate, Blank or AI");
  await expect(card.getByRole("button")).toHaveCount(1);
  await expect(card.locator(".game-card__pill")).toHaveCount(0);
  expect(
    await card.locator(".game-card__meta").evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: test.info().outputPath("home-neutral-card.png") });
  await page.getByTestId("shelf-template-knights-trial").click();
  await expect(page.getByTestId("local-create-kind-ai")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("template-knights-trial")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("create-adventure-close").click();
  await page.getByTestId("create-adventure-toggle").click();
  await expect(
    page.getByRole("radiogroup", { name: "Starting point" }).locator('[aria-checked="true"]'),
  ).toHaveCount(0);
  await expect(page.getByTestId("local-create-submit")).toBeHidden();
  await page.getByTestId("create-adventure-close").click();
  await button.click();
  await expect(page.getByRole("radiogroup", { name: "Starting point" })).toBeVisible();
  await expect(
    page.getByRole("radiogroup", { name: "Starting point" }).locator('[aria-checked="true"]'),
  ).toHaveCount(0);
});
