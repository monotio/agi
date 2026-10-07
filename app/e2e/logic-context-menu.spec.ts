import { test, expect } from "./test.ts";
import { isolateStorage, waitForRoom, workspaceSaved } from "./engineProbe.ts";

test("the LOGIC editor's context menu draws above the workspace @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1063, height: 400 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  await page.getByTestId("part-room:1:logic").click();
  const editor = page.getByTestId("workspace-logic-editor");
  await expect(editor).toBeVisible();
  // In a short window the menu is taller than the editor and reaches up over the
  // tabs and the context row.
  const area = (await editor.boundingBox())!;
  await page.mouse.click(area.x + 120, area.y + area.height - 12, { button: "right" });
  const menu = page.locator(".monaco-menu").first();
  await expect(menu).toBeVisible();
  // The menu keeps the editor theme's opaque background wherever Monaco attaches it.
  expect(
    await page
      .locator(".monaco-menu-container .monaco-scrollable-element")
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");
  await expect(menu.getByRole("menuitem").locator(".action-label")).toHaveText([
    "Go to definition",
    "Find references",
    "Rename…",
    "Format document",
    "Cut",
    "Copy",
    "Paste",
  ]);
  await page.screenshot({ path: test.info().outputPath("logic-context-menu.png") });
  const box = (await menu.boundingBox())!;
  expect(box.y, "the menu reaches up over the tabs and the context row").toBeLessThan(area.y);
  for (const y of [box.y + 8, box.y + box.height / 2, box.y + box.height - 8]) {
    const inside = await page.evaluate(
      ([x, y]) => {
        const hit = document.elementFromPoint(x!, y!);
        // Monaco draws its menus in a shadow root, so hit testing stops at the host.
        return Boolean(hit?.closest(".shadow-root-host"));
      },
      [box.x + box.width / 2, y],
    );
    expect(inside, `the menu is topmost at y ${Math.round(y)}`).toBe(true);
  }
});

test("Find references opens the app uses list from the menu and keyboard @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  await page.getByTestId("part-room:1:logic").click();
  await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor.getEditors().find((editor) => editor.getDomNode()?.offsetParent)!;
    editor.getModel()!.setValue("increment(current_room);\nmarker: return;\ngoto marker;");
  });
  await workspaceSaved(page);
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor.getEditors().find((editor) => editor.getDomNode()?.offsetParent)!;
    editor.setPosition({ lineNumber: 1, column: 12 });
    editor.focus();
    editor.trigger("spec", "editor.action.showContextMenu", {});
  });
  // Monaco arms mouse-up later to avoid accidental selection while opening.
  // Keyboard menu activation exercises the action without timing that delay.
  await page.getByRole("menu").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const details = page.getByTestId("binding-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText("current_room");
  await expect(page.getByTestId("project-tab-state")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("state-variable-0")).toBeFocused();
  await expect(page.locator(".peekview-widget")).toHaveCount(0);
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTestId("project-tab-logic:1").click();
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor.getEditors().find((editor) => editor.getDomNode()?.offsetParent)!;
    editor.setPosition({ lineNumber: 3, column: 7 });
    editor.focus();
  });
  await page.keyboard.press("Shift+F12");
  const references = page.getByRole("region", { name: "References", exact: true });
  await expect(references).toBeVisible();
  await expect(references.getByRole("button").filter({ hasText: /line/ })).toHaveText([
    "Used · first_room · LOGIC 1 · line 2",
    "Used · first_room · LOGIC 1 · line 3",
  ]);
  await expect(references.getByRole("button", { name: /line 3/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("logic-references.png") });
  await references.getByRole("button", { name: /line 3/ }).click();
  await expect(references).toBeHidden();
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor.getEditors().find((editor) => editor.getDomNode()?.offsetParent)!;
    editor.setPosition({ lineNumber: 3, column: 7 });
    editor.focus();
  });
  await page.keyboard.press("F12");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
        return monaco.editor
          .getEditors()
          .find((editor) => editor.hasTextFocus())
          ?.getPosition()?.lineNumber;
      }),
    )
    .toBe(2);
});

test("completion near the top of a short editor is drawn whole, and typing shows no build banner @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1063, height: 640 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  await page.getByTestId("part-room:1:logic").click();
  const editor = page.getByTestId("workspace-logic-editor");
  await expect(editor).toBeVisible();
  const area = (await editor.boundingBox())!;
  await page.mouse.click(area.x + 200, area.y + area.height - 12);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("set");
  const list = page.locator(".suggest-widget").first();
  await expect(list).toBeVisible();
  // Not paused: editing never shows the running-build note or moves the editor.
  await expect(page.getByRole("button", { name: "Show running source", exact: true })).toHaveCount(
    0,
  );
  expect((await editor.boundingBox())!.y).toBe(area.y);
  const box = (await list.boundingBox())!;
  for (const y of [box.y + 6, box.y + box.height - 6]) {
    const top = await page.evaluate(
      ([x, y]) => Boolean(document.elementFromPoint(x!, y!)?.closest(".suggest-widget")),
      [box.x + box.width / 2, y],
    );
    expect(top, `the completion list is topmost at y ${Math.round(y)}`).toBe(true);
  }
});
