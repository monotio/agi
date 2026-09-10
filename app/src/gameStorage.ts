import { parseWordsTok } from "../../src/logic/words.ts";
import {
  gameRevision,
  isLocalGamePreview,
  normalizeLibraryMetadata,
  type LibraryMetadata,
} from "./gameMetadata.ts";
/**
 * IndexedDB project bodies with a lightweight localStorage metadata index.
 * Prevents loss of generated worlds across HMR, page refreshes, and browser sessions.
 */

import type { CachedGameMeta, CachedGameData } from "./gameTypes.ts";
export type { CachedGameMeta, CachedGameData } from "./gameTypes.ts";

interface StoredGameIndex extends CachedGameMeta {
  format: "monotio.agi.project-index";
  version: 1;
  storage: "indexeddb";
}

interface StoredGameBody extends CachedGameData {
  format: "monotio.agi.project";
  version: 1;
}

const STORAGE_PREFIX = "monotio_agi.authored.";
const SHA256 = /^[a-f0-9]{64}$/;
/** Every released library field; a version-1 reader keeps anything else as an additive extension. */
const LIBRARY_FIELDS: Record<keyof LibraryMetadata, true> = {
  version: true,
  gameId: true,
  revision: true,
  source: true,
  catalog: true,
  preview: true,
  validation: true,
  description: true,
  author: true,
  license: true,
  parent: true,
};

export interface GameConversation {
  provider: string;
  model: string;
  transcript: unknown[];
  sessionId?: string | undefined;
  authoringState: Record<string, unknown>;
}

/** Local discussions of installed games, without copying game resources into a project. */
export async function saveGameConversation(
  gameId: string,
  context: GameConversation,
): Promise<void> {
  const key = `conversation/${gameId}`;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    const existing = store.get(key);
    let contractError: Error | undefined;
    existing.onsuccess = () => {
      const value = existing.result as Record<string, unknown> | undefined;
      // Only a record this release recognises as newer is protected; a
      // format-less pre-release record is replaced rather than blocking saves.
      if (value && value["format"] === "monotio.agi.conversation" && value["version"] !== 1) {
        contractError = new Error("This game conversation version is not supported by this app.");
        transaction.abort();
        return;
      }
      store.put({
        ...context,
        gameId: key,
        format: "monotio.agi.conversation",
        version: 1,
      });
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(contractError ?? transaction.error);
    transaction.onabort = () =>
      reject(
        contractError ?? transaction.error ?? new Error("Project storage transaction aborted."),
      );
  });
}

export async function loadGameConversation(gameId: string): Promise<GameConversation | undefined> {
  const stored = await bodyTransaction<(GameConversation & Record<string, unknown>) | undefined>(
    "readonly",
    (store) => store.get(`conversation/${gameId}`),
  );
  if (!stored) return undefined;
  if (stored["format"] !== "monotio.agi.conversation" || stored["version"] !== 1)
    throw new Error("This game conversation version is not supported by this app.");
  const { format: _format, version: _version, gameId: _gameId, ...context } = stored;
  return context as unknown as GameConversation;
}

export function getStorageKey(gameId: string): string {
  return `${STORAGE_PREFIX}${gameId}`;
}

