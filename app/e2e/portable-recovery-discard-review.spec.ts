import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { isolateStorage, observe } from "./engineProbe.ts";

/**
 * Monaco's document-end keybinding is platform-mapped: Cmd+ArrowDown on
 * macOS, Ctrl+End on Windows and Linux.
 */
const DOCUMENT_END = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

/** The engine-side recovery codec, served by Vite's /@fs escape for seeding. */
const RECOVERY_MODULE =
  "/@fs" + fileURLToPath(new URL("../../src/authoring/projectRecovery.ts", import.meta.url));

function logicOpen(page: Page, projectId: string): Promise<void> {
  return page.evaluate((id) => {
    const hook = (window as unknown as { __AGI_LOGIC__?: { open(projectId: string): void } })
      .__AGI_LOGIC__;
    if (!hook) throw new Error("Logic Studio dev hook is not installed");
    hook.open(id);
  }, projectId);
}

/**
 * Seed a saved project whose body carries a portable recovery draft, through
 * the same storage path "Create game" and the archive importer use. `stale`
 * moves the draft's saved base off the current project so the dialog offers
 * it without a Restore.
 */
async function seedCarriedProject(
  page: Page,
  title: string,
  options?: { stale?: boolean },
): Promise<string> {
  const projectId = await page.evaluate(
    async ({ name, recoveryModule, stale }) => {
      const { prepareLocalProject } = await import("/src/project/localProject.ts");
      const prepared = prepareLocalProject({ title: name, kind: "blank" });
      await prepared.save();
      const storage = await import("/src/project/gameStorage.ts");
      const { recoveryBaseOf } = await import("/src/project/editableProject.ts");
      const { writeProjectRecovery } = await import(recoveryModule);
      const data = await storage.loadAuthoredGame(prepared.projectId);
      if (!data) throw new Error("seeded project did not persist");
      const base = recoveryBaseOf(data);
      data.recoveryDraft = writeProjectRecovery(
        stale ? { ...base, authoring: "0".repeat(64) } : base,
        {
          changes: [{ key: "logic:1", version: 1, content: "// carried work\nreturn;" }],
          groups: [],
        },
      );
      if (!(await storage.saveAuthoredGame(prepared.projectId, data)))
        throw new Error("the carried draft did not persist");
      return prepared.projectId as string;
    },
    { name: title, recoveryModule: RECOVERY_MODULE, stale: options?.stale === true },
  );
  await finishOpeningPreview(page);
  return projectId;
}

/**
 * The installed fixture card's opening preview is the home shelf's lazy
 * render: its fixture files are fetched one by one through the bounded
 * queue, so `networkidle` can settle inside that sequence. A deliberate
 * navigation must wait for the real thumbnail — WebKit reports a fetch cut
 * by reload as a pageerror — and for the rest of the queue to drain behind
 * it.
 */
async function finishOpeningPreview(page: Page): Promise<void> {
  const card = page.getByTestId("local-game-card-synthetic");
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByTestId("library-thumbnail")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("thumbnail-placeholder")).toHaveCount(0, { timeout: 30_000 });
}

