import type { Page } from "@playwright/test";
import { workspaceSaved } from "./engineProbe.ts";
import { blockProviders, prepareIsolatedPage, seedLocalProject } from "./logicDebugShared.ts";
import { expect, reviewShot, test } from "./test.ts";
import {
  focusWorkspaceLogic,
  openStoredWorkspace,
  openWorkspaceLogic,
  workspaceDocument,
  workspaceDocumentEnd,
} from "./workspaceShared.ts";
async function cursor(page: Page) {
  return page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    return monaco.editor
      .getEditors()
      .find((editor) => editor.getModel()?.uri.path === "/logic:1")
      ?.getPosition();
  });
}

test("LOGIC to SOUND and back preserves autosaved source and caret @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  await page.goto("/");
  await seedLocalProject(page, "Sibling retained work");
  await page.reload();
  await openStoredWorkspace(page, "Sibling retained work");
  await openWorkspaceLogic(page);
  await focusWorkspaceLogic(page);
  await workspaceDocumentEnd(page);
  await page.keyboard.insertText("\n// source across sibling navigation");
  await page.keyboard.press("ArrowLeft");
  const caret = await cursor(page);
  await expect
    .poll(() => workspaceDocument(page, "logic:1"))
    .toContain("source across sibling navigation");
  await workspaceSaved(page);

  await page.getByTestId("part-sound:1").click();
  await expect(page.getByTestId("workspace-sound")).toBeVisible();
  await page.getByTestId("project-tab-logic:1").click();
  await expect(page.getByTestId("workspace-logic-editor").filter({ visible: true })).toBeVisible();
  expect(await workspaceDocument(page, "logic:1")).toContain("source across sibling navigation");
  expect(await cursor(page)).toEqual(caret);
  await reviewShot(page, "studio-sibling-retained-source");
  expect(providers.count()).toBe(0);
});
