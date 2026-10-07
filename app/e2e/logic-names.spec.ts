import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { prepareIsolatedPage, seedLocalProject } from "./logicDebugShared.ts";
import { openStoredWorkspace, openWorkspaceLogic, workspaceDocument } from "./workspaceShared.ts";
import { expect, test } from "./test.ts";
import { workspaceSaved } from "./engineProbe.ts";

async function positionFlag(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor
      .getEditors()
      .find(
        (editor) =>
          editor.getModel()?.uri.scheme === "agi-workspace" && editor.getDomNode()?.offsetParent,
      );
    const model = editor!.getModel()!;
    editor!.setPosition(model.getPositionAt(model.getValue().indexOf("f36") + 1));
    editor!.focus();
  });
}

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test(`numbered flag hover, inline naming and project Undo ${width} @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize(width === 390 ? { width: 1440, height: 900 } : { width, height });
    await prepareIsolatedPage(page);
    await page.goto("/");
    const projectId = await seedLocalProject(page, "Numbered names");
    await page.evaluate(
      async ({ projectId, workspaceModule }) => {
        const { loadAuthoredGame, saveAuthoredGame } = await import("/src/project/gameStorage.ts");
        const { readProjectWorkspace, writeProjectWorkspace } = await import(workspaceModule);
        const data = (await loadAuthoredGame(projectId as never))!;
        const docs = { ...readProjectWorkspace(data.workspace!) };
        docs["logic:1"] = "set(f36);\nif (isset(f36)) { reset(f36); }\nreturn;";
        docs["logic:2"] = "if (isset(f36)) { reset(f36); }\nreturn;";
        data.workspace = writeProjectWorkspace(docs);
        await saveAuthoredGame(projectId as never, data);
      },
      {
        projectId,
        workspaceModule:
          "/@fs" +
          fileURLToPath(new URL("../../src/authoring/projectWorkspace.ts", import.meta.url)),
      },
    );
    await page.reload();
    await openStoredWorkspace(page, "Numbered names");
    await openWorkspaceLogic(page);
    await page.setViewportSize({ width, height });
    await positionFlag(page);
    await page.evaluate(async () => {
      const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
      monaco.editor
        .getEditors()
        .find((editor) => editor.hasTextFocus())!
        .trigger("spec", "editor.action.showHover", {});
    });
    const hover = page.locator(".monaco-hover").filter({ visible: true });
    await expect(hover).toBeVisible();
    const hoverBox = await hover.boundingBox();
    const editorBox = await page
      .getByTestId("workspace-logic-editor")
      .filter({ visible: true })
      .boundingBox();
    expect(hoverBox!.y).toBeGreaterThanOrEqual(editorBox!.y);
    expect(hoverBox!.y + hoverBox!.height).toBeLessThanOrEqual(editorBox!.y + editorBox!.height);
    await page.screenshot({
      path: test.info().outputPath(`hover-${width}.png`),
      animations: "disabled",
    });
    await expect(hover).toContainText("Flag 36");
    await expect(hover).toContainText("Set (1): first_room · LOGIC 1 line 1");
    await expect(hover).toContainText("Checked (2): first_room · LOGIC 1 line 2; LOGIC 2 line 1");
    await expect(hover).toContainText("Rename…");
    await page.keyboard.press("Escape");
    await positionFlag(page);
    await page.keyboard.press("F2");
    const rename = page.locator(".rename-box input").filter({ visible: true });
    await expect(rename).toBeVisible();
    await rename.fill("gate_open");
    await page.screenshot({
      path: test.info().outputPath(`rename-${width}.png`),
      animations: "disabled",
    });
    await rename.press("Enter");
    await expect(rename).not.toBeVisible();
    await expect.poll(() => workspaceDocument(page, "logic:1")).toContain("set(gate_open)");
    await expect.poll(() => workspaceDocument(page, "logic:2")).toContain("isset(gate_open)");
    await expect.poll(() => workspaceDocument(page, "bindings")).toContain('"gate_open"');
    await workspaceSaved(page);
    const undo = page.getByTestId("workspace-undo");
    await expect(undo).toBeVisible();
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect.poll(() => workspaceDocument(page, "logic:1")).toContain("set(f36)");
    await expect.poll(() => workspaceDocument(page, "logic:2")).toContain("isset(f36)");
    expect(await workspaceDocument(page, "bindings")).not.toContain('"gate_open"');
  });
}