export function getCachedGameMeta(gameId: string): CachedGameMeta | null {
  try {
    const raw = localStorage.getItem(getStorageKey(gameId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredGameIndex;
    if (
      parsed.format !== "monotio.agi.project-index" ||
      parsed.version !== 1 ||
      parsed.storage !== "indexeddb"
    )
      return null;
    const libraryValue = parsed.library as unknown as Record<string, unknown> | undefined;
    const library =
      libraryValue?.["version"] === 1 &&
      typeof libraryValue["revision"] === "string" &&
      SHA256.test(libraryValue["revision"])
        ? normalizeLibraryMetadata(libraryValue, {
            gameId,
            revision: libraryValue["revision"],
            source: parsed.imported ? "zip" : "authored",
          })
        : undefined;
    const effectiveGameId = parsed.gameId ?? gameId;
    return {
      ...(library ? { library } : {}),
      gameId: effectiveGameId,
      title: parsed.title,
      authoredAt: parsed.authoredAt,
      provider: parsed.provider,
      model: parsed.model,
      sessionId: parsed.sessionId,
      imported: parsed.imported,
      roomGeneration: parsed.roomGeneration,
    };
  } catch {
    return null;
  }
}

export function listCachedGames(): CachedGameMeta[] {
  try {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(STORAGE_PREFIX))
      .map((key) => getCachedGameMeta(key.slice(STORAGE_PREFIX.length)))
      .filter((entry): entry is CachedGameMeta => entry !== null)
      .sort((a, b) => (b.authoredAt ?? "").localeCompare(a.authoredAt ?? ""));
  } catch {
    return [];
  }
}

let database: Promise<IDBDatabase> | undefined;
const writes = new Map<string, Promise<unknown>>();
function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined")
    return Promise.reject(
      new Error("Browser project storage is unavailable. Enable site storage and try again."),
    );
  database ??= new Promise((resolve, reject) => {
    let abandoned = false;
    const request = indexedDB.open("monotio-agi-projects", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("projects", { keyPath: "gameId" });
    request.onsuccess = () => {
      const opened = request.result;
      if (abandoned) {
        opened.close();
        return;
      }
      opened.onversionchange = () => {
        opened.close();
        database = undefined;
      };
      resolve(opened);
    };
    request.onblocked = () => {
      abandoned = true;
      database = undefined;
      reject(
        new Error(
          "Project storage is open in another tab. Close or reload that tab, then try again.",
        ),
      );
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  });
  return database.catch((error) => {
    database = undefined;
    throw error;
  });
}
async function bodyTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("projects", mode);
    const request = operation(transaction.objectStore("projects"));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? request.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Project storage transaction aborted."));
  });
}
async function writeCurrentBody(data: CachedGameData): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    const existing = store.get(data.gameId);
    let contractError: Error | undefined;
    existing.onsuccess = () => {
      const value = existing.result as Partial<StoredGameBody> | undefined;
      if (value && value.format === "monotio.agi.project" && value.version !== 1) {
        contractError = new Error("This saved project version is not supported by this app.");
        transaction.abort();
        return;
      }
      store.put(storedBody(data));
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(contractError ?? transaction.error);
    transaction.onabort = () =>
      reject(
        contractError ?? transaction.error ?? new Error("Project storage transaction aborted."),
      );
  });
}
function metadata(data: CachedGameData): CachedGameMeta {
  return {
    gameId: data.gameId,
    library: data.library,
    title: data.title,
    authoredAt: data.authoredAt,
    provider: data.provider,
    model: data.model,
    sessionId: data.sessionId,
    imported: data.imported,
    roomGeneration: data.roomGeneration,
  };
}
function storedIndex(data: CachedGameData): StoredGameIndex {
  return {
    ...metadata(data),
    format: "monotio.agi.project-index",
    version: 1,
    storage: "indexeddb",
  };
}
function storedBody(data: CachedGameData): StoredGameBody {
  return { ...data, format: "monotio.agi.project", version: 1 };
}
function readStoredBody(raw: StoredGameBody, gameId: string): CachedGameData {
  if (raw.format !== "monotio.agi.project" || raw.version !== 1)
    throw new Error("This saved project version is not supported by this app.");
  const storedId = raw.gameId;
  if (storedId !== gameId) throw new Error("The saved project identity does not match its index.");
  const { format: _format, version: _version, ...data } = raw;
  return { ...data, gameId };
}
async function readBody(gameId: string): Promise<CachedGameData | null> {
  const raw = localStorage.getItem(getStorageKey(gameId));
  if (!raw) return null;
  const index = JSON.parse(raw) as Record<string, unknown>;
  if (
    index["format"] !== "monotio.agi.project-index" ||
    index["version"] !== 1 ||
    index["storage"] !== "indexeddb"
  )
    throw new Error("This saved project version is not supported by this app.");
  const stored = await bodyTransaction<StoredGameBody | undefined>("readonly", (store) =>
    store.get(gameId),
  );
  if (!stored)
    throw new Error(
      "The saved project data is unavailable. Open a downloaded project to recover it.",
    );
  const data = readStoredBody(stored, gameId);
  data.library = readLibrary(data);
  return data;
}
/**
 * Version 1 is released: a reader checks the record's shape and takes the
 * normalized values (bounded text, known enums, local previews), never the
 * exact bytes, so tightening a bound later cannot orphan a saved project.
 * Resource hashes are verified where identity matters — preview updates and
 * resume — not on every load.
 */
