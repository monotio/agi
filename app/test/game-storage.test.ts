import assert from "node:assert/strict";
import { test } from "node:test";
import * as storage from "../src/gameStorage.ts";
import { readGameSaves, writeGameSave } from "../src/gameSaves.ts";
import {
  lastGameId,
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
  await storage.saveAuthoredGame("custom", {
    title: "Custom Adventure",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1, 2, 3) },
    words: [],
    transcript: [{ text: "Original" }],
  });
  const original = (await storage.loadAuthoredGame("custom"))!;
  const gameId = original.library?.gameId;
  assert.equal(await storage.renameAuthoredGame("custom", "  My adventure  "), true);
  assert.deepEqual(await storage.loadAuthoredGame("custom"), {
    ...original,
    title: "My adventure",
  });
  assert.equal((await storage.loadAuthoredGame("custom"))?.library?.gameId, gameId);
  assert.equal(await storage.renameAuthoredGame("custom", "   "), false);
  assert.equal(await storage.renameAuthoredGame("absent", "New title"), false);
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
    storage.getStorageKey("old-project"),
    JSON.stringify({
      gameId: "old-project",
      title: "Old project",
      authoredAt: "2025-01-01T00:00:00.000Z",
      provider: "stub",
      model: "stub",
      filesBase64: { "VOL.0": btoa("old") },
      words: [],
    }),
  );
  await assert.rejects(storage.loadAuthoredGame("old-project"), /version/);
  assert.equal(storage.getCachedGameMeta("old-project"), null);
  assert.match(values.get(storage.getStorageKey("old-project"))!, /filesBase64/);
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
  const key = storage.getStorageKey("future-index");
  const futureIndex = JSON.stringify({
    format: "monotio.agi.project-index",
    version: 2,
    storage: "indexeddb",
  });
  values.set(key, futureIndex);
  await assert.rejects(storage.loadAuthoredGame("future-index"), /version/);
  assert.equal(await storage.renameAuthoredGame("future-index", "Changed"), false);
  assert.equal(values.get(key), futureIndex);

  await storage.saveAuthoredGame("future-body", {
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
  await assert.rejects(storage.loadAuthoredGame("future-body"), /version/);
  assert.equal(await storage.renameAuthoredGame("future-body", "Changed"), false);
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
  await storage.saveAuthoredGame("future-reconcile", {
    title: "Current",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });
  const indexKey = storage.getStorageKey("future-reconcile");
  const futureIndex = JSON.stringify({
    format: "monotio.agi.project-index",
    version: 2,
    storage: "indexeddb",
    privateFutureField: true,
  });
  values.set(indexKey, futureIndex);
  const bodyBeforeSave = structuredClone(indexedDbRecords.get("future-reconcile"));
  assert.equal(
    await storage.saveAuthoredGame("future-reconcile", {
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
    gameId: conversationKey,
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
    await storage.saveAuthoredGame("no-database", {
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
  await storage.saveAuthoredGame("preview", {
    title: "Preview",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });
  const storedPreview = indexedDbRecords.get("preview") as Record<string, unknown>;
  const library = storedPreview["library"] as Record<string, unknown>;
  storedPreview["library"] = {
    gameId: library["gameId"],
    revision: library["revision"],
    source: library["source"],
    validation: library["validation"],
    additiveExtension: { retained: true },
    version: 1,
  };
  indexedDbRecords.set("preview", storedPreview);
  const revision = (await storage.loadAuthoredGame("preview"))!.library!.revision;
  assert.equal(
    await storage.updateGamePreview("preview", revision, preview, {
      status: "ready",
      message: "Opening checked.",
      profile: "2.936",
    }),
    true,
  );
  await storage.updateGameConversation("preview", [{ role: "user", content: "hello" }]);
  assert.deepEqual(
    (
      (indexedDbRecords.get("preview") as Record<string, unknown>)["library"] as Record<
        string,
        unknown
      >
    )["additiveExtension"],
    { retained: true },
  );
  assert.equal((await storage.loadAuthoredGame("preview"))?.library?.preview, preview);
  assert.equal(
    await storage.updateAuthoredGameFiles("preview", { "VOL.0": Uint8Array.of(2) }),
    true,
  );
  const changed = (await storage.loadAuthoredGame("preview"))!;
  assert.equal(changed.library?.preview, undefined);
  assert.equal(changed.library?.validation.status, "unverified");
  assert.equal(
    await storage.updateGamePreview(
      "preview",
      changed.library!.revision,
      "https://example.com/tracker.png",
      { status: "ready", message: "Remote." },
    ),
    false,
  );
  assert.equal(
    await storage.updateGamePreview(
      "preview",
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
  await storage.saveAuthoredGame("race", {
    title: "Before",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1) },
    words: [],
  });
  const revision = (await storage.loadAuthoredGame("race"))!.library!.revision;
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

  const update = storage.updateGamePreview("race", revision, preview, {
    status: "ready",
    message: "Opening checked.",
  });
  await firstStarted;
  const rename = storage.renameAuthoredGame("race", "After");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const callsBeforeRelease = digestCalls;
  releaseFirst();
  assert.equal(await update, true);
  assert.equal(await rename, true);
  assert.equal(callsBeforeRelease, 1, "the rename waits for the in-flight revision check");
  const after = (await storage.loadAuthoredGame("race"))!;
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
  await storage.saveAuthoredGame("bounded", {
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
  const loaded = (await storage.loadAuthoredGame("bounded"))!;
  assert.equal(loaded.library?.description, "d".repeat(600));
  assert.deepEqual((loaded.library as unknown as Record<string, unknown>)["additiveExtension"], {
    retained: true,
  });

  // Resource bytes that drifted from the recorded revision still load; the
  // preview update, which must describe exact bytes, refuses them.
  const revision = loaded.library!.revision;
  (body["files"] as Record<string, Uint8Array>)["VOL.0"] = Uint8Array.of(7);
  indexedDbRecords.set("bounded", body);
  assert.deepEqual((await storage.loadAuthoredGame("bounded"))?.files, {
    "VOL.0": Uint8Array.of(7),
  });
  assert.equal(
    await storage.updateGamePreview("bounded", revision, "data:image/png;base64,iVBORw0KGgo=", {
      status: "ready",
      message: "Opening checked.",
    }),
    false,
  );

  library["revision"] = "not-a-revision";
  indexedDbRecords.set("bounded", body);
  await assert.rejects(storage.loadAuthoredGame("bounded"), /invalid library metadata/);
  library["revision"] = revision;
  library["version"] = 2;
  indexedDbRecords.set("bounded", body);
  await assert.rejects(storage.loadAuthoredGame("bounded"), /version/);
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
    projectId: "formatless",
    title: "Pre-release",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(9) },
    words: [],
  });
  assert.equal(
    await storage.saveAuthoredGame("formatless", {
      title: "Replacement",
      provider: "stub",
      model: "stub",
      files: { "VOL.0": Uint8Array.of(1) },
      words: [],
    }),
    true,
  );
  assert.equal((await storage.loadAuthoredGame("formatless"))?.title, "Replacement");

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
  await storage.saveAuthoredGame("gone", {
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
    game: { projectId: "gone", installed: false, revision: "0".repeat(64) },
  };
  assert.deepEqual(writeAutosave(localStorage, checkpoint), checkpoint);
  assert.equal(writeGameSave(localStorage, "gone", 1, "AAAA"), true);
  localStorage.setItem("monotio_agi.lastGame", "gone");

  await removeLibraryGame("gone");
  assert.equal(await storage.loadAuthoredGame("gone"), null);
  assert.equal(storage.getCachedGameMeta("gone"), null);
  assert.equal(await storage.loadGameConversation("gone"), undefined, "conversation");
  assert.equal(readAutosave("gone"), null, "checkpoint");
  assert.deepEqual(readGameSaves(localStorage, "gone"), {}, "save slots");
  assert.equal(lastGameId(), null, "resume pointer");
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
