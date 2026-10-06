import { providerReply } from "../../test/provider-stream.ts";
import { test, expect } from "./test.ts";
import {
  isolateStorage,
  textHook,
  configureAi,
  openWorkspaceAgent,
  openWorkspacePicture,
} from "./engineProbe.ts";
import { openWorkspaceLogic } from "./workspaceShared.ts";
import type { Page } from "@playwright/test";

async function startStarter(page: Page) {
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
}

async function editorBox(page: Page) {
  const editor = page.getByTestId("workspace-editor");
  await expect(editor).toBeVisible();
  return (await editor.boundingBox())!;
}

test("agent drawer overlays the workspace without narrowing the editor in both arrangements", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startStarter(page);
  await openWorkspaceLogic(page);
  const panel = page.getByTestId("workspace-agent-panel");

  for (const arrangement of ["Side by side", "Stacked"]) {
    await page.getByRole("button", { name: arrangement, exact: true }).click();
    const before = await editorBox(page);
    await openWorkspaceAgent(page);
    await expect(panel).toBeVisible();
    const after = await editorBox(page);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    // The drawer hugs the right edge over the workspace, opaque.
    const drawer = page.locator(".agent-drawer");
    const box = (await drawer.boundingBox())!;
    expect(box.x + box.width).toBe(1440);
    expect(box.width).toBeGreaterThanOrEqual(400);
    const bg = await drawer.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");
    await page.screenshot({
      path: test.info().outputPath(`drawer-${arrangement.replaceAll(" ", "-")}-1440.png`),
    });
    await panel.getByTestId("agent-panel-close").click();
    await expect(panel).toBeHidden();
  }

  // Esc inside the drawer closes it; Esc in the game stays with the game.
  await openWorkspaceAgent(page);
  await panel.getByTestId("agent-message").focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await openWorkspaceAgent(page);
  await expect(panel).toBeVisible();
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
});

test("the drawer is full width on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startStarter(page);
  await openWorkspaceAgent(page);
  const drawer = page.locator(".agent-drawer");
  await expect(page.getByTestId("workspace-agent-panel")).toBeVisible();
  const box = (await drawer.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBe(390);
});

test("a blank project has a working agent drawer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-blank").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByText("Nothing to play yet.")).toBeVisible();

  const toggle = page.getByRole("button", { name: "Agent", exact: true });
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  const panel = page.getByTestId("workspace-agent-panel");
  await expect(panel).toBeVisible();

  // Without a key the drawer says how to connect one, on the existing settings path.
  await expect(panel).toContainText("Connect your AI provider in Settings to start a task.");
  await panel.getByTestId("agent-open-ai-settings").click();
  const dialog = page.getByTestId("ai-settings-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("provider-select").selectOption("stub");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();

  // With a provider connected the blank project answers through the drawer.
  const composer = panel.getByTestId("agent-message");
  await expect(composer).toBeEnabled();
  await composer.fill("Build a meadow room");
  const send = panel.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(panel.locator(".agent-panel__message").last()).toContainText(
    "The project is ready for a task.",
  );
  await page.screenshot({ path: test.info().outputPath("drawer-blank-1440.png") });

  // Esc with focus in the drawer closes it; × closes it too.
  await composer.press("Escape");
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Build a meadow room");
  await panel.getByTestId("agent-panel-close").click();
  await expect(panel).toBeHidden();
});

test("the context chip follows the selection and its × asks about the whole game", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  const prompts: string[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    prompts.push(route.request().postData() ?? "");
    await route.fulfill(
      providerReply("openai", {
        id: `chip-${prompts.length}`,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `Answer ${prompts.length}.` }],
          },
        ],
      }),
    );
  });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);

  // LOGIC: the chip names the cursor line and follows it.
  const logic = await openWorkspaceLogic(page);
  await openWorkspaceAgent(page);
  const chip = page.getByTestId("agent-context-chip");
  await logic
    .locator(".view-line")
    .nth(2)
    .click({ position: { x: 24, y: 8 } });
  await expect(chip).toContainText("LOGIC 1 · line 3");
  await page.keyboard.press("ArrowDown");
  await expect(chip).toContainText("LOGIC 1 · line 4");

  // Dismissed: the next ask is about the whole game; a new selection brings the chip back.
  const messages = page.getByTestId("workspace-agent-panel").locator(".agent-panel__message");
  const composer = page.getByTestId("agent-message");
  await chip.getByRole("button", { name: "Ask about the whole game", exact: true }).click();
  await expect(chip).toHaveCount(0);
  let sent = prompts.length;
  await composer.fill("What is here?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(messages.last()).toContainText(`Answer ${sent + 1}.`);
  expect(prompts.slice(sent).join("\n")).not.toContain("Selection: LOGIC 1");
  await logic.locator(".view-line").nth(5).click({ position: { x: 24, y: 8 } });
  await expect(chip).toContainText("LOGIC 1 · line 6");
  sent = prompts.length;
  await composer.fill("And this line?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => prompts.length).toBeGreaterThan(sent);
  await expect(messages.last()).toContainText(`Answer ${sent + 1}.`);
  expect(prompts.slice(sent).join("\n")).toContain("Selection: LOGIC 1 · line 6");

  // PICTURE: the chip names the selected item (keyboard selection: the drawer covers the list).
  await openWorkspacePicture(page, 1);
  const studio = page.getByTestId("room-studio");
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(chip).toContainText("PICTURE 1 ·");
});
