import { test, expect } from "./test.ts";
import { isolateStorage, waitForRoom } from "./engineProbe.ts";

/**
 * The LOGIC editor shows its gestures: a dot left of a line number on hover
 * marks where a click stops the game, the debug panels say how to stop it
 * when they are empty, and the key list names the editor's keys.
 */
for (const [width, height] of [
  [1440, 900],
  [1063, 815],
] as const)
  test(`LOGIC shows breakpoints, debug hints and its keys at ${width} @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await isolateStorage(page);
    const codiconResponse = page.waitForResponse((response) =>
      /\/codicon(?:-[\w-]+)?\.ttf$/.test(new URL(response.url()).pathname),
    );
    await page.goto("/#create-adventure");
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByRole("button", { name: "Start building", exact: true }).click();
    await waitForRoom(page, 1);
    await page.getByTestId("part-room:1:logic").click();
    const editor = page.getByTestId("workspace-logic-editor").filter({ visible: true });
    await expect(editor.locator(".monaco-editor")).toBeVisible();
    expect((await codiconResponse).status(), "Monaco icon font is served").toBe(200);

    // Hovering left of line 3's number shows a dot; a click there sets the breakpoint.
    const lineNumber = editor.locator(".line-numbers", { hasText: /^3$/ }).first();
    await expect(lineNumber).toBeVisible();
    const box = (await lineNumber.boundingBox())!;
    const margin = (await editor.locator(".glyph-margin").first().boundingBox())!;
    const at = { x: margin.x + margin.width / 2, y: box.y + box.height / 2 };
    await expect(editor.locator(".workspace-breakpoint-hint")).toHaveCount(0);
    await page.mouse.move(at.x, at.y);
    await expect(editor.locator(".workspace-breakpoint-hint")).toHaveCount(1);
    await page.screenshot({
      path: test.info().outputPath(`logic-gutter-hover-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    await page.mouse.move(at.x + 200, at.y);
    await expect(editor.locator(".workspace-breakpoint-hint")).toHaveCount(0);

    // The key list opened from LOGIC names its keys.
    await page.getByTestId("workspace-keys").click();
    const sheet = page.getByTestId("studio-key-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAccessibleName("LOGIC keys");
    await expect(sheet).toContainText("Keys work while the code has focus.");
    for (const key of ["F9", "F5", "F2", "F12"]) await expect(sheet).toContainText(key);
    for (const does of ["Set or clear a breakpoint", "Go to definition", "Find references"])
      await expect(sheet).toContainText(does);
    await page.screenshot({
      path: test.info().outputPath(`logic-keys-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // Clearing the breakpoint leaves the panel hint while the paused run stays inspectable.
    await editor.locator("textarea.inputarea").focus();
    await page.keyboard.press("ControlOrMeta+f");
    await page
      .getByRole("textbox", { name: "Find", exact: true })
      .fill("assignn(v50, clearing_pic)");
    await page.keyboard.press("Escape");
    await page.keyboard.press("F9");
    await expect(editor.locator(".workspace-breakpoint")).toHaveCount(1);
    await page.keyboard.press("F5");
    const header = page.locator(".workspace-context");
    await expect(header.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
    await page.getByTestId("part-debug:breakpoints").click();
    const panel = page.getByTestId("workspace-debug-panel").filter({ visible: true });
    await panel.getByRole("button", { name: "Remove breakpoint 1:3", exact: true }).click();
    await expect(panel).toContainText("Click left of a line number to stop there, or press F9.");
    await page.screenshot({
      path: test.info().outputPath(`logic-breakpoints-empty-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    // A breakpoint paused the run; once it continues, Variables and Call stack say how to stop it.
    await header.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(header.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
    await page.getByTestId("part-debug:variables").click();
    await expect(page.getByTestId("workspace-debug-panel").filter({ visible: true })).toContainText(
      "Click left of a line number to stop there",
    );
    await page.getByTestId("part-debug:stack").click();
    await expect(page.getByTestId("workspace-debug-panel").filter({ visible: true })).toContainText(
      "Click left of a line number to stop there",
    );
  });
