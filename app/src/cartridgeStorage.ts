import { parseWordsTok } from "../../src/logic/words.ts";
import { gameRevision, isLocalGamePreview, normalizeLibraryMetadata } from "./gameMetadata.ts";
/**
 * IndexedDB project bodies with a lightweight localStorage metadata index.
 * Prevents loss of generated worlds across HMR, page refreshes, and browser sessions.
 */

import type { CachedCartridgeMeta, CachedCartridgeData } from "./cartridgeTypes.ts";
export type { CachedCartridgeMeta, CachedCartridgeData } from "./cartridgeTypes.ts";

interface StoredCartridgeIndex extends CachedCartridgeMeta {
  format: "monotio.agi.project-index";
  version: 1;
  storage: "indexeddb";
}

interface StoredCartridgeBody extends CachedCartridgeData {
  format: "monotio.agi.project";
  version: 1;
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
  const key = `conversation/${slug}`;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    const existing = store.get(key);
    let contractError: Error | undefined;
    existing.onsuccess = () => {
      const value = existing.result as Record<string, unknown> | undefined;
      if (value && (value["format"] !== "monotio.agi.conversation" || value["version"] !== 1)) {
        contractError = new Error("This game conversation version is not supported by this app.");
        transaction.abort();
        return;
      }
      store.put({
        ...context,
        slug: key,
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

export async function loadGameConversation(slug: string): Promise<GameConversation | undefined> {
  const stored = await bodyTransaction<(GameConversation & Record<string, unknown>) | undefined>(
    "readonly",
    (store) => store.get(`conversation/${slug}`),
  );
  if (!stored) return undefined;
  if (stored["format"] !== "monotio.agi.conversation" || stored["version"] !== 1)
    throw new Error("This game conversation version is not supported by this app.");
  const { format: _format, version: _version, slug: _slug, ...context } = stored;
  return context as unknown as GameConversation;
}

export function getStorageKey(slug: string): string {
  return `${STORAGE_PREFIX}${slug}`;
}

export function getCachedCartridgeMeta(slug: string): CachedCartridgeMeta | null {
  try {
    const raw = localStorage.getItem(getStorageKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCartridgeIndex;
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
      /^[a-f0-9]{64}$/.test(libraryValue["revision"])
        ? normalizeLibraryMetadata(libraryValue, {
            gameId: slug,
            revision: libraryValue["revision"],
            source: parsed.imported ? "zip" : "authored",
          })
        : undefined;
    return {
      ...(library ? { library } : {}),
      slug: parsed.slug,
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

export function listCachedCartridges(): CachedCartridgeMeta[] {
  try {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(STORAGE_PREFIX))
      .map((key) => getCachedCartridgeMeta(key.slice(STORAGE_PREFIX.length)))
      .filter((entry): entry is CachedCartridgeMeta => entry !== null)
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
      request.result.createObjectStore("projects", { keyPath: "slug" });
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
async function writeCurrentBody(data: CachedCartridgeData): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    const existing = store.get(data.slug);
    let contractError: Error | undefined;
    existing.onsuccess = () => {
      const value = existing.result as Partial<StoredCartridgeBody> | undefined;
      if (value && (value.format !== "monotio.agi.project" || value.version !== 1)) {
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
function metadata(data: CachedCartridgeData): CachedCartridgeMeta {
  return {
    slug: data.slug,
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
function storedIndex(data: CachedCartridgeData): StoredCartridgeIndex {
  return {
    ...metadata(data),
    format: "monotio.agi.project-index",
    version: 1,
    storage: "indexeddb",
  };
}
function storedBody(data: CachedCartridgeData): StoredCartridgeBody {
  return { ...data, format: "monotio.agi.project", version: 1 };
}
function readStoredBody(raw: StoredCartridgeBody, slug: string): CachedCartridgeData {
  if (raw.format !== "monotio.agi.project" || raw.version !== 1)
    throw new Error("This saved project version is not supported by this app.");
  if (raw.slug !== slug) throw new Error("The saved project identity does not match its index.");
  const { format: _format, version: _version, ...data } = raw;
  return data;
}
async function readBody(slug: string): Promise<CachedCartridgeData | null> {
  const raw = localStorage.getItem(getStorageKey(slug));
  if (!raw) return null;
  const index = JSON.parse(raw) as Record<string, unknown>;
  if (
    index["format"] !== "monotio.agi.project-index" ||
    index["version"] !== 1 ||
    index["storage"] !== "indexeddb"
  )
    throw new Error("This saved project version is not supported by this app.");
  const stored = await bodyTransaction<StoredCartridgeBody | undefined>("readonly", (store) =>
    store.get(slug),
  );
  if (!stored)
    throw new Error(
      "The saved project data is unavailable. Open a downloaded project to recover it.",
    );
  const data = readStoredBody(stored, slug);
  if (!data.library) throw new Error("The saved project has invalid library metadata.");
  const normalized = normalizeLibraryMetadata(data.library, {
    gameId: data.library.gameId,
    revision: data.library.revision,
    source: data.library.source,
  });
  const sameParent =
    normalized.parent?.gameId === data.library.parent?.gameId &&
    normalized.parent?.revision === data.library.parent?.revision;
  const sameCatalog =
    normalized.catalog?.id === data.library.catalog?.id &&
    normalized.catalog?.version === data.library.catalog?.version;
  const sameValidation =
    normalized.validation.status === data.library.validation?.status &&
    normalized.validation.message === data.library.validation?.message &&
    normalized.validation.profile === data.library.validation?.profile;
  if (
    normalized.gameId !== data.library.gameId ||
    normalized.revision !== data.library.revision ||
    normalized.source !== data.library.source ||
    normalized.description !== data.library.description ||
    normalized.author !== data.library.author ||
    normalized.license !== data.library.license ||
    normalized.preview !== data.library.preview ||
    !sameParent ||
    !sameCatalog ||
    !sameValidation
  )
    throw new Error("The saved project has invalid library metadata.");
  if ((await gameRevision(data.files)) !== data.library.revision)
    throw new Error("The saved project resources do not match their recorded revision.");
  return data;
}
async function stampLibraryMetadata(
  data: CachedCartridgeData,
  protectCatalog: boolean,
): Promise<boolean> {
  const revision = await gameRevision(data.files);
  const previous = data.library;
  if (protectCatalog && previous?.source === "catalog" && previous.revision !== revision)
    throw new Error("Catalog resources are immutable. Create a remix before changing them.");
  const next = normalizeLibraryMetadata(previous, {
    gameId: data.slug,
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
async function writeBody(data: CachedCartridgeData): Promise<void> {
  const existingIndex = localStorage.getItem(getStorageKey(data.slug));
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
  localStorage.setItem(getStorageKey(data.slug), JSON.stringify(storedIndex(data)));
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
  return serializeWrite(slug, () => readBody(slug));
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
    await bodyTransaction("readwrite", (store) => store.delete(slug));
    localStorage.removeItem(getStorageKey(slug));
  });
}

/** Store a newly checked preview only if it describes the exact current revision. */
export function updateCartridgePreview(
  slug: string,
  revision: string,
  preview: string,
  validation: NonNullable<CachedCartridgeMeta["library"]>["validation"],
): Promise<boolean> {
  return serializeWrite(slug, async () => {
    const data = await readBody(slug);
    if (!data || !isLocalGamePreview(preview) || (await gameRevision(data.files)) !== revision)
      return false;
    data.library = {
      ...(data.library ?? {
        version: 1,
        gameId: slug,
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
export async function reconcileCartridgeIndex(): Promise<void> {
  const bodies = await bodyTransaction<StoredCartridgeBody[]>("readonly", (store) =>
    store.getAll(),
  );
  const slugs = bodies
    .filter(
      (data) =>
        data.format === "monotio.agi.project" &&
        data.version === 1 &&
        typeof data.slug === "string" &&
        !data.slug.startsWith("conversation/") &&
        data.files &&
        typeof data.files === "object",
    )
    .map((data) => data.slug);
  for (const slug of slugs) {
    await serializeWrite(slug, async () => {
      const stored = await bodyTransaction<StoredCartridgeBody | undefined>("readonly", (store) =>
        store.get(slug),
      );
      if (!stored) return;
      const data = readStoredBody(stored, slug);
      if (!data.library) return;
      const current = localStorage.getItem(getStorageKey(data.slug));
      if (current) {
        try {
          const parsed = JSON.parse(current) as Record<string, unknown>;
          if (parsed["format"] === "monotio.agi.project-index" && parsed["version"] !== 1) return;
        } catch {
          return;
        }
      }
      localStorage.setItem(getStorageKey(data.slug), JSON.stringify(storedIndex(data)));
    });
  }
  for (const key of Object.keys(localStorage).filter((key) => key.startsWith(STORAGE_PREFIX))) {
    const slug = key.slice(STORAGE_PREFIX.length);
    await serializeWrite(slug, async () => {
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
      const data = await bodyTransaction<StoredCartridgeBody | undefined>("readonly", (store) =>
        store.get(slug),
      );
      if (!data) localStorage.removeItem(key);
    });
  }
}
