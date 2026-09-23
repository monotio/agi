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

import type { CachedGameMeta, CachedGameData, ProjectId, ResourceRevision } from "./gameTypes.ts";
import { normalizeReferences, type StoredReference } from "./referenceArt.ts";
import { projectId, resourceRevision } from "../../src/gameIdentity.ts";
import { PROFILES, type ProfileId } from "../../src/runtime/profile.ts";
export type { CachedGameMeta, CachedGameData, ProjectId } from "./gameTypes.ts";

interface StoredGameIndex extends CachedGameMeta {
  format: "monotio.agi.project-index";
  version: 1;
  storage: "indexeddb";
}

/** The browser's project record; PROJECT.JSON is the archive format. */
interface StoredGameBody extends CachedGameData {
  format: "monotio.agi.stored-project";
  version: 1;
}

const STORAGE_PREFIX = "monotio_agi.authored.";
/** Every recognized library field; a version-1 reader keeps anything else as an additive extension. */
const LIBRARY_FIELDS: Record<keyof LibraryMetadata, true> = {
  version: true,
  revision: true,
  source: true,
  catalog: true,
  preview: true,
  profile: true,
  workInProgress: true,
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
  storageKey: string,
  context: GameConversation,
): Promise<void> {
  const key = `conversation/${storageKey}`;
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
  storageKey: string,
): Promise<GameConversation | undefined> {
  const stored = await bodyTransaction<(GameConversation & Record<string, unknown>) | undefined>(
    "readonly",
    (store) => store.get(`conversation/${storageKey}`),
  );
  if (!stored) return undefined;
  if (stored["format"] !== "monotio.agi.conversation" || stored["version"] !== 1)
    throw new Error("This game conversation version is not supported by this app.");
  const { format: _format, version: _version, projectId: _projectId, ...context } = stored;
  return context as unknown as GameConversation;
}

export function getStorageKey(projectId: ProjectId): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

export function getCachedGameMeta(projectId: ProjectId): CachedGameMeta | null {
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
    const libraryRevision = resourceRevision(libraryValue?.["revision"]);
    const library =
      libraryValue?.["version"] === 1 && libraryRevision !== null
        ? normalizeLibraryMetadata(libraryValue, {
            revision: libraryRevision,
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
      .map((key) => {
        const id = projectId(key.slice(STORAGE_PREFIX.length));
        return id === null ? null : getCachedGameMeta(id);
      })
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
      // A newer app already upgraded this browser's database; this page's
      // code is out of date, not the data.
      reject(
        request.error?.name === "VersionError"
          ? new Error(
              "Your projects were saved by a newer version of this app. Reload the page to update it.",
            )
          : request.error,
      );
    };
  });
  return database.catch((error) => {
    database = undefined;
    throw error;
  });
}
export async function bodyTransaction<T>(
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

/**
 * Read-modify-write on one record inside a single read-write transaction.
 * Separate get and put transactions from two tabs can interleave — the
 * second put silently overwrites the first's merge — so a caller that
 * updates an existing record must hold one transaction across both.
 * `update` gets the raw stored value (undefined when absent) and returns
 * the record to write plus the operation's result; omit `put` to commit no
 * write. Throwing aborts the transaction and propagates.
 */
export async function updateBodyRecord<T>(
  key: string,
  update: (stored: unknown) => { put?: unknown; result: T },
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    const request = store.get(key);
    let outcome: { put?: unknown; result: T } | undefined;
    let contractError: Error | undefined;
    request.onsuccess = () => {
      try {
        outcome = update(request.result);
        if (outcome.put !== undefined) store.put(outcome.put);
      } catch (error) {
        contractError = error instanceof Error ? error : new Error(String(error));
        transaction.abort();
      }
    };
    transaction.oncomplete = () => {
      if (outcome === undefined) reject(new Error("Project storage transaction closed early."));
      else resolve(outcome.result);
    };
    transaction.onerror = () => reject(contractError ?? transaction.error ?? request.error);
    transaction.onabort = () =>
      reject(
        contractError ?? transaction.error ?? new Error("Project storage transaction aborted."),
      );
  });
}

