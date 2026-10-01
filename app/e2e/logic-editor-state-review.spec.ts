import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { expect, reviewShot, test } from "./test.ts";
import { isolateStorage, observe, openLibraryActions, savedGameCard } from "./engineProbe.ts";

/**
 * Monaco's document-end keybinding is platform-mapped: Cmd+ArrowDown on
 * macOS, Ctrl+End on Windows and Linux.
 */
const DOCUMENT_END = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

/** The engine-side workspace codec, served by Vite's /@fs escape for seeding. */
const WORKSPACE_MODULE =
  "/@fs" + fileURLToPath(new URL("../../src/authoring/projectWorkspace.ts", import.meta.url));

interface LogicHook {
  open(projectId: string): void;
  cursor(): { line: number; column: number } | undefined;
}

function logicHook(page: Page) {
  return {
    open: (projectId: string) =>
      page.evaluate((id) => {
        const hook = (window as unknown as { __AGI_LOGIC__?: LogicHook }).__AGI_LOGIC__;
        if (!hook) throw new Error("Logic Studio dev hook is not installed");
        hook.open(id);
      }, projectId),
    cursor: () =>
      page.evaluate(() =>
        (window as unknown as { __AGI_LOGIC__?: LogicHook }).__AGI_LOGIC__?.cursor(),
      ),
  };
}

/** Seed a saved project through the same storage path "Create game" uses. */
async function seedLocalProject(page: Page, title: string): Promise<string> {
  const projectId = await page.evaluate(async (name) => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    const prepared = prepareLocalProject({ title: name, kind: "blank" });
    await prepared.save();
    return prepared.projectId as string;
  }, title);
  await page.waitForLoadState("networkidle");
  return projectId;
}

/**
 * Seed a project whose LOGIC 0 has no source claim: it opens in the byte
 * inspector, so one explorer listing carries a text document and a byte
 * document side by side.
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

/** The recovery records stored for one project, counted from IndexedDB. */
async function draftCount(page: Page, projectId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const { listProjectDrafts } = await import("/src/project/projectDrafts.ts");
    return (await listProjectDrafts(id as never)).length;
  }, projectId);
}

/** The live text of a kept editor model, visible or detached alike. */
async function modelValue(page: Page, key: string): Promise<string | undefined> {
  return page.evaluate(async (docKey) => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    return monaco.editor
      .getModels()
      .find((model) => model.uri.toString().endsWith(`/${encodeURIComponent(docKey)}`))
      ?.getValue();
  }, key);
}

async function openStudio(page: Page, title: string): Promise<Locator> {
  await openLibraryActions(page, savedGameCard(page, title));
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  const studio = page.getByTestId("logic-studio");
  await expect(studio).toBeVisible();
  return studio;
}

/**
 * Hold one project's serialized storage writes until the release runs, so a
 * real open can still be deferred when the studio goes away.
 */
async function holdProjectWrites(page: Page, projectId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const storage = await import("/src/project/gameStorage.ts");
    const gate = new Promise<void>((resolve) => {
      (window as { __AGI_REVIEW_GATE__?: () => void }).__AGI_REVIEW_GATE__ = resolve;
    });
    void storage.serializeWrite(id, () => gate);
  }, projectId);
}

async function releaseProjectWrites(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as { __AGI_REVIEW_GATE__?: () => void }).__AGI_REVIEW_GATE__?.(),
  );
}

/**
 * Delay only the draft transaction's completion acknowledgement for one
 * project: the real delete still commits, while the UI awaits it. This is the
 * same harness the clean-close race review uses.
 */
async function holdDraftTransaction(page: Page, projectId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const held = new WeakSet<IDBTransaction>();
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (key === `draft/${id}` && this.transaction.mode === "readwrite")
        held.add(this.transaction);
      return get.call(this, key);
    };
    const gate = new Promise<void>((resolve) => {
      (window as { __AGI_SETTLE_REVIEW_GATE__?: () => void }).__AGI_SETTLE_REVIEW_GATE__ = resolve;
    });
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete")!;
    const set = descriptor.set!;
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
      ...descriptor,
      set(callback: ((this: IDBTransaction, event: Event) => void) | null) {
        const transaction = this as IDBTransaction;
        if (callback === null || !held.has(transaction)) {
          set.call(transaction, callback);
          return;
        }
        set.call(transaction, (event: Event) => {
          void gate.then(() => callback.call(transaction, event));
        });
      },
    });
  }, projectId);
}

async function releaseDraftTransaction(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as { __AGI_SETTLE_REVIEW_GATE__?: () => void }).__AGI_SETTLE_REVIEW_GATE__?.(),
  );
}

/**
 * Monaco splits typed text into several undo stops; click until the draft
 * reads clean. Extra clicks on an empty undo stack are no-ops.
 */
