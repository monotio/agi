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
export type { CachedGameMeta, CachedGameData, ProjectId } from "./gameTypes.ts";

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
/** Every recognized library field; a version-1 reader keeps anything else as an additive extension. */
const LIBRARY_FIELDS: Record<keyof LibraryMetadata, true> = {
  version: true,
  alias: true,
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
  projectId: string,
  context: GameConversation,
): Promise<void> {
  const key = `conversation/${projectId}`;
  await putVersionedRecord(
    key,
    {
      ...context,
      projectId: key,
      format: "monotio.agi.conversation",
      version: 1,
    },
    "This game conversation version is not supported by this app.",
  );
}

export async function loadGameConversation(
  projectId: string,
): Promise<GameConversation | undefined> {
  const stored = await bodyTransaction<(GameConversation & Record<string, unknown>) | undefined>(
    "readonly",
    (store) => store.get(`conversation/${projectId}`),
  );
  if (!stored) return undefined;
  if (stored["format"] !== "monotio.agi.conversation" || stored["version"] !== 1)
    throw new Error("This game conversation version is not supported by this app.");
  const { format: _format, version: _version, projectId: _projectId, ...context } = stored;
  return context as unknown as GameConversation;
}

export function getStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

export function getCachedGameMeta(projectId: string): CachedGameMeta | null {
  try {
    const raw = localStorage.getItem(getStorageKey(projectId));
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
            revision: libraryValue["revision"],
            source: parsed.imported ? "zip" : "authored",
          })
        : undefined;
    const effectiveProjectId = parsed.projectId ?? projectId;
    return {
      ...(library ? { library } : {}),
      projectId: effectiveProjectId,
      ...(parsed.templateId ? { templateId: parsed.templateId } : {}),
      ...(typeof parsed.generation === "number" ? { generation: parsed.generation } : {}),
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
      request.result.createObjectStore("projects", { keyPath: "projectId" });
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
export class ConcurrencyConflictError extends Error {
  readonly currentRecord?: StoredGameBody | undefined;
  constructor(message: string, currentRecord?: StoredGameBody) {
    super(message);
    this.name = "ConcurrencyConflictError";
    this.currentRecord = currentRecord;
  }
}

export class ProjectDeletedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectDeletedError";
  }
}

export class ProjectExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectExistsError";
  }
}

export interface StashedConflict {
  projectId: string;
  data: CachedGameData;
  stashedAt: string;
  reason: "concurrency_conflict" | "project_deleted";
  error: Error;
}

const stashedConflicts = new Map<string, StashedConflict>();

export function getStashedConflict(projectId: string): StashedConflict | undefined {
  return stashedConflicts.get(projectId);
}

export function clearStashedConflict(projectId: string): void {
  stashedConflicts.delete(projectId);
}

async function putVersionedRecord<T extends { format: string; version: number }>(
  key: string,
  record: T,
  versionError: string,
): Promise<void> {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    const existing = store.get(key);
    let contractError: Error | undefined;
    existing.onsuccess = () => {
      const value = existing.result as Record<string, unknown> | undefined;
      // Only a record this release recognises as newer is protected; a
      // format-less pre-release record is replaced rather than blocking saves.
      if (value && value["format"] === record.format && value["version"] !== record.version) {
        contractError = new Error(versionError);
        transaction.abort();
        return;
      }
      store.put(record);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(contractError ?? transaction.error);
    transaction.onabort = () =>
      reject(
        contractError ?? transaction.error ?? new Error("Project storage transaction aborted."),
      );
  });
}

async function writeCurrentBody(
  data: CachedGameData,
  options?: { expectedGeneration?: number | undefined; requireNew?: boolean | undefined },
): Promise<number> {
  const db = await openDatabase();
  return new Promise<number>((resolve, reject) => {
    const transaction = db.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    const existing = store.get(data.projectId);
    let contractError: Error | undefined;
    let committedGeneration = 1;

    existing.onsuccess = () => {
      const value = existing.result as StoredGameBody | undefined;
      // Only a record this release recognises as newer is protected; a
      // format-less pre-release record is replaced rather than blocking saves.
      if (value && value.format === "monotio.agi.project" && value.version !== 1) {
        contractError = new Error("This saved project version is not supported by this app.");
        transaction.abort();
        return;
      }

      if (options?.requireNew && value) {
        contractError = new ProjectExistsError(`Project "${data.projectId}" already exists.`);
        transaction.abort();
        return;
      }

      if (options?.expectedGeneration !== undefined) {
        if (!value) {
          contractError = new ProjectDeletedError(
            `Project "${data.projectId}" was removed by another window.`,
          );
          transaction.abort();
          return;
        }
        const existingGen = typeof value.generation === "number" ? value.generation : 0;
        if (existingGen !== options.expectedGeneration) {
          contractError = new ConcurrencyConflictError(
            `Project "${data.projectId}" was modified by another window (expected generation ${options.expectedGeneration}, found ${existingGen}).`,
            value,
          );
          transaction.abort();
          return;
        }
      }

      const prevGen = typeof value?.generation === "number" ? value.generation : 0;
      committedGeneration =
        (options?.expectedGeneration !== undefined ? options.expectedGeneration : prevGen) + 1;
      data.generation = committedGeneration;
      store.put(storedBody(data));
    };

    transaction.oncomplete = () => resolve(committedGeneration);
    transaction.onerror = () => reject(contractError ?? transaction.error);
    transaction.onabort = () =>
      reject(
        contractError ?? transaction.error ?? new Error("Project storage transaction aborted."),
      );
  });
}

