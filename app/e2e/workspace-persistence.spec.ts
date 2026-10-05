import { expect, test } from "./test.ts";
import { readFile } from "node:fs/promises";
import { openContainer } from "../../src/container/container.ts";
import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import {
  isolateStorage,
  openGameOptions,
  workspaceSaved,
  workspaceUpdated,
} from "./engineProbe.ts";
import {
  openStoredWorkspace,
  openWorkspaceLogic,
  focusWorkspaceLogic,
  workspaceDocument,
} from "./workspaceShared.ts";

async function downloadPendingEditsFromReadOnlyTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __AGI_STATE__: { staleTab: boolean } }).__AGI_STATE__.staleTab = true;
  });
  await page
    .getByTestId("stale-tab-note")
    .getByRole("button", { name: "Download unsaved edits", exact: true })
    .click();
}

async function starter(page: Page) {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Save boundaries");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  if (page.viewportSize()!.width <= 600) await page.getByTestId("workspace-parts").click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await workspaceSaved(page);
}

for (const successfulFirst of [false, true]) {
  test(`Exit retains a refused note and Retry saves it (prior success: ${successfulFirst})`, async ({
    page,
  }) => {
    await starter(page);
    await page.getByTestId("part-notes").click();
    const notes = page.getByLabel("Game notes", { exact: true });
    if (successfulFirst) {
      await notes.fill("first durable note");
      await workspaceSaved(page);
    }
    await page.evaluate(() => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const drafts = session.drafts();
      const flush = drafts.flush;
      let fail = true;
      drafts.flush = () => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error("Injected note draft write failure"));
        }
        return flush();
      };
    });
    await notes.fill("note kept after refusal");
    await openGameOptions(page, "settings-menu");
    await page.getByTestId("btn-exit").click();
    await expect(page.getByTestId("eject-refusal")).toContainText(
      "Injected note draft write failure",
    );
    await expect(page.getByTestId("parts-list")).toBeVisible();
    await expect(notes).toHaveValue("note kept after refusal");
    await expect(page.getByTestId("workspace-saved")).toHaveText("Could not save. Retry");
    await page.screenshot({ path: test.info().outputPath("failed-save.png") });
    await page.getByTestId("eject-retry").click();
    await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
    await openStoredWorkspace(page, "Save boundaries");
    await page.getByTestId("part-notes").click();
    await expect(notes).toHaveValue("note kept after refusal");
  });
}

test("Name this version saves the draft and names the running update", async ({ page }) => {
  await starter(page);
  await openWorkspaceLogic(page);
  await page.getByTestId("workspace-saved").click();
  const history = page.getByTestId("workspace-history");
  await history.getByLabel("Version name", { exact: true }).fill("Visible source");
  await focusWorkspaceLogic(page);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("invalid LOGIC !!!");
  // Submit within the same task as a fresh model edit, before the typing timer can fire.
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const model = monaco.editor
      .getModels()
      .find((model) => model.getValue() === "invalid LOGIC !!!")!;
    model.setValue("invalid LOGIC named now !!!");
    document
      .querySelector<HTMLFormElement>("[data-testid='workspace-history'] form")!
      .requestSubmit();
  });
  await expect(history.locator(".workspace-history__name")).toHaveText("Visible source");
  expect(await workspaceDocument(page, "logic:1")).toBe("invalid LOGIC named now !!!");
  const named = await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const state = session.history.capture();
    return { named: state.tags["Visible source"], cursor: state.cursor };
  });
  expect(named.named).toBe(named.cursor);
  await page.screenshot({ path: test.info().outputPath("named-invalid-source.png") });
});

