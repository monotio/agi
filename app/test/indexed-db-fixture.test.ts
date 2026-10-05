import assert from "node:assert/strict";
import { test } from "node:test";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open("fixture");
    request.onsuccess = () => resolve(request.result);
  });

const settle = (transaction: IDBTransaction): Promise<string> =>
  new Promise<string>((resolve) => {
    transaction.oncomplete = () => resolve("complete");
    transaction.onabort = () => resolve("abort");
  });

const read = (store: IDBObjectStore, key: string): Promise<unknown> =>
  new Promise((resolve) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
  });

/** Production storage waits on transaction events, so a failed operation must settle the transaction. */
test("a failing operation rejects the transaction instead of leaving it pending", async () => {
  installIndexedDbFixture();
  const database = await openDatabase();
  const transaction = database.transaction("projects", "readwrite");
  const events: string[] = [];
  const settled = new Promise<string[]>((resolve) => {
    transaction.oncomplete = () => resolve([...events, "complete"]);
    transaction.onerror = () => events.push("error");
    transaction.onabort = () => resolve([...events, "abort"]);
  });
  // Functions are not structured-cloneable, so the fixture's put throws like a real store would.
  const request = transaction.objectStore("projects").put({ projectId: "broken", run: () => {} });
  request.onerror = () => events.push("request-error");
  assert.deepEqual(await settled, ["request-error", "error", "abort"]);
  assert.ok(request.error instanceof Error);
});

test("a put rolled back by abort leaves the committed map untouched", async () => {
  const records = installIndexedDbFixture();
  records.set("keep", { projectId: "keep", title: "Original" });
  const database = await openDatabase();
  const transaction = database.transaction("projects", "readwrite");
  const settled = settle(transaction);
  const request = transaction.objectStore("projects").put({ projectId: "keep", title: "Changed" });
  request.onsuccess = () => transaction.abort();
  assert.equal(await settled, "abort");
  assert.equal((records.get("keep") as { title: string }).title, "Original");
});

test("a failing request rolls back every earlier write of its transaction", async () => {
  const records = installIndexedDbFixture();
  const database = await openDatabase();
  const transaction = database.transaction("projects", "readwrite");
  const settled = settle(transaction);
  const store = transaction.objectStore("projects");
  store.put({ projectId: "staged", title: "Staged" });
  // The second put throws on structuredClone, aborting the whole transaction.
  store.put({ projectId: "broken", run: () => {} });
  assert.equal(await settled, "abort");
  assert.equal(records.has("staged"), false);
  assert.equal(records.has("broken"), false);
});

test("a readwrite transaction reads its own writes before they commit", async () => {
  const records = installIndexedDbFixture();
  const database = await openDatabase();
  const transaction = database.transaction("projects", "readwrite");
  const settled = settle(transaction);
  const store = transaction.objectStore("projects");
  store.put({ projectId: "draft", title: "Draft" });
  const draft = await new Promise<unknown>((resolve) => {
    const request = store.get("draft");
    request.onsuccess = () => {
      // Still inside the live transaction: the staged write is visible to its
      // own reads but not yet published to the committed map.
      assert.equal(records.has("draft"), false);
      resolve(request.result);
    };
  });
  assert.deepEqual(draft, { projectId: "draft", title: "Draft" });
  assert.equal(await settled, "complete");
  assert.deepEqual(records.get("draft"), { projectId: "draft", title: "Draft" });
});

test("a serialized writer sees only what the earlier transaction committed", async () => {
  installIndexedDbFixture();
  const database = await openDatabase();

  const committed = database.transaction("projects", "readwrite");
  const committedSettled = settle(committed);
  committed.objectStore("projects").put({ projectId: "seq", n: 1 });
  assert.equal(await committedSettled, "complete");

  const afterCommit = database.transaction("projects", "readwrite");
  const afterCommitSettled = settle(afterCommit);
  assert.deepEqual(await read(afterCommit.objectStore("projects"), "seq"), {
    projectId: "seq",
    n: 1,
  });
  assert.equal(await afterCommitSettled, "complete");

  const aborted = database.transaction("projects", "readwrite");
  const abortedSettled = settle(aborted);
  const dropped = aborted.objectStore("projects").put({ projectId: "dropped", n: 2 });
  dropped.onsuccess = () => aborted.abort();
  assert.equal(await abortedSettled, "abort");

  const afterAbort = database.transaction("projects", "readwrite");
  const afterAbortSettled = settle(afterAbort);
  assert.equal(await read(afterAbort.objectStore("projects"), "dropped"), undefined);
  assert.equal(await afterAbortSettled, "complete");
});

test("cursor deletions roll back when the transaction aborts", async () => {
  const records = installIndexedDbFixture();
  records.set("history/p", { projectId: "history/p" });
  records.set("history/p/1", { projectId: "history/p/1" });
  records.set("history/p/2", { projectId: "history/p/2" });
  const database = await openDatabase();
  const transaction = database.transaction("projects", "readwrite");
  const settled = settle(transaction);
  const children = transaction
    .objectStore("projects")
    .openCursor(IDBKeyRange.bound("history/p/", "history/p0"));
  children.onsuccess = () => {
    const cursor = children.result;
    if (cursor === null) {
      transaction.abort();
      return;
    }
    cursor.delete();
    cursor.continue();
  };
  assert.equal(await settled, "abort");
  assert.equal(records.has("history/p"), true);
  assert.equal(records.has("history/p/1"), true);
  assert.equal(records.has("history/p/2"), true);
});

test("a late publication failure restores every earlier put and deletion", async (t) => {
  const records = installIndexedDbFixture();
  records.set("old", { projectId: "old" });
  const original = [...records];
  const set = records.set.bind(records);
  t.mock.method(records, "set", (key: IDBValidKey, value: unknown) => {
    if (key === "fail") throw new Error("Injected late quota failure");
    return set(key, value);
  });
  const database = await openDatabase();
  const transaction = database.transaction("projects", "readwrite");
  const settled = settle(transaction);
  const store = transaction.objectStore("projects");
  store.delete("old");
  store.put({ projectId: "first" });
  store.put({ projectId: "fail" });
  assert.equal(await settled, "abort");
  assert.deepEqual([...records], original);
});

test("a transaction completes once after several requests drain together", async () => {
  installIndexedDbFixture();
  const database = await openDatabase();
  const transaction = database.transaction("projects", "readwrite");
  let completions = 0;
  const settled = new Promise<void>((resolve) => {
    transaction.oncomplete = () => {
      completions++;
      resolve();
    };
  });
  const store = transaction.objectStore("projects");
  store.get("one");
  store.get("two");
  await settled;
  assert.equal(completions, 1);
});

test("queued requests never run after explicit abort", async () => {
  const records = installIndexedDbFixture();
  const database = await openDatabase();
  const transaction = database.transaction("projects", "readwrite");
  const settled = settle(transaction);
  const store = transaction.objectStore("projects");
  store.put({ projectId: "first" }).onsuccess = () => transaction.abort();
  let lateSuccess = false;
  store.put({ projectId: "second" }).onsuccess = () => {
    lateSuccess = true;
  };
  assert.equal(await settled, "abort");
  assert.equal(lateSuccess, false);
  assert.deepEqual([...records], []);
});
