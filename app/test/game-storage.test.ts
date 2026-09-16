import assert from "node:assert/strict";
import { test } from "node:test";
import { testProjectId } from "./identity.ts";
import { requireResourceRevision } from "../../src/gameIdentity.ts";
import * as storage from "../src/gameStorage.ts";
import { readGameSaves, writeGameSave } from "../src/gameSaves.ts";
import { mapKey, writeMapSidecar } from "../src/roomMapStore.ts";
import {
  lastGameKey,
  readAutosave,
  removeLibraryGame,
  writeAutosave,
  type AutosaveRecord,
} from "../src/useEngine.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

const indexedDbRecords = installIndexedDbFixture();

test("renaming preserves game resources, conversation and save identity", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  await storage.saveAuthoredGame(testProjectId("custom"), {
    title: "Custom Adventure",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1, 2, 3) },
    words: [],
    transcript: [{ text: "Original" }],
  });
  const original = (await storage.loadAuthoredGame(testProjectId("custom")))!;
  const revision = original.library?.revision;
  assert.equal(await storage.renameAuthoredGame(testProjectId("custom"), "  My adventure  "), true);
  assert.deepEqual(await storage.loadAuthoredGame(testProjectId("custom")), {
    ...original,
    generation: (original.generation ?? 1) + 1,
    title: "My adventure",
  });
  assert.equal(
    (await storage.loadAuthoredGame(testProjectId("custom")))?.library?.revision,
    revision,
  );
  assert.equal(await storage.renameAuthoredGame(testProjectId("custom"), "   "), false);
  assert.equal(await storage.renameAuthoredGame(testProjectId("absent"), "New title"), false);
});

test("pre-release localStorage project bodies are left untouched", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  values.set(
    storage.getStorageKey(testProjectId("old-project")),
    JSON.stringify({
      projectId: testProjectId("old-project"),
      title: "Old project",
      authoredAt: "2025-01-01T00:00:00.000Z",
      provider: "stub",
      model: "stub",
      filesBase64: { "VOL.0": btoa("old") },
      words: [],
    }),
  );
  await assert.rejects(storage.loadAuthoredGame(testProjectId("old-project")), /version/);
  assert.equal(storage.getCachedGameMeta(testProjectId("old-project")), null);
  assert.match(values.get(storage.getStorageKey(testProjectId("old-project")))!, /filesBase64/);
});

test("future project bodies and indexes are rejected without being overwritten", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const key = storage.getStorageKey(testProjectId("future-index"));
  const futureIndex = JSON.stringify({
    format: "monotio.agi.project-index",
    version: 2,
    storage: "indexeddb",
  });
  values.set(key, futureIndex);
  await assert.rejects(storage.loadAuthoredGame(testProjectId("future-index")), /version/);
  assert.equal(await storage.renameAuthoredGame(testProjectId("future-index"), "Changed"), false);
  assert.equal(values.get(key), futureIndex);

  await storage.saveAuthoredGame(testProjectId("future-body"), {
    title: "Current",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });
  const body = indexedDbRecords.get("future-body") as Record<string, unknown>;
  body["version"] = 2;
  indexedDbRecords.set("future-body", body);
  const before = structuredClone(body);
  await assert.rejects(storage.loadAuthoredGame(testProjectId("future-body")), /version/);
  assert.equal(await storage.renameAuthoredGame(testProjectId("future-body"), "Changed"), false);
  assert.deepEqual(indexedDbRecords.get("future-body"), before);
});

