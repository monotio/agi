import { readFile } from "node:fs/promises";
import type { Page, Download } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { test, expect } from "./test.ts";
import { isolateStorage, openGameOptions, workspaceSaved } from "./engineProbe.ts";
import { openStoredWorkspace } from "./workspaceShared.ts";
import { readGameZip } from "../src/archive/gameZip.ts";

async function starter(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Recovery proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await workspaceSaved(page);
}

async function moveStorage(page: Page, other: Page, removed: boolean): Promise<void> {
  await other.goto("/");
  await openStoredWorkspace(other, "Recovery proof");
  if (removed) {
    await other.evaluate(async () => {
      const { clearCachedGame } = await import("/src/project/gameStorage.ts");
      const { listCachedGames } = await import("/src/project/gameStorage.ts");
      await clearCachedGame(
        listCachedGames().find((game) => game.title === "Recovery proof")!.projectId,
      );
    });
  } else {
    await other.getByTestId("part-notes").click();
    await other.getByLabel("Game notes", { exact: true }).fill("From the other tab");
    await workspaceSaved(other);
  }
  await page.bringToFront();
  await expect(page.getByTestId(removed ? "removed-tab-note" : "stale-tab-note")).toBeVisible();
}

for (const mode of ["refusal", "storage", "stale", "removed"] as const) {
  test(`Download game preserves a backup after ${mode}`, async ({ page, context }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await starter(page);
    if (mode === "stale" || mode === "removed") {
      const other = await context.newPage();
      await moveStorage(page, other, mode === "removed");
    } else {
      await page.evaluate((mode) => {
        if (mode === "refusal") {
          const session = (
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
          ).__AGI_PROJECT__.getSession();
          session.submit = () => Promise.reject(new Error("Injected admission refusal"));
        } else {
          const put = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function (...args) {
            if (this.name === "projects")
              throw new DOMException("Injected quota failure", "QuotaExceededError");
            return put.apply(this, args);
          };
        }
      }, mode);
      await page.getByTestId("part-notes").click();
      await page.getByLabel("Game notes", { exact: true }).fill("Local recovery note");
      await expect(page.getByTestId("workspace-saved")).toContainText("Could not save");
    }
    const downloads: Download[] = [];
    page.on("download", (download) => downloads.push(download));
    await openGameOptions(page, "settings-menu");
    await page.getByTestId("btn-download-game").click();
    await expect
      .poll(async () => ({
        downloads: downloads.length,
        refusal: await page.getByTestId("export-refusal").allTextContents(),
      }))
      .toMatchObject({ downloads: 1 });
    const downloaded = downloads[0]!;
    const archive = await readGameZip(new Uint8Array(await readFile((await downloaded.path())!)));
    expect(archive.files["LOGDIR"]).toBeDefined();
    await expect(page.getByTestId("export-refusal")).toContainText(
      "Backup downloaded with limitations",
    );
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`backup-${mode}.png`) });
  });
}

for (const removed of [false, true]) {
  for (const action of ["reload", "exit"] as const) {
    if (removed && action !== "exit") continue;
    test(`${removed ? "removed" : "stale"} tab can ${action} without a save attempt`, async ({
      page,
      context,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await starter(page);
      const other = await context.newPage();
      await moveStorage(page, other, removed);
      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          if (
            this.name === "projects" &&
            !(args[0] as { projectId?: string }).projectId?.includes("/")
          )
            throw new Error("Stale tab tried to save");
          return put.apply(this, args);
        };
      });
      if (action === "exit") {
        await openGameOptions(page, "settings-menu");
        await page.getByTestId("btn-exit").click();
        await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
        await expect(page.getByTestId("eject-refusal")).toBeHidden();
      } else {
        if (action === "reload")
          await page
            .getByTestId("stale-tab-note")
            .getByRole("button", { name: "Reload game" })
            .click();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
                ).__AGI_PROJECT__
                  .getSession()
                  ?.model.capture()
                  .read("notes")?.content,
            ),
          )
          .toBe("From the other tab");
        await workspaceSaved(page);
        await expect(page.getByTestId("stale-tab-note")).toBeHidden();
      }
      expect(errors).toEqual([]);
    });
  }
}

test("Discard and exit stays disabled through Retry's save barrier", async ({ page }) => {
  await starter(page);
  await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const flush = session.flush.bind(session);
    const surface = window as unknown as {
      releaseSave?: () => void;
      saveEntered?: boolean;
      allowSave?: boolean;
    };
    const gate = new Promise<void>((resolve) => {
      surface.releaseSave = resolve;
    });
    session.flush = async () => {
      if (!surface.allowSave) throw new Error("Injected project save failure");
      surface.saveEntered = true;
      await gate;
      await flush();
    };
  });
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("eject-refusal")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { allowSave: boolean }).allowSave = true;
  });
  await page.getByTestId("eject-retry").click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { saveEntered?: boolean }).saveEntered))
    .toBe(true);
  await expect(page.getByTestId("eject-leave-anyway")).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("retry-pending.png") });
  await page.evaluate(() => {
    (window as unknown as { releaseSave(): void }).releaseSave();
  });
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  await expect(page.getByTestId("eject-refusal")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("retry-saved.png") });
});

