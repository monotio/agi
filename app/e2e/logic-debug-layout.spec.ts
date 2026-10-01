import { expect, test, reviewShot } from "./test.ts";
import {
  openLogicOne,
  openStudio,
  prepareIsolatedPage,
  seedLocalProject,
  startDebugRun,
} from "./logicDebugShared.ts";

test.use({ viewport: { width: 1440, height: 900 } });

test("the desktop workspace gives the editor a real share beside the test dock", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await seedLocalProject(page, "Desktop lab");
  await page.reload();
  await openStudio(page, "Desktop lab");
  const editor = await openLogicOne(page);
  const dock = await startDebugRun(page);
  const visibleEditorHeight = () =>
    editor.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(0, rect.top));
    });
  expect(await visibleEditorHeight(), "the editor should grow with the viewport").toBeGreaterThan(
    200,
  );
  await dock.getByTestId("debug-diff-toggle").click();
  await expect(page.getByTestId("debug-diff-view")).toBeVisible();
  expect(await visibleEditorHeight()).toBeGreaterThan(200);
  // The bounded dock keeps its controls in the pinned strip while its body
  // scrolls — execution and preview stay reachable without leaving the page.
  await expect(dock.getByTestId("debug-continue")).toBeVisible();
  await expect(dock.getByTestId("debug-game")).toBeAttached();
  await reviewShot(page, "debug-desktop-source-comparison");
  expect(errors).toEqual([]);
});
