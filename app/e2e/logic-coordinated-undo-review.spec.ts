import { workspaceSaved } from "./engineProbe.ts";
import { prepareIsolatedPage, seedLocalProject } from "./logicDebugShared.ts";
import { expect, reviewShot, test } from "./test.ts";
import {
  addWorkspaceResponse,
  focusWorkspaceLogic,
  openStoredWorkspace,
  openWorkspaceLogic,
  workspaceDocument,
} from "./workspaceShared.ts";

for (const method of ["toolbar", "keyboard"] as const) {
  test(`a ${method} Undo restores every document in a guided command transaction @webkit-desktop`, async ({
    page,
  }) => {
    await prepareIsolatedPage(page);
    await page.goto("/");
    const title = `Coordinated undo ${method}`;
    await seedLocalProject(page, title);
    await page.reload();
    await openStoredWorkspace(page, title);
    await openWorkspaceLogic(page);
    const beforeWords = await workspaceDocument(page, "words");
    const beforeLogic = await workspaceDocument(page, "logic:1");
    await addWorkspaceResponse(page, "wave hand", "You wave to the trees.");
    expect(await workspaceDocument(page, "words")).not.toBe(beforeWords);
    expect(await workspaceDocument(page, "logic:1")).not.toBe(beforeLogic);
    if (method === "toolbar") await page.getByTestId("workspace-undo").click();
    else {
      await focusWorkspaceLogic(page);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    }
    await reviewShot(page, `logic-coordinated-undo-${method}`);
    await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(beforeLogic);
    await expect
      .poll(() => workspaceDocument(page, "words"), {
        message: "Undo must also restore the vocabulary changed by the same operation",
      })
      .toBe(beforeWords);
    await workspaceSaved(page);
  });
}
