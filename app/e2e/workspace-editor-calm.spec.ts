import type { ProjectSession } from "../src/project/projectSession.ts";
import { test, expect } from "./test.ts";
import { textHook } from "./engineProbe.ts";
import { start, open } from "./pictureWorkspaceShared.ts";
import {
  focusWorkspaceLogic,
  findWorkspaceLogic,
  runningWorkspaceDocument,
  workspaceDocumentEnd,
} from "./workspaceShared.ts";

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test.describe(`Calm editor ${width}`, () => {
    test.use({ viewport: { width, height }, hasTouch: width === 390 });
    test("typing an unfinished condition keeps the editor in place @webkit-desktop", async ({
      page,
    }) => {
      await start(page);
      await open(page, "part-room:1:logic");
      const editor = page.getByTestId("workspace-logic-editor").filter({ visible: true });
      await expect(editor.locator(".monaco-editor")).toBeVisible();
      await focusWorkspaceLogic(page);
      await workspaceDocumentEnd(page);
      await page.keyboard.press("Enter");
      await page.evaluate(() => document.fonts.ready);
      const before = await editor.boundingBox();
      await page.keyboard.type("if (");
      await expect(page.getByTestId("workspace-status-problems")).toBeVisible();
      expect(await editor.boundingBox()).toEqual(before);
      await expect(page.getByTestId("workspace-last-good")).toHaveCount(0);
    });

    test("context actions fit and overflow is keyboard accessible @webkit-desktop", async ({
      page,
    }) => {
      await start(page);
      await open(page, "part-room:1:logic");
      const context = page.getByTestId("workspace-context");
      await expect(
        page.getByTestId("workspace-logic-editor").locator(".monaco-editor"),
      ).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath(`context-${width}.png`),
        animations: "disabled",
      });
      await expect(
        context.getByRole("button", { name: "Change number…", exact: true }),
      ).toHaveCount(0);
      const more = context.getByRole("button", { name: "More actions", exact: true });
      await expect(more).toBeVisible();
      const buttons = context.locator("button:visible");
      const bounds = (await context.boundingBox())!;
      for (const button of await buttons.all()) {
        const box = (await button.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await more.focus();
      await more.press("ArrowDown");
      const menu = page.getByRole("menu", { name: "More actions", exact: true });
      await expect(menu).toBeVisible();
      await expect(
        menu.getByRole("menuitem", { name: "Change number…", exact: true }),
      ).toBeVisible();
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      await page.keyboard.press("End");
      await expect(menu.getByRole("menuitem").last()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(more).toBeFocused();
      if (width === 1063) {
        await page.setViewportSize({ width: 390, height });
        await expect(context.getByTestId("room-action-response")).toBeVisible();
        await expect(context.getByTestId("room-action-door")).toHaveCount(0);
        await expect(context.getByRole("button", { name: /^▶ Play |^Debug / })).toHaveCount(0);
        await expect(page.getByTestId("workspace-update")).toBeVisible();
        await more.click();
        await expect(menu.getByRole("menuitem")).toHaveText([
          "Door",
          "Sound when…",
          "Change number…",
        ]);
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width, height });
        await expect(context.getByTestId("room-action-door")).toBeVisible();
      }
    });
  });
}

for (const action of ["update", "shortcut", "F5", "breakpoint"] as const) {
  test(`broken draft refuses ${action} and preserves the game @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await start(page);
    await open(page, "part-room:1:logic");
    const original = await runningWorkspaceDocument(page, "logic:1");
    if (action === "breakpoint") {
      await findWorkspaceLogic(page, "assignn(v50, clearing_pic)");
      await page.keyboard.press("F9");
      await expect(page.locator(".workspace-breakpoint")).toHaveCount(1);
    }
    await focusWorkspaceLogic(page);
    await workspaceDocumentEnd(page);
    await page.keyboard.insertText("\nif (");
    await expect(page.getByTestId("workspace-status-problems")).toBeVisible();
    const editor = page.getByTestId("workspace-logic-editor").filter({ visible: true });
    const before = await editor.boundingBox();
    const cycle = (await textHook(page)).cycle;
    if (action === "shortcut") {
      const mac = await page.evaluate(() => /mac|iphone|ipad/i.test(navigator.platform));
      await page.keyboard.press(mac ? "Meta+Enter" : "Control+Enter");
    } else if (action === "update") await page.getByTestId("workspace-update").click();
    else await page.keyboard.press("F5");
    const notice = page
      .getByRole("alert")
      .filter({ hasText: "LOGIC 1 has errors. Fix them to update the game." });
    await expect(notice).toBeVisible();
    await expect(notice).toHaveCount(1);
    await expect(page.getByTestId("workspace-debug-status")).toHaveCount(0);
    await expect(
      page.getByTestId("workspace-logic-editor").filter({ visible: true }),
    ).toBeVisible();
    expect(await runningWorkspaceDocument(page, "logic:1")).toBe(original);
    await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
    expect(await editor.boundingBox()).toEqual(before);
    await page.screenshot({
      path: test.info().outputPath(`refusal-${action}.png`),
      animations: "disabled",
    });
    await notice.getByRole("button", { name: "Go to error", exact: true }).click();
    await expect(
      page
        .getByTestId("workspace-logic-editor")
        .locator("textarea.inputarea, .native-edit-context")
        .first(),
    ).toBeFocused();
    await page.keyboard.insertText(" ");
    await expect(notice).toHaveCount(0);
    expect(await editor.boundingBox()).toEqual(before);
  });
}

test("a failed build can be repaired from its error notice @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:1:logic");
  const original = await runningWorkspaceDocument(page, "logic:8");
  // A closed part has no live editor diagnostics; Update must validate it too.
  await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    session.drafts().stage([{ key: "logic:8", content: "if (" }]);
  });
  await expect(page.getByTestId("workspace-pending")).toBeVisible();
  await page.getByTestId("workspace-update").click();
  const notice = page
    .getByRole("alert")
    .filter({ hasText: "LOGIC 8 has errors. Fix them to update the game." });
  await expect(notice).toBeVisible();
  expect(await runningWorkspaceDocument(page, "logic:8")).toBe(original);
  await notice.getByRole("button", { name: "Go to error", exact: true }).click();
  await focusWorkspaceLogic(page);
  const mac = await page.evaluate(() => navigator.userAgent.includes("Macintosh"));
  await page.keyboard.press(mac ? "Meta+a" : "Control+a");
  await page.keyboard.insertText("return;");
  await expect(page.getByTestId("workspace-status-problems")).toBeHidden();
  await page.getByTestId("workspace-update-menu").click();
  await page.getByRole("menuitem", { name: "Update and keep playing", exact: true }).click();
  await expect.poll(() => runningWorkspaceDocument(page, "logic:8")).toBe("return;");
  await expect(notice).toHaveCount(0);
});
