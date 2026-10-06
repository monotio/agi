import type { Page } from "@playwright/test";
import { workspaceSaved, workspaceUpdated } from "./engineProbe.ts";
import { prepareIsolatedPage, seedLocalProject } from "./logicDebugShared.ts";
import { expect, reviewShot, test } from "./test.ts";
import {
  addWorkspaceResponse,
  openStoredWorkspace,
  openWorkspaceLogic,
  workspaceDocument,
} from "./workspaceShared.ts";

async function appendNativeGroup(page: Page, chunks: readonly string[]): Promise<void> {
  await page.evaluate(async (parts) => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const model = monaco.editor.getModels().find((item) => item.uri.path === "/logic:1");
    if (!model) throw new Error("Missing LOGIC 1 model");
    model.pushStackElement();
    for (const part of parts) {
      const line = model.getLineCount();
      const column = model.getLineMaxColumn(line);
      model.pushEditOperations(
        null,
        [
          {
            range: new monaco.Range(line, column, line, column),
            text: part,
          },
        ],
        () => null,
      );
    }
    model.pushStackElement();
  }, chunks);
}

test("typing updates and a coordinated operation undo and redo as complete steps @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  await page.goto("/");
  const title = "Grouped project history";
  await seedLocalProject(page, title);
  await page.reload();
  await openStoredWorkspace(page, title);
  await openWorkspaceLogic(page);
  const beforeWords = await workspaceDocument(page, "words");
  const before = await workspaceDocument(page, "logic:1");
  await appendNativeGroup(page, ["\n// First", " typing group"]);
  await expect.poll(() => workspaceDocument(page, "logic:1")).toContain("First typing group");
  await workspaceUpdated(page);
  const first = await workspaceDocument(page, "logic:1");
  await appendNativeGroup(page, ["\n// Second", " typing group"]);
  await expect.poll(() => workspaceDocument(page, "logic:1")).toContain("Second typing group");
  await workspaceUpdated(page);
  const second = await workspaceDocument(page, "logic:1");
  expect(first).not.toBe(before);
  expect(second).not.toBe(first);

  await addWorkspaceResponse(page, "wave hand", "You wave to the trees.");
  const applied = await workspaceDocument(page, "logic:1");
  const appliedWords = await workspaceDocument(page, "words");
  expect(appliedWords).not.toBe(beforeWords);

  for (const expected of [second, first, before]) {
    await page.getByTestId("workspace-undo").click();
    await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(expected);
    await expect.poll(() => workspaceDocument(page, "words")).toBe(beforeWords);
  }
  for (const expected of [first, second, applied]) {
    await page.getByTestId("workspace-redo").click();
    await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(expected);
  }
  await expect
    .poll(() => workspaceDocument(page, "words"), {
      message: "Redo restores the coordinated vocabulary",
    })
    .toBe(appliedWords);
  await workspaceSaved(page);
  await reviewShot(page, "logic-grouped-project-history");
});
