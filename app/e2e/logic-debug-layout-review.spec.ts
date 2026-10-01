import { expect, test, reviewShot } from "./test.ts";
import {
  focusEditor,
  openLogicOne,
  openStudio,
  prepareIsolatedPage,
  seedLocalProject,
  startDebugRun,
} from "./logicDebugShared.ts";

test.use({ viewport: { width: 1280, height: 720 } });

test("the laptop workspace keeps source editable beside the running test @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  let requests = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    requests++;
    return route.abort();
  });
  await page.goto("/");
  await seedLocalProject(page, "Laptop lab");
  await page.reload();
  await openStudio(page, "Laptop lab");
  const editor = await openLogicOne(page);
  const dock = await startDebugRun(page);
  const visibleEditorHeight = () =>
    editor.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(0, rect.top));
    });
  await reviewShot(page, "debug-laptop-source");
  expect(
    await visibleEditorHeight(),
    "the source editor needs space while testing",
  ).toBeGreaterThanOrEqual(160);
  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await page.keyboard.type("// Comparing a changed draft\n");
  await expect(dock.getByTestId("debug-stale")).toContainText("Draft changed");
  await dock.getByTestId("debug-diff-toggle").click();
  await expect(page.getByTestId("debug-diff-view")).toBeVisible();
  await reviewShot(page, "debug-laptop-source-comparison");
  expect(
    await visibleEditorHeight(),
    "source comparison must keep the editor usable",
  ).toBeGreaterThanOrEqual(160);
  expect(requests).toBe(0);
});
