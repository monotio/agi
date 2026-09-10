import assert from "node:assert/strict";
import { test } from "node:test";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

/** Production storage waits on transaction events, so a failed operation must settle the transaction. */
test("a failing operation rejects the transaction instead of leaving it pending", async () => {
  installIndexedDbFixture();
  const database = await new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open("fixture");
    request.onsuccess = () => resolve(request.result);
  });
  const transaction = database.transaction("projects", "readwrite");
  const events: string[] = [];
  const settled = new Promise<string[]>((resolve, reject) => {
    transaction.oncomplete = () => resolve([...events, "complete"]);
    transaction.onerror = () => events.push("error");
    transaction.onabort = () => resolve([...events, "abort"]);
    setTimeout(() => reject(new Error("transaction never settled")), 100);
  });
  // Functions are not structured-cloneable, so the fixture's put throws like a real store would.
  const request = transaction.objectStore("projects").put({ gameId: "broken", run: () => {} });
  request.onerror = () => events.push("request-error");
  assert.deepEqual(await settled, ["request-error", "error", "abort"]);
  assert.ok(request.error instanceof Error);
});
