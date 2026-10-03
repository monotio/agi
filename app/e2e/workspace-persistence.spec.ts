import { expect, test } from "./test.ts";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { isolateStorage, openGameOptions, workspaceSaved } from "./engineProbe.ts";
import {
  openStoredWorkspace,
  openWorkspaceLogic,
  focusWorkspaceLogic,
  workspaceDocument,
} from "./workspaceShared.ts";

async function starter(page: Page) {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Save boundaries");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
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
      const submit = session.submit;
      let fail = true;
      session.submit = (...args) => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error("Injected note admission failure"));
        }
        return submit(...args);
      };
    });
    await notes.fill("note kept after refusal");
    await openGameOptions(page, "settings-menu");
    await page.getByTestId("btn-exit").click();
    await expect(page.getByTestId("eject-refusal")).toContainText(
      "Injected note admission failure",
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

test("Name this version drains pending LOGIC and names visible invalid source", async ({
  page,
}) => {
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
  for (const stage of ["before submission", "worker admission"] as const) {
    test(`${key} stays visible and downloads before acceptance (${stage})`, async ({ page }) => {
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
      const originalSound =
        key === "sound"
          ? await page.evaluate(() => {
              const session = (
                window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
              ).__AGI_PROJECT__.getSession();
              return [...(session.model.capture().read("sound:1")!.content as Uint8Array)];
            })
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
          const session = (
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
          ).__AGI_PROJECT__.getSession();
          if (stage === "before submission") session.submit = () => new Promise(() => {});
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
      await expect(page.getByTestId("workspace-saved")).toContainText("Saving");
      const downloading = page.waitForEvent("download");
      await page.getByTestId("download-unsaved-edits").click();
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
      if (key === "logic")
        expect(await workspaceDocument(page, "logic:1")).not.toContain(
          "invalid LOGIC immediate !!!",
        );
      else if (key === "notes") {
        await page.getByTestId("part-notes").click();
        await expect(page.getByLabel("Game notes", { exact: true })).not.toHaveValue(
          "note from the edit event",
        );
      } else if (key === "words")
        expect(await workspaceDocument(page, "words")).not.toContain("instantword");
      else {
        await page.getByTestId("part-sound:1").click();
        await expect(
          page.getByTestId("workspace-sound").getByLabel("Tempo", { exact: true }),
        ).toHaveValue("120");
      }
    });
  }
}

test("Unsaved edits keeps tempo metadata for both retained SOUND buffers", async ({ page }) => {
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
  await page.getByTestId("download-unsaved-edits").click();
  const bytes = await readFile((await (await downloading).path())!);
  const name = "unsaved-edits/music.txt";
  const at = bytes.indexOf(name);
  expect(at).toBeGreaterThanOrEqual(30);
  const length = bytes.readUInt32LE(at - 30 + 18);
  const music = JSON.parse(bytes.subarray(at + name.length, at + name.length + length).toString());
  expect(music["1"].tempo).toBe(240);
  expect(music["255"].tempo).toBe(180);
});

test("a failed flush refuses a version name and Retry names the visible source", async ({
  page,
}) => {
  await starter(page);
  await openWorkspaceLogic(page);
  await page.getByTestId("workspace-saved").click();
  const history = page.getByTestId("workspace-history");
  await history.getByLabel("Version name", { exact: true }).fill("Failed first");
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const submit = session.submit;
    let fail = true;
    session.submit = (...args) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("Injected LOGIC admission failure"));
      }
      return submit(...args);
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
  await expect(page.locator(".workspace-error[role=alert]")).toContainText(
    "Injected LOGIC admission failure",
  );
  await expect(history.locator(".workspace-history__name")).toHaveCount(0);
  await expect(page.locator(".monaco-editor")).toContainText("invalid named draft !!!");
  await page
    .locator(".workspace-error[role=alert]")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await workspaceSaved(page);
  await history.getByRole("button", { name: "Name this version", exact: true }).click();
  await expect(history.locator(".workspace-history__name")).toHaveText("Failed first");
  expect(await workspaceDocument(page, "logic:1")).toBe("invalid named draft !!!");
});

test("Discard and exit retires a refused draft and keeps the previous durable note", async ({
  page,
}) => {
  await starter(page);
  await page.getByTestId("part-notes").click();
  const notes = page.getByLabel("Game notes", { exact: true });
  await notes.fill("previous durable note");
  await workspaceSaved(page);
  await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    session.submit = () => Promise.reject(new Error("Injected refused draft"));
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