for (const key of ["notes", "logic", "words", "sound"] as const) {
  for (const stage of ["draft storage", "worker admission"] as const) {
    test(`${key} draft downloads and restores before Update game when read-only (${stage})`, async ({
      page,
    }) => {
      await starter(page);
      if (key === "logic") {
        await openWorkspaceLogic(page);
        await focusWorkspaceLogic(page);
      } else await page.getByTestId(key === "sound" ? "part-sound:1" : `part-${key}`).click();
      if (key === "notes")
        await expect(page.getByLabel("Game notes", { exact: true })).toBeVisible();
      if (key === "sound") await expect(page.getByTestId("workspace-sound")).toBeVisible();
      if (key === "words") {
        await page
          .getByTestId("workspace-words-editor")
          .getByRole("button", { name: "+ Meaning", exact: true })
          .click();
      }
      const files =
        key === "sound"
          ? await page.evaluate(() => {
              const session = (
                window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
              ).__AGI_PROJECT__.getSession();
              return [...session.model.capture().lastAdmissibleBuild!.files()].map(
                ([name, bytes]) => [name, Array.from(bytes)] as const,
              );
            })
          : [];
      const originalSound =
        key === "sound"
          ? Array.from(
              openContainer(
                new Map(files.map(([name, bytes]) => [name, Uint8Array.from(bytes)])),
              ).getResource("sound", 1)!,
            )
          : [];
      if (key === "logic")
        await page.evaluate(async () => {
          const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
          const model = monaco.editor
            .getModels()
            .find((model) => model.uri.toString().includes("logic"))!;
          (window as unknown as { editImmediateLogic(): void }).editImmediateLogic = () =>
            model.setValue("invalid LOGIC immediate !!!");
        });
      if (stage === "worker admission") {
        await page.evaluate(() => {
          const probe = (
            window as unknown as {
              __AGI_PROJECT__: { getSession(): ProjectSession; getWorker(): Worker };
            }
          ).__AGI_PROJECT__;
          const worker = probe.getWorker();
          const post = worker.postMessage.bind(worker);
          worker.postMessage = (message: { type?: string }) => {
            if (message.type === "previewUpdate") {
              (window as unknown as { admissionHeld?: boolean }).admissionHeld = true;
              return;
            }
            post(message);
          };
          const session = probe.getSession();
          void session.submit({
            proposal: session.model.propose(session.model.capture(), "Held admission", [
              { key: "notes", content: "Admission held" },
            ]),
            label: "Held admission",
            origin: "logic",
            author: "creator",
          });
        });
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as { admissionHeld?: boolean }).admissionHeld),
          )
          .toBe(true);
      }
      await page.evaluate(
        ({ key, stage }) => {
          if (stage === "draft storage") {
            const put = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (...args) {
              if (String((args[0] as { projectId?: string }).projectId).startsWith("part-drafts/"))
                throw new Error("Draft storage refused");
              return put.apply(this, args);
            };
          }
          if (key === "logic") {
            (window as unknown as { editImmediateLogic(): void }).editImmediateLogic();
          } else if (key === "notes") {
            const textarea = document.querySelector<HTMLTextAreaElement>(".workspace-notes")!;
            textarea.value = "note from the edit event";
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
          } else if (key === "sound") {
            const tempo = document.querySelector<HTMLInputElement>(
              "[data-testid='workspace-sound'] input[aria-label='Tempo']",
            )!;
            tempo.value = "240";
            tempo.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            const input = document.querySelector<HTMLInputElement>(
              "[data-testid='workspace-words-editor'] input.add-word",
            )!;
            input.value = "instantword";
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          }
        },
        { key, stage },
      );
      await expect(page.getByTestId("workspace-pending")).toBeVisible();
      if (stage === "draft storage")
        await expect(page.getByTestId("workspace-saved")).toContainText("Could not save");
      const downloading = page.waitForEvent("download");
      await downloadPendingEditsFromReadOnlyTab(page);
      const downloaded = await downloading;
      expect(downloaded.suggestedFilename()).toBe("agi-unsaved-edits.zip");
      const bytes = await readFile((await downloaded.path())!);
      if (key === "logic") expect(bytes.toString()).toContain("invalid LOGIC immediate !!!");
      else if (key === "notes") {
        await expect(page.getByLabel("Game notes", { exact: true })).toHaveValue(
          "note from the edit event",
        );
        expect(bytes.toString()).toContain("note from the edit event");
      } else if (key === "words") expect(bytes.toString()).toContain("instantword");
      else {
        await expect(
          page.getByTestId("workspace-sound").getByLabel("Tempo", { exact: true }),
        ).toHaveValue("240");
        expect(bytes.toString()).toMatch(/"tempo"\s*:\s*240/);
        const name = "unsaved-edits/sound-1.bin";
        const nameAt = bytes.indexOf(name);
        expect(nameAt).toBeGreaterThanOrEqual(30);
        const length = bytes.readUInt32LE(nameAt - 30 + 18);
        expect([
          ...bytes.subarray(nameAt + name.length, nameAt + name.length + length),
        ]).not.toEqual(originalSound);
      }
      expect(
        await page.evaluate(() =>
          Object.keys(localStorage)
            .filter((key) => key.startsWith("monotio_agi.project-writes."))
            .map((key) => localStorage.getItem(key))
            .join("\n"),
        ),
      ).not.toContain("editorIntent");
      await page.reload();
      await expect(page.getByTestId("parts-list")).toBeVisible();
      await expect(page.getByTestId("pending-edit-recovery")).toHaveCount(0);
      await expect(page.getByTestId("workspace-pending")).toBeVisible();
      if (key === "logic")
        expect(await workspaceDocument(page, "logic:1")).toContain("invalid LOGIC immediate !!!");
      else if (key === "notes") {
        await page.getByTestId("part-notes").click();
        await expect(page.getByLabel("Game notes", { exact: true })).toHaveValue(
          "note from the edit event",
        );
      } else if (key === "words")
        expect(await workspaceDocument(page, "words")).toContain("instantword");
      else {
        await page.getByTestId("part-sound:1").click();
        await expect(
          page.getByTestId("workspace-sound").getByLabel("Tempo", { exact: true }),
        ).toHaveValue("240");
      }
    });
  }
}

