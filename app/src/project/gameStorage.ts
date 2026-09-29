import { parseWordsTok } from "../../../src/logic/words.ts";
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
import { announceProjectWrite } from "./projectBroadcast.ts";
import { normalizeReferences, type StoredReference } from "../references/referenceArt.ts";
import { projectId, resourceRevision } from "../../../src/gameIdentity.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import { PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";
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
/** The refusal for a stored project this release cannot read; Home's recovery matches on it. */
export const UNREADABLE_PROJECT_MESSAGE =
  "This saved project version is not supported by this app.";
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

/**
 * The conversation half of a session record — what an Ask, a Studio assist
 * request or an AI settings change writes. It never carries authoring
 * content: the stored plan, bindings and sources stay as they are.
 */
export interface ConversationUpdate {
  provider: string;
  model: string;
  transcript: unknown[];
  sessionId?: string | undefined;
  /** The assistant panel's messages, stored as the authoring state's `chat`. */
  chat: unknown[];
}

const CONVERSATION_RECORD = {
  format: "monotio.agi.conversation",
  version: 1,
  versionError: "This game conversation version is not supported by this app.",
};

/**
 * Local discussions of installed games, without copying game resources into
 * a project. `expected` makes it an authoring write: it lands only while the
 * stored record still holds the authoring content it was made from, and
 * refuses with a `StaleAuthoringError` otherwise.
 */
export async function saveGameConversation(
  storageKey: string,
  context: GameConversation,
  expected?: { fingerprint: AuthoringFingerprint },
): Promise<void> {
  const key = `conversation/${storageKey}`;
  await putVersionedRecord(key, CONVERSATION_RECORD, (stored: GameConversation | undefined) => {
    if (expected && authoringFingerprint(stored?.authoringState) !== expected.fingerprint)
      throw new StaleAuthoringError("This game's authoring was changed elsewhere.");
    return { ...context, projectId: key };
  });
}

/** Store an installed game's conversation beside the authoring content it already holds. */
export async function saveGameConversationUpdate(
  storageKey: string,
  update: ConversationUpdate,
): Promise<void> {
  const key = `conversation/${storageKey}`;
  const { chat, ...conversation } = update;
  await putVersionedRecord(key, CONVERSATION_RECORD, (stored: GameConversation | undefined) => ({
    ...conversation,
    authoringState: { ...stored?.authoringState, chat },
    projectId: key,
  }));
}

/** A write refused because the stored authoring content is not the one it was made from. */
export class StaleAuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleAuthoringError";
  }
}

