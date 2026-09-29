import type { Page } from "@playwright/test";
import { expect, test, reviewShot } from "./test.ts";
import {
  isolateStorage,
  observe,
  openLibraryActions,
  savedGameCard,
  textHook,
} from "./engineProbe.ts";

/**
 * Monaco's document-end keybinding is platform-mapped: Cmd+ArrowDown on
 * macOS, Ctrl+End on Windows and Linux (where Ctrl+ArrowDown scrolls
 * instead). These specs run the real shortcut of the browser's platform.
 */
const DOCUMENT_END = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

/** Seed a saved project through the same storage path "Create game" uses. */
async function seedLocalProject(
  page: Page,
  title: string,
  kind: "blank" | "starter" = "blank",
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

/** The stored project's exact source for one document key. */
async function storedDocument(page: Page, projectId: string, key: string) {
  return page.evaluate(
    async ({ projectId, key }) => {
      const storage = await import("/src/project/gameStorage.ts");
      const { inspectEditableProject } = await import("/src/project/projectWorkspaceSource.ts");
      const data = await storage.loadAuthoredGame(projectId as never);
      if (!data) return null;
      // Only provable text answers — a kept document that no longer compiles
      // to the stored bytes would be refused here, not returned.
      const document = inspectEditableProject(data).documents[key];
      return typeof document === "string" ? document : null;
    },
    { projectId, key },
  );
}

test("library Edit opens an offline Logic Studio: Monaco edit, review, Keep, reopen", async ({
  page,
}) => {
  await isolateStorage(page);
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Edit me", "starter");
  await page.reload();

  // The card's Game actions menu carries the Edit verb; no engine boots.
  const card = savedGameCard(page, "Edit me");
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  const studio = page.getByTestId("logic-studio");
  await expect(studio).toBeVisible();
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  await reviewShot(page, "logic-studio-open");

  // Every authored LOGIC is in the explorer, including LOGIC 0.
  const explorer = page.getByTestId("logic-explorer");
  await expect(explorer.getByTestId("logic-doc-logic:0")).toBeVisible();
  await expect(explorer.getByTestId("logic-doc-logic:1")).toBeVisible();

  // Open LOGIC 1: the real editor loads with the stored source.
  await explorer.getByTestId("logic-doc-logic:1").click();
  const editor = studio.getByTestId("logic-editor");
  await expect(editor.locator(".monaco-editor")).toBeVisible();
  await expect(editor.locator(".view-lines")).toContainText("sunny clearing");

  // Completion lists the game's vocabulary inside a said() string. The pairs
  // auto-close as they type; End plus a block finishes a valid statement.
  await editor.locator(".view-lines").click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.type('if (said("');
  await expect(page.locator(".suggest-widget")).toBeVisible();
  await expect(page.locator(".suggest-widget")).toContainText("look");
  await page.keyboard.press("Escape");
  await page.keyboard.type("look");
  await page.keyboard.press("End");
  await page.keyboard.type(" {}");

  // Hover documentation answers through the analysis worker.
  await editor.locator(".view-lines").getByText("set.view").first().click();
  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.press("ControlOrMeta+I");
  const hover = page.locator(".monaco-hover:not(.hidden)");
  await expect(hover).toBeVisible();
  await expect(hover).toContainText("set.view");
  await page.keyboard.press("Escape");

  // Go to definition on a goto jumps the caret to its label. Escape before
  // Enter so a live suggestion list cannot accept a completion mid-typing.
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.press("Enter");
  await page.keyboard.type("marker: return;");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.keyboard.type("goto marker;");
  await page.keyboard.press("Escape");
  await expect(editor.locator(".view-lines")).toContainText("goto marker;");
  await editor.locator(".view-lines").getByText("marker").last().click();
  await page.keyboard.press("F12");
  await expect
    .poll(async () => {
      const position = await page.evaluate(() =>
        (
          window as {
            __AGI_LOGIC__?: {
              open(projectId: string): void;
              cursor(): { line: number; column: number } | undefined;
            };
          }
        ).__AGI_LOGIC__?.cursor(),
      );
      return position?.line;
    })
    .toBe(
      await page.evaluate(async () => {
        const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
        const model = monaco.editor.getModels().find((m) => m.getValue().includes("marker:"));
        if (!model) return undefined;
        return (
          model
            .getValue()
            .split("\n")
            .findIndex((line) => line.startsWith("marker:")) + 1
        );
      }),
    );

  // A broken line lands in Problems; Problems stays openable from the chip.
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.press("Enter");
  await page.keyboard.type("if broken");
  await expect(page.getByTestId("logic-problems")).toContainText("broken", {
    timeout: 15_000,
  });
  await reviewShot(page, "logic-studio-problems");

  // Delete the broken line; the draft needs review before it can be kept.
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await page.getByTestId("logic-review-build").click();
  const review = page.getByTestId("logic-review-dialog");
  await expect(review).toBeVisible();
  await reviewShot(page, "logic-studio-review");

  // Keep stores the change; nothing claims a running game was updated.
  await review.getByTestId("logic-keep-confirm").click();
  await expect(page.getByTestId("logic-saved-note")).toContainText("Saved to the library");

  // Close the document tab; the draft survives the hidden tab.
  await page.getByTestId("logic-tab-close-logic:1").click();
  await explorer.getByTestId("logic-doc-logic:1").click();
  await expect(editor.locator(".view-lines")).toContainText("said(");

  // Closing the workspace with unkept typing asks first; Keep reviews first.
  await editor.locator(".view-lines").click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.press("Enter");
  await page.keyboard.type("// still working");
  await page.getByTestId("logic-close").click();
  await expect(page.getByTestId("logic-leave-dialog")).toBeVisible();
  await page.getByTestId("logic-leave-keep").click();
  await expect(page.getByTestId("logic-review-dialog")).toBeVisible();
  await page.getByTestId("logic-keep-confirm").click();
  await expect(studio).toBeHidden();

  // Reopen: the exact kept source is what the workspace shows.
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  await expect(studio).toBeVisible();
  await explorer.getByTestId("logic-doc-logic:1").click();
  await expect(editor.locator(".view-lines")).toContainText('if (said("');

  const stored = await storedDocument(page, projectId, "logic:1");
  expect(stored).toContain('if (said("');
  expect(providerCalls).toBe(0);
});

test("the build review focuses the changed document, not an unchanged closure entry", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedLocalProject(page, "Changed focus");
  await page.reload();
  const card = savedGameCard(page, "Changed focus");
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  const studio = page.getByTestId("logic-studio");
  await expect(studio).toBeVisible();
  const explorer = page.getByTestId("logic-explorer");
  await explorer.getByTestId("logic-doc-logic:1").click();
  const editor = studio.getByTestId("logic-editor");
  await editor.locator(".view-lines").click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.press("Enter");
  await page.keyboard.type("// review opens on the change");
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");
  await page.getByTestId("logic-review-build").click();
  const review = page.getByTestId("logic-review-dialog");
  await expect(review).toBeVisible();
  // No navigation click: the diff already shows the edited document while the
  // unchanged bindings pulled in by the closure stays listed but passive.
  await expect(review.getByTestId("logic-review-doc-logic:1")).toHaveClass(
    /logic-review__doc--active/,
  );
  await expect(
    review.getByTestId("logic-review-diff").locator(".modified .view-lines"),
  ).toContainText("review opens on the change");
  await expect(review.getByTestId("logic-review-doc-bindings")).toBeVisible();
});

