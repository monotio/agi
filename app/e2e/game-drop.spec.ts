import { expect, test, type Page } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/zip.ts";
import { isolateStorage, savedGameCard, textHook } from "./engineProbe.ts";

interface BrowserFile {
  name: string;
  bytes: number[];
}

function dropGame(): { files: BrowserFile[]; zip: number[] } {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic('assignn(v0, 1); display(5, 4, "Dropped adventure."); accept.input(); return;', {
      dictionary: new Map(),
    }).payload,
  );
  game.putFile("WORDS.TOK", new Uint8Array(52));
  const files = [...game.files].map(([name, data]) => ({ name, bytes: [...data] }));
  return {
    files,
    zip: [...buildZip(files.map(({ name, bytes }) => ({ name, data: Uint8Array.from(bytes) })))],
  };
}

async function dispatchZipDrop(page: Page, bytes: number[]): Promise<void> {
  await page.getByTestId("game-zip-drop").evaluate((target, zipBytes) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File([Uint8Array.from(zipBytes)], "dropped-adventure.zip", {
        type: "application/zip",
      }),
    );
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { items: [], files: dataTransfer.files },
    });
    target.dispatchEvent(event);
  }, bytes);
}

async function dispatchFolderDrop(page: Page, files: BrowserFile[]): Promise<void> {
  await page.getByTestId("game-zip-drop").evaluate((target, droppedFiles) => {
    interface Entry {
      isFile: boolean;
      isDirectory: boolean;
      name: string;
      file?: (success: (file: File) => void) => void;
      createReader?: () => { readEntries(success: (entries: Entry[]) => void): void };
    }

    const fileEntries: Entry[] = droppedFiles.map(({ name, bytes }) => {
      const file = new File([Uint8Array.from(bytes)], name);
      return {
        isFile: true,
        isDirectory: false,
        name,
        file(success): void {
          setTimeout(() => success(file), 35);
        },
      };
    });
    const note = new File(["nested"], "README.TXT");
    const nested: Entry = {
      isFile: false,
      isDirectory: true,
      name: "extras",
      createReader() {
        let read = 0;
        return {
          readEntries(success): void {
            const batch: Entry[] =
              read++ === 0
                ? [
                    {
                      isFile: true,
                      isDirectory: false,
                      name: note.name,
                      file(done): void {
                        setTimeout(() => done(note), 35);
                      },
                    },
                  ]
                : [];
            queueMicrotask(() => success(batch));
          },
        };
      },
    };
    const root: Entry = {
      isFile: false,
      isDirectory: true,
      name: "Dropped Folder",
      createReader() {
        let read = 0;
        return {
          readEntries(success): void {
            const batch =
              read === 0
                ? [...fileEntries.slice(0, 2), nested]
                : read === 1
                  ? fileEntries.slice(2)
                  : [];
            read++;
            queueMicrotask(() => success(batch));
          },
        };
      },
    };
    const item = {
      kind: "file",
      type: "",
      webkitGetAsEntry: () => root,
      getAsFile: () => null,
    };
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { items: [item], files: [] },
    });
    target.dispatchEvent(event);
  }, files);
}

async function dispatchAmbiguousDrop(page: Page): Promise<void> {
  await page.getByTestId("game-zip-drop").evaluate((target) => {
    const directory = (name: string) => ({
      isFile: false,
      isDirectory: true,
      name,
      createReader: () => ({ readEntries: (success: (entries: never[]) => void) => success([]) }),
    });
    const items = [directory("First game"), directory("Second game")].map((entry) => ({
      kind: "file",
      type: "",
      webkitGetAsEntry: () => entry,
      getAsFile: () => null,
    }));
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { items, files: [] } });
    target.dispatchEvent(event);
  });
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  await isolateStorage(page);
  await page.goto("/");
});

test("a ZIP dropped through DataTransfer is checked before it can be played", async ({ page }) => {
  const { zip } = dropGame();

  await dispatchZipDrop(page, zip);

  await expect(page.getByTestId("game-import-ready")).toContainText("ready to play");
  const card = savedGameCard(page, "dropped-adventure");
  await expect(card).toContainText("Opening checked");
  await expect(page.getByTestId("input-line")).toBeHidden();
  await card.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("Dropped adventure");
});

test("a nested multi-batch folder drop is staged only after its opening is valid", async ({
  page,
}) => {
  const { files } = dropGame();
  await dispatchFolderDrop(page, files);

  expect(await page.locator("[data-testid^='saved-game-card-']").count()).toBe(0);
  expect(await page.getByTestId("btn-resume-cached").count()).toBe(0);
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).filter((key) => key.startsWith("monotio_agi.authored.")).length,
    ),
  ).toBe(0);

  await expect(page.getByTestId("game-import-ready")).toContainText("ready to play");
  const card = savedGameCard(page, "Dropped Folder");
  await expect(card).toContainText("Opening checked");
  await card.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("Dropped adventure");
});

test("ambiguous dropped roots display an error without changing the library", async ({ page }) => {
  await dispatchAmbiguousDrop(page);

  await expect(page.getByTestId("game-zip-error")).toContainText(
    "Drop one game folder or one ZIP at a time.",
  );
  await expect(page.locator("[data-testid^='saved-game-card-']")).toHaveCount(0);
  await expect(page.getByTestId("game-import-ready")).toHaveCount(0);
});