function readLibrary(data: CachedGameData): LibraryMetadata {
  const raw = data.library as unknown as Record<string, unknown> | undefined;
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw["revision"] !== "string" ||
    !SHA256.test(raw["revision"])
  )
    throw new Error("The saved project has invalid library metadata.");
  const normalized = normalizeLibraryMetadata(raw, {
    gameId: data.gameId,
    revision: raw["revision"],
    source: data.imported ? "zip" : "authored",
  });
  const library: Record<string, unknown> = { ...normalized };
  for (const [key, value] of Object.entries(raw))
    if (!Object.hasOwn(LIBRARY_FIELDS, key)) library[key] = value;
  return library as unknown as LibraryMetadata;
}
async function stampLibraryMetadata(
  data: CachedGameData,
  protectCatalog: boolean,
): Promise<boolean> {
  const revision = await gameRevision(data.files);
  const previous = data.library;
  if (protectCatalog && previous?.source === "catalog" && previous.revision !== revision)
    throw new Error("Catalog resources are immutable. Create a remix before changing them.");
  const next = normalizeLibraryMetadata(previous, {
    gameId: data.gameId,
    revision,
    source: data.imported ? "zip" : "authored",
  });
  next.revision = revision;
  if (!previous || previous.revision !== revision) {
    delete next.preview;
    next.validation = previous
      ? {
          status: "unverified",
          message: "Resources changed. Check the opening again to refresh its preview.",
        }
      : { status: "unverified", message: "Opening not checked yet." };
  }
  const merged = { ...previous, ...next };
  if (!previous || previous.revision !== revision) delete merged.preview;
  const changed = JSON.stringify(previous) !== JSON.stringify(merged);
  data.library = merged;
  return changed;
}
async function writeBody(data: CachedGameData): Promise<void> {
  const existingIndex = localStorage.getItem(getStorageKey(data.gameId));
  if (existingIndex) {
    let index: Record<string, unknown>;
    try {
      index = JSON.parse(existingIndex) as Record<string, unknown>;
    } catch {
      throw new Error("The saved project index is invalid and was left unchanged.");
    }
    if (
      index["format"] !== "monotio.agi.project-index" ||
      index["version"] !== 1 ||
      index["storage"] !== "indexeddb"
    )
      throw new Error("This saved project version is not supported by this app.");
  }
  await stampLibraryMetadata(data, true);
  await writeCurrentBody(data);
  localStorage.setItem(getStorageKey(data.gameId), JSON.stringify(storedIndex(data)));
}
function serializeWrite<T>(gameId: string, operation: () => Promise<T>): Promise<T> {
  const next = (writes.get(gameId) ?? Promise.resolve()).catch(() => {}).then(operation);
  writes.set(gameId, next);
  void next;
  writes.set(gameId, next);
  void next
    .finally(() => {
      if (writes.get(gameId) === next) writes.delete(gameId);
    })
    .catch(() => {});
  return next;
}
export async function loadAuthoredGame(gameId: string): Promise<CachedGameData | null> {
  return serializeWrite(gameId, () => readBody(gameId));
}

export function saveAuthoredGame(
  gameId: string,
  data: Omit<CachedGameData, "gameId" | "authoredAt">,
): Promise<boolean> {
  return serializeWrite(gameId, async () => {
    try {
      await writeBody({ ...data, gameId, authoredAt: new Date().toISOString() });
      return true;
    } catch (error) {
      console.error("Project storage failed:", error);
      return false;
    }
  });
}

export function updateAuthoredGameFiles(
  gameId: string,
  files: Record<string, Uint8Array>,
): Promise<boolean> {
  return serializeWrite(gameId, async () => {
    try {
      const data = await readBody(gameId);
      if (!data) return false;
      data.files = files;
      if (files["WORDS.TOK"])
        data.words = parseWordsTok(files["WORDS.TOK"]).map(({ word, id }) => [word, id]);
      await writeBody(data);
      return true;
    } catch (error) {
      console.error("Project autosave failed:", error);
      return false;
    }
  });
}