function metadata(data: CachedGameData): CachedGameMeta {
  return {
    projectId: data.projectId,
    templateId: data.templateId,
    generation: data.generation,
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
function readStoredBody(raw: StoredGameBody, projectId: string): CachedGameData {
  if (raw.format !== "monotio.agi.project" || raw.version !== 1)
    throw new Error("This saved project version is not supported by this app.");
  const storedId = raw.projectId;
  if (storedId !== projectId)
    throw new Error("The saved project identity does not match its index.");
  const { format: _format, version: _version, ...data } = raw;
  return { ...data, projectId };
}
async function readBody(projectId: string): Promise<CachedGameData | null> {
  const raw = localStorage.getItem(getStorageKey(projectId));
  if (!raw) return null;
  const index = JSON.parse(raw) as Record<string, unknown>;
  if (
    index["format"] !== "monotio.agi.project-index" ||
    index["version"] !== 1 ||
    index["storage"] !== "indexeddb"
  )
    throw new Error("This saved project version is not supported by this app.");
  const stored = await bodyTransaction<StoredGameBody | undefined>("readonly", (store) =>
    store.get(projectId),
  );
  if (!stored)
    throw new Error(
      "The saved project data is unavailable. Open a downloaded project to recover it.",
    );
  const data = readStoredBody(stored, projectId);
  data.library = readLibrary(data);
  return data;
}
/**
 * Release contract: Version 1.0 is the first public archive baseline. Readers
 * check the record's shape and take the normalized values (bounded text,
 * known enums, local previews), never the exact bytes, so tightening a bound
 * later cannot orphan a saved project. Resource hashes are verified where
 * identity matters — preview updates and resume — not on every load.
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
async function writeBody(
  data: CachedGameData,
  options?: { expectedGeneration?: number | undefined; requireNew?: boolean | undefined },
): Promise<void> {
  const existingIndex = localStorage.getItem(getStorageKey(data.projectId));
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
  try {
    await writeCurrentBody(data, options);
  } catch (err) {
    if (err instanceof ConcurrencyConflictError || err instanceof ProjectDeletedError) {
      stashedConflicts.set(data.projectId, {
        projectId: data.projectId,
        data: { ...data },
        stashedAt: new Date().toISOString(),
        reason:
          err instanceof ConcurrencyConflictError ? "concurrency_conflict" : "project_deleted",
        error: err,
      });
    }
    throw err;
  }
  localStorage.setItem(getStorageKey(data.projectId), JSON.stringify(storedIndex(data)));
}
function serializeWrite<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const next = (writes.get(projectId) ?? Promise.resolve()).catch(() => {}).then(operation);
  writes.set(projectId, next);
  void next
    .finally(() => {
      if (writes.get(projectId) === next) writes.delete(projectId);
    })
    .catch(() => {});
  return next;
}
export async function loadAuthoredGame(projectId: string): Promise<CachedGameData | null> {
  return serializeWrite(projectId, () => readBody(projectId));
}

export function saveAuthoredGame(
  projectId: string,
  data: Omit<CachedGameData, "projectId" | "authoredAt">,
  options?: { expectedGeneration?: number | undefined; requireNew?: boolean | undefined },
): Promise<boolean> {
  return serializeWrite(projectId, async () => {
    try {
      const gen = options?.expectedGeneration;
      await writeBody(
        { ...data, projectId, authoredAt: new Date().toISOString() },
        { expectedGeneration: gen, requireNew: options?.requireNew },
      );
      return true;
    } catch (error) {
      console.error("Project storage failed:", error);
      return false;
    }
  });
}

export function updateAuthoredGameFiles(
  projectId: string,
  files: Record<string, Uint8Array>,
  expectedGeneration?: number,
): Promise<boolean> {
  return serializeWrite(projectId, async () => {
    try {
      const data = await readBody(projectId);
      if (!data) {
        if (expectedGeneration !== undefined) {
          const err = new ProjectDeletedError(`Project "${projectId}" was removed.`);
          stashedConflicts.set(projectId, {
            projectId,
            data: {
              projectId,
              files,
              words: files["WORDS.TOK"]
                ? parseWordsTok(files["WORDS.TOK"]).map(({ word, id }) => [word, id])
                : [],
              title: projectId,
              authoredAt: new Date().toISOString(),
              provider: "",
              model: "",
            },
            stashedAt: new Date().toISOString(),
            reason: "project_deleted",
            error: err,
          });
        }
        return false;
      }
      const gen = expectedGeneration ?? data.generation;
      data.files = files;
      if (files["WORDS.TOK"])
        data.words = parseWordsTok(files["WORDS.TOK"]).map(({ word, id }) => [word, id]);
      await writeBody(data, { expectedGeneration: gen });
      return true;
    } catch (error) {
      console.error("Project autosave failed:", error);
      return false;
    }
  });
}

export function updateGameConversation(
  projectId: string,
  transcript: unknown[],
  sessionId?: string,
  authoringState?: Record<string, unknown>,
  provider?: string,
  model?: string,
  files?: Record<string, Uint8Array>,
  expectedGeneration?: number,
): Promise<boolean> {
  return serializeWrite(projectId, async () => {
    try {
      const data = await readBody(projectId);
      if (!data) return false;
      const gen = expectedGeneration ?? data.generation;
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
      await writeBody(data, { expectedGeneration: gen });
      return true;
    } catch (error) {
      console.error("Conversation save failed:", error);
      return false;
    }
  });
}

export function renameAuthoredGame(
  projectId: string,
  title: string,
  expectedGeneration?: number,
): Promise<boolean> {
  return serializeWrite(projectId, async () => {
    const name = title.trim();
    if (!name || name.length > 100) return false;
    try {
      const data = await readBody(projectId);
      if (!data) return false;
      const gen = expectedGeneration ?? data.generation;
      data.title = name;
      await writeBody(data, { expectedGeneration: gen });
      return true;
    } catch {
      return false;
    }
  });
}

export function clearCachedGame(projectId: string): Promise<void> {
  return serializeWrite(projectId, async () => {
    // The body and its conversation leave together: projectIds are deterministic,
    // so a game added again must not inherit the removed one's history.
    await bodyTransaction("readwrite", (store) => {
      store.delete(`conversation/${projectId}`);
      return store.delete(projectId);
    });
    localStorage.removeItem(getStorageKey(projectId));
  });
}

/** Store a newly checked preview only if it describes the exact current revision. */
export function updateGamePreview(
  projectId: string,
  revision: string,
  preview: string,
  validation: NonNullable<CachedGameMeta["library"]>["validation"],
  expectedGeneration?: number,
): Promise<boolean> {
  return serializeWrite(projectId, async () => {
    const data = await readBody(projectId);
    if (!data || !isLocalGamePreview(preview) || (await gameRevision(data.files)) !== revision)
      return false;
    const gen = expectedGeneration ?? data.generation;
    data.library = {
      ...(data.library ?? {
        version: 1,
        revision,
        source: data.imported ? "zip" : "authored",
      }),
      preview,
      validation,
    };
    await writeBody(data, { expectedGeneration: gen });
    return true;
  });
}

/** Rebuild the disposable index from committed IndexedDB bodies after an interrupted write. */
export async function reconcileGameIndex(): Promise<void> {
  const bodies = await bodyTransaction<StoredGameBody[]>("readonly", (store) => store.getAll());
  const projectIds = bodies
    .filter(
      (data) =>
        data.format === "monotio.agi.project" &&
        data.version === 1 &&
        typeof data.projectId === "string" &&
        !data.projectId.startsWith("conversation/") &&
        data.files &&
        typeof data.files === "object",
    )
    .map((data) => data.projectId);
  for (const projectId of projectIds) {
    await serializeWrite(projectId, async () => {
      const stored = await bodyTransaction<StoredGameBody | undefined>("readonly", (store) =>
        store.get(projectId),
      );
      if (!stored) return;
      const data = readStoredBody(stored, projectId);
      if (!data.library) return;
      const current = localStorage.getItem(getStorageKey(data.projectId));
      if (current) {
        try {
          const parsed = JSON.parse(current) as Record<string, unknown>;
          if (parsed["format"] === "monotio.agi.project-index" && parsed["version"] !== 1) return;
        } catch {
          return;
        }
      }
      localStorage.setItem(getStorageKey(data.projectId), JSON.stringify(storedIndex(data)));
    });
  }
  for (const key of Object.keys(localStorage).filter((key) => key.startsWith(STORAGE_PREFIX))) {
    const projectId = key.slice(STORAGE_PREFIX.length);
    await serializeWrite(projectId, async () => {
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
        store.get(projectId),
      );
      if (!data) localStorage.removeItem(key);
    });
  }
}
