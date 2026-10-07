import type { Locator, Page } from "@playwright/test";
import { VOCABULARY } from "../../src/vocabulary.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import {
  enterCreateMode,
  openLibraryActions,
  savedGameCard,
  waitForGameInput,
  workspaceSaved,
  workspaceUpdated,
} from "./engineProbe.ts";
import { expect } from "./test.ts";

export async function focusWorkspaceGame(page: Page): Promise<void> {
  // Agent enables when the Create command adapter has registered its commands.
  const commands = page.getByTestId("workspace-agent");
  await expect(commands).toBeVisible();
  await expect(commands).toBeEnabled();
  await page.keyboard.press("Control+`");
  await waitForGameInput(page);
}

export async function openStoredWorkspace(page: Page, title: string): Promise<void> {
  await openLibraryActions(page, savedGameCard(page, title));
  await page.getByTestId("edit-library-game").click();
  await expect(page.getByRole("heading", { name: title, exact: true, level: 1 })).toBeVisible();
  await expect(page.getByTestId("input-line")).toBeEnabled();
  const parts = page.getByTestId("parts-list");
  if (page.viewportSize()!.width <= 600 && !(await parts.isVisible()))
    await page.getByTestId("workspace-parts").click();
  await expect(parts).toBeVisible();
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
  await expect(editor.locator('.monaco-editor[role="code"]')).toBeVisible({ timeout: 30_000 });
  return editor;
}

/** Map an AGI pixel after tool changes and font loading have settled the canvas. */
export async function clickPictureCell(studio: Locator, x: number, y: number): Promise<void> {
  const pane = studio.locator(".studio-pane").last();
  await expect(pane).toBeVisible();
  await pane.evaluate(() => document.fonts.ready);
  // Playwright observes stable geometry and scrolls the pane into view.
  await pane.click({ trial: true });
  const box = (await pane.boundingBox())!;
  await pane.click({
    position: { x: ((x + 0.5) * box.width) / 160, y: ((y + 0.5) * box.height) / 168 },
  });
}

export async function workspaceDocument(page: Page, key: string): Promise<string> {
  return page.evaluate((key) => {
    const probe = window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } };
    const content = probe.__AGI_PROJECT__.getSession().workingSnapshot().read(key)?.content;
    if (typeof content !== "string") throw new Error(`Missing text document ${key}`);
    return content;
  }, key);
}

