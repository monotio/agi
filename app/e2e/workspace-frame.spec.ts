import { test, expect } from "./test.ts";
import { isolateStorage, textHook, workspaceSaved } from "./engineProbe.ts";
import type { Page } from "@playwright/test";

async function starter(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Frame proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  const parts = page.getByTestId("parts-list");
  if (page.viewportSize()!.width <= 600 && !(await parts.isVisible()))
    await page.getByTestId("workspace-parts").click();
  await expect(parts).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
}

test("tabs persist until × and restore across reload @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page.getByTestId("part-room:1:picture:1").click();
  await expect(page.getByTestId("project-tab-picture:1")).toBeVisible();
  // Choosing another part adds a tab; the first stays open.
  await page.getByTestId("part-view:0").click();
  await expect(page.getByTestId("project-tab-picture:1")).toBeVisible();
  await expect(page.getByTestId("project-tab-view:0")).toBeVisible();
  await expect(page.getByTestId("project-tab-picture:1")).not.toHaveCSS("font-style", "italic");
  await page.getByTestId("part-sound:255").click();
  await expect(page.getByTestId("project-tab-sound:255")).toBeVisible();
  await expect(page.getByTestId("project-tab-picture:1")).toBeVisible();
  // Only × closes a tab.
  await page.getByTestId("project-tab-close-view:0").click();
  await expect(page.getByTestId("project-tab-view:0")).toHaveCount(0);
  await expect(page.getByTestId("project-tab-picture:1")).toBeVisible();
  // A reload restores the open tabs and the selection for this project.
  await page.reload();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect(page.getByTestId("project-tab-picture:1")).toBeVisible();
  await expect(page.getByTestId("project-tab-sound:255")).toBeVisible();
  await expect(page.getByTestId("project-tab-view:0")).toHaveCount(0);
  await expect(page.getByTestId("project-tab-sound:255")).toHaveAttribute("aria-selected", "true");
});

test("stacked is the default; side by side toggles and falls back when narrow @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page.getByTestId("part-room:1:picture:1").click();
  const game = page.locator(".play-area");
  const editor = page.getByTestId("workspace-editor");
  // Stacked by default: the editor sits below the game.
  let gameBox = (await game.boundingBox())!;
  let editBox = (await editor.boundingBox())!;
  expect(editBox.y).toBeGreaterThanOrEqual(gameBox.y + gameBox.height);
  // The tab bar's layout icon switches to Side by side.
  await expect(page.getByTestId("workspace-layout")).toBeVisible();
  await page.getByTestId("workspace-layout").click();
  gameBox = (await game.boundingBox())!;
  editBox = (await editor.boundingBox())!;
  expect(editBox.x).toBeGreaterThanOrEqual(gameBox.x + gameBox.width);
  // Narrow viewports fall back to Stacked without squeezing.
  await page.setViewportSize({ width: 1023, height: 900 });
  await expect(editor).toBeVisible();
  await expect
    .poll(async () => {
      const gameBox = (await game.boundingBox())!;
      const editBox = (await editor.boundingBox())!;
      return editBox.y - (gameBox.y + gameBox.height);
    })
    .toBeGreaterThanOrEqual(0);
  // Wide again: the viewer's Side by side choice returns.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect
    .poll(async () => {
      const gameBox = (await game.boundingBox())!;
      const editBox = (await editor.boundingBox())!;
      return editBox.x - (gameBox.x + gameBox.width);
    })
    .toBeGreaterThanOrEqual(0);
});

test("every parts section has its own + and OBJECTS and WORDS always show @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  const parts = page.getByTestId("parts-list");
  for (const label of [
    "GAME STATE",
    "ROOMS",
    "SHARED LOGIC",
    "PICTURES",
    "VIEWS",
    "SOUNDS",
    "OBJECTS",
    "WORDS",
  ]) {
    const section = parts
      .locator("section", {
        has: page.getByRole("heading", { name: label, exact: true }),
      })
      .first();
    await expect(section).toBeVisible();
    await expect(section.locator(".parts-add").first()).toBeVisible();
  }
  await expect(page.getByTestId("part-inventory")).toBeVisible();
  await expect(page.getByTestId("part-words")).toBeVisible();
});

test("Game state + names a flag in place @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  const naming = page.getByTestId("game-state-naming");
  await page.getByTestId("add-game-state").click();
  await expect(naming).toBeVisible();
  await expect(page.getByTestId("game-state-num")).toHaveValue(/^\d+$/);
  await page.getByTestId("game-state-name").fill("picked_flower");
  await naming.getByRole("button", { name: "Name it", exact: true }).click();
  // The named flag joins the Game state list and the bindings draft.
  await expect(page.getByTestId("parts-list")).toContainText("picked_flower");
  await expect(page.locator('[data-testid="project-tab-state"]')).toBeVisible();
});