/**
 * updateBodyRecord's multi-record form: one get, then the puts and deletes
 * `update` returns, all inside the same read-write transaction. Append-only
 * tables use it to write an immutable record and its manifest update
 * atomically — a commit that dies mid-write leaves no half-published row.
 */
export async function updateBodyRecords<T>(
  key: string,
  update: (stored: unknown) => { result: T; puts?: unknown[]; deletes?: string[] },
  guard?: { key: string; check: (stored: unknown) => void },
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    const request = store.get(key);
    let outcome: { result: T; puts?: unknown[]; deletes?: string[] } | undefined;
    let contractError: Error | undefined;
    request.onsuccess = () => {
      const apply = () => {
        try {
          outcome = update(request.result);
          // Deletes first: a key that is replaced in the same transaction must
          // come out before its new record goes in.
          for (const key of outcome.deletes ?? []) store.delete(key);
          for (const put of outcome.puts ?? []) store.put(put);
        } catch (error) {
          contractError = error instanceof Error ? error : new Error(String(error));
          transaction.abort();
        }
      };
      if (guard === undefined) apply();
      else {
        const guarded = store.get(guard.key);
        guarded.onsuccess = () => {
          try {
            guard.check(guarded.result);
            apply();
          } catch (error) {
            contractError = error instanceof Error ? error : new Error(String(error));
            transaction.abort();
          }
        };
      }
    };
    transaction.oncomplete = () => {
      if (outcome === undefined) reject(new Error("Project storage transaction closed early."));
      else resolve(outcome.result);
    };
    transaction.onerror = () => reject(contractError ?? transaction.error ?? request.error);
    transaction.onabort = () =>
      reject(
        contractError ?? transaction.error ?? new Error("Project storage transaction aborted."),
      );
  });
}

interface HistoryLifetime {
  projectId: string;
  epoch: string;
  deleted: boolean;
}

/** A boot captures this before its worker starts; deletion invalidates it permanently. */
export async function readHistoryLifetime(storageKey: string): Promise<string | null> {
  const stored = await bodyTransaction<HistoryLifetime | undefined>("readonly", (store) =>
    store.get(`lifetime/${storageKey}`),
  );
  return stored?.deleted ? null : (stored?.epoch ?? "initial");
}

/** Checked inside the history write transaction, including for installed games without bodies. */
export function historyLifetimeGuard(storageKey: string, expected?: string | null) {
  return {
    key: `lifetime/${storageKey}`,
    check: (raw: unknown): void => {
      const stored = raw as HistoryLifetime | undefined;
      if (
        stored?.deleted ||
        expected === null ||
        (expected !== undefined && expected !== (stored?.epoch ?? "initial"))
      )
        throw new ProjectDeletedError("This history writer belongs to a removed game.");
    },
  };
}

/**
 * Read one record plus every record `follow` names after seeing it, inside a
 * single read-only transaction — the batch and blob records an export or
 * replay assembles all come from the same snapshot while writers continue.
 * `records` holds the keys follow named that existed.
 */
