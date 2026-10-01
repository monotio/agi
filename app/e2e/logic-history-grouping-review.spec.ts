import type { Page } from "@playwright/test";
import { expect, test, reviewShot } from "./test.ts";
import {
  prepareIsolatedPage,
  seedLocalProject,
  openStudio,
  focusEditor,
} from "./logicDebugShared.ts";

async function text(page: Page, key: string): Promise<string> {
  return page.evaluate(async (wanted) => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const model = monaco.editor
      .getModels()
      .find((item) => item.uri.toString().endsWith(`/${encodeURIComponent(wanted)}`));
    if (!model) throw new Error(`Missing model ${wanted}`);
    return model.getValue();
  }, key);
}

async function appendNativeGroup(page: Page, chunks: readonly string[]): Promise<void> {
  await page.evaluate(async (parts) => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const model = monaco.editor
      .getModels()
      .find((item) => item.uri.toString().endsWith("/logic%3A1"));
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

test("grouped typing and a coordinated operation undo and redo as complete steps @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  await page.goto("/");
  const title = "Grouped project history";
  await seedLocalProject(page, title);
  await page.reload();
  await openStudio(page, title);
  const tree = page.getByTestId("logic-explorer");
  await tree.getByTestId("logic-doc-words").click();
  const beforeWords = await text(page, "words");
  await tree.getByTestId("logic-doc-logic:1").click();
  const before = await text(page, "logic:1");
  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await appendNativeGroup(page, ["\n// First", " typing group"]);
  const first = await text(page, "logic:1");
  await appendNativeGroup(page, ["\n// Second", " typing group"]);
  const second = await text(page, "logic:1");
  expect(first).not.toBe(before);
  expect(second).not.toBe(first);

  const guided = page.getByTestId("guided-actions");
  await guided.getByTestId("guided-respond-to-command").click();
  await guided.getByTestId("guided-respond-command").fill("wave hand");
  await guided.getByTestId("guided-respond-response").fill("You wave to the trees.");
  await guided.getByTestId("guided-prepare").click();
  await expect(guided.getByTestId("guided-preview")).toBeVisible();
  await guided.getByTestId("guided-apply").click();
  await expect(guided.getByTestId("guided-applied")).toBeVisible();
  const applied = await text(page, "logic:1");
  const appliedWords = await text(page, "words");
  expect(appliedWords).not.toBe(beforeWords);

  for (const expected of [second, first, before]) {
    await page.getByTestId("logic-undo").click();
    await expect.poll(() => text(page, "logic:1")).toBe(expected);
    await expect.poll(() => text(page, "words")).toBe(beforeWords);
  }
  for (const expected of [first, second, applied]) {
    await page.getByTestId("logic-redo").click();
    await expect.poll(() => text(page, "logic:1")).toBe(expected);
  }
  await expect
    .poll(() => text(page, "words"), { message: "Redo restores the coordinated vocabulary" })
    .toBe(appliedWords);
  await expect(guided.getByTestId("guided-applied")).toBeVisible();
  await reviewShot(page, "logic-grouped-project-history");
});