async function undoAllToClean(page: Page, status: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.getByTestId("logic-undo").click();
        return status.textContent();
      },
      { timeout: 10_000 },
    )
    .toContain("No changes");
}

test("Undo and Redo stay on the visible document when a byte-only tab is active @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await seedMixedProject(page, "Byte tab guard");
  await page.reload();

  const studio = await openStudio(page, "Byte tab guard");
  const explorer = page.getByTestId("logic-explorer");
  const undo = page.getByTestId("logic-undo");
  const redo = page.getByTestId("logic-redo");
  const status = page.getByTestId("logic-studio-status");
  const editor = studio.getByTestId("logic-editor");

  // The project opens on LOGIC 0, a byte-only document: the byte inspector
  // shows and the toolbar commands have no text model to command.
  await expect(page.getByTestId("logic-bytes")).toBeVisible();
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();

  // Edit text A so its model holds one undoable change.
  await explorer.getByTestId("logic-doc-logic:1").click();
  await expect(editor.locator(".monaco-editor")).toBeVisible();
  await editor.locator(".view-lines").click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.type("// hidden undo target");
  await expect(status).toContainText("1 change");
  await expect(undo).toBeEnabled();
  const cursorA = await logicHook(page).cursor();

  // Switch to the byte document: Monaco detaches and both commands disable.
  await explorer.getByTestId("logic-doc-logic:0").click();
  await expect(page.getByTestId("logic-bytes")).toBeVisible();
  await expect(editor.locator(".monaco-editor")).toBeHidden();
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();
  await reviewShot(page, "editor-state-byte-tab");

  // Dispatching the guarded commands anyway must not reach A's hidden model.
  await undo.dispatchEvent("click");
  await redo.dispatchEvent("click");
  await expect.poll(() => modelValue(page, "logic:1")).toContain("hidden undo target");

  // Switching back restores A's own model: undo history and caret included.
  await explorer.getByTestId("logic-doc-logic:1").click();
  await expect(undo).toBeEnabled();
  expect(await logicHook(page).cursor()).toEqual(cursorA);
  await undoAllToClean(page, status);
  expect(await modelValue(page, "logic:1")).not.toContain("hidden undo target");
  await expect
    .poll(
      async () => {
        await redo.click();
        return modelValue(page, "logic:1");
      },
      { timeout: 10_000 },
    )
    .toContain("hidden undo target");
  await expect(status).toContainText("1 change");

  // Closing the active text tab while a byte tab remains uses the same guard.
  await page.getByTestId("logic-tab-close-logic:1").click();
  await expect(page.getByTestId("logic-bytes")).toBeVisible();
  await expect(undo).toBeDisabled();
  await undo.dispatchEvent("click");
  await expect.poll(() => modelValue(page, "logic:1")).toContain("hidden undo target");

  // Reopening A keeps the text and the per-model undo history intact.
  await explorer.getByTestId("logic-doc-logic:1").click();
  await expect(editor.locator(".view-lines")).toContainText("hidden undo target");
  await undoAllToClean(page, status);
  expect(pageErrors).toEqual([]);
});