export async function loadGameConversation(
  storageKey: string,
): Promise<GameConversation | undefined> {
  const stored = await bodyTransaction<(GameConversation & Record<string, unknown>) | undefined>(
    "readonly",
    (store) => store.get(`conversation/${storageKey}`),
  );
  if (!stored) return undefined;
  if (
    stored["format"] !== CONVERSATION_RECORD.format ||
    stored["version"] !== CONVERSATION_RECORD.version
  )
    throw new Error(CONVERSATION_RECORD.versionError);
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
 * Read-modify-write inside a single read-write transaction: one get, then the
 * puts and deletes `update` returns. Append-only
 * tables use it to write an immutable record and its manifest update
 * atomically — a commit that dies mid-write leaves no half-published row.
 */
export async function updateBodyRecords<T>(
  key: string,
  update: (stored: unknown) => { result: T; puts?: unknown[]; deletes?: string[] },
  guard?:
    | { key: string; check: (stored: unknown) => void }
    | readonly { key: string; check: (stored: unknown) => void }[],
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
      const guards = guard === undefined ? [] : Array.isArray(guard) ? guard : [guard];
      let remaining = guards.length;
      if (remaining === 0) apply();
      for (const each of guards) {
        const guarded = store.get(each.key);
        guarded.onsuccess = () => {
          if (contractError) return;
          try {
            each.check(guarded.result);
            if (--remaining === 0) apply();
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

// ---------- record identities ----------
//
// Three facts about a stored record, each derived here and nowhere else;
// projectTransaction.ts decides what they mean for a running game:
// - the storage generation, the counter every conditional project write
//   compares and bumps (a record written before it existed counts as 0);
// - the history lifetime, the epoch of the `lifetime/<key>` receipt that
//   deletion ends for good ("initial" for a project that predates receipts);
// - the authoring fingerprint, a digest of the authoring state's editable
//   content, computed from the record and never stored.
// The fourth identity, the resource revision, is the playable bytes' digest
// (gameMetadata.ts `gameRevision`) that every write stamps into `library`.

interface HistoryLifetime {
  projectId: string;
  epoch: string;
  deleted: boolean;
}

/** The lifetime of a project written before lifetime receipts existed. */
const INITIAL_LIFETIME = "initial";

/** A receipt's live lifetime: null once the game was removed. */
function liveLifetime(receipt: HistoryLifetime | undefined): string | null {
  return receipt?.deleted ? null : (receipt?.epoch ?? INITIAL_LIFETIME);
}

/**
 * Whether a writer holding `expected` may still write into a record whose
 * live lifetime is `actual`. `undefined` expects no particular lifetime; a
 * removed game (`actual` null) and a writer that booted a removed one
 * (`expected` null) never hold.
 */
export function lifetimeHolds(expected: string | null | undefined, actual: string | null): boolean {
  return actual !== null && expected !== null && (expected === undefined || expected === actual);
}

/** The generation a conditional write compares; 0 for a record written before generations. */
export function generationOf(record: { generation?: number | undefined } | undefined): number {
  return typeof record?.generation === "number" ? record.generation : 0;
}

/** A digest of a stored authoring state's editable content; see `authoringFingerprint`. */
export type AuthoringFingerprint = string & { readonly __authoringFingerprint: true };

/**
 * The editable content of a stored authoring state as canonical JSON: every
 * field but the chat (the plan, bindings, labels, locks, annotations and
 * sources), keys in code-point order, byte arrays as number arrays. A
 * missing state and one holding only chat are the same empty content.
 */
function editableContent(authoringState: Record<string, unknown> | undefined): string {
  const { chat: _chat, ...editable } = authoringState ?? {};
  return canonicalJson(editable);
}

function canonicalJson(value: unknown): string {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView))
    return canonicalJson(Array.from(value as unknown as ArrayLike<number>));
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    entries.sort(([a], [b]) => compareCodePoints(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < x.length && i < y.length; i++) {
    const order = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (order !== 0) return order;
  }
  return x.length - y.length;
}

/**
 * The authoring fingerprint of a stored authoring state: SHA-256 of its
 * editable content. Equal fingerprints mean equal plans, bindings and
 * sources; the chat never counts. Synchronous, so a write transaction can
 * check it before its put.
 */
export function authoringFingerprint(
  authoringState: Record<string, unknown> | undefined,
): AuthoringFingerprint {
  return sha256Hex(
    new TextEncoder().encode(editableContent(authoringState)),
  ) as AuthoringFingerprint;
}

/** A boot captures this before its worker starts; deletion invalidates it permanently. */
export async function readHistoryLifetime(storageKey: string): Promise<string | null> {
  const stored = await bodyTransaction<HistoryLifetime | undefined>("readonly", (store) =>
    store.get(`lifetime/${storageKey}`),
  );
  return liveLifetime(stored);
}

/** Checked inside the history write transaction, including for installed games without bodies. */
export function historyLifetimeGuard(storageKey: string, expected?: string | null) {
  return {
    key: `lifetime/${storageKey}`,
    check: (raw: unknown): void => {
      if (!lifetimeHolds(expected, liveLifetime(raw as HistoryLifetime | undefined)))
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
class ConcurrencyConflictError extends Error {
  readonly currentRecord?: StoredGameBody | undefined;
  constructor(message: string, currentRecord?: StoredGameBody) {
    super(message);
    this.name = "ConcurrencyConflictError";
    this.currentRecord = currentRecord;
  }
}

class ProjectDeletedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectDeletedError";
  }
}

class ProjectExistsError extends Error {
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

/**
 * A write that lost its compare-and-swap, or targeted a removed project,
 * kept by project for this page's lifetime so its content is not lost silently.
 */
export const stashedConflicts = new Map<string, StashedConflict>();

/**
 * Replace one versioned record inside a single read-write transaction. A
 * stored record of another format or version is never overwritten; `build`
 * sees the stored record of this one (or none) and returns its successor,
 * or throws to refuse.
 */
async function putVersionedRecord<S, T>(
  key: string,
  kind: { format: string; version: number; versionError: string },
  build: (stored: S | undefined) => T,
): Promise<void> {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    const existing = store.get(key);
    let contractError: Error | undefined;
    existing.onsuccess = () => {
      const value = existing.result as Record<string, unknown> | undefined;
      try {
        if (value && (value["format"] !== kind.format || value["version"] !== kind.version))
          throw new Error(kind.versionError);
        store.put({ ...build(value as S | undefined), format: kind.format, version: kind.version });
      } catch (error) {
        contractError = error instanceof Error ? error : new Error(String(error));
        transaction.abort();
      }
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

/** What a committed body write replaced and began. */
interface BodyWrite {
  /** The committed history lifetime (a new record's fresh epoch). */
  lifetime: string;
  /** The record the write replaced; undefined for a new record. */
  replaced: StoredGameBody | undefined;
}

async function writeCurrentBody(
  data: CachedGameData,
  options?: ProjectWriteOptions,
): Promise<BodyWrite> {
  const db = await openDatabase();
  return new Promise<BodyWrite>((resolve, reject) => {
    const transaction = db.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    const existing = store.get(data.projectId);
    let contractError: Error | undefined;
    let lifetime = INITIAL_LIFETIME;
    let replaced: StoredGameBody | undefined;

    existing.onsuccess = () => {
      const value = existing.result as StoredGameBody | undefined;
      // A record this release does not recognise is never overwritten.
      if (value && (value.format !== "monotio.agi.stored-project" || value.version !== 1)) {
        contractError = new Error(UNREADABLE_PROJECT_MESSAGE);
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
        const existingGen = generationOf(value);
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
        lifetime = previousLifetime?.epoch ?? INITIAL_LIFETIME;
        if (
          options?.expectedLifetime !== undefined &&
          (value === undefined ||
            !lifetimeHolds(options.expectedLifetime, liveLifetime(previousLifetime)))
        ) {
          contractError = new ProjectDeletedError(
            `Project "${data.projectId}" was removed or replaced by another window.`,
          );
          transaction.abort();
          return;
        }
        data.generation = (options?.expectedGeneration ?? generationOf(value)) + 1;
        replaced = value;
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

    transaction.oncomplete = () => resolve({ lifetime, replaced });
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
    throw new Error(UNREADABLE_PROJECT_MESSAGE);
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
  const raw = readableIndex(projectId);
  const snapshot = await readBodyRecords(projectId, () => [`lifetime/${projectId}`]);
  const stored = snapshot.head as StoredGameBody | undefined;
  onLifetime?.(liveLifetime(snapshot.records.get(`lifetime/${projectId}`) as HistoryLifetime));
  if (!stored && raw === null) return null;
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
      throw new Error(UNREADABLE_PROJECT_MESSAGE);
  }
  await stampLibraryMetadata(data, true);
  let written: BodyWrite;
  try {
    written = await writeCurrentBody(data, options);
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
  // Committed: a tab running another revision of this project learns now,
  // and one holding other authoring content when this write changed it.
  if (data.library && data.generation !== undefined) {
    const authoring = editableContent(data.authoringState);
    announceProjectWrite({
      projectId: data.projectId,
      revision: data.library.revision,
      generation: data.generation,
      ...(written.replaced !== undefined &&
      authoring !== editableContent(written.replaced.authoringState)
        ? { fingerprint: authoringFingerprint(data.authoringState) }
        : {}),
    });
  }
  return written.lifetime;
}
/** IndexedDB is authoritative; an inaccessible cache must not hide a committed body. */
function readableIndex(id: ProjectId): string | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(getStorageKey(id));
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const index = parsed as Record<string, unknown>;
  if (
    index["format"] !== "monotio.agi.project-index" ||
    index["version"] !== 1 ||
    index["storage"] !== "indexeddb"
  )
    throw new Error(UNREADABLE_PROJECT_MESSAGE);
  return raw;
}

interface CommittedProjectIdentity {
  readonly projectId: ProjectId;
  readonly generation: number;
  readonly lifetime: string;
  readonly revision: ResourceRevision;
  readonly authoring: AuthoringFingerprint;
  readonly buildId: string;
}

export interface ProjectCommitRequest {
  readonly projectId: ProjectId;
  readonly commitId: string;
  readonly workspaceId: string;
  readonly buildId: string;
  readonly expected: CommittedProjectIdentity | null;
  readonly documents: readonly { readonly key: string; readonly version: number }[];
  readonly data: Omit<CachedGameData, "projectId" | "authoredAt" | "generation">;
}

export interface ProjectCommitReceipt {
  readonly commitId: string;
  readonly workspaceId: string;
  readonly candidateHash: string;
  readonly documents: readonly { readonly key: string; readonly version: number }[];
  readonly saved: CommittedProjectIdentity;
}

interface StoredProjectCommit {
  projectId: string;
  format: "monotio.agi.project-commit";
  version: 1;
  receipt: ProjectCommitReceipt;
}

// Tags distinguish byte arrays, arrays and records. JSON escapes lone UTF-16
// surrogates, so source spelling survives hashing as well as storage.
function commitContent(value: unknown): unknown {
  if (value === undefined) return ["undefined"];
  if (Object.is(value, -0)) return ["negative-zero"];
  if (value instanceof Uint8Array) return ["bytes", Array.from(value)];
  if (Array.isArray(value)) return ["array", Array.from(value, commitContent)];
  if (value !== null && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error("A project commit contains an unsupported value.");
    return [
      "record",
      Object.keys(value)
        .sort(compareCodePoints)
        .map((key) => [key, commitContent((value as Record<string, unknown>)[key])]),
    ];
  }
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("A project commit contains a non-finite number.");
  if (value !== null && !["string", "number", "boolean"].includes(typeof value))
    throw new Error("A project commit contains an unsupported value.");
  return value;
}

/**
 * Publish a complete, already validated candidate and its retry receipt in one
 * transaction. A receipt acknowledges durable storage only; installing the build
 * in a worker is a separate operation. The caller owns compilation and references.
 * Candidate metadata accepts finite JSON values, undefined and Uint8Array bytes;
 * other structured-clone types are rejected before storage.
 */
export async function commitProject(input: ProjectCommitRequest): Promise<{
  receipt: ProjectCommitReceipt;
  warnings: readonly "indexRepairPending"[];
}> {
  // Ownership precedes every await, including waiting behind another writer.
  const request = structuredClone(input);
  if (
    projectId(request.projectId) === null ||
    projectId(request.commitId) === null ||
    projectId(request.workspaceId) === null ||
    resourceRevision(request.buildId) === null
  )
    throw new Error("Invalid project commit identity.");
  const keys = new Set<string>();
  for (const document of request.documents) {
    if (
      typeof document.key !== "string" ||
      !document.key ||
      keys.has(document.key) ||
      !Number.isSafeInteger(document.version) ||
      document.version < 0
    )
      throw new Error("Invalid captured document version.");
    keys.add(document.key);
  }
  if (request.expected !== null && request.expected.projectId !== request.projectId)
    throw new Error("The commit base belongs to another project.");
  const candidateHash = sha256Hex(new TextEncoder().encode(JSON.stringify(commitContent(request))));
  return serializeWrite(request.projectId, async () => {
    readableIndex(request.projectId);
    const data: CachedGameData = {
      ...request.data,
      projectId: request.projectId,
      authoredAt: new Date().toISOString(),
    };
    await stampLibraryMetadata(data, true);
    let current: StoredGameBody | undefined;
    let previousLifetime: HistoryLifetime | undefined;
    const receiptKey = `commit/${request.projectId}/${request.commitId}`;
    const committed = await updateBodyRecords(
      receiptKey,
      (raw) => {
        if (current !== undefined) {
          readStoredBody(current, request.projectId);
          readLibrary(current);
        }
        const lifetime = liveLifetime(previousLifetime);
        if (raw !== undefined) {
          const stored = raw as StoredProjectCommit;
          if (stored.format !== "monotio.agi.project-commit" || stored.version !== 1)
            throw new Error("This project commit version is not supported by this app.");
          if (stored.projectId !== receiptKey || stored.receipt.candidateHash !== candidateHash)
            throw new Error("This commit ID was reused for a different candidate.");
          if (current === undefined || stored.receipt.saved.lifetime !== lifetime)
            throw new ProjectDeletedError(
              "This commit belongs to a removed or replaced project lifetime.",
            );
          return { result: { receipt: stored.receipt, body: current, changed: false } };
        }
        const expected = request.expected;
        if (expected === null) {
          if (current !== undefined) throw new ProjectExistsError("This project already exists.");
        } else {
          if (current === undefined || lifetime !== expected.lifetime)
            throw new ProjectDeletedError(
              "This project was removed or replaced by another window.",
            );
          if (
            generationOf(current) !== expected.generation ||
            current.library?.revision !== expected.revision ||
            authoringFingerprint(current.authoringState) !== expected.authoring
          )
            throw new ConcurrencyConflictError(
              "This project was modified by another window.",
              current,
            );
        }
        data.generation = generationOf(current) + 1;
        if (!Number.isSafeInteger(data.generation))
          throw new Error("Project generation limit reached.");
        const epoch = current === undefined ? crypto.randomUUID() : lifetime;
        if (epoch === null) throw new ProjectDeletedError("This project lifetime was removed.");
        const receipt: ProjectCommitReceipt = {
          commitId: request.commitId,
          workspaceId: request.workspaceId,
          candidateHash,
          documents: request.documents,
          saved: {
            projectId: request.projectId,
            generation: data.generation,
            lifetime: epoch,
            revision: data.library!.revision,
            authoring: authoringFingerprint(data.authoringState),
            buildId: request.buildId,
          },
        };
        const body = storedBody(data);
        const puts: unknown[] = [
          body,
          {
            projectId: receiptKey,
            format: "monotio.agi.project-commit",
            version: 1,
            receipt,
          } satisfies StoredProjectCommit,
        ];
        if (current === undefined)
          puts.push({
            projectId: `lifetime/${request.projectId}`,
            epoch,
            deleted: false,
          } satisfies HistoryLifetime);
        return { result: { receipt, body, changed: true }, puts };
      },
      [
        {
          key: request.projectId,
          check: (raw) => {
            current = raw as StoredGameBody | undefined;
          },
        },
        {
          key: `lifetime/${request.projectId}`,
          check: (raw) => {
            previousLifetime = raw as HistoryLifetime | undefined;
          },
        },
      ],
    );
    const warnings: "indexRepairPending"[] = [];
    try {
      // An old retry must refresh from the current body, never its old candidate.
      localStorage.setItem(
        getStorageKey(request.projectId),
        JSON.stringify(storedIndex(committed.body)),
      );
    } catch {
      warnings.push("indexRepairPending");
    }
    if (committed.changed)
      announceProjectWrite({
        projectId: request.projectId,
        generation: committed.receipt.saved.generation,
        revision: committed.receipt.saved.revision,
        fingerprint: committed.receipt.saved.authoring,
      });
    return { receipt: structuredClone(committed.receipt), warnings };
  });
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
 * Replace the project's files only while the record still holds `expected`:
 * its stamped revision (every write stamps `library.revision` from the files,
 * so no hash is taken here) and, when given, its history lifetime. A record
 * that already holds `current` (the files' own revision) is left as it is.
 * "stale" when the record moved elsewhere, "failed" when storage refused.
 */
export function updateAuthoredGameFilesAt(
  projectId: ProjectId,
  files: Record<string, Uint8Array>,
  expected: { revision: ResourceRevision; current: ResourceRevision; lifetime?: string | null },
): Promise<"saved" | "stale" | "failed"> {
  return serializeWrite(projectId, async () => {
    try {
      let lifetime: string | null = null;
      const data = await readBody(projectId, (value) => {
        lifetime = value;
      });
      if (!data || !lifetimeHolds(expected.lifetime, lifetime)) return "stale";
      // The stamp is enough on every record this app writes; one without it
      // (or with a stamp that disagrees) is judged by its files instead.
      let stored = data.library?.revision;
      if (stored !== expected.current && stored !== expected.revision)
        stored = await gameRevision(data.files);
      if (stored === expected.current) return "saved";
      if (stored !== expected.revision) return "stale";
      data.files = files;
      if (files["WORDS.TOK"])
        data.words = parseWordsTok(files["WORDS.TOK"]).map(({ word, id }) => [word, id]);
      await writeBody(data, { expectedGeneration: data.generation, expectedLifetime: lifetime });
      return "saved";
    } catch (error) {
      if (error instanceof ConcurrencyConflictError || error instanceof ProjectDeletedError)
        return "stale";
      console.error("Project autosave failed:", error);
      return "failed";
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

/** The stored transcript moves to the history when the provider or model changes. */
function applyConversation(
  data: CachedGameData,
  transcript: unknown[],
  sessionId: string | undefined,
  provider: string | undefined,
  model: string | undefined,
): void {
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
  if (provider) data.provider = provider;
  if (model) data.model = model;
}

/**
 * Store a project's conversation (see `ConversationUpdate`) under the
 * generation check every project write shares, beside the files and
 * authoring content the record already holds.
 */
export function updateProjectConversation(
  projectId: ProjectId,
  update: ConversationUpdate,
  expectedGeneration: number,
): Promise<boolean> {
  return serializeWrite(projectId, async () => {
    try {
      const data = await readBody(projectId);
      if (!data) return false;
      applyConversation(data, update.transcript, update.sessionId, update.provider, update.model);
      data.authoringState = { ...data.authoringState, chat: update.chat };
      await writeBody(data, { expectedGeneration });
      return true;
    } catch (error) {
      console.error("Conversation save failed:", error);
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
      applyConversation(data, transcript, sessionId, provider, model);
      if (authoringState) data.authoringState = authoringState;
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
    let ended: IDBRequest<HistoryLifetime | undefined> | undefined;
    await bodyTransaction("readwrite", (store) => {
      // The lifetime this removal ends, read before its receipt is replaced.
      ended = store.get(`lifetime/${projectId}`) as IDBRequest<HistoryLifetime | undefined>;
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
    // A tab running the removed lifetime stops writing for it at once; one
    // already removed has no lifetime left to end.
    const removed = liveLifetime(ended?.result);
    if (removed !== null) announceProjectWrite({ projectId, removed });
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

async function storedProjects(): Promise<StoredGameBody[]> {
  // Keys first: the shared store also carries history batch/blob bodies, and
  // getAll() would clone every tape into memory just to name the projects.
  // Only the candidate project bodies are read — history keys all live under
  // `history/` and `conversation/` prefixes.
  return (async (): Promise<StoredGameBody[]> => {
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
}

/** Discover committed projects even when the disposable metadata cache is unavailable. */
export async function listStoredProjects(): Promise<CachedGameMeta[]> {
  const bodies = await storedProjects();
  const entries: CachedGameMeta[] = [];
  for (const body of bodies) {
    if (
      typeof body.title !== "string" ||
      typeof body.authoredAt !== "string" ||
      typeof body.provider !== "string" ||
      typeof body.model !== "string"
    )
      continue;
    try {
      const data = readStoredBody(body, body.projectId);
      data.library = readLibrary(data);
      entries.push(metadata(data));
    } catch {
      // An unreadable record stays untouched and cannot hide the readable ones.
    }
  }
  return entries.sort((a, b) => compareCodePoints(b.authoredAt, a.authoredAt));
}

/** Rebuild the disposable index from committed IndexedDB bodies after an interrupted write. */
export async function reconcileGameIndex(): Promise<void> {
  const bodies = await storedProjects();
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
        // Leave data this app does not recognise untouched.
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