export async function runningWorkspaceDocument(page: Page, key: string): Promise<string> {
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

/** Monaco selects its keyboard platform from the browser identity. */
export async function findWorkspaceLogic(page: Page, text: string): Promise<void> {
  await focusWorkspaceLogic(page);
  const mac = await page.evaluate(
    () =>
      navigator.userAgent.includes("Macintosh") ||
      (/iPad|iPhone/.test(navigator.userAgent) && navigator.maxTouchPoints > 0),
  );
  await page.keyboard.press(mac ? "Meta+f" : "Control+f");
  await page.getByRole("textbox", { name: "Find", exact: true }).fill(text);
  await page.keyboard.press("Escape");
}

/** Insert through Monaco's real input so braces and quotes remain verbatim. */
export async function replaceWorkspaceDocument(
  page: Page,
  key: string,
  text: string,
  update = true,
): Promise<void> {
  if (key.startsWith("logic:")) {
    await openWorkspaceLogic(page, Number(key.split(":")[1]));
    await focusWorkspaceLogic(page);
    // Monaco chooses its keyboard platform from the browser's user agent.
    const mac = await page.evaluate(() => navigator.userAgent.includes("Macintosh"));
    await page.keyboard.press(mac ? "Meta+a" : "Control+a");
    await page.evaluate(async (text) => {
      const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
      const editor = monaco.editor.getEditors().find((editor) => editor.hasTextFocus())!;
      editor.trigger("spec", "paste", { text });
    }, text);
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
    // Table edits retain existing entries and append the requested vocabulary/objects.
    for (const [index, row] of rows.entries()) {
      if ((await table.locator("tbody tr").count()) <= index) {
        await table.getByRole("button", { name: "+ Add", exact: true }).click();
        await workspaceSaved(page);
      }
      const name = table.locator("tbody tr").nth(index).getByRole("textbox");
      if ((await name.inputValue()) !== row[0]) {
        await name.fill(row[0]);
        await name.press("Tab");
        await workspaceSaved(page);
      }
      const entry = table.locator("tbody tr").nth(index);
      const value = entry.getByRole("combobox");
      if ((await value.inputValue()) !== String(row[1])) {
        const known = await value.locator(`option[value="${row[1]}"]`).count();
        await value.selectOption(known ? String(row[1]) : "other");
        if (!known) {
          const number = entry.getByRole("spinbutton");
          await number.fill(String(row[1]));
          await number.press("Tab");
        }
        await workspaceSaved(page);
      }
    }
  }
  if (update) await workspaceUpdated(page);
  await expect
    .poll(() => workspaceDocument(page, key))
    .toBe(key.startsWith("logic:") ? text : JSON.stringify(JSON.parse(text)));
  await workspaceSaved(page);
}

/** Room helpers live in Add; editor tools stay reachable through the priority overflow. */
export async function clickContextAction(page: Page, testId: string): Promise<void> {
  const edit = page.getByRole("button", { name: "Edit", exact: true });
  if (await edit.isVisible()) await edit.click();
  const action = page.getByTestId(testId);
  if (!(await action.isVisible()))
    await page
      .getByTestId(testId.startsWith("room-action-") ? "room-actions-menu" : "context-more-actions")
      .click();
  await action.click();
}

export async function addWorkspaceResponse(
  page: Page,
  command: string,
  response: string,
): Promise<void> {
  await clickContextAction(page, "room-action-response");
  const form = page.getByTestId("workspace-guided-form");
  await expect(form).toBeVisible();
  await form.getByLabel("When the player types…", { exact: true }).fill(command);
  await form.getByLabel("The game says…", { exact: true }).fill(response);
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form).toBeHidden();
  await workspaceUpdated(page);
}

/** Apply a guided operation through its workspace form and observe the changed documents. */
export async function addWorkspaceAction(
  page: Page,
  label: string,
  fields: Readonly<Record<string, string>>,
  changedKey: string,
): Promise<void> {
  const before = await workspaceDocument(page, changedKey);
  if (label === "Add a room") {
    await page.getByRole("button", { name: "Add a room", exact: true }).click();
    const input = page.getByTestId("room-rename-input");
    await expect(input).toBeVisible();
    const name = fields["Room name"];
    if (name !== undefined) await input.fill(name);
    await input.press("Enter");
    await expect.poll(() => workspaceDocument(page, changedKey)).not.toBe(before);
    await workspaceUpdated(page);
    return;
  }
  const testId = (
    {
      "Place hero": "room-action-place-hero",
      "Answer a sentence": "room-action-response",
      Door: "room-action-door",
      "Play a sound when…": "room-action-play-sound",
      "Sound when…": "room-action-play-sound",
    } as Record<string, string>
  )[label]!;
  await clickContextAction(page, testId);
  if (label === "Door") {
    // A door starts on the game; drive the form by exact numbers instead.
    const overlay = page.getByTestId("guided-placement");
    await expect(overlay).toBeVisible();
    await overlay.press("Escape");
    await expect(overlay).toBeHidden();
  }
  const form = page.getByTestId("workspace-guided-form");
  await expect(form).toBeVisible();
  if (
    Object.keys(fields).some((name) =>
      ["VIEW", "SOUND", "X", "Y", "Destination ROOM", "Right", "Bottom"].includes(name),
    )
  )
    await form.getByText("Exact numbers", { exact: true }).click();
  for (const [name, value] of Object.entries(fields))
    await form.getByLabel(name, { exact: true }).fill(value);
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => workspaceDocument(page, changedKey)).not.toBe(before);
  await workspaceUpdated(page);
}