for (const failure of ["flush", "admission", "journal"] as const) {
  test(
    failure === "journal"
      ? "guided changes save when recovery storage is unavailable"
      : `guided changes report ${failure} and retain admission intent`,
    async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await starter(page);
      await page.getByTestId("part-room:1:logic").click();
      await page.getByTestId("workspace-add").click();
      await page.getByRole("menuitem", { name: "Add a room", exact: true }).click();
      const form = page.getByTestId("workspace-guided-form");
      await form.getByLabel("Room name", { exact: true }).fill("Recovered room");
      await page.evaluate((failure) => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        if (failure === "flush")
          session.flush = () => Promise.reject(new Error("Injected flush failure"));
        else if (failure === "admission")
          session.submit = () => Promise.reject(new Error("Injected admission failure"));
        else {
          const set = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (key.startsWith("monotio_agi.project-writes.")) {
              Object.assign(window, { journalFailed: true });
              throw new DOMException("Injected journal quota", "QuotaExceededError");
            }
            return set.call(this, key, value);
          };
        }
      }, failure);
      await form.getByRole("button", { name: "Add", exact: true }).click();
      if (failure === "journal") {
        await expect(page.getByTestId("parts-list")).toContainText("Recovered room");
        await workspaceSaved(page);
        expect(
          await page.evaluate(
            () => (window as unknown as { journalFailed: boolean }).journalFailed,
          ),
        ).toBe(true);
      } else
        await expect(page.locator(".workspace-error")).toContainText(`Injected ${failure} failure`);
      expect(errors).toEqual([]);
      if (failure === "admission") {
        const journal = await page.evaluate(() =>
          Object.keys(localStorage)
            .filter((key) => key.startsWith("monotio_agi.project-writes."))
            .map((key) => localStorage.getItem(key))
            .join("\n"),
        );
        expect(journal).toContain("Recovered room");
        await page.reload();
        await expect(page.getByTestId("parts-list")).toContainText("Recovered room");
        await workspaceSaved(page);
      }
    },
  );
}

for (const failure of ["flush", "admission", "journal"] as const) {
  test(
    failure === "journal"
      ? "WORDS meaning changes save when recovery storage is unavailable"
      : `WORDS meaning changes report ${failure} and retain admission intent`,
    async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await starter(page);
      await page.evaluate(async () => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        const words = JSON.parse(String(session.model.capture().read("words")!.content)) as [
          string,
          number,
        ][];
        await session.submit({
          proposal: session.model.propose(session.model.capture(), "Recovery word", [
            { key: "words", content: JSON.stringify([...words, ["recoveryword", 800]]) },
          ]),
          label: "Recovery word",
          origin: "words",
          author: "creator",
        });
        await session.flush();
      });
      await page.getByTestId("part-words").click();
      const remove = page.getByRole("button", { name: "Remove recoveryword", exact: true });
      await expect(remove).toBeVisible();
      await page.evaluate((failure) => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        if (failure === "flush")
          session.flush = () => Promise.reject(new Error("Injected flush failure"));
        else if (failure === "admission")
          session.submit = () => Promise.reject(new Error("Injected admission failure"));
        else {
          const set = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (key.startsWith("monotio_agi.project-writes.")) {
              Object.assign(window, { journalFailed: true });
              throw new DOMException("Injected journal quota", "QuotaExceededError");
            }
            return set.call(this, key, value);
          };
        }
      }, failure);
      await remove.locator("..").hover();
      await remove.click();
      if (failure === "journal") {
        await expect
          .poll(() =>
            page.evaluate(() => {
              const session = (
                window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
              ).__AGI_PROJECT__.getSession();
              return String(session.model.capture().read("words")!.content);
            }),
          )
          .not.toContain("recoveryword");
        await workspaceSaved(page);
        expect(
          await page.evaluate(
            () => (window as unknown as { journalFailed: boolean }).journalFailed,
          ),
        ).toBe(true);
      } else
        await expect(page.locator(".workspace-error")).toContainText(`Injected ${failure} failure`);
      expect(errors).toEqual([]);
      if (failure === "admission") {
        const pending = await page.evaluate(() =>
          Object.keys(localStorage)
            .filter((key) => key.startsWith("monotio_agi.project-writes."))
            .map((key) => localStorage.getItem(key))
            .join("\n"),
        );
        expect(pending).toContain("editorIntent");
        // Recovery changes the resource revision; inspect the recovered project
        // while its earlier checkpoint keeps its original revision.
        await page.goto("/");
        const recovered = await page.evaluate(async () => {
          const { listCachedGames, loadAuthoredGame } = await import("/src/project/gameStorage.ts");
          const id = listCachedGames().find((game) => game.title === "Recovery proof")!.projectId;
          const data = (await loadAuthoredGame(id))!;
          return {
            words: data.workspace!.documents.find((doc) => doc.key === "words")!.content,
            dictionary: data.words,
            pending: Object.keys(localStorage).filter((key) =>
              key.startsWith("monotio_agi.project-writes."),
            ),
          };
        });
        expect(recovered.words).toMatchObject({ type: "text" });
        expect(JSON.stringify(recovered.words)).not.toContain("recoveryword");
        expect(recovered.dictionary.some(([word]) => word === "recoveryword")).toBe(false);
        expect(recovered.pending).toEqual([]);
      }
    },
  );
}