test("reconciliation and conversation writes preserve future-version records", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  await storage.saveAuthoredGame(testProjectId("future-reconcile"), {
    title: "Current",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });
  const indexKey = storage.getStorageKey(testProjectId("future-reconcile"));
  const futureIndex = JSON.stringify({
    format: "monotio.agi.project-index",
    version: 2,
    storage: "indexeddb",
    privateFutureField: true,
  });
  values.set(indexKey, futureIndex);
  const bodyBeforeSave = structuredClone(indexedDbRecords.get("future-reconcile"));
  assert.equal(
    await storage.saveAuthoredGame(testProjectId("future-reconcile"), {
      title: "Replacement",
      provider: "stub",
      model: "stub",
      files: { "VOL.0": Uint8Array.of(2) },
      words: [],
    }),
    false,
  );
  assert.equal(values.get(indexKey), futureIndex);
  assert.deepEqual(indexedDbRecords.get("future-reconcile"), bodyBeforeSave);
  await storage.reconcileGameIndex();
  assert.equal(values.get(indexKey), futureIndex);

  const conversationKey = "conversation/future";
  const futureConversation = {
    projectId: conversationKey,
    format: "monotio.agi.conversation",
    version: 2,
    privateFutureField: true,
  };
  indexedDbRecords.set(conversationKey, futureConversation);
  await assert.rejects(
    storage.saveGameConversation("future", {
      provider: "stub",
      model: "stub",
      transcript: [],
      authoringState: {},
    }),
    /version/,
  );
  assert.deepEqual(indexedDbRecords.get(conversationKey), futureConversation);
});

test("unavailable IndexedDB fails clearly without creating a localStorage body", async (t) => {
  const values = new Map<string, string>();
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const databaseDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const errors: string[] = [];
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (databaseDescriptor) Object.defineProperty(globalThis, "indexedDB", databaseDescriptor);
  });
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  Reflect.deleteProperty(globalThis, "indexedDB");
  assert.equal(
    await storage.saveAuthoredGame(testProjectId("no-database"), {
      title: "Unsaved",
      provider: "stub",
      model: "stub",
      files: { "VOL.0": Uint8Array.of(1) },
      words: [],
    }),
    false,
  );
  assert.equal(values.size, 0);
  assert.match(errors.join("\n"), /Browser project storage is unavailable/);
});

test("previews survive metadata-only saves and invalidate when resource bytes change", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const preview = "data:image/png;base64,iVBORw0KGgo=";
  await storage.saveAuthoredGame(testProjectId("preview"), {
    title: "Preview",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });
  const storedPreview = indexedDbRecords.get("preview") as Record<string, unknown>;
  const library = storedPreview["library"] as Record<string, unknown>;
  storedPreview["library"] = {
    revision: library["revision"],
    source: library["source"],
    validation: library["validation"],
    additiveExtension: { retained: true },
    version: 1,
  };
  indexedDbRecords.set("preview", storedPreview);
  const revision = (await storage.loadAuthoredGame(testProjectId("preview")))!.library!.revision;
  assert.equal(
    await storage.updateGamePreview(testProjectId("preview"), revision, preview, {
      status: "ready",
      message: "Opening checked.",
      profile: "2.936",
    }),
    true,
  );
  await storage.updateGameConversation(testProjectId("preview"), [
    { role: "user", content: "hello" },
  ]);
  assert.deepEqual(
    (
      (indexedDbRecords.get("preview") as Record<string, unknown>)["library"] as Record<
        string,
        unknown
      >
    )["additiveExtension"],
    { retained: true },
  );
  assert.equal(
    (await storage.loadAuthoredGame(testProjectId("preview")))?.library?.preview,
    preview,
  );
  assert.equal(
    await storage.updateAuthoredGameFiles(testProjectId("preview"), { "VOL.0": Uint8Array.of(2) }),
    true,
  );
  const changed = (await storage.loadAuthoredGame(testProjectId("preview")))!;
  assert.equal(changed.library?.preview, undefined);
  assert.equal(changed.library?.validation.status, "unverified");
  assert.equal(
    await storage.updateGamePreview(
      testProjectId("preview"),
      changed.library!.revision,
      "https://example.com/tracker.png",
      { status: "ready", message: "Remote." },
    ),
    false,
  );
  assert.equal(
    await storage.updateGamePreview(
      testProjectId("preview"),
      changed.library!.revision,
      "data:image/png;base64,AAAA",
      { status: "ready", message: "Not really a PNG." },
    ),
    false,
  );
});

