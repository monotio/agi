import type { Page } from "@playwright/test";
import { test, expect } from "./test.ts";
import { isolateStorage, waitForRoom, workspaceSaved, textHook } from "./engineProbe.ts";
import {
  openWorkspaceLogic,
  focusWorkspaceLogic,
  runningWorkspaceDocument,
} from "./workspaceShared.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

async function starter(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Update proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  if (page.viewportSize()!.width <= 600) await page.getByTestId("workspace-parts").click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
}
async function draft(page: Page, source: string): Promise<void> {
  await openWorkspaceLogic(page);
  await focusWorkspaceLogic(page);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(source);
  await page.keyboard.press("Escape");
}
async function commits(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
        .getSession()
        .history.capture().commits.length,
  );
}

test("the approved Update game storyboard replaces per-edit patching @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  const before = await runningWorkspaceDocument(page, "logic:1");
  const history = await commits(page);
  const changed = `${before}\n// Waiting for Update\n`;
  await draft(page, changed);
  await expect(page.getByTestId("workspace-pending")).toBeVisible();
  await expect(page.getByTestId("workspace-pending")).toHaveText("1 change not in the game yet");
  await expect(page.getByTestId("part-room:1:logic").getByLabel("Pending change")).toBeVisible();
  await workspaceSaved(page);
  expect(await runningWorkspaceDocument(page, "logic:1")).toBe(before);
  expect(await commits(page)).toBe(history);
  const cycle = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect(page.getByTestId("workspace-update")).toBeVisible();
  await expect(page.getByTestId("workspace-pending")).toBeVisible();
  await page.getByTestId("workspace-update").click();
  await expect.poll(() => runningWorkspaceDocument(page, "logic:1")).toBe(changed);
  expect(await commits(page)).toBe(history + 1);
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await expect(page.getByTestId("workspace-updated")).toBeVisible();
  await page.getByTestId("workspace-undo").click();
  await expect.poll(() => runningWorkspaceDocument(page, "logic:1")).toBe(before);
});