test("Read-only unsaved edits keeps tempo metadata for both retained SOUND buffers", async ({
  page,
}) => {
  await starter(page);
  await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    session.submit = () => new Promise(() => {});
  });
  for (const [number, tempo] of [
    [1, 240],
    [255, 180],
  ]) {
    await page.getByTestId(`part-sound:${number}`).click();
    const field = page
      .getByTestId("workspace-sound")
      .filter({ visible: true })
      .getByLabel("Tempo", { exact: true });
    await field.fill(String(tempo));
    await field.dispatchEvent("change");
  }
  const downloading = page.waitForEvent("download");
  await downloadPendingEditsFromReadOnlyTab(page);
  const bytes = await readFile((await (await downloading).path())!);
  const name = "unsaved-edits/music.txt";
  const at = bytes.indexOf(name);
  expect(at).toBeGreaterThanOrEqual(30);
  const length = bytes.readUInt32LE(at - 30 + 18);
  const music = JSON.parse(bytes.subarray(at + name.length, at + name.length + length).toString());
  expect(music["1"].tempo).toBe(240);
  expect(music["255"].tempo).toBe(180);
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 1063, height: 815 },
  { width: 390, height: 844 },
]) {
  test(`a failed flush refuses a version name and Retry names the visible source at ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await starter(page);
    await openWorkspaceLogic(page);
    await page.getByTestId("workspace-saved").click();
    const history = page.getByTestId("workspace-history");
    await expect(history).toBeVisible();
    await history.getByLabel("Version name", { exact: true }).fill("Failed first");
    await page.evaluate(async () => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const drafts = session.drafts();
      const flush = drafts.flush;
      let fail = true;
      drafts.flush = () => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error("Injected LOGIC draft write failure"));
        }
        return flush();
      };
      const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
      monaco.editor
        .getModels()
        .find((model) => model.uri.toString().includes("logic"))!
        .setValue("invalid named draft !!!");
      document
        .querySelector<HTMLFormElement>("[data-testid='workspace-history'] form")!
        .requestSubmit();
    });
    const error = page.locator(".workspace-error[role=alert]");
    await expect(error).toBeVisible();
    await expect(error).toContainText("Injected LOGIC draft write failure");
    await expect(history.locator(".workspace-history__name")).toHaveCount(0);
    await expect(page.locator(".monaco-editor")).toBeVisible();
    await expect(page.locator(".monaco-editor")).toContainText("invalid named draft !!!");
    const retry = error.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`history-error-${size.width}.png`) });
    expect(
      await retry.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return top === button || button.contains(top);
      }),
    ).toBe(true);
    await history.getByRole("button", { name: "Close", exact: true }).click();
    await expect(history).toBeHidden();
    await expect(error).toBeVisible();
    await retry.click();
    await workspaceSaved(page);
    await page.getByTestId("workspace-saved").click();
    await expect(history).toBeVisible();
    await history.getByRole("button", { name: "Name this version", exact: true }).click();
    await expect(history.locator(".workspace-history__name")).toBeVisible();
    await expect(history.locator(".workspace-history__name")).toHaveText("Failed first");
    expect(await workspaceDocument(page, "logic:1")).toBe("invalid named draft !!!");
  });
}

test("Discard and exit retires a refused draft and keeps the previous durable note", async ({
  page,
}) => {
  await starter(page);
  await page.getByTestId("part-notes").click();
  const notes = page.getByLabel("Game notes", { exact: true });
  await notes.fill("previous durable note");
  await workspaceUpdated(page);
  await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    session.drafts().flush = () => Promise.reject(new Error("Injected refused draft"));
  });
  await notes.fill("deliberately discarded note");
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("eject-refusal")).toContainText("Injected refused draft");
  await page.getByTestId("eject-leave-anyway").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  await openStoredWorkspace(page, "Save boundaries");
  await page.getByTestId("part-notes").click();
  await expect(notes).toHaveValue("previous durable note");
});

test("Exit detaches LOGIC while code intelligence is pending @webkit-desktop", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await starter(page);
  await openWorkspaceLogic(page);
  await focusWorkspaceLogic(page);
  await workspaceSaved(page);
  await page.evaluate(async () => {
    const { monaco, LOGIC_LANGUAGE_ID } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor
      .getEditors()
      .find((editor) => editor.getModel()?.uri.scheme === "agi-workspace");
    if (!editor) throw new Error("The LOGIC editor is missing.");
    const state = { pending: 0, cancelled: 0, detached: 0 };
    Object.assign(window, { __pendingLogicExit: state });
    editor.onDidChangeModel(() => {
      if (!editor.getModel()) state.detached++;
    });
    monaco.languages.registerFoldingRangeProvider(LOGIC_LANGUAGE_ID, {
      provideFoldingRanges(_model, _context, token) {
        state.pending++;
        return new Promise<never[]>((resolve) => {
          token.onCancellationRequested(() => {
            state.cancelled++;
            resolve([]);
          });
        });
      },
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __pendingLogicExit: { pending: number } }).__pendingLogicExit
            .pending,
      ),
    )
    .toBeGreaterThan(0);
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
      return {
        ...(
          window as unknown as {
            __pendingLogicExit: { pending: number; cancelled: number; detached: number };
          }
        ).__pendingLogicExit,
        liveModels: monaco.editor
          .getModels()
          .filter((model) => model.uri.scheme === "agi-workspace").length,
      };
    }),
  ).toEqual({ pending: 1, cancelled: 1, detached: 1, liveModels: 0 });
  expect(errors).toEqual([]);
});