/** The stored body's carried draft, read straight out of IndexedDB. */
async function carriedDraft(page: Page, projectId: string): Promise<unknown> {
  return page.evaluate(async (id) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    return (await loadAuthoredGame(id as never))?.recoveryDraft ?? null;
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

/**
 * Hold one project's serialized storage writes until released, so a Discard
 * stays in flight while the user dismisses the dialog and keeps typing.
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

test("a carried draft is discarded for good and the workspace keeps working @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const projectId = await seedCarriedProject(page, "Carried draft");
  await page.reload();

  await logicOpen(page, projectId);
  const studio = page.getByTestId("logic-studio");
  const status = page.getByTestId("logic-studio-status");
  const dialog = page.getByTestId("logic-recovery-dialog");
  const entry = page.getByTestId("logic-recovery-0");
  await expect(studio).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(entry).toContainText("Carried draft");
  await expect(entry).toContainText("Current");

  // The carried payload is an offer, not applied source.
  const editor = studio.getByTestId("logic-editor");
  await expect(editor.locator(".view-lines")).not.toContainText("carried work");

  await entry.getByTestId("logic-recovery-discard").click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => carriedDraft(page, projectId)).toBeNull();

  // An ordinary edit, build review and Keep work on the advanced baseline —
  // aimed at logic:1, the document the discarded draft had named.
  await page.getByTestId("logic-doc-logic:1").click();
  await editor.locator(".view-lines").click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.type("// kept after the discard");
  await expect(status).toContainText("1 change");
  await page.getByTestId("logic-review-build").click();
  const review = page.getByTestId("logic-review-dialog");
  await expect(review).toBeVisible();
  await review.getByTestId("logic-keep-confirm").click();
  await expect(review).toBeHidden();
  await expect(page.getByTestId("logic-saved-note")).toContainText("Saved to the library");
  await expect.poll(() => carriedDraft(page, projectId)).toBeNull();

  // Close and reopen: no recovery offer comes back, and the kept source is
  // the typed text — never the discarded payload.
  await page.getByTestId("logic-close").click();
  await expect(studio).toBeHidden();
  await logicOpen(page, projectId);
  await expect(studio).toBeVisible();
  await expect(page.getByTestId("logic-recovery-dialog")).toHaveCount(0);
  await page.getByTestId("logic-doc-logic:1").click();
  await expect(editor.locator(".view-lines")).toContainText("kept after the discard");
  await expect(editor.locator(".view-lines")).not.toContainText("carried work");
  expect(pageErrors).toEqual([]);
});

test("Open as saved and a dismissed dialog both keep the carried draft @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const projectId = await seedCarriedProject(page, "Keep the draft");
  await page.reload();

  await logicOpen(page, projectId);
  const studio = page.getByTestId("logic-studio");
  const dialog = page.getByTestId("logic-recovery-dialog");
  const entry = page.getByTestId("logic-recovery-0");
  await expect(dialog).toBeVisible();
  await expect(entry).toContainText("Carried draft");

  await dialog.getByTestId("logic-recovery-open").click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => carriedDraft(page, projectId)).not.toBeNull();

  // Closing and reopening offers the same carried draft again.
  await page.getByTestId("logic-close").click();
  await expect(studio).toBeHidden();
  await logicOpen(page, projectId);
  await expect(dialog).toBeVisible();
  await expect(entry).toContainText("Carried draft");
  expect(pageErrors).toEqual([]);
});

test("a stale carried draft discards explicitly without applying it @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const projectId = await seedCarriedProject(page, "Stale carried draft", { stale: true });
  await page.reload();

  await logicOpen(page, projectId);
  const studio = page.getByTestId("logic-studio");
  const dialog = page.getByTestId("logic-recovery-dialog");
  const entry = page.getByTestId("logic-recovery-0");
  await expect(dialog).toBeVisible();
  await expect(entry).toContainText("Carried draft");
  await expect(entry).toContainText("Stale");
  await expect(entry.getByTestId("logic-recovery-restore")).toHaveCount(0);

  await entry.getByTestId("logic-recovery-discard").click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => carriedDraft(page, projectId)).toBeNull();
  await expect(studio.getByTestId("logic-editor").locator(".view-lines")).not.toContainText(
    "carried work",
  );
  expect(pageErrors).toEqual([]);
});

test("dismissing the dialog and typing while a discard is pending loses nothing @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const projectId = await seedCarriedProject(page, "Discard while typing");
  await page.reload();

  await logicOpen(page, projectId);
  const studio = page.getByTestId("logic-studio");
  const status = page.getByTestId("logic-studio-status");
  const editor = studio.getByTestId("logic-editor");
  const dialog = page.getByTestId("logic-recovery-dialog");
  const entry = page.getByTestId("logic-recovery-0");
  await expect(dialog).toBeVisible();
  await expect(entry).toContainText("Carried draft");

  // The write queues behind the held storage lock; dismissal and typing
  // land on the same live workspace while it waits.
  await holdProjectWrites(page, projectId);
  await entry.getByTestId("logic-recovery-discard").click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByTestId("logic-doc-logic:1").click();
  await editor.locator(".view-lines").click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.type("// typed during the pending discard");
  await expect(status).toContainText("1 change");
  await releaseProjectWrites(page);
  await expect.poll(() => carriedDraft(page, projectId)).toBeNull();

  // Same workspace, same model: the text and its Undo history survived.
  await expect(editor.locator(".view-lines")).toContainText("typed during the pending discard");
  await expect
    .poll(
      async () => {
        await page.getByTestId("logic-undo").click();
        return status.textContent();
      },
      { timeout: 10_000 },
    )
    .toContain("No changes");
  await expect(editor.locator(".view-lines")).not.toContainText("typed during the pending discard");
  await observe(page, 10);
  expect(await modelValue(page, "logic:1")).not.toContain("carried work");
  expect(pageErrors).toEqual([]);
});
