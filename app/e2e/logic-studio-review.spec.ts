import type { Page } from "@playwright/test";
import { isolateStorage, workspaceSaved, workspaceUpdated } from "./engineProbe.ts";
import { expect, reviewShot, test } from "./test.ts";
import {
  focusWorkspaceLogic,
  openStoredWorkspace,
  openWorkspaceLogic,
  replaceWorkspaceDocument,
  workspaceDocument,
  workspaceDocumentEnd,
} from "./workspaceShared.ts";

async function seed(page: Page, title: string): Promise<string> {
  return page.evaluate(async (name) => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    const project = prepareLocalProject({ title: name, kind: "starter" });
    await project.save();
    return project.projectId;
  }, title);
}

async function edit(page: Page, title: string): Promise<void> {
  await openStoredWorkspace(page, title);
  await openWorkspaceLogic(page);
}

async function appendComment(page: Page): Promise<void> {
  await focusWorkspaceLogic(page);
  await workspaceDocumentEnd(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("// authored without a key");
  await expect.poll(() => workspaceDocument(page, "logic:1")).toContain("authored without a key");
  await workspaceSaved(page);
}

test("Update game saves an exact source-only edit and reopens it", async ({ page }) => {
  await isolateStorage(page);
  // These editor scenarios use local projects rather than the development
  // fixture shelf and its independent thumbnail fetches.
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  const projectId = await seed(page, "Source review");
  await page.reload();
  await edit(page, "Source review");
  await appendComment(page);
  await workspaceUpdated(page);
  await reviewShot(page, "logic-source-saved");
  const source = await page.evaluate(async (id) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const data = await loadAuthoredGame(id as never);
    const content = data?.workspace?.documents.find((doc) => doc.key === "logic:1")?.content;
    return content?.type === "text" ? content.text : null;
  }, projectId);
  expect(source).toMatch(/\n\/\/ authored without a key$/);
  await page.getByTestId("btn-exit").click();
  await edit(page, "Source review");
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(source);
  await focusWorkspaceLogic(page);
  await workspaceDocumentEnd(page);
  await expect(
    page.getByTestId("workspace-logic-editor").filter({ visible: true }).locator(".view-lines"),
  ).toContainText("authored without a key");
  await reviewShot(page, "logic-studio-source-reopened");
  expect(providerCalls).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("invalid LOGIC and another document both autosave and reopen", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  const id = await seed(page, "Selected changes");
  await page.reload();
  await edit(page, "Selected changes");
  const source = await workspaceDocument(page, "logic:1");
  const runningSource = await workspaceDocument(page, "logic:0");
  await replaceWorkspaceDocument(page, "logic:0", "if broken", false);
  await expect(page.getByTestId("workspace-last-good")).toBeVisible();
  await replaceWorkspaceDocument(
    page,
    "logic:1",
    source + "\n// saved beside broken source",
    false,
  );
  await workspaceSaved(page);
  const contents = await page.evaluate(async (id) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    return (await loadAuthoredGame(id as never))?.workspace?.documents;
  }, id);
  expect(contents?.find((doc) => doc.key === "logic:0")?.content).toEqual({
    type: "text",
    text: runningSource,
  });
  await page.reload();
  await openWorkspaceLogic(page, 0);
  await expect.poll(() => workspaceDocument(page, "logic:0")).toBe("if broken");
  await openWorkspaceLogic(page, 1);
  await expect
    .poll(() => workspaceDocument(page, "logic:1"))
    .toBe(source + "\n// saved beside broken source");
});