test("Logic Studio over a running game pauses it and swallows its keys", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Play then edit", "blank");
  await page.reload();
  await savedGameCard(page, "Play then edit")
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(0);

  // The shell bridge opens the stored-project workspace over the run.
  await page.evaluate(
    (id) =>
      (
        window as {
          __AGI_LOGIC__?: {
            open(projectId: string): void;
            cursor(): { line: number; column: number } | undefined;
          };
        }
      ).__AGI_LOGIC__?.open(id),
    projectId,
  );
  const studio = page.getByTestId("logic-studio");
  await expect(studio).toBeVisible();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);

  // Typing into the editor never reaches the hidden game.
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
  const cyclesBefore = (await textHook(page)).cycle;
  const explorer = page.getByTestId("logic-explorer");
  await explorer.getByTestId("logic-doc-logic:1").click();
  const editor = studio.getByTestId("logic-editor");
  await editor.locator(".view-lines").click();
  await page.keyboard.type("// pause-proof\n");
  await observe(page, 30);
  expect((await textHook(page)).cycle).toBe(cyclesBefore);

  // Closing returns to the same running game, resumed.
  await page.getByTestId("logic-close").click();
  await page.getByTestId("logic-leave-discard").click();
  await expect(studio).toBeHidden();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
});

test("an interrupted workspace offers its draft back, restorable or discardable", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Recover me");
  await page.reload();

  // Open, type, leave without settling — the debounced save lands first.
  const card = savedGameCard(page, "Recover me");
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  const studio = page.getByTestId("logic-studio");
  await expect(studio).toBeVisible();
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1").click();
  const editor = studio.getByTestId("logic-editor");
  await editor.locator(".view-lines").click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.type("\n// unfinished work\n");
  await expect(page.getByTestId("logic-studio-status")).toContainText("change");
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const { listProjectDrafts } = await import("/src/project/projectDrafts.ts");
        return (await listProjectDrafts(id as never)).length;
      }, projectId),
    )
    .toBe(1);

  // Reload while dirty: the stored draft, not the kept bytes, carries the work.
  await page.reload();
  await openLibraryActions(page, savedGameCard(page, "Recover me"));
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  const recovery = page.getByTestId("logic-recovery-dialog");
  await expect(recovery).toBeVisible();
  await recovery.getByRole("button", { name: "Restore" }).click();
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1").click();
  await expect(editor.locator(".view-lines")).toContainText("unfinished work");
});