test("preview updates serialize revision verification with writes to the same game", async (t) => {
  const values = new Map<string, string>();
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  t.after(() => {
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  await storage.saveAuthoredGame(testProjectId("race"), {
    title: "Before",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });
  const revision = (await storage.loadAuthoredGame(testProjectId("race")))!.library!.revision;
  const preview = "data:image/png;base64,iVBORw0KGgo=";

  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let digestCalls = 0;
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      ...globalThis.crypto,
      subtle: {
        digest: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
          digestCalls++;
          if (digestCalls === 1) {
            markFirstStarted();
            await firstGate;
          }
          return digest(algorithm, data);
        },
      },
    },
  });

  const update = storage.updateGamePreview(testProjectId("race"), revision, preview, {
    status: "ready",
    message: "Opening checked.",
  });
  await firstStarted;
  const rename = storage.renameAuthoredGame(testProjectId("race"), "After");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const callsBeforeRelease = digestCalls;
  releaseFirst();
  assert.equal(await update, true);
  assert.equal(await rename, true);
  assert.equal(callsBeforeRelease, 1, "the rename waits for the in-flight revision check");
  const after = (await storage.loadAuthoredGame(testProjectId("race")))!;
  assert.equal(after.title, "After");
  assert.equal(after.library?.preview, preview);
});

test("released bodies load with normalized library text; identity checks re-hash", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  await storage.saveAuthoredGame(testProjectId("bounded"), {
    title: "Bounded",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });
  const body = indexedDbRecords.get("bounded") as Record<string, unknown>;
  const library = body["library"] as Record<string, unknown>;
  library["description"] = "d".repeat(700);
  library["additiveExtension"] = { retained: true };
  indexedDbRecords.set("bounded", body);
  const loaded = (await storage.loadAuthoredGame(testProjectId("bounded")))!;
  assert.equal(loaded.library?.description, "d".repeat(600));
  assert.deepEqual((loaded.library as unknown as Record<string, unknown>)["additiveExtension"], {
    retained: true,
  });

  // Resource bytes that drifted from the recorded revision still load; the
  // preview update, which must describe exact bytes, refuses them.
  const revision = loaded.library!.revision;
  (body["files"] as Record<string, Uint8Array>)["VOL.0"] = Uint8Array.of(7);
  indexedDbRecords.set("bounded", body);
  assert.deepEqual((await storage.loadAuthoredGame(testProjectId("bounded")))?.files, {
    "VOL.0": Uint8Array.of(7),
  });
  assert.equal(
    await storage.updateGamePreview(
      testProjectId("bounded"),
      revision,
      "data:image/png;base64,iVBORw0KGgo=",
      {
        status: "ready",
        message: "Opening checked.",
      },
    ),
    false,
  );

  library["revision"] = "not-a-revision";
  indexedDbRecords.set("bounded", body);
  await assert.rejects(
    storage.loadAuthoredGame(testProjectId("bounded")),
    /invalid library metadata/,
  );
  library["revision"] = revision;
  library["version"] = 2;
  indexedDbRecords.set("bounded", body);
  await assert.rejects(storage.loadAuthoredGame(testProjectId("bounded")), /version/);
});

test("format-less records are replaced while future versions stay untouched", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  indexedDbRecords.set("formatless", {
    projectId: testProjectId("formatless"),
    title: "Pre-release",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(9) },
    words: [],
  });
  assert.equal(
    await storage.saveAuthoredGame(testProjectId("formatless"), {
      title: "Replacement",
      provider: "stub",
      model: "stub",
      files: { "VOL.0": Uint8Array.of(1) },
      words: [],
    }),
    true,
  );
  assert.equal((await storage.loadAuthoredGame(testProjectId("formatless")))?.title, "Replacement");

  indexedDbRecords.set("conversation/formatless", {
    projectId: "conversation/formatless",
    transcript: [{ text: "pre-release" }],
  });
  const conversation = {
    provider: "stub",
    model: "stub",
    transcript: [{ text: "hello" }],
    authoringState: {},
  };
  await storage.saveGameConversation("formatless", conversation);
  assert.deepEqual(await storage.loadGameConversation("formatless"), conversation);
});

