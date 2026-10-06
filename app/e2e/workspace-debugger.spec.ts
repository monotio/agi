import { test, expect, reviewShot } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import type { Page, Locator } from "@playwright/test";
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await target.evaluateAll((rows) => rows.some((row) => row === document.activeElement)))
      return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Keyboard target could not be reached");
}
for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test(`MAIN keyboard debugger at ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    const loaded: string[] = [];
    page.on("request", (req) => loaded.push(req.url()));
    await isolateStorage(page);
    await page.goto("/#create-adventure");
    await tabTo(page, page.getByTestId("local-create-kind-starter"));
    await page.keyboard.press("Enter");
    await tabTo(page, page.getByRole("button", { name: "Start building", exact: true }));
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("parts-list")).toBeVisible();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await page.keyboard.press("ControlOrMeta+p");
    await page.keyboard.type("LOGIC 1");
    await page.keyboard.press("Enter");
    const editor = page.getByTestId("workspace-logic-editor");
    await expect(editor).toBeVisible();
    const source = await page.evaluate(
      () =>
        (
          window as unknown as {
            __AGI_PROJECT__: {
              getSession(): { model: { capture(): { read(key: string): { content: string } } } };
            };
          }
        ).__AGI_PROJECT__
          .getSession()
          .model.capture()
          .read("logic:1").content,
    );
    const look = source.split("\n").findIndex((line) => line.includes('said("look")'));
    const line = look + 1;
    expect(line).toBeGreaterThan(0);
    const before = (await textHook(page)).cycle;
    await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(before);
    expect(loaded.some((url) => /workspaceDebug|debugController/.test(url))).toBe(false);
    await tabTo(page, editor.getByRole("textbox", { name: "Editor content", exact: true }));
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+f");
    await page.keyboard.type('print("You stand');
    await page.keyboard.press("Escape");
    await page.keyboard.press("F9");
    await expect(editor.locator(".workspace-breakpoint")).toHaveCount(1);
    await page.keyboard.press("F5");
    await expect(page.locator(".workspace-context").getByTestId("debug-stop")).toBeEnabled();
    await expect(page.getByTestId("workspace-debug-status")).toBeVisible();
    await page.getByRole("button", { name: "Continue", exact: true }).first().click();
    await page.keyboard.press("Control+`");
    await page.keyboard.type("look");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("workspace-debug-status")).toHaveText(
      `Paused at LOGIC 1, line ${line}`,
    );
    // Monaco repeats this decoration for wrapped line fragments; one visible fragment proves the stop.
    await expect(editor.locator(".workspace-stopped-line").first()).toBeVisible();
    // The debugger's views open as workspace tabs from Parts.
    await page.getByTestId("part-debug:variables").click();
    await expect(page.getByRole("tab", { name: "Variables", exact: true })).toBeVisible();
    // Several debug views stay mounted; the open tab shows one.
    const panel = page.locator('[data-testid="workspace-debug-panel"]:visible');
    await expect(panel.getByRole("heading", { name: "Used here", exact: true })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Game", exact: true })).toBeVisible();
    await expect(panel.getByRole("spinbutton", { name: "v255", exact: true })).toHaveCount(0);
    await panel.getByText("All variables", { exact: true }).click();
    await expect(panel.getByRole("spinbutton", { name: "v255", exact: true })).toBeVisible();
    await panel.getByText("All variables", { exact: true }).click();
    const toolbar = page
      .locator(".workspace-context")
      .getByRole("group", { name: "Debug controls", exact: true });
    await expect(toolbar).toBeVisible();
    expect(
      await toolbar
        .getByRole("button")
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    ).toEqual(["Continue", "Step over (F10)", "Step into (F11)", "Step out (⇧F11)", "Stop (⇧F5)"]);
    await page.getByTestId("part-debug:watch").click();
    await expect(page.getByRole("tab", { name: "Watch", exact: true })).toBeVisible();
    await page.getByTestId("part-debug:stack").click();
    await expect(page.getByRole("tab", { name: "Call stack", exact: true })).toBeVisible();
    await page.getByTestId("project-tab-debug:variables").click();
    await panel.locator(".workspace-debug-content").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.keyboard.press("Control+`");
    await reviewShot(page, `debugger-${size.width}-breakpoint`);
    await page.keyboard.press("F10");
    await expect
      .poll(async () => (await textHook(page)).rows.join("\n"))
      .toContain("sunny clearing");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("workspace-debug-status")).toContainText("Paused");
    await page.keyboard.press("ControlOrMeta+j");
    await expect(page.getByTestId("workspace-problems")).toBeVisible();
    await expect(page.locator('[data-testid="workspace-debug-panel"]:visible')).toBeHidden();
    await page.keyboard.press("ControlOrMeta+j");
    await expect(page.locator('[data-testid="workspace-debug-panel"]:visible')).toBeVisible();
    await reviewShot(page, `debugger-${size.width}-step`);
    await page.keyboard.press("Shift+F5");
    await expect(page.getByTestId("workspace-debug-status")).toHaveCount(0);
    await page.keyboard.press("Enter");
    const resumed = (await textHook(page)).cycle;
    await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(resumed);
  });
}