test("data tabs open from Parts and Problems opens from the status bar @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page.getByTestId("part-state").click();
  await expect(page.getByTestId("project-tab-state")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("workspace-state")).toBeVisible();
  await page.getByTestId("part-messages").click();
  await expect(page.getByTestId("project-tab-messages")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("workspace-messages")).toBeVisible();
  await page.getByTestId("part-problems").click();
  await expect(page.getByTestId("project-tab-problems")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("workspace-problems")).toBeVisible();
  // A nonzero problem count also surfaces in the status bar and opens the tab.
  await page.getByTestId("part-room:1:logic").click();
  await page.locator(".monaco-editor").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\nthis is not logic\n");
  await expect(page.getByTestId("workspace-status-problems")).toBeVisible();
  await page.getByTestId("workspace-status-problems").click();
  await expect(page.getByTestId("project-tab-problems")).toHaveAttribute("aria-selected", "true");
});

test("the editor frame has no repeated room or bytes rows and Focus is an icon @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page.getByTestId("part-room:1:picture:1").click();
  await expect(page.getByTestId("room-studio")).toBeVisible();
  await expect(page.getByTestId("workspace-room-live")).toHaveCount(0);
  await expect(page.getByTestId("room-studio").locator(".studio__meta-bar")).toHaveCount(0);
  await expect(page.getByTestId("studio-size")).toHaveCount(0);
  await expect(page.getByTestId("studio-issues")).toHaveCount(0);
  const focus = page.getByTestId("workspace-focus");
  await expect(focus).toBeVisible();
  await expect(focus).not.toContainText("Focus");
  // The shared status bar carries the studio's status and quiet meta.
  const status = page.getByTestId("workspace-status");
  await expect(status).toBeVisible();
  await expect(status.getByTestId("studio-status")).toBeVisible();
  await expect(status).toContainText("AGI 2.936");
});

test("the game bar names the running room; Play visits and Back returns @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  const bar = page.getByTestId("workspace-game-bar");
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId("workspace-room")).toBeVisible();
  await expect(bar.getByTestId("workspace-room")).toContainText("Room 1");
  // Publish the new room while keeping play in place, then select its picture.
  await page
    .getByTestId("parts-list")
    .getByRole("button", { name: "Add a room", exact: true })
    .click();
  await expect(page.getByTestId("workspace-guided-form")).toBeVisible();
  await page.getByLabel("Room name", { exact: true }).fill("Garden");
  await page
    .getByTestId("workspace-guided-form")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await workspaceSaved(page);
  await page.getByTestId("workspace-update-menu").click();
  await page.getByRole("menuitem", { name: "Update and keep playing", exact: true }).click();
  await expect(page.getByTestId("workspace-pending")).toBeHidden();
  await page.getByTestId("part-room:2:picture:2").click();
  await expect(page.getByTestId("room-studio")).toBeVisible();
  expect((await textHook(page)).room).toBe(1);
  await expect(bar.getByTestId("workspace-room")).toHaveText("Room 1 · Meadow");
  await expect(bar.getByRole("button", { name: "Back to Room 1", exact: true })).toHaveCount(0);
  const action = page.getByTestId("workspace-update");
  await expect(action).toBeVisible();
  await expect(action).toHaveText("Play Garden");
  await action.click();
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await expect(bar.getByTestId("workspace-room")).toHaveText("Room 2 · Garden");
  const back = bar.getByRole("button", { name: "Back to Room 1", exact: true });
  await expect(back).toBeVisible();
  await back.click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(bar.getByTestId("workspace-room")).toHaveText("Room 1 · Meadow");
  await expect(back).toHaveCount(0);
});

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test(`context row room actions receive clicks at ${width} @webkit-desktop`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width, height });
    await starter(page);
    await page.getByTestId("part-room:1:logic").click();
    const context = page.getByTestId("workspace-context");
    await expect(context).toBeVisible();
    await context.getByTestId("workspace-add").click();
    await page.getByRole("menuitem", { name: "Place hero", exact: true }).click();
    const form = context.getByTestId("workspace-guided-form");
    const here = form.getByRole("button", { name: "Start here", exact: true });
    await expect(form).toBeVisible();
    await expect(here).toBeVisible();
    await here.scrollIntoViewIfNeeded();
    const shot = await page.screenshot({
      path: test.info().outputPath(`action-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    if (process.env["CI"] && browserName === "webkit" && width === 390)
      console.log(`FRAME_SHOT:action-${width}:${shot.toString("base64")}`);
    await expect
      .poll(async () => {
        const box = (await form.boundingBox())!;
        return box.y + box.height;
      })
      .toBeLessThanOrEqual(height);
    await expect
      .poll(() =>
        here.evaluate((button) => {
          const box = button.getBoundingClientRect();
          return button.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          );
        }),
      )
      .toBe(true);
    const position = await textHook(page);
    await here.click();
    const code = form.getByTestId("guided-code-preview");
    await expect(code).toBeVisible();
    await expect(code).toContainText(`position(o0, ${position.egoX}, ${position.egoY})`);
    // Scrolling the form itself reaches its actions, while the editor stays in place.
    await form.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(form.getByRole("button", { name: "Add", exact: true })).toBeInViewport({
      ratio: 1,
    });
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(form).toBeHidden();
  });
}
