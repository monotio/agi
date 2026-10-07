import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import {
  enterCreateMode,
  isolateStorage,
  openLibraryActions,
  savedGameCard,
  textHook,
  workspaceSaved,
  workspaceUpdated,
  savePlayProgress,
} from "./engineProbe.ts";
import { expect, reviewShot, test } from "./test.ts";
import {
  focusWorkspaceLogic,
  openStoredWorkspace,
  openWorkspaceLogic,
  replaceWorkspaceDocument,
  workspaceDocument,
  workspaceDocumentEnd,
} from "./workspaceShared.ts";

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

test("workspace binding rename updates closed LOGIC and names in one History edit", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedLocalProject(page, "Rename game", "starter");
  await page.reload();
  await openStoredWorkspace(page, "Rename game");
  await page.evaluate(async () => {
    const session = (
      window as unknown as {
        __AGI_PROJECT__: {
          getSession(): ProjectSession;
        };
      }
    ).__AGI_PROJECT__.getSession();
    const base = session.model.capture();
    const names = JSON.parse(base.read("bindings")!.content as string);
    names.shared_gate = { kind: "flag", num: 90 };
    await session.submit({
      proposal: session.model.propose(base, "Add shared name", [
        { key: "bindings", content: JSON.stringify(names) },
        ...[0, 1].map((num) => ({
          key: `logic:${num}`,
          content: `set(shared_gate);\n${base.read(`logic:${num}`)!.content as string}`,
        })),
      ]),
      label: "Add shared name",
      origin: "logic",
      author: "creator",
    });
  });
  await openWorkspaceLogic(page, 1);
  const before0 = await workspaceDocument(page, "logic:0");
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor
      .getEditors()
      .find((editor) => editor.getDomNode()?.closest('[data-testid="workspace-logic-editor"]'))!;
    editor.setPosition({ lineNumber: 1, column: 6 });
    editor.focus();
    editor.trigger("spec", "editor.action.rename", {});
  });
  const input = page.locator(".rename-box input");
  await expect(input).toBeVisible();
  await input.fill("shared_door");
  await input.press("Enter");
  await expect.poll(() => workspaceDocument(page, "logic:0")).toContain("set(shared_door)");
  expect(await workspaceDocument(page, "logic:1")).toContain("set(shared_door)");
  expect(JSON.parse(await workspaceDocument(page, "bindings")).shared_door).toEqual({
    kind: "flag",
    num: 90,
  });
  await workspaceUpdated(page);
  await page.evaluate(async () => {
    await (
      window as unknown as {
        __AGI_PROJECT__: {
          getSession(): ProjectSession;
        };
      }
    ).__AGI_PROJECT__
      .getSession()
      .undo();
  });
  expect(await workspaceDocument(page, "logic:0")).toBe(before0);
  expect(await workspaceDocument(page, "logic:1")).toContain("set(shared_gate)");
  expect(JSON.parse(await workspaceDocument(page, "bindings")).shared_gate).toEqual({
    kind: "flag",
    num: 90,
  });
});

