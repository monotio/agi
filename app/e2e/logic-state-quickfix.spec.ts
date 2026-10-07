import { prepareIsolatedPage, seedLocalProject } from "./logicDebugShared.ts";
import { workspaceSaved } from "./engineProbe.ts";
import {
  openStoredWorkspace,
  replaceWorkspaceDocument,
  workspaceDocument,
} from "./workspaceShared.ts";
import { expect, reviewShot, test } from "./test.ts";

test("LOGIC quick fix creates a Game state flag and one Undo removes it @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareIsolatedPage(page);
  await page.goto("/");
  await seedLocalProject(page, "Flag quick fix");
  await page.reload();
  await openStoredWorkspace(page, "Flag quick fix");
  const source = "sound(255, scary_sound_off); return;";
  await replaceWorkspaceDocument(page, "logic:1", source, false);
  const before = await workspaceDocument(page, "bindings");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
        return monaco.editor
          .getModelMarkers({})
          .filter((marker) => marker.message.includes("scary_sound_off"))
          .map((marker) => ({
            message: marker.message,
            operand: monaco.editor.getModel(marker.resource)!.getValueInRange(marker),
            startLineNumber: marker.startLineNumber,
            startColumn: marker.startColumn,
            endLineNumber: marker.endLineNumber,
            endColumn: marker.endColumn,
          }));
      }),
    )
    .toEqual([
      {
        message: "1:12: No flag is named scary_sound_off.",
        operand: "scary_sound_off",
        startLineNumber: 1,
        startColumn: 12,
        endLineNumber: 1,
        endColumn: 27,
      },
    ]);
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor
      .getEditors()
      .find(
        (editor) =>
          editor.getModel()?.uri.scheme === "agi-workspace" && editor.getDomNode()?.offsetParent,
      )!;
    editor.setPosition({ lineNumber: 1, column: 17 });
    editor.focus();
    editor.trigger("spec", "editor.action.quickFix", {});
  });
  const create = page.getByText("Create flag scary_sound_off (Flag 17)", { exact: true });
  await expect(create).toBeVisible();
  await expect(page.getByText("Define as a constant in this file…", { exact: true })).toBeVisible();
  await reviewShot(page, "logic-create-flag-action");
  await create.click();
  await expect
    .poll(async () => JSON.parse(await workspaceDocument(page, "bindings")).scary_sound_off)
    .toEqual({ kind: "flag", num: 17 });
  await workspaceSaved(page);
  expect(await workspaceDocument(page, "logic:1")).toBe(source);
  await page.getByTestId("part-state").click();
  const row = page
    .getByTestId("workspace-state")
    .locator("tr")
    .filter({ hasText: "scary_sound_off" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Flag 17");
  await reviewShot(page, "logic-created-game-state-flag");
  await page.getByTestId("workspace-undo").click();
  await expect(row).toHaveCount(0);
  await expect.poll(() => workspaceDocument(page, "bindings")).toBe(before);
  expect(await workspaceDocument(page, "logic:1")).toBe(source);
});
