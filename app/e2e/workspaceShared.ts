import type { Locator, Page } from "@playwright/test";
import { VOCABULARY } from "../../src/vocabulary.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import {
  enterCreateMode,
  openLibraryActions,
  savedGameCard,
  workspaceSaved,
} from "./engineProbe.ts";
import { expect } from "./test.ts";

export async function openStoredWorkspace(page: Page, title: string): Promise<void> {
  await openLibraryActions(page, savedGameCard(page, title));
  await page.getByTestId("edit-library-game").click();
  await expect(page.getByRole("heading", { name: title, exact: true, level: 1 })).toBeVisible();
  await expect(page.getByTestId("input-line")).toBeEnabled();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await workspaceSaved(page);
}

export async function openWorkspaceLogic(page: Page, num = 1): Promise<Locator> {
  await enterCreateMode(page);
  const show = page.getByTestId("workspace-show-game");
  if (await show.isVisible()) await show.click();
  await page
    .getByTestId(`part-room:${num}:logic`)
    .or(page.getByTestId(`part-logic:${num}`))
    .click();
  if (await show.isVisible()) await show.click();
  const editor = page.getByTestId("workspace-logic-editor").filter({ visible: true });
  await expect(editor.locator(".monaco-editor")).toBeVisible({ timeout: 30_000 });
  return editor;
}

export async function workspaceDocument(page: Page, key: string): Promise<string> {
  return page.evaluate((key) => {
    const probe = window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } };
    const content = probe.__AGI_PROJECT__.getSession().model.capture().read(key)?.content;
    if (typeof content !== "string") throw new Error(`Missing text document ${key}`);
    return content;
  }, key);
}

export async function storedDocument(
  page: Page,
  projectId: string,
  key: string,
): Promise<string | null> {
  return page.evaluate(
    async ({ projectId, key }) => {
      const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
      const data = await loadAuthoredGame(projectId as never);
      const content = data?.workspace?.documents.find((doc) => doc.key === key)?.content;
      return content?.type === "text" ? content.text : null;
    },
    { projectId, key },
  );
}

export async function workspaceDocumentEnd(page: Page): Promise<void> {
  const mac = await page.evaluate(() => /mac|iphone|ipad/i.test(navigator.platform));
  await page.keyboard.press(mac ? "Meta+ArrowDown" : "Control+End");
}

export async function focusWorkspaceLogic(page: Page): Promise<void> {
  await page
    .getByTestId("workspace-logic-editor")
    .filter({ visible: true })
    .locator("textarea.inputarea, .native-edit-context")
    .first()
    .focus();
}

/** Insert through Monaco's real input so braces and quotes remain verbatim. */
export async function replaceWorkspaceDocument(
  page: Page,
  key: string,
  text: string,
): Promise<void> {
  if (key.startsWith("logic:")) {
    await openWorkspaceLogic(page, Number(key.split(":")[1]));
    await focusWorkspaceLogic(page);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText(text);
    await page.keyboard.press("Escape");
  } else if (key === "words") {
    const show = page.getByTestId("workspace-show-game");
    if (await show.isVisible()) await show.click();
    await page.getByTestId("part-words").click();
    const editor = page.getByTestId("workspace-words-editor").filter({ visible: true });
    const desired = JSON.parse(text) as [string, number][];
    for (const [word, id] of desired) {
      const current = JSON.parse(await workspaceDocument(page, key)) as [string, number][];
      if (current.some(([entry, meaning]) => entry === word && meaning === id)) continue;
      const group = editor.locator(`[data-word-group="${id}"]`);
      if (!(await group.count())) {
        await editor
          .getByRole("button", { name: VOCABULARY.meaningButton.label, exact: true })
          .click();
        await expect(group).toBeVisible();
      }
      // The add field opens from the row's + chip, shown on hover.
      const input = group.locator("input.add-word");
      if (!(await input.isVisible())) {
        await group.hover();
        await group.getByRole("button", { name: VOCABULARY.addWord.label, exact: true }).click();
      }
      await input.fill(word);
      await input.press("Enter");
      await workspaceSaved(page);
    }
  } else {
    const show = page.getByTestId("workspace-show-game");
    if (await show.isVisible()) await show.click();
    await page.getByTestId(`part-${key}`).click();
    const table = page.getByTestId("workspace-table-editor").filter({ visible: true });
    const rows =
      key === "words"
        ? (JSON.parse(text) as [string, number][])
        : (JSON.parse(text) as { name: string; startingRoom: number }[]).map(
            (row) => [row.name, row.startingRoom] as const,
          );
    const first = VOCABULARY.objectColumn.label;
    const second = key === "words" ? "Group" : "Room";
    // Table edits retain existing entries and append the requested vocabulary/objects.
    for (const [index, row] of rows.entries()) {
      if ((await table.locator("tbody tr").count()) <= index) {
        await table.getByRole("button", { name: "+ Add", exact: true }).click();
        await workspaceSaved(page);
      }
      const name = table.getByLabel(`${first} ${index}`, { exact: true });
      if ((await name.inputValue()) !== row[0]) {
        await name.fill(row[0]);
        await name.press("Tab");
        await workspaceSaved(page);
      }
      const value = table.getByLabel(`${second} ${index}`, { exact: true });
      if ((await value.inputValue()) !== String(row[1])) {
        await value.fill(String(row[1]));
        await value.press("Tab");
        await workspaceSaved(page);
      }
    }
  }
  await expect
    .poll(() => workspaceDocument(page, key))
    .toBe(key.startsWith("logic:") ? text : JSON.stringify(JSON.parse(text)));
  await workspaceSaved(page);
}

export async function addWorkspaceResponse(
  page: Page,
  command: string,
  response: string,
): Promise<void> {
  await page.getByTestId("workspace-add").click();
  await page.getByRole("menuitem", { name: "Response", exact: true }).click();
  const form = page.getByTestId("workspace-guided-form");
  await form.getByLabel("Command", { exact: true }).fill(command);
  await form.getByLabel("Response", { exact: true }).fill(response);
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form).toBeHidden();
  await workspaceSaved(page);
}

/** Apply a guided operation through its workspace form and observe the changed documents. */
export async function addWorkspaceAction(
  page: Page,
  label: string,
  fields: Readonly<Record<string, string>>,
  changedKey: string,
): Promise<void> {
  const before = await workspaceDocument(page, changedKey);
  await page.getByTestId("workspace-add").click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  const form = page.getByTestId("workspace-guided-form");
  for (const [name, value] of Object.entries(fields))
    await form.getByLabel(name, { exact: true }).fill(value);
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => workspaceDocument(page, changedKey)).not.toBe(before);
  await workspaceSaved(page);
}
