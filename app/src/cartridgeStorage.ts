import { parseWordsTok } from "../../src/logic/words.ts";
/**
 * IndexedDB project bodies with a lightweight localStorage metadata index.
 * Prevents loss of generated worlds across HMR, page refreshes, and browser sessions.
 */

import type { CachedCartridgeMeta, CachedCartridgeData } from "./cartridgeTypes.ts";
export type { CachedCartridgeMeta, CachedCartridgeData } from "./cartridgeTypes.ts";

interface StoredCartridgeJson extends CachedCartridgeMeta {
  filesBase64: Record<string, string>;
  words: [string, number][];
  transcript?: unknown[] | undefined;
  authoringState?: Record<string, unknown> | undefined;
  conversationHistory?: { provider: string; model: string; transcript: unknown[] }[] | undefined;
}

const STORAGE_PREFIX = "monotio_agi.authored.";

export interface GameConversation {
  provider: string;
  model: string;
  transcript: unknown[];
  sessionId?: string | undefined;
  authoringState: Record<string, unknown>;
}

/** Local discussions of installed games, without copying game resources into a project. */
export async function saveGameConversation(slug: string, context: GameConversation): Promise<void> {
  await bodyTransaction("readwrite", (store) =>
    store.put({ ...context, slug: `conversation/${slug}` }),
  );
}

export async function loadGameConversation(slug: string): Promise<GameConversation | undefined> {
  return bodyTransaction<GameConversation | undefined>("readonly", (store) =>
    store.get(`conversation/${slug}`),
  );
}

export function getStorageKey(slug: string): string {
  return `${STORAGE_PREFIX}${slug}`;
}

function legacySaveAuthoredCartridge(
  slug: string,
  data: {
    title: string;
    authoredAt?: string;
    provider: string;
    model: string;
    files: Record<string, Uint8Array>;
    words: [string, number][];
    transcript?: unknown[] | undefined;
    authoringState?: Record<string, unknown> | undefined;
    conversationHistory?: { provider: string; model: string; transcript: unknown[] }[] | undefined;
    sessionId?: string | undefined;
    imported?: boolean | undefined;
    roomGeneration?: boolean | undefined;
  },
): boolean {
  try {
    const filesBase64: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(data.files)) {
      let binary = "";
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]!);
      }
      filesBase64[name] = btoa(binary);
    }

    const payload: StoredCartridgeJson = {
      slug,
      title: data.title,
      authoredAt: data.authoredAt ?? new Date().toISOString(),
      provider: data.provider,
      model: data.model,
      sessionId: data.sessionId,
      imported: data.imported,
      roomGeneration: data.roomGeneration,
      authoringState: data.authoringState,
      conversationHistory: data.conversationHistory,
      filesBase64,
      words: data.words,
      transcript: data.transcript,
    };

    localStorage.setItem(getStorageKey(slug), JSON.stringify(payload));
    return true;
  } catch (e) {
    console.warn("Failed to persist authored cartridge to localStorage:", e);
    return false;
  }
}