export function updateGameConversation(
  gameId: string,
  transcript: unknown[],
  sessionId?: string,
  authoringState?: Record<string, unknown>,
  provider?: string,
  model?: string,
  files?: Record<string, Uint8Array>,
): Promise<boolean> {
  return serializeWrite(gameId, async () => {
    try {
      const data = await readBody(gameId);
      if (!data) return false;
      if (
        provider &&
        (provider !== data.provider || (model && model !== data.model)) &&
        data.transcript?.length
      )
        data.conversationHistory = [
          ...(data.conversationHistory ?? []),
          { provider: data.provider, model: data.model, transcript: data.transcript },
        ];
      data.transcript = transcript;
      data.sessionId = sessionId;
      if (authoringState) data.authoringState = authoringState;
      if (provider) data.provider = provider;
      if (model) data.model = model;
      if (files) {
        data.files = files;
        if (files["WORDS.TOK"])
          data.words = parseWordsTok(files["WORDS.TOK"]).map(({ word, id }) => [word, id]);
      }
      await writeBody(data);
      return true;
    } catch (error) {
      console.error("Conversation save failed:", error);
      return false;
    }
  });
}

export function renameAuthoredGame(gameId: string, title: string): Promise<boolean> {
  return serializeWrite(gameId, async () => {
    const name = title.trim();
    if (!name || name.length > 100) return false;
    try {
      const data = await readBody(gameId);
      if (!data) return false;
      data.title = name;
      await writeBody(data);
      return true;
    } catch {
      return false;
    }
  });
}

export function clearCachedGame(gameId: string): Promise<void> {
  return serializeWrite(gameId, async () => {
    // The body and its conversation leave together: gameIds are deterministic,
    // so a game added again must not inherit the removed one's history.
    await bodyTransaction("readwrite", (store) => {
      store.delete(`conversation/${gameId}`);
      return store.delete(gameId);
    });
    localStorage.removeItem(getStorageKey(gameId));
  });
}

/** Store a newly checked preview only if it describes the exact current revision. */
export function updateGamePreview(
  gameId: string,
  revision: string,
  preview: string,
  validation: NonNullable<CachedGameMeta["library"]>["validation"],
): Promise<boolean> {
  return serializeWrite(gameId, async () => {
    const data = await readBody(gameId);
    if (!data || !isLocalGamePreview(preview) || (await gameRevision(data.files)) !== revision)
      return false;
    data.library = {
      ...(data.library ?? {
        version: 1,
        gameId,
        revision,
        source: data.imported ? "zip" : "authored",
      }),
      preview,
      validation,
    };
    await writeBody(data);
    return true;
  });
}

/** Rebuild the disposable index from committed IndexedDB bodies after an interrupted write. */
export async function reconcileGameIndex(): Promise<void> {
  const bodies = await bodyTransaction<StoredGameBody[]>("readonly", (store) => store.getAll());
  const gameIds = bodies
    .filter(
      (data) =>
        data.format === "monotio.agi.project" &&
        data.version === 1 &&
        typeof data.gameId === "string" &&
        !data.gameId.startsWith("conversation/") &&
        data.files &&
        typeof data.files === "object",
    )
    .map((data) => data.gameId);
  for (const gameId of gameIds) {
    await serializeWrite(gameId, async () => {
      const stored = await bodyTransaction<StoredGameBody | undefined>("readonly", (store) =>
        store.get(gameId),
      );
      if (!stored) return;
      const data = readStoredBody(stored, gameId);
      if (!data.library) return;
      const current = localStorage.getItem(getStorageKey(data.gameId));
      if (current) {
        try {
          const parsed = JSON.parse(current) as Record<string, unknown>;
          if (parsed["format"] === "monotio.agi.project-index" && parsed["version"] !== 1) return;
        } catch {
          return;
        }
      }
      localStorage.setItem(getStorageKey(data.gameId), JSON.stringify(storedIndex(data)));
    });
  }
  for (const key of Object.keys(localStorage).filter((key) => key.startsWith(STORAGE_PREFIX))) {
    const gameId = key.slice(STORAGE_PREFIX.length);
    await serializeWrite(gameId, async () => {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      let index: Record<string, unknown>;
      try {
        index = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Leave unrelated legacy data recoverable.
        return;
      }
      if (
        index["format"] !== "monotio.agi.project-index" ||
        index["version"] !== 1 ||
        index["storage"] !== "indexeddb"
      )
        return;
      const data = await bodyTransaction<StoredGameBody | undefined>("readonly", (store) =>
        store.get(gameId),
      );
      if (!data) localStorage.removeItem(key);
    });
  }
}
