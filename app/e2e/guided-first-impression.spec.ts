import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { isolateStorage } from "./engineProbe.ts";
import { expect, reviewShot, test } from "./test.ts";
import { openStoredWorkspace, openWorkspaceLogic } from "./workspaceShared.ts";

/** The engine-side workspace codec, served by Vite's /@fs escape for seeding. */
const WORKSPACE_MODULE =
  "/@fs" + fileURLToPath(new URL("../../src/authoring/projectWorkspace.ts", import.meta.url));

test.use({ viewport: { width: 1440, height: 900 } });

/** Seed a saved project through the same storage path "Create game" uses. */
async function seedProject(
  page: Page,
  title: string,
  kind: "blank" | "starter" = "starter",
): Promise<string> {
  const projectId = await page.evaluate(
    async ({ title, kind }) => {
      const { prepareLocalProject } = await import("/src/project/localProject.ts");
      const prepared = prepareLocalProject({ title, kind });
      await prepared.save();
      return prepared.projectId as string;
    },
    { title, kind },
  );
  await page.waitForLoadState("networkidle");
  return projectId;
}

/**
 * Seed a blank project whose LOGIC 0 has no source claim: retained native
 * bytes beside authored text, the smallest project that exercises the
 * first-open fallback.
 */
async function seedMixedProject(page: Page, title: string): Promise<string> {
  const projectId = await page.evaluate(
    async ({ name, workspaceModule }) => {
      const { prepareLocalProject } = await import("/src/project/localProject.ts");
      const prepared = prepareLocalProject({ title: name, kind: "starter" });
      await prepared.save();
      const storage = await import("/src/project/gameStorage.ts");
      const { readProjectWorkspace, writeProjectWorkspace } = await import(workspaceModule);
      const data = await storage.loadAuthoredGame(prepared.projectId);
      if (!data) throw new Error("seeded project did not persist");
      const documents = { ...readProjectWorkspace(data.workspace) };
      delete documents["logic:0"];
      data.workspace = writeProjectWorkspace(documents);
      await storage.saveAuthoredGame(prepared.projectId, data);
      return prepared.projectId as string;
    },
    { name: title, workspaceModule: WORKSPACE_MODULE },
  );
  await page.waitForLoadState("networkidle");
  return projectId;
}

/** The library card's Edit verb opens Logic Studio on the stored project. */
async function openStudio(page: Page, title: string): Promise<void> {
  await openStoredWorkspace(page, title);
  await openWorkspaceLogic(page);
}

test("a fresh Starter opens on its room's real source, not the LOGIC 0 boilerplate @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedProject(page, "First impression", "starter");
  await page.reload();
  await openStudio(page, "First impression");

  // LOGIC 1's authored room code is the first document, not the boot/menu
  // boilerplate — the tab and the editor agree.
  await expect(page.getByTestId("project-tab-logic:1")).toHaveAttribute("aria-selected", "true");
  const viewLines = page
    .getByTestId("workspace-logic-editor")
    .filter({ visible: true })
    .locator(".view-lines");
  await expect(viewLines).toContainText("sunny clearing");
  await expect(viewLines).not.toContainText("set.menu(");
  await reviewShot(page, "first-impression-room-source");
});

test("a project with retained LOGIC bytes keeps the plain first document @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedMixedProject(page, "Mixed bytes");
  await page.reload();
  await openStudio(page, "Mixed bytes");

  await openWorkspaceLogic(page, 0);
  await expect(page.getByTestId("project-tab-logic:0")).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByTestId("workspace-logic-editor").filter({ visible: true }).locator(".view-lines"),
  ).toContainText("#message");
});
