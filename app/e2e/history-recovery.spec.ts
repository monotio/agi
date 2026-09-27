import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { readFile } from "node:fs/promises";
import { readGameZip } from "../src/gameZip.ts";
import { isolateStorage, openGameOptions, textHook, waitForCycles } from "./engineProbe.ts";

function entries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Map<string, Uint8Array>();
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + nameLength + extraLength;
    result.set(
      new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength)),
      bytes.slice(dataStart, dataStart + size),
    );
    offset = dataStart + size;
  }
  return result;
}

async function boot(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 3);
}

async function download(page: Page) {
  const pending = page.waitForEvent("download");
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-download-game").click();
  const path = (await (await pending).path())!;
  const bytes = new Uint8Array(await readFile(path));
  return { path, opened: await readGameZip(bytes), files: entries(bytes) };
}

test("healthy development backup contains replay history and a complete report", async ({
  page,
}) => {
  await boot(page);
  const result = await download(page);
  expect(result.opened.progress?.autosave?.room).toBe(1);
  expect(result.opened.history?.recording.segments.length).toBeGreaterThan(0);
  expect(result.files.has("HISTORY-RECOVERY.JSON")).toBe(false);
  expect(JSON.parse(new TextDecoder().decode(result.files.get("BACKUP.JSON"))).complete).toBe(true);
  await expect(page.getByTestId("export-refusal")).toBeHidden();
});

test("blocked stores still download current game and checkpoint with explicit recovery history", async ({
  page,
  browser,
}) => {
  await boot(page);
  const spawn = (await textHook(page)).egoX;
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(spawn + 12);
  await page.keyboard.press("ArrowRight");
  await waitForCycles(page, 2);
  const before = await textHook(page);
  await page.evaluate(() => {
    IDBDatabase.prototype.transaction = function () {
      throw new Error("Injected database denial");
    };
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("monotio_agi.autosave.")) throw new Error("Injected autosave denial");
      return setItem.call(this, key, value);
    };
  });
  const result = await download(page);
  expect(result.opened.files["LOGDIR"]).toBeDefined();
  expect(result.opened.progress?.autosave?.cycle).toBeGreaterThanOrEqual(before.cycle);
  expect(result.opened.progress?.autosave?.room).toBe(1);
  expect(result.files.has("HISTORY-RECOVERY.JSON")).toBe(true);
  const report = JSON.parse(new TextDecoder().decode(result.files.get("BACKUP.JSON")));
  expect(report.complete).toBe(false);
  expect(report.notes.join(" ")).toContain("could not be read");
  expect(result.opened.backupWarning).toContain("Keep the original ZIP");
  await expect(page.getByTestId("export-refusal")).toContainText(
    "Backup downloaded with limitations",
  );
  const fresh = await browser.newContext();
  try {
    const imported = await fresh.newPage();
    await imported.goto(page.url());
    await imported.getByTestId("game-zip-input").setInputFiles(result.path);
    await expect(imported.getByText(/added to your library.*Keep the original ZIP/)).toBeVisible();
    await imported.getByTestId("btn-resume-cached").click();
    await expect.poll(async () => (await textHook(imported)).room).toBe(1);
    await expect.poll(async () => (await textHook(imported)).egoX).toBe(before.egoX);
  } finally {
    await fresh.close();
  }
});

test("an unreadable history manifest produces a visible incomplete-download notice", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (typeof key === "string" && key.startsWith("history/"))
        throw new Error("Injected history read failure");
      return get.call(this, key);
    };
  });
  const result = await download(page);
  expect(result.files.has("BACKUP.JSON")).toBe(true);
  expect(result.opened.history).toBeUndefined();
  expect(result.opened.progress?.autosave?.room).toBe(1);
  await expect(page.getByTestId("export-refusal")).toContainText(
    "Stored session history could not be read",
  );
});

