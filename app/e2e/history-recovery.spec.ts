import { type Page } from "@playwright/test";
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
  await openGameOptions(page, "game-menu");
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
  await openGameOptions(page, "game-menu");
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("eject-refusal")).toContainText("Session history is not saved", {
    timeout: 15_000,
  });
  expect((await textHook(page)).autosave).toBeGreaterThan(0);
  await page.getByTestId("eject-dismiss").click();
  await waitForCycles(page, 2);
  await page.evaluate(() => {
    (window as unknown as { refuseHistory: boolean }).refuseHistory = false;
  });
  await openGameOptions(page, "game-menu");
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("btn-resume-cached")).toBeVisible({ timeout: 15_000 });
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