test("stopped edits keep the running source, value edits and watches inspect MAIN", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("part-room:1:logic").click();
  const editor = page.getByTestId("workspace-logic-editor");
  await expect(editor).toBeVisible();
  const source = await page.evaluate(
    () =>
      (
        window as unknown as {
          __AGI_PROJECT__: {
            getSession(): { model: { capture(): { read(key: string): { content: string } } } };
          };
        }
      ).__AGI_PROJECT__
        .getSession()
        .model.capture()
        .read("logic:1").content,
  );
  await editor.getByRole("textbox", { name: "Editor content", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+f");
  await page.keyboard.type('print("You stand');
  await page.keyboard.press("Escape");
  await page.keyboard.press("F9");
  await expect(editor.locator(".workspace-breakpoint")).toHaveCount(1);
  // Gutter click removes and restores the same source breakpoint.
  await editor.locator(".workspace-breakpoint").click();
  await expect(editor.locator(".workspace-breakpoint")).toHaveCount(0);
  await page.keyboard.press("F9");
  await expect(editor.locator(".workspace-breakpoint")).toHaveCount(1);
  await page.keyboard.press("F5");
  await expect(page.locator(".workspace-context").getByTestId("debug-stop")).toBeEnabled();
  await expect(page.getByTestId("workspace-debug-status")).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).first().click();
  await page.keyboard.press("Control+`");
  await page.keyboard.type("look");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("workspace-debug-status")).toContainText("Paused at LOGIC 1");
  await page.getByTestId("part-debug:variables").click();
  await page.getByLabel("Find a value", { exact: true }).fill("v40");
  await page.getByRole("spinbutton", { name: "v40", exact: true }).fill("77");
  await page.getByRole("spinbutton", { name: "v40", exact: true }).press("Tab");
  await expect(page.getByRole("spinbutton", { name: "v40", exact: true })).toHaveValue("77");
  await page.getByLabel("Find a value", { exact: true }).fill("chime_done");
  const namedFlag = page.getByRole("checkbox", { name: /^f\d+ chime_done$/ });
  await namedFlag.check();
  await expect(namedFlag).toBeChecked();
  await page.getByTestId("part-debug:watch").click();
  await page.getByLabel("Watch expression", { exact: true }).fill("v40");
  await page.getByRole("button", { name: "Add watch", exact: true }).click();
  await expect(page.locator(".workspace-debug-row output")).toHaveText("77");
  await page.getByTestId("part-debug:stack").click();
  await expect(page.locator(".workspace-debug-frame")).toHaveCount(2);
  await expect(page.locator(".workspace-debug-frame").first()).toContainText("LOGIC 1");
  const token = await page.evaluate(
    () =>
      (
        window as unknown as { __AGI_PROJECT__: { getSession(): { runToken: string } } }
      ).__AGI_PROJECT__.getSession().runToken,
  );
  // The Call stack is its own tab: go back to LOGIC 1 to edit it.
  await page.getByTestId("project-tab-logic:1").click();
  await editor.getByRole("textbox", { name: "Editor content", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(
    source.replace("You stand in a sunny clearing.", "A blue flower grows in the clearing."),
  );
  await expect(
    page.getByRole("button", { name: "Show running source", exact: true }),
  ).toBeVisible();
  await expect(editor.locator(".workspace-stopped-line")).toHaveCount(0);
  await page.getByRole("button", { name: "Show running source", exact: true }).click();
  // Monaco repeats this decoration for wrapped line fragments; one visible fragment proves the stop.
  await expect(editor.locator(".workspace-stopped-line").first()).toBeVisible();
  await expect(
    editor.getByRole("textbox", { name: "Editor content", exact: true }),
  ).toHaveAttribute("readonly");
  await page.getByRole("button", { name: "Return to editing", exact: true }).click();
  await editor.getByRole("textbox", { name: "Editor content", exact: true }).focus();
  await page.keyboard.press("F5");
  await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("sunny clearing");
  await page.keyboard.press("Control+`");
  await page.keyboard.press("Enter");
  await page.getByTestId("workspace-update-menu").click();
  const keep = page.getByRole("menuitem", { name: "Update and keep playing", exact: true });
  await expect(keep).toBeVisible();
  await keep.click();
  await expect(page.getByTestId("workspace-pending")).toBeHidden();
  await expect(page.getByRole("button", { name: "Show running source", exact: true })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { __AGI_PROJECT__: { getSession(): { runToken: string } } }
        ).__AGI_PROJECT__.getSession().runToken,
    ),
  ).toBe(token);
  await page.keyboard.press("Control+`");
  await page.keyboard.type("look");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("workspace-debug-status")).toContainText("Paused at LOGIC 1");
  await page.keyboard.press("F10");
  await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("blue flower");
  await page.keyboard.press("Shift+F5");
});