export async function readBodyRecords(
  key: string,
  follow: (head: unknown) => string[],
): Promise<{ head: unknown; records: Map<string, unknown> }> {
  const db = await openDatabase();
  return new Promise<{ head: unknown; records: Map<string, unknown> }>((resolve, reject) => {
    const transaction = db.transaction("projects", "readonly");
    const store = transaction.objectStore("projects");
    const records = new Map<string, unknown>();
    let head: unknown;
    let contractError: Error | undefined;
    const request = store.get(key);
    request.onsuccess = () => {
      head = request.result;
      let follows: string[];
      try {
        follows = head === undefined ? [] : follow(head);
      } catch (error) {
        // A format reject inside the event handler would otherwise surface as
        // an uncaught exception — abort so the caller gets the real error.
        contractError = error instanceof Error ? error : new Error(String(error));
        transaction.abort();
        return;
      }
      for (const next of follows) {
        const each = store.get(next);
        each.onsuccess = () => {
          if (each.result !== undefined) records.set(next, each.result);
        };
      }
    };
    transaction.oncomplete = () => resolve({ head, records });
    transaction.onerror = () => reject(contractError ?? transaction.error ?? request.error);
    transaction.onabort = () =>
      reject(
        contractError ?? transaction.error ?? new Error("Project storage transaction aborted."),
      );
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
  projectId: ProjectId;
  data: CachedGameData;
  stashedAt: string;
  reason: "concurrency_conflict" | "project_deleted";
  error: Error;
}

const stashedConflicts = new Map<string, StashedConflict>();

export function getStashedConflict(projectId: ProjectId): StashedConflict | undefined {
  return stashedConflicts.get(projectId);
}

export function clearStashedConflict(projectId: ProjectId): void {
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
      // A record this release does not recognise is never overwritten.
      if (value && (value["format"] !== record.format || value["version"] !== record.version)) {
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

interface ProjectWriteOptions {
  expectedGeneration?: number | undefined;
  expectedLifetime?: string | null | undefined;
  requireNew?: boolean | undefined;
}

async function writeCurrentBody(
  data: CachedGameData,
  options?: ProjectWriteOptions,
): Promise<string> {
  const db = await openDatabase();
  return new Promise<string>((resolve, reject) => {
    const transaction = db.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    const existing = store.get(data.projectId);
    let contractError: Error | undefined;
    let committedGeneration = 1;
    let lifetime = "initial";

    existing.onsuccess = () => {
      const value = existing.result as StoredGameBody | undefined;
      // A record this release does not recognise is never overwritten.
      if (value && (value.format !== "monotio.agi.stored-project" || value.version !== 1)) {
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

      // Generation alone cannot distinguish a deleted-and-recreated project
      // whose counter reached the same number. Check both identities in this
      // transaction before writing either the body or its lifetime receipt.
      const receipt = store.get(`lifetime/${data.projectId}`);
      receipt.onsuccess = () => {
        const previousLifetime = receipt.result as HistoryLifetime | undefined;
        lifetime = previousLifetime?.epoch ?? "initial";
        if (
          options?.expectedLifetime !== undefined &&
          (value === undefined ||
            previousLifetime?.deleted ||
            lifetime !== options.expectedLifetime)
        ) {
          contractError = new ProjectDeletedError(
            `Project "${data.projectId}" was removed or replaced by another window.`,
          );
          transaction.abort();
          return;
        }
        const prevGen = typeof value?.generation === "number" ? value.generation : 0;
        committedGeneration =
          (options?.expectedGeneration !== undefined ? options.expectedGeneration : prevGen) + 1;
        data.generation = committedGeneration;
        if (value === undefined) {
          lifetime = crypto.randomUUID();
          store.put({
            projectId: `lifetime/${data.projectId}`,
            epoch: lifetime,
            deleted: false,
          } satisfies HistoryLifetime);
        }
        store.put(storedBody(data));
      };
    };

    transaction.oncomplete = () => resolve(lifetime);
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
  return { ...data, format: "monotio.agi.stored-project", version: 1 };
}
function readStoredBody(raw: StoredGameBody, projectId: ProjectId): CachedGameData {
  if (raw.format !== "monotio.agi.stored-project" || raw.version !== 1)
    throw new Error("This saved project version is not supported by this app.");
  const storedId = raw.projectId;
  if (storedId !== projectId)
    throw new Error("The saved project identity does not match its index.");
  const { format: _format, version: _version, ...data } = raw;
  const normalized = { ...data, projectId };
  if (normalized.references !== undefined)
    normalized.references = normalizeReferences(normalized.references);
  return normalized;
}
async function readBody(
  projectId: ProjectId,
  onLifetime?: (lifetime: string | null) => void,
): Promise<CachedGameData | null> {
  const raw = localStorage.getItem(getStorageKey(projectId));
  if (!raw) return null;
  const index = JSON.parse(raw) as Record<string, unknown>;
  if (
    index["format"] !== "monotio.agi.project-index" ||
    index["version"] !== 1 ||
    index["storage"] !== "indexeddb"
  )
    throw new Error("This saved project version is not supported by this app.");
  const snapshot = await readBodyRecords(projectId, () => [`lifetime/${projectId}`]);
  const stored = snapshot.head as StoredGameBody | undefined;
  const lifetime = snapshot.records.get(`lifetime/${projectId}`) as HistoryLifetime | undefined;
  onLifetime?.(lifetime?.deleted ? null : (lifetime?.epoch ?? "initial"));
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
  const storedRevision = resourceRevision(raw?.["revision"]);
  if (!raw || typeof raw !== "object" || storedRevision === null)
    throw new Error("The saved project has invalid library metadata.");
  const normalized = normalizeLibraryMetadata(raw, {
    revision: storedRevision,
    source: data.imported ? "zip" : "authored",
  });
  const library: Record<string, unknown> = { ...normalized };
  for (const [key, value] of Object.entries(raw))
    // A stored alias is a pre-identity lookup key, not an extension — drop it.
    if (!Object.hasOwn(LIBRARY_FIELDS, key) && key !== "alias") library[key] = value;
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
async function writeBody(data: CachedGameData, options?: ProjectWriteOptions): Promise<string> {
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
  let lifetime: string;
  try {
    lifetime = await writeCurrentBody(data, options);
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
  return lifetime;
}
export function serializeWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const next = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  writes.set(key, next);
  void next
    .finally(() => {
      if (writes.get(key) === next) writes.delete(key);
    })
    .catch(() => {});
  return next;
}
export async function loadAuthoredGame(projectId: ProjectId): Promise<CachedGameData | null> {
  return serializeWrite(projectId, () => readBody(projectId));
}

/** Body and lifetime are read from one snapshot before a worker can start. */
export function loadAuthoredGameWithHistoryLifetime(
  projectId: ProjectId,
): Promise<{ data: CachedGameData; lifetime: string | null } | null> {
  return serializeWrite(projectId, async () => {
    let lifetime: string | null = null;
    const data = await readBody(projectId, (value) => {
      lifetime = value;
    });
    return data === null ? null : { data, lifetime };
  });
}

export async function saveAuthoredGame(
  projectId: ProjectId,
  data: Omit<CachedGameData, "projectId" | "authoredAt">,
  options?: ProjectWriteOptions,
): Promise<boolean> {
  return (await saveAuthoredGameWithLifetime(projectId, data, options)) !== null;
}

/** Save and return the exact committed lifetime, without a second read racing recreation. */
export function saveAuthoredGameWithLifetime(
  projectId: ProjectId,
  data: Omit<CachedGameData, "projectId" | "authoredAt">,
  options?: ProjectWriteOptions,
): Promise<string | null> {
  return serializeWrite(projectId, async () => {
    try {
      const gen = options?.expectedGeneration;
      return await writeBody(
        { ...data, projectId, authoredAt: new Date().toISOString() },
        {
          expectedGeneration: gen,
          expectedLifetime: options?.expectedLifetime,
          requireNew: options?.requireNew,
        },
      );
    } catch (error) {
      console.error("Project storage failed:", error);
      return null;
    }
  });
}

export function updateAuthoredGameFiles(
  projectId: ProjectId,
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

/**
 * Write the project's reference-art list under the same generation check the
 * other project writes share. Reference bytes are project data: they never
 * join `files`, so a reference write cannot move the playable revision.
 *
 * The callback form mutates against the freshest read inside the serialized
 * write — an add, remove or stage-clear by reference id cannot lose a
 * concurrent writer's attachment. Returning null aborts the write.
 */
export function updateAuthoredReferences(
  projectId: ProjectId,
  references: StoredReference[] | ((current: StoredReference[]) => StoredReference[] | null),
): Promise<boolean> {
  return serializeWrite(projectId, async () => {
    try {
      const data = await readBody(projectId);
      if (!data) return false;
      const next =
        typeof references === "function" ? references(data.references ?? []) : references;
      if (next === null) return false;
      data.references = next;
      await writeBody(data, { expectedGeneration: data.generation });
      return true;
    } catch (error) {
      console.error("Project reference write failed:", error);
      return false;
    }
  });
}

export function updateGameConversation(
  projectId: ProjectId,
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
  projectId: ProjectId,
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

/** Store an interpreter-profile override (undefined: automatic); false when refused or stale. */
export function setLibraryGameProfile(
  projectId: ProjectId,
  profile: ProfileId | undefined,
  expectedGeneration?: number,
): Promise<boolean> {
  return serializeWrite(projectId, async () => {
    if (profile !== undefined && !Object.hasOwn(PROFILES, profile)) return false;
    try {
      const data = await readBody(projectId);
      if (!data?.library) return false;
      const library = { ...data.library };
      if (profile) library.profile = profile;
      else delete library.profile;
      data.library = library;
      await writeBody(data, { expectedGeneration: expectedGeneration ?? data.generation });
      return true;
    } catch {
      return false;
    }
  });
}

export function clearCachedGame(projectId: ProjectId): Promise<void> {
  return serializeWrite(projectId, async () => {
    // The body, its conversation and its history leave together: projectIds are
    // deterministic, so a game added again must not inherit the removed one's
    // history. The manifest's batch and blob records key under
    // `history/${id}/`, so a plain manifest delete would orphan them all —
    // the cursor deletes every child key in the same transaction.
    await bodyTransaction("readwrite", (store) => {
      // Keep a small deletion receipt outside the history prefix. A writer in
      // another tab must not recreate a tape, even if its boot arrives late.
      store.put({
        projectId: `lifetime/${projectId}`,
        epoch: crypto.randomUUID(),
        deleted: true,
      } satisfies HistoryLifetime);
      store.delete(`conversation/${projectId}`);
      store.delete(`history/${projectId}`);
      const children = store.openCursor(
        IDBKeyRange.bound(`history/${projectId}/`, `history/${projectId}/￿`),
      );
      children.onsuccess = () => {
        const cursor = children.result;
        if (cursor === null) return;
        cursor.delete();
        cursor.continue();
      };
      return store.delete(projectId);
    });
    localStorage.removeItem(getStorageKey(projectId));
  });
}

/** Store a newly checked preview only if it describes the exact current revision. */
export function updateGamePreview(
  projectId: ProjectId,
  revision: ResourceRevision,
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
  // Keys first: the shared store also carries history batch/blob bodies, and
  // getAll() would clone every tape into memory just to name the projects.
  // Only the candidate project bodies are read — history keys all live under
  // `history/` and `conversation/` prefixes.
  const bodies = await (async (): Promise<StoredGameBody[]> => {
    const db = await openDatabase();
    return new Promise<StoredGameBody[]>((resolve, reject) => {
      const transaction = db.transaction("projects", "readonly");
      const store = transaction.objectStore("projects");
      const found: StoredGameBody[] = [];
      const keysRequest = store.getAllKeys();
      keysRequest.onsuccess = () => {
        for (const key of keysRequest.result) {
          if (typeof key !== "string" || key.includes("/")) continue;
          const each = store.get(key);
          each.onsuccess = () => {
            const data = each.result as StoredGameBody | undefined;
            if (
              data !== undefined &&
              data.format === "monotio.agi.stored-project" &&
              data.version === 1 &&
              data.projectId === key &&
              data.files &&
              typeof data.files === "object"
            )
              found.push(data);
          };
        }
      };
      transaction.oncomplete = () => resolve(found);
      transaction.onerror = () => reject(transaction.error ?? keysRequest.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Project storage transaction aborted."));
    });
  })();
  const projectIds = bodies.map((data) => data.projectId);
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
    const id = projectId(key.slice(STORAGE_PREFIX.length));
    if (id === null) continue;
    await serializeWrite(id, async () => {
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
        store.get(id),
      );
      if (!data) localStorage.removeItem(key);
    });
  }
}
