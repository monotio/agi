import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import type { WorkerQueryFn } from "../src/worker/workerProtocol.ts";
import { textHook } from "./engineProbe.ts";
import { blockProviders, prepareIsolatedPage, seedLocalProject } from "./logicDebugShared.ts";
import { expect, reviewShot, test } from "./test.ts";
import {
  openStoredWorkspace,
  openWorkspaceLogic,
  replaceWorkspaceDocument,
  workspaceDocument,
} from "./workspaceShared.ts";

/** Same-worker updates preserve the progressed game and retain the last valid build. */
interface ProjectProbe {
  getSession(): ProjectSession;
  getWorker(): Worker;
  query: WorkerQueryFn;
}
async function state(page: Page) {
  return page.evaluate(() =>
    (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__.query("state"),
  );
}

test("Update game applies LOGIC while preserving play @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await seedLocalProject(page, "Live update preview");
  await page.reload();
  await openStoredWorkspace(page, "Live update preview");
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.locator(".play-area").evaluate((el: HTMLElement) => {
    el.tabIndex = -1;
    el.focus();
  });
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => (await state(page))?.egoX).toBeGreaterThan(80);
  await page.keyboard.up("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await state(page))?.egoDirection).toBe(0);
  await page.evaluate(() => {
    const probe = (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__;
    Object.assign(window, {
      __WORKSPACE_WORKER__: probe.getWorker(),
      __WORKSPACE_RUN__: probe.getSession().runToken,
    });
  });
  const progressed = await state(page);
  const cycle = (await textHook(page)).cycle;
  expect(progressed?.room).toBe(1);
  expect(progressed?.vars[42]).toBe(0);
  await openWorkspaceLogic(page);
  const source = await workspaceDocument(page, "logic:1");
  expect(source).not.toMatch(/return;\s*$/);
  const updated = `${source.trimEnd()}\nincrement(v42);\n`;
  expect(updated).not.toBe(source);
  await replaceWorkspaceDocument(page, "logic:1", updated, false);
  await page.getByTestId("workspace-update-menu").click();
  await expect(
    page.getByRole("menuitem", { name: "Update and keep playing", exact: true }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Update and keep playing", exact: true }).click();
  await expect.poll(async () => (await state(page))?.vars[42]).toBeGreaterThan(0);
  expect((await state(page))?.egoX).toBe(progressed?.egoX);
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);

  const generation = (await state(page))?.patchGeneration;
  await replaceWorkspaceDocument(page, "logic:1", "this is not logic\n", false);
  await expect(page.getByTestId("workspace-status-problems")).toBeVisible();
  await expect(page.locator(".workspace-build-error")).toBeHidden();
  await page.getByTestId("workspace-update").click();
  await expect(page.locator(".workspace-build-error")).toHaveText(
    "LOGIC 1 has errors. Fix them to update the game. Go to error",
  );
  const invalidCycle = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(invalidCycle);
  expect((await state(page))?.patchGeneration).toBe(generation);
  await replaceWorkspaceDocument(page, "logic:1", "assignn(v43, 5);\nreturn;\n", false);
  await page.getByTestId("workspace-update-menu").click();
  await expect(
    page.getByRole("menuitem", { name: "Update and keep playing", exact: true }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Update and keep playing", exact: true }).click();
  await expect(page.getByTestId("workspace-status-problems")).toBeHidden();
  await expect.poll(async () => (await state(page))?.vars[43]).toBe(5);
  expect(
    await page.evaluate(() => {
      const probe = (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__;
      const prior = window as unknown as {
        __WORKSPACE_WORKER__: Worker;
        __WORKSPACE_RUN__: string;
      };
      return {
        worker: probe.getWorker() === prior.__WORKSPACE_WORKER__,
        run: probe.getSession().runToken === prior.__WORKSPACE_RUN__,
      };
    }),
  ).toEqual({ worker: true, run: true });
  await reviewShot(page, "logic-main-live-update");
  expect(errors).toEqual([]);
  expect(providers.count()).toBe(0);
});