test("a draft undone back to its saved contents retires the recovery offer @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Undone draft");
  await page.reload();

  const studio = await openStudio(page, "Undone draft");
  const status = page.getByTestId("logic-studio-status");
  const editor = studio.getByTestId("logic-editor");
  await expect(editor.locator(".monaco-editor")).toBeVisible();

  // Dirty the draft and let the debounced writer store a recovery record.
  await editor.locator(".view-lines").click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.type("// recovered later");
  await expect(status).toContainText("1 change");
  await expect.poll(() => draftCount(page, projectId)).toBe(1);

  // Undo back to the saved contents: the durable record is retired by the
  // persister's own clean write, serialized behind the dirty one.
  await undoAllToClean(page, status);
  await expect.poll(() => draftCount(page, projectId)).toBe(0);

  // Reopen: the retired record must not come back as a recovery offer.
  await page.getByTestId("logic-close").click();
  await expect(studio).toBeHidden();
  await openStudio(page, "Undone draft");
  await expect(status).toContainText("No changes");
  await expect(page.getByTestId("logic-recovery-dialog")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("an immediate clean close settles the recovery record before leaving @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Immediate close");
  await page.reload();

  const studio = await openStudio(page, "Immediate close");
  const status = page.getByTestId("logic-studio-status");
  const editor = studio.getByTestId("logic-editor");
  await expect(editor.locator(".monaco-editor")).toBeVisible();

  await editor.locator(".view-lines").click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.type("// closed over");
  await expect(status).toContainText("1 change");
  await expect.poll(() => draftCount(page, projectId)).toBe(1);

  // Undo, then close before the debounce would fire: the close itself must
  // settle the cleanup rather than cancelling the pending write over it.
  await undoAllToClean(page, status);
  await page.getByTestId("logic-close").click();
  await expect(studio).toBeHidden();
  await expect.poll(() => draftCount(page, projectId)).toBe(0);

  await openStudio(page, "Immediate close");
  await expect(status).toContainText("No changes");
  await expect(page.getByTestId("logic-recovery-dialog")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("typing during a clean project switch's settle re-arms the dirty guard @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const first = await seedLocalProject(page, "Switch settle base");
  const second = await seedLocalProject(page, "Switch settle target");
  await page.reload();

  await logicHook(page).open(first);
  const studio = page.getByTestId("logic-studio");
  const status = page.getByTestId("logic-studio-status");
  const editor = studio.getByTestId("logic-editor");
  await expect(studio.getByRole("heading", { name: "Switch settle base" })).toBeVisible();
  await expect(editor.locator(".monaco-editor")).toBeVisible();

  // Dirty the draft so its record exists, then hold the draft transaction
  // before undoing: the clean retire's delete is what the settle awaits.
  await editor.locator(".view-lines").click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.type("// first draft work");
  await expect(status).toContainText("1 change");
  await expect.poll(() => draftCount(page, first)).toBe(1);
  await holdDraftTransaction(page, first);
  await undoAllToClean(page, status);

  // The switch settles the outgoing record behind the held delete; typing
  // while it waits revokes the clean-switch decision.
  await logicHook(page).open(second);
  await editor.locator(".view-lines").click();
  await page.keyboard.type("// typed during the switch settle");
  await expect(editor.locator(".view-lines")).toContainText("typed during the switch settle");
  await releaseDraftTransaction(page);

  // Still the mounted project, with the ordinary dirty guard showing.
  await expect(studio.getByRole("heading", { name: "Switch settle base" })).toBeVisible();
  await expect(page.getByTestId("logic-leave-dialog")).toBeVisible();
  await expect(status).toContainText("1 change");
  await expect(editor.locator(".view-lines")).toContainText("typed during the switch settle");
  await reviewShot(page, "switch-settle-guard");
  expect(pageErrors).toEqual([]);
});

test("a Discard-approved switch with unchanged dirty state completes @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const first = await seedLocalProject(page, "Discard switch base");
  const second = await seedLocalProject(page, "Discard switch target");
  await page.reload();

  await logicHook(page).open(first);
  const studio = page.getByTestId("logic-studio");
  const status = page.getByTestId("logic-studio-status");
  const editor = studio.getByTestId("logic-editor");
  await expect(studio.getByRole("heading", { name: "Discard switch base" })).toBeVisible();
  await expect(editor.locator(".monaco-editor")).toBeVisible();

  await editor.locator(".view-lines").click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.type("// draft the user will discard");
  await expect(status).toContainText("1 change");

  // The guard asks once; approving Discard mounts the target — the same
  // unchanged dirty state must not re-arm the guard inside the open.
  await logicHook(page).open(second);
  const leave = page.getByTestId("logic-leave-dialog");
  await expect(leave).toBeVisible();
  await leave.getByTestId("logic-leave-discard").click();
  await expect(studio.getByRole("heading", { name: "Discard switch target" })).toBeVisible();
  await expect(leave).toBeHidden();
  await expect(status).toContainText("No changes");
  expect(pageErrors).toEqual([]);
});

test("closing while a project open is still deferred never mounts its workspace @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Deferred open");
  await page.reload();

  // Hold the project's storage queue, then ask the studio to open it: the
  // mount is real while the open stays in flight.
  await holdProjectWrites(page, projectId);
  await logicHook(page).open(projectId);
  const studio = page.getByTestId("logic-studio");
  await expect(studio).toBeVisible();
  await expect(page.getByTestId("logic-studio-status")).toContainText("Opening");

  await page.getByTestId("logic-close").click();
  await expect(studio).toBeHidden();
  await releaseProjectWrites(page);
  await observe(page, 10);

  // The deferred open resolves after the studio is gone: no editor model may
  // be installed, and nothing may dispose into a mounted workspace.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
        return monaco.editor.getModels().length;
      }),
    )
    .toBe(0);
  expect(pageErrors).toEqual([]);
});

test("a project switch requested during a deferred open still wins @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const first = await seedLocalProject(page, "Switch base");
  const second = await seedLocalProject(page, "Switch deferred");
  const winner = await seedLocalProject(page, "Switch winner");
  await page.reload();

  await logicHook(page).open(first);
  const studio = page.getByTestId("logic-studio");
  await expect(studio).toBeVisible();
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  await expect(studio.getByRole("heading", { name: "Switch base" })).toBeVisible();

  // Defer the second open, then point the request at a third project: when
  // the deferred open lands, the newer request — not the resolved one — wins.
  await holdProjectWrites(page, second);
  await logicHook(page).open(second);
  await logicHook(page).open(winner);
  await releaseProjectWrites(page);

  await expect(studio.getByRole("heading", { name: "Switch winner" })).toBeVisible();
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  expect(pageErrors).toEqual([]);
});