test("library Edit opens LOGIC: completion, hover, definition, diagnostics and autosave reopen", async ({
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
  const studio = page.getByTestId("workspace-editor");
  await expect(studio).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await reviewShot(page, "logic-studio-open");

  // Every authored LOGIC is in the explorer, including LOGIC 0.
  const explorer = page.getByTestId("parts-list");
  await expect(explorer.getByTestId("part-logic:0")).toBeVisible();
  await expect(explorer.getByTestId("part-room:1:logic")).toBeVisible();

  // Open LOGIC 1: the real editor loads with the stored source.
  await explorer.getByTestId("part-room:1:logic").click();
  const editor = page.getByTestId("workspace-logic-editor").filter({ visible: true });
  await expect(editor.locator(".monaco-editor")).toBeVisible();
  // Monaco renders only the lines in view; assert on a line near the top.
  await expect(editor.locator(".view-lines")).toContainText("set.horizon");

  // Completion lists the game's vocabulary inside a said() string. The pairs
  // auto-close as they type; End plus a block finishes a valid statement.
  const originalSource = await workspaceDocument(page, "logic:1");
  await focusWorkspaceLogic(page);
  await workspaceDocumentEnd(page);
  await page.keyboard.insertText('\nif (said("lo');
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".suggest-widget")).toBeVisible();
  await expect(page.locator(".suggest-widget")).toContainText("look");
  await page.screenshot({ path: test.info().outputPath("completion-visible.png") });
  await page.keyboard.press("Escape");
  await replaceWorkspaceDocument(page, "logic:1", originalSource + '\nif (said("look")) {}\n');

  // Hover documentation answers through the analysis worker.
  await focusWorkspaceLogic(page);
  await page.keyboard.press(
    (await page.evaluate(() => /mac/i.test(navigator.platform))) ? "Meta+ArrowUp" : "Control+Home",
  );
  // Hover needs a real pointer move: park the cursor elsewhere first so
  // Monaco sees it arrive over the token.
  const hoverToken = editor.locator(".view-lines").getByText("set.view").first();
  await expect(hoverToken).toBeVisible();
  const hoverBox = (await hoverToken.boundingBox())!;
  await page.mouse.move(hoverBox.x - 60, hoverBox.y);
  await page.mouse.move(hoverBox.x + hoverBox.width / 2, hoverBox.y + hoverBox.height / 2, {
    steps: 4,
  });
  const hover = page.locator(".monaco-hover:not(.hidden)");
  await expect(hover).toBeVisible();
  await expect(hover).toContainText("set.view");
  await page.keyboard.press("Escape");

  // Go to definition on a goto jumps the caret to its label. Escape before
  // Enter so a live suggestion list cannot accept a completion mid-typing.
  await workspaceDocumentEnd(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("marker: return;");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.keyboard.type("goto marker;");
  await page.keyboard.press("Escape");
  await expect(editor.locator(".view-lines")).toContainText("goto marker;");
  await workspaceSaved(page);
  await editor.locator(".view-lines").getByText("marker").last().click();
  await page.keyboard.press("F12");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
        const editor = monaco.editor
          .getEditors()
          .find((editor) => editor.getDomNode()?.closest('[data-testid="workspace-logic-editor"]'));
        const position = editor?.getPosition();
        return position && editor?.getModel()?.getLineContent(position.lineNumber);
      }),
    )
    .toBe("marker: return;");

  // A broken line lands in Problems; Problems stays openable from the chip.
  await workspaceDocumentEnd(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("if broken");
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByTestId("workspace-problems")).toContainText("broken", {
    timeout: 15_000,
  });
  await reviewShot(page, "logic-studio-problems");

  // Problems is its own tab now; go back to LOGIC 1 to keep editing.
  await page.getByTestId("project-tab-logic:1").click();
  await focusWorkspaceLogic(page);
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await workspaceSaved(page);
  // Close the document tab; the draft survives the hidden tab.
  await page.getByTestId("project-tab-close-logic:1").click();
  await explorer.getByTestId("part-room:1:logic").click();
  await focusWorkspaceLogic(page);
  await workspaceDocumentEnd(page);
  await expect(editor.locator(".view-lines")).toContainText("said(");

  await focusWorkspaceLogic(page);
  await workspaceDocumentEnd(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("// still working");
  await expect.poll(() => workspaceDocument(page, "logic:1")).toContain("still working");
  await workspaceSaved(page);
  await savePlayProgress(page);
  await page.getByTestId("btn-exit").click();
  await openStoredWorkspace(page, "Edit me");
  await openWorkspaceLogic(page);
  await focusWorkspaceLogic(page);
  await workspaceDocumentEnd(page);
  await expect(editor.locator(".view-lines")).toContainText('if (said("');
  const stored = await storedDocument(page, projectId, "logic:1");
  expect(stored).toContain('if (said("');
  expect(providerCalls).toBe(0);
});

test("LOGIC beside a running game isolates editor typing", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedLocalProject(page, "Play then edit", "starter");
  await page.reload();
  await savedGameCard(page, "Play then edit")
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await enterCreateMode(page);
  await openWorkspaceLogic(page);
  const cycles = (await textHook(page)).cycle;
  await focusWorkspaceLogic(page);
  await workspaceDocumentEnd(page);
  await page.keyboard.insertText("\n// editor typing");
  await expect(page.getByTestId("input-line")).toHaveValue("");
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycles);
  await workspaceSaved(page);
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect(page.getByTestId("workspace-editor")).toBeHidden();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
});
