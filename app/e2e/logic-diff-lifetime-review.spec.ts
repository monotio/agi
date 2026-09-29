import { expect, test } from "@playwright/test";
import { isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";

test("closing a build review cancels every diff view model before disposing its text", async ({
  page,
}) => {
  await isolateStorage(page);
  // This source-lifetime scenario uses a local blank project. Keep the
  // development fixture shelf out of its unrelated thumbnail requests.
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.evaluate(async () => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    await prepareLocalProject({ title: "Diff lifetime", kind: "blank" }).save();
  });
  await page.reload();
  await openLibraryActions(page, savedGameCard(page, "Diff lifetime"));
  await page.getByTestId("edit-library-game").click();
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1").click();
  const probe = await page.evaluateHandle(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const state = { created: 0, disposed: 0, textBeforeCancellation: 0 };
    const create = monaco.editor.createDiffEditor;
    monaco.editor.createDiffEditor = (...args: Parameters<typeof create>) => {
      const editor = create(...args);
      const createViewModel = editor.createViewModel.bind(editor);
      editor.createViewModel = (...modelArgs: Parameters<typeof createViewModel>) => {
        const viewModel = createViewModel(...modelArgs);
        state.created++;
        let disposed = false;
        const dispose = viewModel.dispose.bind(viewModel);
        viewModel.dispose = () => {
          if (!disposed) state.disposed++;
          disposed = true;
          dispose();
        };
        for (const model of [viewModel.model.original, viewModel.model.modified]) {
          model.onWillDispose(() => {
            if (!disposed) state.textBeforeCancellation++;
          });
        }
        return viewModel;
      };
      return editor;
    };
    return state;
  });
  await page.getByTestId("logic-editor").locator(".view-lines").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("// retained only after review");
  await page.getByTestId("logic-review-build").click();
  await expect.poll(() => probe.evaluate((state) => state.created)).toBeGreaterThan(0);
  await page.getByTestId("logic-keep-confirm").click();
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  await page.getByTestId("logic-close").click();
  const final = await probe.jsonValue();
  expect(final.disposed).toBe(final.created);
  expect(final.textBeforeCancellation).toBe(0);
  expect(errors).toEqual([]);
});
