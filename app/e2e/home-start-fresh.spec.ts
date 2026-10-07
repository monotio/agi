import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { decodeJournalValue } from "../src/project/projectJournalCapture.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";

const TUTORIAL_PROJECT_ID = "catalog-adventure-department-1.2.0";
const UNRELATED_PROJECT_ID = "keep-me";

/** The keys currently in the project store. */
async function storedKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("monotio-agi-projects");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = db.transaction("projects", "readonly").objectStore("projects").getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return keys.map(String);
  });
}

test("an unreadable stored tutorial offers Start fresh, which removes only that project", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  // The pre-1.0 shape: a project body without the format and version fields
  // this release reads, beside an unrelated record that must survive.
  await page.evaluate(
    async (ids) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("monotio-agi-projects");
        request.onupgradeneeded = () =>
          request.result.createObjectStore("projects", { keyPath: "projectId" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("projects", "readwrite");
        const store = transaction.objectStore("projects");
        for (const projectId of ids)
          store.put({ projectId, title: "Adventure Department", files: {}, words: [] });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    },
    [TUTORIAL_PROJECT_ID, UNRELATED_PROJECT_ID],
  );

  const card = page.getByTestId("catalog-adventure-department");
  const play = page.getByTestId("catalog-play-adventure-department");
  await expect(play).toBeEnabled();
  await play.click();
  await expect(card.getByRole("alert")).toContainText(
    "This saved project version is not supported by this app.",
  );
  const startFresh = card.getByRole("button", { name: "Start fresh…", exact: true });
  await expect(startFresh).toBeVisible();

  // Cancel leaves the stored record alone.
  await startFresh.click();
  const dialog = page.getByRole("dialog", { name: "Start fresh?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "Start fresh removes that copy, its progress and history from this browser",
  );
  await expect(dialog).toContainText("exported");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(startFresh).toBeFocused();
  expect(await storedKeys(page)).toContain(TUTORIAL_PROJECT_ID);

  await startFresh.click();
  await dialog.getByRole("button", { name: "Start fresh", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(startFresh).toHaveCount(0);
  const remaining = await storedKeys(page);
  expect(remaining).not.toContain(TUTORIAL_PROJECT_ID);
  expect(remaining, "other projects are untouched").toContain(UNRELATED_PROJECT_ID);

  await play.click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
});

test("a saved game whose stored body predates 1.0 offers raw recovery on its own card", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  // A release candidate's project: a current index over a body in the
  // pre-1.0 stored format.
  const before = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("monotio-agi-projects");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("projects", "readwrite");
      transaction.objectStore("projects").put({
        projectId: "old-adventure",
        format: "monotio.agi.project",
        version: 1,
        title: "Old Adventure",
        files: {},
        words: [],
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    localStorage.setItem(
      "monotio_agi.authored.old-adventure",
      JSON.stringify({
        format: "monotio.agi.project-index",
        version: 1,
        storage: "indexeddb",
        projectId: "old-adventure",
        title: "Old Adventure",
        authoredAt: "2026-01-01T00:00:00.000Z",
        provider: "stub",
        model: "offline-stub",
        imported: true,
      }),
    );
    const storage = await import("/src/project/gameStorage.ts");
    return {
      body: await storage.bodyTransaction("readonly", (store) => store.get("old-adventure")),
      index: localStorage.getItem("monotio_agi.authored.old-adventure"),
    };
  });
  await page.reload();
  const card = page.getByTestId("unsupported-project-card-old-adventure");
  await expect(card.getByRole("heading")).toHaveText("Old Adventure");
  await expect(card).toContainText("Saved project format needs another app version");
  const pending = page.waitForEvent("download");
  await card.getByRole("button", { name: "Download", exact: true }).click();
  const download = await pending;
  const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(decodeJournalValue(exported.record)).toEqual(before.body);
  expect(exported.index).toBe(before.index);
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  const dialog = card.getByTestId("remove-game-dialog");
  await dialog.getByTestId("remove-game-cancel").click();
  expect(
    await page.evaluate(async () => {
      const storage = await import("/src/project/gameStorage.ts");
      return {
        body: await storage.bodyTransaction("readonly", (store) => store.get("old-adventure")),
        index: localStorage.getItem("monotio_agi.authored.old-adventure"),
      };
    }),
  ).toEqual(before);
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog.getByTestId("remove-game-confirm").click();
  await expect(card).toHaveCount(0);
  expect(await storedKeys(page)).not.toContain("old-adventure");
  expect(
    await page.evaluate(() => localStorage.getItem("monotio_agi.authored.old-adventure")),
  ).toBeNull();
});
