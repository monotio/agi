import { expect, test } from "./test.ts";
import { isolateStorage } from "./engineProbe.ts";

test("native IndexedDB commits the body, lifetime and retry receipt together", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const storage = await import("/src/project/gameStorage.ts");
    const id = "atomic-commit" as Parameters<typeof storage.commitProject>[0]["projectId"];
    const input = {
      projectId: id,
      commitId: "first",
      workspaceId: "test-workspace",
      buildId: "a".repeat(64),
      expected: null,
      documents: [{ key: "logic:1", version: 2 }],
      data: {
        title: "Atomic save",
        provider: "",
        model: "",
        files: { "VOL.0": Uint8Array.of(1) },
        words: [] as [string, number][],
      },
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (value.projectId === `commit/${id}/first`) {
        // The body put was already queued. Fail a later request asynchronously,
        // after it runs, so this proves native transaction rollback.
        return this.add({ projectId: id });
      }
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
    let refused = false;
    try {
      await storage.commitProject(input);
    } catch {
      refused = true;
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    const afterAbort = await storage.bodyTransaction("readonly", (store) => store.getAllKeys());
    const first = await storage.commitProject(input);
    const retry = await storage.commitProject(input);
    const saved = await storage.loadAuthoredGame(id);
    return {
      refused,
      afterAbort,
      first: first.receipt,
      retry: retry.receipt,
      generation: saved?.generation,
    };
  });
  expect(result.refused).toBe(true);
  expect(result.afterAbort).not.toContain("atomic-commit");
  expect(result.afterAbort).not.toContain("lifetime/atomic-commit");
  expect(result.afterAbort).not.toContain("commit/atomic-commit/first");
  expect(result.retry).toEqual(result.first);
  expect(result.generation).toBe(1);
});

test("a saved project survives a cache refusal and a fresh page can resolve the same commit", async ({
  page,
  context,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const receipt = await page.evaluate(async () => {
    const storage = await import("/src/project/gameStorage.ts");
    const id = "cache-refusal" as Parameters<typeof storage.commitProject>[0]["projectId"];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === storage.getStorageKey(id)) throw new Error("Injected cache quota");
      setItem.call(this, key, value);
    };
    try {
      return await storage.commitProject({
        projectId: id,
        commitId: "first",
        workspaceId: "test-workspace",
        buildId: "b".repeat(64),
        expected: null,
        documents: [],
        data: {
          title: "Durable save",
          provider: "",
          model: "",
          files: { "VOL.0": Uint8Array.of(2) },
          words: [],
        },
      });
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });
  expect(receipt.warnings).toEqual(["indexRepairPending"]);
  const fresh = await context.newPage();
  try {
    await fresh.goto(page.url());
    const recovered = await fresh.evaluate(async () => {
      const storage = await import("/src/project/gameStorage.ts");
      const id = "cache-refusal" as Parameters<typeof storage.commitProject>[0]["projectId"];
      // Home may have repaired the cache. Discard it to exercise the durable read.
      localStorage.removeItem(storage.getStorageKey(id));
      const saved = await storage.loadAuthoredGame(id);
      const discovered = await storage.listStoredProjects();
      const retry = await storage.commitProject({
        projectId: id,
        commitId: "first",
        workspaceId: "test-workspace",
        buildId: "b".repeat(64),
        expected: null,
        documents: [],
        data: {
          title: "Durable save",
          provider: "",
          model: "",
          files: { "VOL.0": Uint8Array.of(2) },
          words: [],
        },
      });
      return {
        title: saved?.title,
        generation: saved?.generation,
        listed: discovered.some((entry) => entry.projectId === id),
        receipt: retry.receipt,
      };
    });
    expect(recovered.title).toBe("Durable save");
    expect(recovered.generation).toBe(1);
    expect(recovered.listed).toBe(true);
    expect(recovered.receipt).toEqual(receipt.receipt);
  } finally {
    await fresh.close();
  }
});
