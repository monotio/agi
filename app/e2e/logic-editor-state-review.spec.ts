import type { Page } from "@playwright/test";
import { isolateStorage, openWorkspacePicture, workspaceSaved } from "./engineProbe.ts";
import { expect, reviewShot, test } from "./test.ts";
import {
  openStoredWorkspace,
  openWorkspaceLogic,
  replaceWorkspaceDocument,
  workspaceDocument,
} from "./workspaceShared.ts";

/** Seed a saved project through the same storage path "Create game" uses. */
async function seedLocalProject(page: Page, title: string): Promise<string> {
  const projectId = await page.evaluate(async (name) => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    const prepared = prepareLocalProject({ title: name, kind: "starter" });
    await prepared.save();
    return prepared.projectId as string;
  }, title);
  await page.waitForLoadState("networkidle");
  return projectId;
}

test("Undo and Redo traverse LOGIC edits while another resource is selected @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedLocalProject(page, "Byte tab guard");
  await page.reload();
  await openStoredWorkspace(page, "Byte tab guard");
  await openWorkspaceLogic(page);
  const original = await workspaceDocument(page, "logic:1");
  await replaceWorkspaceDocument(page, "logic:1", original + "\n// hidden undo target");
  await openWorkspacePicture(page, 1);
  await page.getByTestId("workspace-undo").click();
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(original);
  await workspaceSaved(page);
  await page.getByTestId("workspace-redo").click();
  await expect
    .poll(() => workspaceDocument(page, "logic:1"))
    .toBe(original + "\n// hidden undo target");
  await openWorkspaceLogic(page);
  await expect(
    page.getByTestId("workspace-logic-editor").filter({ visible: true }).locator(".view-lines"),
  ).toContainText("hidden undo target");
  await reviewShot(page, "editor-state-resource-tab");
});