test("Exit keeps the game playable after history failure and succeeds after storage recovers", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    (window as unknown as { refuseHistory: boolean }).refuseHistory = true;
    IDBObjectStore.prototype.put = function (value, key) {
      const recordKey = (value as { projectId?: string }).projectId;
      if (
        (window as unknown as { refuseHistory: boolean }).refuseHistory &&
        recordKey?.startsWith("history/")
      )
        throw new Error("Injected history write refusal");
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
  });
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-exit").click();
  // One sentence and a choice, not a refusal: the game itself is saved.
  await expect(page.getByTestId("eject-history")).toContainText(
    "This session's rewind timeline is not saved yet.",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("eject-leave-without-timeline")).toBeVisible();
  await expect(page.getByTestId("eject-keep-backup")).toBeVisible();
  expect((await textHook(page)).autosave).toBeGreaterThan(0);
  await page.getByTestId("eject-stay").click();
  await expect(page.getByTestId("eject-history")).toBeHidden();
  await waitForCycles(page, 2);
  await page.evaluate(() => {
    (window as unknown as { refuseHistory: boolean }).refuseHistory = false;
  });
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-exit").click();
  // Back on the shelf, the tutorial's card offers the checkpoint.
  await expect(page.getByTestId("catalog-play-adventure-department")).toHaveText("Resume", {
    timeout: 15_000,
  });
});

test("a stored timeline this version cannot extend says so once, never blocks Exit, and a new timeline can start", async ({
  page,
}) => {
  const play = page.getByTestId("catalog-play-adventure-department");
  const exit = async () => {
    await openGameOptions(page, "settings-menu");
    await page.getByTestId("btn-exit").click();
    await expect(play).toHaveText("Resume", { timeout: 15_000 });
  };
  await boot(page);
  await exit();
  // Between sessions, the game's tape becomes the pre-1.0 whole-tape layout.
  const key = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open("monotio-agi-projects");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const store = open.result.transaction("projects", "readwrite").objectStore("projects");
          const keys = store.getAllKeys();
          keys.onsuccess = () => {
            const head = (keys.result as string[]).find(
              (k) => k.startsWith("history/") && k.split("/").length === 2,
            )!;
            store.put({
              format: "monotio.agi.history",
              version: 1,
              projectId: head,
              recording: { segments: [] },
              committed: {},
            });
            resolve(head);
          };
        };
      }),
  );
  await play.click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  // The session's first batch meets the old record: one calm, permanent message.
  await expect(page.getByTestId("history-blocked")).toHaveText(
    /^Your game is saved\. This session's rewind timeline can't be stored: an older timeline for this game is in a format this version can't extend\./,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("history-unsaved")).toBeHidden();
  // Nothing about the refused tape holds Exit; the next session says it again.
  await exit();
  await play.click();
  await expect(page.getByTestId("history-blocked")).toBeVisible({ timeout: 20_000 });

  // Start a new timeline, confirmed: the session's tape lands there.
  await page.getByTestId("history-new-timeline").click();
  await page.getByTestId("history-new-timeline-confirm").click();
  await expect(page.getByTestId("history-blocked")).toBeHidden();
  const stored = () =>
    page.evaluate(
      (head) =>
        new Promise<{ old: unknown; next: unknown }>((resolve) => {
          const open = indexedDB.open("monotio-agi-projects");
          open.onsuccess = () => {
            const store = open.result.transaction("projects").objectStore("projects");
            const old = store.get(head);
            const next = store.get(`${head}/next`);
            next.onsuccess = () => resolve({ old: old.result, next: next.result });
          };
        }),
      key,
    );
  await expect
    .poll(async () => ((await stored()).next as { segments?: unknown[] })?.segments?.length ?? 0)
    .toBeGreaterThan(0);
  // The old record is kept exactly as it was, for the release that wrote it.
  expect((await stored()).old).toEqual({
    format: "monotio.agi.history",
    version: 1,
    projectId: key,
    recording: { segments: [] },
    committed: {},
  });
  await exit();
});

test("unreadable saved slots are reported even when current checkpoint and history are available", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key.startsWith("monotio_agi.saves.")) throw new Error("Injected slot read refusal");
      return getItem.call(this, key);
    };
  });
  const result = await download(page);
  expect(result.opened.progress?.autosave?.room).toBe(1);
  expect(result.opened.history).toBeDefined();
  expect(JSON.parse(new TextDecoder().decode(result.files.get("BACKUP.JSON"))).complete).toBe(
    false,
  );
  await expect(page.getByTestId("export-refusal")).toContainText(
    "previously saved progress could not be read",
  );
});