test("invalid drafts report a problem and discard restores the editor @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  const before = await runningWorkspaceDocument(page, "logic:1");
  await draft(page, "if (");
  await expect(page.getByTestId("workspace-update")).toBeVisible();
  await expect(page.getByTestId("workspace-update")).toHaveText("1 problem");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("workspace-update")).toBeVisible();
  await expect(page.getByTestId("workspace-update")).toHaveText("1 problem");
  expect(await runningWorkspaceDocument(page, "logic:1")).toBe(before);
  await page.getByTestId("workspace-update").click();
  await expect(page.getByTestId("workspace-problems")).toBeVisible();
  await page
    .getByTestId("workspace-problems")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByTestId("workspace-update-menu").click();
  await expect(page.getByRole("menuitem", { name: "Discard changes…", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Discard changes…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discard changes?", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("workspace-pending")).toBeHidden();
  await expect(page.getByTestId("workspace-logic-editor").locator(".view-lines")).toBeVisible();
  await expect(page.getByTestId("workspace-logic-editor").locator(".view-lines")).toContainText(
    "draw.pic",
  );
});

for (const [width, height] of [
  [1440, 900],
  [1063, 815],
  [390, 844],
] as const) {
  test.describe("Draft viewport " + width, () => {
    test.use({ hasTouch: width === 390 });
    test(`Update game draft storyboard at ${width} @webkit-desktop`, async ({
      page,
      browserName,
    }) => {
      await page.setViewportSize({ width, height });
      await starter(page);
      await page.evaluate(async () => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        const source = String(session.model.capture().read("logic:1")!.content);
        await session.update(
          [
            {
              key: "logic:1",
              content: source.replace(
                "player.control();",
                "program.control(); move.obj(o0, 140, 140, 1, f180);",
              ),
            },
          ],
          true,
        );
      });
      await page.getByTestId("part-room:1:picture:1").click();
      const studio = page.getByTestId("room-studio");
      await expect(studio).toBeVisible();
      await studio.locator('[data-tool="rect"]').click();
      await studio.getByTestId("studio-tool-filled").check();
      await studio.locator('.workspace-palette [data-colour="4"]').click();
      const pane = studio.locator(".studio-pane");
      await page.evaluate(() => document.fonts.ready);
      await pane.hover();
      const box = (await pane.boundingBox())!;
      const zoom = box.height / 168;
      const before = await page.evaluate(() => window.__AGI_FRAME__?.()?.visual[112 * 160 + 22]);
      await pane.hover({ position: { x: 20.5 * 2 * zoom, y: 110.5 * zoom } });
      await page.mouse.down();
      await page.mouse.move(box.x + 24.5 * 2 * zoom, box.y + 114.5 * zoom, { steps: 4 });
      await page.mouse.up();
      await expect(page.getByTestId("stage-draft")).toBeVisible();
      expect(await page.evaluate(() => window.__AGI_FRAME__?.()?.visual[112 * 160 + 22])).toBe(
        before,
      );
      const cycle = (await textHook(page)).cycle;
      const egoX = (await textHook(page)).egoX;
      await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
      await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(egoX);
      const shot = await page.screenshot({
        path: test.info().outputPath(`update-${width}.png`),
        animations: "disabled",
        scale: "css",
      });
      if (process.env["CI"] && browserName === "webkit" && width === 390)
        console.log(`PHONE_SHOT:${shot.toString("base64")}`);
      await page.getByTestId("workspace-update").click();
      await expect(page.getByTestId("stage-draft")).toBeHidden();
      await expect
        .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[112 * 160 + 22]))
        .toBe(4);
      if (width === 1063) {
        await page.getByTestId("part-room:1:logic").click();
        await expect(page.getByRole("button", { name: "Stacked", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Stacked", exact: true }).click();
        await page.screenshot({
          path: test.info().outputPath(`update-${width}-stacked.png`),
          animations: "disabled",
          scale: "css",
        });
      }
    });
  });
}

test("Help explains Update game after the retired live-edit tips are removed @webkit-desktop", async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page.getByTestId("help-menu").click();
  await expect(page.getByTestId("btn-help-guide")).toBeVisible();
  await page.getByTestId("btn-help-guide").click();
  const help = page.getByTestId("help-guide");
  await expect(help).toBeVisible();
  await page.getByTestId("help-section-creating").click();
  await expect(help).toContainText("Update game puts the changed parts in the game together.");
  for (const [width, height] of [
    [1440, 900],
    [1063, 815],
    [390, 844],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    const shot = await page.screenshot({
      path: test.info().outputPath(`help-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    if (process.env["CI"] && browserName === "webkit" && width === 390)
      console.log(`PHONE_HELP_SHOT:${shot.toString("base64")}`);
  }
  await expect(help.getByRole("button", { name: "Show tips", exact: true })).toHaveCount(0);
});

test("reopening restores a saved draft and its dot while the game keeps its last update", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  const before = await runningWorkspaceDocument(page, "logic:1");
  await draft(page, `// Restored draft\n${before}`);
  await workspaceSaved(page);
  await page.reload();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect(page.getByTestId("part-room:1:logic").getByLabel("Pending change")).toBeVisible();
  expect(await runningWorkspaceDocument(page, "logic:1")).toBe(before);
  await openWorkspaceLogic(page);
  await expect(page.getByTestId("workspace-logic-editor").locator(".view-lines")).toBeVisible();
  await expect(page.getByTestId("workspace-logic-editor").locator(".view-lines")).toContainText(
    "Restored draft",
  );
});

test("Update shortcuts keep the room state and the restart menu starts it again @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  const before = await runningWorkspaceDocument(page, "logic:1");
  await draft(page, before.replace("position(o0, 80, 140)", "position(o0, 42, 140)"));
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  await expect(page.getByTestId("workspace-updated")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).egoX).toBe(42);
  await draft(page, before.replace("position(o0, 80, 140)", "position(o0, 64, 140)"));
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("workspace-updated")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).egoX).toBe(42);
  await expect
    .poll(() => runningWorkspaceDocument(page, "logic:1"))
    .toContain("position(o0, 64, 140)");
  await page.getByTestId("workspace-update-menu").click();
  const restart = page.getByRole("menuitem", { name: "Update and restart this room", exact: true });
  await expect(restart).toBeVisible();
  await restart.click();
  await expect.poll(async () => (await textHook(page)).egoX).toBe(64);
});