test("removing a library game clears its conversation, checkpoint, save slots and resume pointer", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  await storage.saveAuthoredGame(testProjectId("gone"), {
    title: "Gone",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });
  const conversation = {
    provider: "stub",
    model: "stub",
    transcript: [{ text: "hello" }],
    authoringState: {},
  };
  await storage.saveGameConversation("gone", conversation);
  assert.deepEqual(await storage.loadGameConversation("gone"), conversation);
  const checkpoint: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    image: "AAAA",
    cycle: 3,
    room: 1,
    savedAt: 1,
    game: {
      installed: false,
      identity: {
        project: testProjectId("gone"),
        revision: requireResourceRevision("0".repeat(64)),
      },
    },
  };
  assert.deepEqual(writeAutosave(localStorage, checkpoint), checkpoint);
  assert.equal(writeGameSave(localStorage, "gone", 1, "AAAA"), true);
  writeMapSidecar(localStorage, "gone", {
    journal: [],
    discovered: { rooms: {}, edges: [] },
    layout: { 3: { x: 10, y: 20 } },
    notes: {},
    edgeNotes: {},
  });
  assert.ok(localStorage.getItem(mapKey("gone")) !== null, "map record written");
  localStorage.setItem("monotio_agi.lastGame", "gone");

  await removeLibraryGame(testProjectId("gone"));
  assert.equal(await storage.loadAuthoredGame(testProjectId("gone")), null);
  assert.equal(storage.getCachedGameMeta(testProjectId("gone")), null);
  assert.equal(await storage.loadGameConversation("gone"), undefined, "conversation");
  assert.equal(readAutosave("gone"), null, "checkpoint");
  assert.deepEqual(readGameSaves(localStorage, "gone"), {}, "save slots");
  assert.equal(lastGameKey(), null, "resume pointer");
  assert.equal(localStorage.getItem(mapKey("gone")), null, "map record removed");
});

test("a database open that finishes after being blocked closes its abandoned connection", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
    else Reflect.deleteProperty(globalThis, "indexedDB");
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  t.mock.method(console, "error", () => {});
  let closed = 0;
  const request = {
    onblocked: null as (() => void) | null,
    onsuccess: null as (() => void) | null,
    result: {
      close: () => {
        closed++;
      },
      onversionchange: null,
    },
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        queueMicrotask(() => request.onblocked?.());
        return request;
      },
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {
        throw new Error("Must not publish an index");
      },
    },
  });
  const modulePath = "../src/gameStorage.ts?blocked-open";
  const fresh = await import(modulePath);
  assert.equal(
    await fresh.saveAuthoredGame("blocked", {
      title: "Blocked",
      provider: "stub",
      model: "offline-stub",
      files: { "VOL.0": Uint8Array.of(1) },
      words: [],
    }),
    false,
  );
  request.onsuccess?.();
  assert.equal(closed, 1);
});

test("concurrency conflict compare-and-swap preserves losing edits in stashedConflicts", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
    storage.clearStashedConflict(testProjectId("concurrent-project"));
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });

  // 1. Initial save produces generation 1
  assert.equal(
    await storage.saveAuthoredGame(testProjectId("concurrent-project"), {
      title: "Initial",
      provider: "stub",
      model: "stub",
      files: { "VOL.0": Uint8Array.of(1) },
      words: [],
    }),
    true,
  );
  const loaded1 = (await storage.loadAuthoredGame(testProjectId("concurrent-project")))!;
  assert.equal(loaded1.generation, 1);

  // 2. Tab A reads gen 1, Tab B reads gen 1
  // Tab B commits a rename, bumping generation to 2
  assert.equal(
    await storage.renameAuthoredGame(testProjectId("concurrent-project"), "Tab B Title", 1),
    true,
  );
  const loaded2 = (await storage.loadAuthoredGame(testProjectId("concurrent-project")))!;
  assert.equal(loaded2.generation, 2);
  assert.equal(loaded2.title, "Tab B Title");

  // 3. Tab A attempts to save with expectedGeneration 1 (now stale)
  t.mock.method(console, "error", () => {});
  const savedStale = await storage.saveAuthoredGame(
    testProjectId("concurrent-project"),
    {
      title: "Tab A Overwrite",
      provider: "stub",
      model: "stub",
      files: { "VOL.0": Uint8Array.of(2) },
      words: [],
    },
    { expectedGeneration: 1 },
  );
  assert.equal(savedStale, false);

  // Stored record still has Tab B's data
  const surviving = (await storage.loadAuthoredGame(testProjectId("concurrent-project")))!;
  assert.equal(surviving.title, "Tab B Title");
  assert.equal(surviving.generation, 2);

  // Losing writer's work is stashed for recovery
  const stashed = storage.getStashedConflict(testProjectId("concurrent-project"));
  assert.notEqual(stashed, undefined);
  assert.equal(stashed?.reason, "concurrency_conflict");
  assert.equal(stashed?.data.title, "Tab A Overwrite");
  assert.deepEqual(stashed?.data.files["VOL.0"], Uint8Array.of(2));
});

