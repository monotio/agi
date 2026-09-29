import { expect, test } from "./test.ts";
import { isolateStorage } from "./engineProbe.ts";
import { testProjectId } from "../test/identity.ts";

test("the v2 database upgrade preserves v1 records and fences older app writers", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const result = await page.evaluate(async (projectId) => {
    const storage = await import("/src/project/gameStorage.ts");
    if (
      !(await storage.saveAuthoredGame(projectId, {
        title: "Legacy adventure",
        provider: "stub",
        model: "legacy",
        transcript: [],
        files: { "WORDS.TOK": new Uint8Array(52) },
        words: [],
      }))
    )
      throw new Error("Fixture save failed");
    const raw = await storage.bodyTransaction<Record<string, unknown>>("readonly", (store) =>
      store.get(projectId),
    );
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("monotio-agi-projects");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Fixture database delete blocked"));
    });
    const oldConnection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("monotio-agi-projects", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("projects", { keyPath: "projectId" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let oldConnectionClosed = false;
    oldConnection.onversionchange = () => {
      oldConnectionClosed = true;
      oldConnection.close();
    };
    await new Promise<void>((resolve, reject) => {
      const transaction = oldConnection.transaction("projects", "readwrite");
      transaction.objectStore("projects").put({ ...raw, version: 1 });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    const loaded = await storage.loadAuthoredGame(projectId);
    if (!loaded) throw new Error("Upgrade lost the legacy project");
    const beforeSave = await storage.bodyTransaction<Record<string, unknown>>("readonly", (store) =>
      store.get(projectId),
    );
    const oldWriterResult = await new Promise<string>((resolve) => {
      const request = indexedDB.open("monotio-agi-projects", 1);
      request.onerror = () => resolve(request.error?.name ?? "unknown error");
      request.onsuccess = () => {
        request.result.close();
        resolve("opened");
      };
    });
    if (
      !(await storage.saveAuthoredGame(
        projectId,
        { ...loaded, title: "Saved in v2" },
        { expectedGeneration: loaded.generation },
      ))
    )
      throw new Error("Conditional migration save failed");
    const afterSave = await storage.bodyTransaction<Record<string, unknown>>("readonly", (store) =>
      store.get(projectId),
    );
    return {
      oldConnectionClosed,
      oldWriterResult,
      beforeVersion: beforeSave["version"],
      afterVersion: afterSave["version"],
      title: loaded.title,
      provider: loaded.provider,
      model: loaded.model,
      filesEqual: JSON.stringify(beforeSave["files"]) === JSON.stringify(afterSave["files"]),
    };
  }, testProjectId("upgrade-v1"));
  expect(result).toEqual({
    oldConnectionClosed: true,
    oldWriterResult: "VersionError",
    beforeVersion: 1,
    afterVersion: 2,
    title: "Legacy adventure",
    provider: "stub",
    model: "legacy",
    filesEqual: true,
  });
});
