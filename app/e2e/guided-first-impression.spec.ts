import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test, reviewShot } from "./test.ts";
import { isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";

/**
 * First-impression review of the no-key authoring path in Logic Studio:
 * a fresh Starter opens on its room's real source rather than LOGIC 0's
 * boot/menu boilerplate; a project whose logics include retained bytes keeps
 * the plain document order; the guided proposal's code review dialog carries
 * its own Back and the real Apply; and a Keep that leaves draft changes
 * behind says "Kept changes" beside the count still open.
 */

/**
 * Monaco's document-end keybinding is platform-mapped: Cmd+ArrowDown on
 * macOS, Ctrl+End on Windows and Linux.
 */
const DOCUMENT_END = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

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
      const prepared = prepareLocalProject({ title: name, kind: "blank" });
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
  const card = savedGameCard(page, title);
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  await expect(page.getByTestId("logic-studio")).toBeVisible();
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
}

/** Type one appended line into the visible document. */
async function appendLine(page: Page, text: string): Promise<void> {
  await page.getByTestId("logic-editor").locator(".view-lines").click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
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
  await expect(page.getByTestId("logic-tab-logic:1")).toHaveClass(/logic-studio__tab--active/);
  const viewLines = page.getByTestId("logic-editor").locator(".view-lines");
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

  // LOGIC 0 is byte-only here: the byte inspector opens on it, exactly the
  // honest fallback the document order always gave.
  await expect(page.getByTestId("logic-bytes")).toBeVisible();
  await expect(page.getByTestId("logic-tab-logic:0")).toHaveClass(/logic-studio__tab--active/);
});

test("the code review dialog carries Back and the real Apply @webkit-desktop", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedProject(page, "Review journey", "starter");
  await page.reload();
  await openStudio(page, "Review journey");
  const guided = page.getByTestId("guided-actions");
  const editor = page.getByTestId("logic-editor");

  // Prepare Add room, then open the code review with the keyboard.
  await guided.getByTestId("guided-add-room").click();
  await guided.getByTestId("guided-add-room-title").fill("Moonlit grove");
  await guided.getByTestId("guided-prepare").click();
  await expect(guided.getByTestId("guided-preview")).toBeVisible();
  const reviewButton = guided.getByTestId("guided-show-code");
  await reviewButton.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Proposed source" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Review the changes Apply will make to your draft.");
  await reviewShot(page, "first-impression-review-dialog");

  // Back leaves the proposal under review and returns focus to its button.
  await dialog.getByTestId("guided-code-back").click();
  await expect(dialog).toBeHidden();
  await expect(reviewButton).toBeFocused();
  await expect(guided.getByTestId("guided-preview")).toBeVisible();

  // Apply inside the dialog runs the same transaction as the card's Apply:
  // once, with the applied card taking over.
  await reviewButton.click();
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("guided-code-apply").focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  const applied = guided.getByTestId("guided-applied");
  await expect(applied).toBeVisible();
  await expect(applied).toBeFocused();
  await expect(guided.getByTestId("guided-show-code")).toHaveCount(0);
  await expect(page.getByTestId("logic-studio-status")).not.toContainText("No changes");

  // The write landed once: one new room document holds the new source.
  await applied.getByTestId("guided-open-logic:2").click();
  await expect(editor.locator(".view-lines")).toContainText("Moonlit grove");

  // A draft edit landing while the dialog is open turns the preview stale:
  // the dialog's Apply and the card's Apply share the same gate.
  await guided.getByTestId("guided-dismiss").click();
  await guided.getByTestId("guided-respond-to-command").click();
  await guided.getByTestId("guided-respond-command").fill("hum");
  await guided.getByTestId("guided-respond-response").fill("A low hum answers.");
  await guided.getByTestId("guided-prepare").click();
  await expect(guided.getByTestId("guided-preview")).toBeVisible();
  await guided.getByTestId("guided-show-code").click();
  await expect(dialog).toBeVisible();
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const model = monaco.editor
      .getModels()
      .find((entry) => entry.uri.toString().endsWith("/logic%3A2"));
    model?.setValue(`${model.getValue()}// typed while reviewing\n`);
  });
  await expect(dialog.getByTestId("guided-code-apply")).toBeDisabled();
  await expect(guided.getByTestId("guided-apply")).toBeDisabled();
  await dialog.getByTestId("guided-code-back").click();
  await expect(dialog).toBeHidden();
  await expect(guided.getByTestId("guided-preview-stale")).toBeVisible();
  await guided.getByTestId("guided-cancel").click();
});

test("a Keep that leaves draft changes says Kept changes beside the count @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedProject(page, "Receipt wording", "blank");
  await page.reload();
  await openStudio(page, "Receipt wording");
  const status = page.getByTestId("logic-studio-status");
  const note = page.getByTestId("logic-saved-note");
  const explorer = page.getByTestId("logic-explorer");

  // Two edits in two documents: the room, then LOGIC 0.
  await explorer.getByTestId("logic-doc-logic:1").click();
  await appendLine(page, "// first receipt edit");
  await explorer.getByTestId("logic-doc-logic:0").click();
  await appendLine(page, "// second receipt edit");
  await expect(status).toContainText("2 changes");

  // Keep only the room's edit: one change stays draft and the receipt says
  // what it did instead of implying the library holds everything.
  await page.getByTestId("logic-review-build").click();
  const review = page.getByTestId("logic-review-dialog");
  await expect(review).toBeVisible();
  await review.getByTestId("logic-review-include-logic:0").getByRole("checkbox").uncheck();
  await page.getByTestId("logic-keep-confirm").click();
  await expect(status).toContainText("1 change");
  await expect(note).toContainText("Kept changes");
  await expect(note).not.toContainText("Saved to the library");
  await expect(note).toHaveAttribute("title", /draft/);
  await reviewShot(page, "first-impression-kept-changes");

  // The receipt never outlives the state it described: new typing retires it.
  await appendLine(page, "// after the keep");
  await expect(note).toHaveCount(0);

  // Keeping the rest restores the full receipt.
  await page.getByTestId("logic-review-build").click();
  await expect(review).toBeVisible();
  await page.getByTestId("logic-keep-confirm").click();
  await expect(note).toContainText("Saved to the library");
  await expect(status).toContainText("No changes");
});