test("delete-vs-write conflict preserves write in stashedConflicts", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
    storage.clearStashedConflict(testProjectId("deleted-project"));
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });

  t.mock.method(console, "error", () => {});
  // Attempting to update a deleted project expecting generation 1
  const result = await storage.updateAuthoredGameFiles(
    testProjectId("deleted-project"),
    { "VOL.0": Uint8Array.of(99) },
    1,
  );
  assert.equal(result, false);
  // Stashed conflict recorded
  const stashed = storage.getStashedConflict(testProjectId("deleted-project"));
  assert.notEqual(stashed, undefined);
  assert.equal(stashed?.reason, "project_deleted");
});

test("templateId and generation are stored and read in metadata", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });

  await storage.saveAuthoredGame(testProjectId("template-proj-1"), {
    templateId: "adventure-starter",
    title: "My Adventure",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });

  const meta = storage.getCachedGameMeta(testProjectId("template-proj-1"));
  assert.notEqual(meta, null);
  assert.equal(meta?.templateId, "adventure-starter");
  assert.equal(meta?.generation, 1);

  const loaded = await storage.loadAuthoredGame(testProjectId("template-proj-1"));
  assert.notEqual(loaded, null);
  assert.equal(loaded?.templateId, "adventure-starter");
  assert.equal(loaded?.generation, 1);
});

test("reference writes persist under the generation check and leave files untouched", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const projectId = testProjectId("ref-project");
  await storage.saveAuthoredGame(projectId, {
    title: "Referenced",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(7, 8) },
    words: [],
  });
  const before = (await storage.loadAuthoredGame(projectId))!;
  const identity = { project: projectId, revision: requireResourceRevision("a".repeat(64)) };
  const reference = {
    id: "ref-1",
    kind: "room" as const,
    target: 2,
    brief: "a lighthouse",
    attachedAt: identity,
    images: [
      {
        png: "AQID",
        mime: "image/png",
        width: 4,
        height: 4,
        bytes: 3,
        facing: "right" as const,
      },
    ],
  };
  assert.equal(await storage.updateAuthoredReferences(projectId, [reference]), true);
  const attached = (await storage.loadAuthoredGame(projectId))!;
  assert.equal(attached.references?.length, 1);
  assert.equal(attached.references?.[0]?.id, "ref-1");
  // A reference write bumps the generation but never moves the playable files.
  assert.equal(attached.generation, (before.generation ?? 1) + 1);
  assert.deepEqual(attached.files, before.files);
  assert.equal(attached.library?.revision, before.library?.revision);
  // Malformed entries are dropped on read, not stored corrupt.
  assert.equal(
    await storage.updateAuthoredReferences(projectId, [
      reference,
      { id: 9 } as unknown as typeof reference,
    ]),
    true,
  );
  const normalized = (await storage.loadAuthoredGame(projectId))!;
  assert.equal(normalized.references?.length, 1);
  // Detach clears the list.
  assert.equal(await storage.updateAuthoredReferences(projectId, []), true);
  const detached = (await storage.loadAuthoredGame(projectId))!;
  assert.deepEqual(detached.references, []);
  // A missing project refuses the write.
  assert.equal(await storage.updateAuthoredReferences(testProjectId("absent-refs"), []), false);
});
