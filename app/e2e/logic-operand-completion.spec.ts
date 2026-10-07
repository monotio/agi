import { fileURLToPath } from "node:url";
import { prepareIsolatedPage, seedLocalProject } from "./logicDebugShared.ts";
import { openStoredWorkspace, openWorkspaceLogic } from "./workspaceShared.ts";
import { expect, reviewShot, test } from "./test.ts";

test("LOGIC completion offers SOUNDs then flags at the matching parameter @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Operand completion");
  await page.evaluate(
    async ({ projectId, workspaceModule }) => {
      const { loadAuthoredGame, saveAuthoredGame } = await import("/src/project/gameStorage.ts");
      const { readProjectWorkspace, writeProjectWorkspace } = await import(workspaceModule);
      const data = (await loadAuthoredGame(projectId as never))!;
      const docs = { ...readProjectWorkspace(data.workspace!) };
      docs["sound:1"] = docs["sound:255"]!;
      docs["sound:3"] = docs["sound:255"]!;
      docs["bindings"] = JSON.stringify({
        ...JSON.parse(docs["bindings"]!),
        chime_sound: { kind: "sound", num: 1 },
        is_alien_monster: { kind: "flag", num: 16 },
      });
      data.workspace = writeProjectWorkspace(docs);
      await saveAuthoredGame(projectId as never, data);
    },
    {
      projectId,
      workspaceModule:
        "/@fs" + fileURLToPath(new URL("../../src/authoring/projectWorkspace.ts", import.meta.url)),
    },
  );
  await page.reload();
  await openStoredWorkspace(page, "Operand completion");
  await openWorkspaceLogic(page);
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor
      .getEditors()
      .find(
        (editor) =>
          editor.getModel()?.uri.scheme === "agi-workspace" && editor.getDomNode()?.offsetParent,
      )!;
    editor.getModel()!.setValue("sound(");
    editor.setPosition({ lineNumber: 1, column: 7 });
    editor.focus();
    editor.trigger("spec", "editor.action.triggerSuggest", {});
  });
  const widget = page.locator(".suggest-widget.visible");
  await expect(widget).toBeVisible();
  const labels = widget.locator(".label-name");
  await expect(labels).toHaveText(["chime_sound · SOUND 1", "SOUND 3", "death_sound · SOUND 255"]);
  await reviewShot(page, "logic-sound-operand-completion");
  await labels.filter({ hasText: "chime_sound" }).dblclick();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
        return monaco.editor
          .getEditors()
          .find(
            (editor) =>
              editor.getModel()?.uri.scheme === "agi-workspace" &&
              editor.getDomNode()?.offsetParent,
          )!
          .getModel()!
          .getValue();
      }),
    )
    .toBe("sound(chime_sound");
  await page.keyboard.type(", is_");
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    monaco.editor
      .getEditors()
      .find((editor) => editor.hasTextFocus())!
      .trigger("spec", "editor.action.triggerSuggest", {});
  });
  await expect(widget).toBeVisible();
  await expect(labels.filter({ hasText: "is_alien_monster" })).toHaveCount(1);
  await expect(labels.filter({ hasText: "SOUND" })).toHaveCount(0);
});
