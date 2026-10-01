import type { Page } from "@playwright/test";
import { expect, test, reviewShot } from "./test.ts";
import {
  prepareIsolatedPage,
  seedLocalProject,
  openStudio,
  focusEditor,
} from "./logicDebugShared.ts";

async function modelText(page: Page, key: string): Promise<string> {
  return page.evaluate(async (wanted) => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const model = monaco.editor
      .getModels()
      .find((item) => item.uri.toString().endsWith(`/${encodeURIComponent(wanted)}`));
    if (!model) throw new Error(`Missing actual editor model ${wanted}`);
    return model.getValue();
  }, key);
}

for (const method of ["toolbar", "keyboard"] as const) {
  test(`a ${method} Undo restores every document in a guided command transaction @webkit-desktop`, async ({
    page,
  }) => {
    await prepareIsolatedPage(page);
    await page.goto("/");
    const title = `Coordinated undo ${method}`;
    await seedLocalProject(page, title);
    await page.reload();
    await openStudio(page, title);
    const tree = page.getByTestId("logic-explorer");
    await tree.getByTestId("logic-doc-words").click();
    const beforeWords = await modelText(page, "words");
    await tree.getByTestId("logic-doc-logic:1").click();
    const beforeLogic = await modelText(page, "logic:1");
    const guided = page.getByTestId("guided-actions");
    await guided.getByTestId("guided-respond-to-command").click();
    await guided.getByTestId("guided-respond-command").fill("wave hand");
    await guided.getByTestId("guided-respond-response").fill("You wave to the trees.");
    await guided.getByTestId("guided-prepare").click();
    await expect(guided.getByTestId("guided-preview")).toBeVisible();
    await guided.getByTestId("guided-apply").click();
    await expect(guided.getByTestId("guided-applied")).toBeVisible();
    expect(await modelText(page, "words")).not.toBe(beforeWords);
    expect(await modelText(page, "logic:1")).not.toBe(beforeLogic);
    if (method === "toolbar") await page.getByTestId("logic-undo").click();
    else {
      await focusEditor(page);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    }
    await reviewShot(page, `logic-coordinated-undo-${method}`);
    await expect.poll(() => modelText(page, "logic:1")).toBe(beforeLogic);
    await expect
      .poll(() => modelText(page, "words"), {
        message: "Undo must also restore the vocabulary changed by the same operation",
      })
      .toBe(beforeWords);
    await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  });
}