export function getCachedCartridgeMeta(slug: string): CachedCartridgeMeta | null {
  try {
    const raw = localStorage.getItem(getStorageKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCartridgeJson;
    return {
      slug: parsed.slug || slug,
      title: parsed.title || slug,
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

function legacyLoadAuthoredCartridge(slug: string): CachedCartridgeData | null {
  try {
    const raw = localStorage.getItem(getStorageKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCartridgeJson;

    const files: Record<string, Uint8Array> = {};
    for (const [name, b64] of Object.entries(parsed.filesBase64 || {})) {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      files[name] = bytes;
    }

    return {
      slug: parsed.slug || slug,
      title: parsed.title || slug,
      authoredAt: parsed.authoredAt,
      provider: parsed.provider,
      model: parsed.model,
      sessionId: parsed.sessionId,
      imported: parsed.imported,
      roomGeneration: parsed.roomGeneration,
      files,
      words: parsed.words || [],
      transcript: parsed.transcript,
      authoringState: parsed.authoringState,
      conversationHistory: parsed.conversationHistory,
    };
  } catch (e) {
    console.warn("Failed to load cached cartridge from localStorage:", e);
    return null;
  }
}

export function listCachedCartridges(): CachedCartridgeMeta[] {
  try {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(STORAGE_PREFIX))
      .map((key) => getCachedCartridgeMeta(key.slice(STORAGE_PREFIX.length)))
      .filter((entry): entry is CachedCartridgeMeta => entry !== null)
      .sort((a, b) => b.authoredAt.localeCompare(a.authoredAt));
  } catch {
    return [];
  }
}

let database: Promise<IDBDatabase> | undefined;
const writes = new Map<string, Promise<unknown>>();
function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("monotio-agi-projects", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("projects", { keyPath: "slug" });
    request.onsuccess = () => resolve(request.result);
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
function metadata(data: CachedCartridgeData): CachedCartridgeMeta {
  return {
    slug: data.slug,
    title: data.title,
    authoredAt: data.authoredAt,
    provider: data.provider,
    model: data.model,
    sessionId: data.sessionId,
    imported: data.imported,
    roomGeneration: data.roomGeneration,
  };
}
async function readBody(slug: string): Promise<CachedCartridgeData | null> {
  const raw = localStorage.getItem(getStorageKey(slug));
  if (!raw) return null;
  const index = JSON.parse(raw);
  if (index.storage === "indexeddb") {
    const data = await bodyTransaction<CachedCartridgeData | undefined>("readonly", (store) =>
      store.get(slug),
    );
    if (!data)
      throw new Error(
        "The saved project data is unavailable. Open a downloaded project to recover it.",
      );
    return data;
  }
  const legacy = legacyLoadAuthoredCartridge(slug);
  if (legacy && typeof indexedDB !== "undefined") {
    // Commit the large body first. If migration fails, retain the original archive intact.
    await bodyTransaction("readwrite", (store) => store.put(legacy));
    localStorage.setItem(
      getStorageKey(slug),
      JSON.stringify({ ...metadata(legacy), storage: "indexeddb" }),
    );
  }
  return legacy;
}
async function writeBody(data: CachedCartridgeData): Promise<void> {
  if (typeof indexedDB === "undefined") {
    if (!legacySaveAuthoredCartridge(data.slug, data))
      throw new Error("Browser storage could not save the project.");
    return;
  }
  await bodyTransaction("readwrite", (store) => store.put(data));
  localStorage.setItem(
    getStorageKey(data.slug),
    JSON.stringify({ ...metadata(data), storage: "indexeddb" }),
  );
}
function serializeWrite<T>(slug: string, operation: () => Promise<T>): Promise<T> {
  const next = (writes.get(slug) ?? Promise.resolve()).catch(() => {}).then(operation);
  writes.set(slug, next);
  void next
    .finally(() => {
      if (writes.get(slug) === next) writes.delete(slug);
    })
    .catch(() => {});
  return next;
}
export async function loadAuthoredCartridge(slug: string): Promise<CachedCartridgeData | null> {
  await writes.get(slug);
  return readBody(slug);
}
export function saveAuthoredCartridge(
  slug: string,
  data: Omit<CachedCartridgeData, "slug" | "authoredAt">,
): Promise<boolean> {
  return serializeWrite(slug, async () => {
    try {
      await writeBody({ ...data, slug, authoredAt: new Date().toISOString() });
      return true;
    } catch (error) {
      console.error("Project storage failed:", error);
      return false;
    }
  });
}
export function updateAuthoredCartridgeFiles(
  slug: string,
  files: Record<string, Uint8Array>,
): Promise<boolean> {
  return serializeWrite(slug, async () => {
    try {
      const data = await readBody(slug);
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
export function updateCartridgeConversation(
  slug: string,
  transcript: unknown[],
  sessionId?: string,
  authoringState?: Record<string, unknown>,
  provider?: string,
  model?: string,
  files?: Record<string, Uint8Array>,
): Promise<boolean> {
  return serializeWrite(slug, async () => {
    try {
      const data = await readBody(slug);
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
export function renameAuthoredCartridge(slug: string, title: string): Promise<boolean> {
  return serializeWrite(slug, async () => {
    const name = title.trim();
    if (!name || name.length > 100) return false;
    try {
      const data = await readBody(slug);
      if (!data) return false;
      data.title = name;
      await writeBody(data);
      return true;
    } catch {
      return false;
    }
  });
}
export function clearCachedCartridge(slug: string): Promise<void> {
  return serializeWrite(slug, async () => {
    if (typeof indexedDB !== "undefined")
      await bodyTransaction("readwrite", (store) => store.delete(slug));
    localStorage.removeItem(getStorageKey(slug));
  });
}
