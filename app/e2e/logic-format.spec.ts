import type { Page } from "@playwright/test";
import { test, expect } from "./test.ts";
import { isolateStorage, waitForRoom, workspaceSaved } from "./engineProbe.ts";
import { workspaceDocument } from "./workspaceShared.ts";

const MESSY = "if(f1){load.sound(2);v2=3;}else{return;}";
const FORMATTED = "if (f1) {\n  load.sound(2);\n  v2 = 3;\n} else {\n  return;\n}\n";
async function setSource(page: Page, text: string): Promise<void> {
  await page.evaluate(async (text) => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor.getEditors().find((editor) => editor.getDomNode()?.offsetParent)!;
    editor.getModel()!.setValue(text);
    editor.setPosition({ lineNumber: 1, column: text.length + 1 });
    editor.focus();
  }, text);
}
test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  await page.getByTestId("part-room:1:logic").click();
  await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
});
test("Format document from the menu is one Undo step @webkit-desktop", async ({ page }) => {
  await setSource(page, MESSY);
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    monaco.editor
      .getEditors()
      .find((editor) => editor.getDomNode()?.offsetParent)!
      .trigger("spec", "editor.action.showContextMenu", {});
  });
  await page.getByRole("menu").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(FORMATTED);
  await page.screenshot({ path: test.info().outputPath("logic-formatted.png") });
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(MESSY);
});
test("Shift Alt F formats and the palette offers Format document @webkit-desktop", async ({
  page,
}) => {
  await setSource(page, MESSY);
  await page.keyboard.press("Shift+Alt+f");
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(FORMATTED);
  await page.getByTestId("part-logic:0").click();
  await page.getByTestId("part-room:1:logic").click();
  await setSource(page, MESSY);
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByPlaceholder("Type a command").fill("Format document");
  await expect(page.getByRole("option", { name: /Format document/ })).toHaveCount(1);
  await page.getByRole("option", { name: /Format document/ }).click();
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(FORMATTED);
});
test("Enter indents a block and typing a close brace outdents @webkit-desktop", async ({
  page,
}) => {
  await setSource(page, "if (f1) {");
  await page.keyboard.press("Enter");
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe("if (f1) {\n  ");
  await page.keyboard.type("return;");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.keyboard.type("}");
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe("if (f1) {\n  return;\n}");
});
test("format on leaving is opt-in and closing a tab keeps the formatted draft @webkit-desktop", async ({
  page,
}) => {
  await setSource(page, MESSY);
  await workspaceSaved(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("switch", { name: /Format on leaving/ });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(MESSY);
  await toggle.click();
  await page.keyboard.press("Escape");
  await setSource(page, MESSY);
  await page.getByTestId("project-tab-close-logic:1").click();
  await page.getByTestId("part-room:1:logic").click();
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(FORMATTED);
  await workspaceSaved(page);
  await page.reload();
  await waitForRoom(page, 1, { coldBoot: true });
  await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(FORMATTED);
});
