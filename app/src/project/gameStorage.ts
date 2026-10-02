import { readAgentChats, appendAgentTasks, type AgentChat } from "../../../src/agent/chats.ts";
import {
  encodeJournalValue,
  journalCandidate,
  type ProjectJournalCapture,
} from "./projectJournalCapture.ts";
import { resumeProjectSaveJournals } from "./projectSaveJournal.ts";
import { historyBlobKeys, type StoredProjectHistory } from "./projectHistoryStorageHeader.ts";
import {
  readProjectWorkspace,
  writeProjectWorkspace,
  type PortableProjectWorkspace,
} from "../../../src/authoring/projectWorkspace.ts";
import {
  readProjectRecovery,
  writeProjectRecovery,
} from "../../../src/authoring/projectRecoveryCodec.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import {
  gameRevision,
  isLocalGamePreview,
  normalizeLibraryMetadata,
  projectCommitLibrary,
  type LibraryMetadata,
} from "./gameMetadata.ts";
/**
 * IndexedDB project bodies with a lightweight localStorage metadata index.
 * Prevents loss of generated worlds across HMR, page refreshes, and browser sessions.
 */

import type { CachedGameMeta, CachedGameData, ProjectId, ResourceRevision } from "./gameTypes.ts";
import {
  classifyLegacyProgressRecord,
  isLegacyProgressKey,
  legacyProgressPrefix,
  newLegacyProgressRecord,
  queuePrefixScan,
  readLegacyProgressRecord,
  type CapturedRecord,
  type LegacyProgressRecord,
  type LegacyProgressRow,
  type RawLocalEntry,
} from "./legacyProgressRecovery.ts";
import { isProgressNamespace, type ProjectProgressTarget } from "./progressTarget.ts";
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
  editHistory?: StoredProjectHistory | undefined;
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
    const request = indexedDB.open("monotio-agi-projects", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("projects"))
        request.result.createObjectStore("projects", { keyPath: "projectId" });
    };
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
 * `update` may name `reads` it only knows after seeing the head record and
 * finish in `complete`, still inside the one transaction.
 */
type BodyRecordsOutcome<T> =
  | {
      readonly result: T;
      readonly puts?: unknown[];
      readonly deletes?: string[];
    }
  | {
      readonly reads: readonly string[];
      readonly complete: (records: Map<string, unknown>) => {
        readonly result: T;
        readonly puts?: unknown[];
        readonly deletes?: string[];
      };
    };

export async function updateBodyRecords<T>(
  key: string,
  update: (stored: unknown) => BodyRecordsOutcome<T>,
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
        const settle = (settled: { result: T; puts?: unknown[]; deletes?: string[] }): void => {
          outcome = settled;
          // Deletes first: a key that is replaced in the same transaction must
          // come out before its new record goes in.
          for (const key of settled.deletes ?? []) store.delete(key);
          for (const put of settled.puts ?? []) store.put(put);
        };
        try {
          const produced = update(request.result);
          if ("complete" in produced) {
            // A deferred finish still runs inside this transaction: the keys
            // were only nameable after the head record arrived (cross-record
            // referential checks such as a catalog's blob references).
            const records = new Map<string, unknown>();
            let remaining = produced.reads.length;
            if (remaining === 0) {
              settle(produced.complete(records));
              return;
            }
            for (const readKey of produced.reads) {
              const each = store.get(readKey);
              each.onsuccess = () => {
                if (contractError !== undefined) return;
                records.set(readKey, each.result);
                if (--remaining === 0) {
                  try {
                    settle(produced.complete(records));
                  } catch (error) {
                    contractError = error instanceof Error ? error : new Error(String(error));
                    transaction.abort();
                  }
                }
              };
            }
            return;
          }
          settle(produced);
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

export interface HistoryLifetime {
  projectId: string;
  epoch: string;
  deleted: boolean;
}

/** The lifetime of a project written before lifetime receipts existed. */
const INITIAL_LIFETIME = "initial";

/** A receipt's live lifetime: null once the game was removed. */
export function liveLifetime(receipt: HistoryLifetime | undefined): string | null {
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
  workspace?: PortableProjectWorkspace,
): AuthoringFingerprint {
  const content = editableContent(authoringState);
  // Preserve legacy hashes exactly. A workspace adds a separately tagged value;
  // sorting the document set makes input ordering irrelevant to its identity.
  const canonical =
    workspace === undefined
      ? content
      : `["workspace",${content},${canonicalJson({
          ...workspace,
          documents: [...workspace.documents].sort((a, b) => compareCodePoints(a.key, b.key)),
        })}]`;
  return sha256Hex(new TextEncoder().encode(canonical)) as AuthoringFingerprint;
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

/**
 * Snapshot several records in one readonly transaction. Creative storage
 * needs the body and its catalog from the same view — a marker can only be
 * checked against the catalog beside it — and `readBodyRecords` only follows
 * keys the head record names, which a missing head cannot do.
 */
export async function readBodyRecordSet(keys: readonly string[]): Promise<Map<string, unknown>> {
  const db = await openDatabase();
  return new Promise<Map<string, unknown>>((resolve, reject) => {
    const transaction = db.transaction("projects", "readonly");
    const store = transaction.objectStore("projects");
    const records = new Map<string, unknown>();
    for (const key of keys) {
      const each = store.get(key);
      each.onsuccess = () => {
        records.set(key, each.result);
      };
    }
    transaction.oncomplete = () => resolve(records);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Project storage transaction aborted."));
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
  const historyModule = await import("./projectHistoryStorage.ts");
  const history = historyModule.checkedProjectHistory(data);
  if (history !== undefined) data.projectHistory = history;
  readStoredBody(storedBody(data), data.projectId);
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

      if (value) {
        try {
          readStoredBody(value, data.projectId);
        } catch (error) {
          contractError = error instanceof Error ? error : new Error(String(error));
          transaction.abort();
          return;
        }
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
        const body = storedBody(data);
        if (history === undefined && value?.editHistory !== undefined) {
          body.editHistory = value.editHistory;
        }
        try {
          const keys = [
            ...new Set([
              ...historyModule.historyBlobKeys(data.projectId, value?.editHistory),
              ...Object.keys(history?.blobs ?? {}).map((hash) =>
                historyModule.projectHistoryBlobKey(data.projectId, hash),
              ),
            ]),
          ];
          const rows = new Map<string, unknown>();
          const finish = () => {
            const changes = historyModule.projectHistoryWrites(
              data.projectId,
              value?.editHistory,
              history,
              rows,
            );
            for (const key of changes.deletes) store.delete(key);
            store.put(body);
            for (const row of changes.puts) store.put(row);
          };
          let remaining = keys.length;
          if (remaining === 0) finish();
          for (const key of keys) {
            const blob = store.get(key);
            blob.onsuccess = () => {
              rows.set(key, blob.result);
              if (--remaining === 0) {
                try {
                  finish();
                } catch (error) {
                  contractError = error instanceof Error ? error : new Error(String(error));
                  transaction.abort();
                }
              }
            };
          }
        } catch (error) {
          contractError = error instanceof Error ? error : new Error(String(error));
          transaction.abort();
        }
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
  const { projectHistory, ...body } = data;
  return {
    ...body,
    format: "monotio.agi.stored-project",
    version: 1,
    ...(projectHistory !== undefined
      ? { editHistory: { ...projectHistory, blobs: Object.keys(projectHistory.blobs).sort() } }
      : {}),
  };
}
/**
 * Validate a stored project body offered as unknown input — an IDB record,
 * a captured snapshot — into the shape every project read shares. A value
 * that is not a plain record, of another format or version, or bound to a
 * different project refuses rather than reading as empty.
 */
export function readStoredBody(raw: unknown, projectId: ProjectId): CachedGameData {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(UNREADABLE_PROJECT_MESSAGE);
  const record = raw as StoredGameBody;
  if (record.format !== "monotio.agi.stored-project" || record.version !== 1)
    throw new Error(UNREADABLE_PROJECT_MESSAGE);
  const storedId = record.projectId;
  if (storedId !== projectId)
    throw new Error("The saved project identity does not match its index.");
  if (record.editHistory !== undefined && record.editHistory.version !== 1)
    throw new Error("This project history version is not supported by this app.");
  if (Object.hasOwn(record, "creative"))
    throw new Error("This saved project uses an unsupported creative storage format.");
  const { format: _format, version: _version, editHistory: _editHistory, ...data } = record;
  const normalized = { ...data, projectId };
  if (data.chats !== undefined) {
    normalized.chats = readAgentChats(data.chats);
  }
  const hasAssistant =
    normalized.provider !== undefined ||
    normalized.model !== undefined ||
    normalized.transcript !== undefined ||
    normalized.sessionId !== undefined ||
    normalized.conversationHistory !== undefined;
  if (
    hasAssistant &&
    (typeof normalized.provider !== "string" || typeof normalized.model !== "string")
  )
    throw new Error("Invalid saved project model metadata.");
  if (normalized.workspace !== undefined)
    normalized.workspace = writeProjectWorkspace(readProjectWorkspace(normalized.workspace));
  if (normalized.recoveryDraft !== undefined) {
    const recovered = readProjectRecovery(normalized.recoveryDraft);
    normalized.recoveryDraft = writeProjectRecovery(recovered.base, recovered.recovery);
  }
  if (normalized.references !== undefined)
    normalized.references = normalizeReferences(normalized.references);
  return normalized;
}
async function readBody(
  projectId: ProjectId,
  onLifetime?: (lifetime: string | null) => void,
): Promise<CachedGameData | null> {
  const raw = readableIndex(projectId);
  const snapshot = await readBodyRecords(projectId, (raw) => [
    `lifetime/${projectId}`,
    ...historyBlobKeys(projectId, (raw as StoredGameBody | undefined)?.editHistory),
  ]);
  const stored = snapshot.head as StoredGameBody | undefined;
  onLifetime?.(liveLifetime(snapshot.records.get(`lifetime/${projectId}`) as HistoryLifetime));
  if (!stored && raw === null) return null;
  if (!stored)
    throw new Error(
      "The saved project data is unavailable. Open a downloaded project to recover it.",
    );
  const data = readStoredBody(stored, projectId);
  if (stored.editHistory !== undefined)
    data.projectHistory = (await import("./projectHistoryStorage.ts")).hydrateProjectHistory(
      projectId,
      stored.editHistory,
      snapshot.records,
    );
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
/** Validate the authoritative body inside another project record's transaction. */
export function projectBodyGuard(
  projectId: ProjectId,
  check: (data: CachedGameData) => void,
): { key: string; check: (raw: unknown) => void } {
  return {
    key: projectId,
    check(raw) {
      if (raw === undefined) throw new ProjectDeletedError("This project was removed.");
      const data = readStoredBody(raw as StoredGameBody, projectId);
      data.library = readLibrary(data);
      check(data);
    },
  };
}

async function stampLibraryMetadata(
  data: CachedGameData,
  protectCatalog: boolean,
): Promise<boolean> {
  const revision = await gameRevision(data.files);
  const previous = data.library;
  if (protectCatalog && previous?.source === "catalog" && previous.revision !== revision)
    throw new Error("Catalog resources are immutable. Create a remix before changing them.");
  const merged = projectCommitLibrary(previous, {
    revision,
    source: data.imported ? "zip" : "authored",
  });
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
    const authoring = authoringFingerprint(data.authoringState, data.workspace);
    announceProjectWrite({
      projectId: data.projectId,
      revision: data.library.revision,
      generation: data.generation,
      ...(written.replaced !== undefined &&
      authoring !==
        authoringFingerprint(written.replaced.authoringState, written.replaced.workspace)
        ? { fingerprint: authoring }
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
  /**
   * The candidate's own native removals (`logic:N`, `picture:N`, `view:N`,
   * `sound:N`), when it deletes resources. The candidate hash covers the
   * field, so a same-id retry repeats it exactly.
   */
  readonly removals?: readonly string[] | undefined;
  readonly data: Omit<CachedGameData, "projectId" | "authoredAt" | "generation">;
}

export interface ProjectCommitReceipt {
  readonly commitId: string;
  readonly workspaceId: string;
  readonly candidateHash: string;
  readonly journalHash?: string;
  readonly documents: readonly { readonly key: string; readonly version: number }[];
  readonly saved: CommittedProjectIdentity;
  /** Exact durable History acknowledged by this receipt. */
  readonly history?: { readonly cursor: string | null; readonly hash: string };
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
export async function commitProject(
  input: ProjectCommitRequest,
  journalHash?: string,
): Promise<{
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
  const { PROJECT_RESOURCE_KEY } = await import("../../../src/authoring/projectRemoval.ts");
  const removals = new Set<string>();
  for (const key of request.removals ?? []) {
    if (typeof key !== "string" || !PROJECT_RESOURCE_KEY.test(key) || removals.has(key))
      throw new Error("Invalid project commit removal.");
    removals.add(key);
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
    readStoredBody(storedBody(data), data.projectId);
    await stampLibraryMetadata(data, true);
    let current: StoredGameBody | undefined;
    let previousLifetime: HistoryLifetime | undefined;
    const historyModule = await import("./projectHistoryStorage.ts");
    const history = historyModule.checkedProjectHistory(data);
    if (history !== undefined) data.projectHistory = history;
    const receiptKey = `commit/${request.projectId}/${request.commitId}`;
    const committed = await updateBodyRecords(
      receiptKey,
      (raw) => {
        const admit = (): BodyRecordsOutcome<{
          receipt: ProjectCommitReceipt;
          body: StoredGameBody;
          changed: boolean;
        }> => {
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
              authoringFingerprint(current.authoringState, current.workspace) !== expected.authoring
            )
              throw new ConcurrencyConflictError(
                "This project was modified by another window.",
                current,
              );
          }
          const generation = generationOf(current) + 1;
          if (!Number.isSafeInteger(generation))
            throw new Error("Project generation limit reached.");
          data.generation = generation;
          const epoch = current === undefined ? crypto.randomUUID() : lifetime;
          if (epoch === null) throw new ProjectDeletedError("This project lifetime was removed.");
          // One finish for both paths: the body, the commit receipt and, for a
          // first commit, the lifetime receipt go in together.
          const finish = () => {
            const receipt: ProjectCommitReceipt = {
              commitId: request.commitId,
              workspaceId: request.workspaceId,
              candidateHash,
              ...(journalHash === undefined ? {} : { journalHash }),
              ...(history !== undefined
                ? {
                    history: {
                      cursor: history.cursor,
                      hash: sha256Hex(new TextEncoder().encode(JSON.stringify(history))),
                    },
                  }
                : {}),
              documents: request.documents,
              saved: {
                projectId: request.projectId,
                generation,
                lifetime: epoch,
                revision: data.library!.revision,
                authoring: authoringFingerprint(data.authoringState, data.workspace),
                buildId: request.buildId,
              },
            };
            const body = storedBody(data);
            if (history === undefined && current?.editHistory !== undefined) {
              body.editHistory = current.editHistory;
            }
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
            return { receipt, body, puts };
          };
          const finished = finish();
          return { result: { ...finished, changed: true }, puts: finished.puts };
        };
        const outcome = admit();
        const reads = [
          ...new Set([
            ...historyModule.historyBlobKeys(request.projectId, current?.editHistory),
            ...Object.keys(history?.blobs ?? {}).map((hash) =>
              historyModule.projectHistoryBlobKey(request.projectId, hash),
            ),
            ...("complete" in outcome ? outcome.reads : []),
          ]),
        ];
        return {
          reads,
          complete: (rows: Map<string, unknown>) => {
            const settled = "complete" in outcome ? outcome.complete(rows) : outcome;
            const changes = historyModule.projectHistoryWrites(
              request.projectId,
              current?.editHistory,
              settled.result.changed ? history : undefined,
              rows,
            );
            return {
              result: settled.result,
              puts: [...(settled.puts ?? []), ...changes.puts],
              deletes: [...changes.deletes],
            };
          },
        };
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

/**
 * The queue slot a `serializeWriteAction` action holds for its key while it
 * runs. Opaque to every caller: `liveTurns` membership is the only
 * authority, so a fabricated object never passes and a turn goes dead the
 * moment its action settles. The action hands it to the one nested caller
 * that must read inside the slot; nothing else may share it.
 */
export interface OwnedWriteTurn {
  readonly _?: never;
}

const liveTurns = new WeakSet<OwnedWriteTurn>();
const turnKeys = new WeakMap<OwnedWriteTurn, string>();

/**
 * Serialize an action that must hold this key's queue slot while it loads a
 * module before opening a transaction — a coherent capture or publication
 * whose implementation is fetched on demand. The action receives the owned
 * turn for work it deliberately launches inside the slot; writers arriving
 * from outside queue behind the whole action exactly as with
 * `serializeWrite`, whether the action completes or refuses.
 */
export function serializeWriteAction<T>(
  key: string,
  operation: (turn: OwnedWriteTurn) => Promise<T>,
): Promise<T> {
  return serializeWrite(key, async () => {
    const turn: OwnedWriteTurn = {};
    liveTurns.add(turn);
    turnKeys.set(turn, key);
    try {
      return await operation(turn);
    } finally {
      liveTurns.delete(turn);
      turnKeys.delete(turn);
    }
  });
}

/**
 * Run `operation` inside `turn` — the queue slot `serializeWriteAction`
 * still holds for `key` — so the action's own nested reads never queue
 * behind the module load that suspended it. A turn never issued, already
 * settled, or issued for another key refuses by name.
 */
export function runInWriteTurn<T>(
  turn: OwnedWriteTurn,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!liveTurns.has(turn) || turnKeys.get(turn) !== key)
    return Promise.reject(new Error("This write turn is closed or was issued for another queue."));
  return operation();
}
async function recoverProjectJournal(
  capture: ProjectJournalCapture,
): Promise<{ receipt: ProjectCommitReceipt }> {
  const { hash, ...intent } = capture;
  if (sha256Hex(new TextEncoder().encode(JSON.stringify(encodeJournalValue(intent)))) !== hash)
    throw new Error("Invalid pending project write identity.");
  const base = await serializeWrite(capture.base.projectId, async () => {
    const rows = await readBodyRecordSet([
      `commit/${capture.identity.projectId}/${capture.identity.commitId}`,
      `lifetime/${capture.identity.projectId}`,
    ]);
    const committed = rows.get(
      `commit/${capture.identity.projectId}/${capture.identity.commitId}`,
    ) as StoredProjectCommit | undefined;
    if (committed !== undefined) {
      if (committed.format !== "monotio.agi.project-commit" || committed.version !== 1)
        throw new Error("This project commit version is not supported by this app.");
      if (
        liveLifetime(rows.get(`lifetime/${capture.identity.projectId}`) as HistoryLifetime) !==
        committed.receipt.saved.lifetime
      )
        throw new ProjectDeletedError(
          "This commit belongs to a removed or replaced project lifetime.",
        );
      if (committed.receipt.journalHash !== capture.hash)
        throw new Error("This commit ID was reused for a different candidate.");
      return { receipt: committed.receipt };
    }
    let lifetime: string | null = null;
    const data = await readBody(capture.base.projectId, (value) => {
      lifetime = value;
    });
    if (data === null || lifetime !== capture.base.lifetime)
      throw new ProjectDeletedError("This project was removed or replaced by another window.");
    if (
      (data.generation ?? 0) !== capture.base.generation ||
      data.library?.revision !== capture.base.revision ||
      authoringFingerprint(data.authoringState, data.workspace) !== capture.base.authoring
    )
      throw new ConcurrencyConflictError(
        "This project was modified by another window.",
        storedBody(data),
      );
    return { data };
  });
  if ("receipt" in base) return { receipt: base.receipt! };
  const { rebuildProjectJournal } = await import("./projectSessionCore.ts");
  const rebuilt = await rebuildProjectJournal(base.data!, capture, {
    commit: commitProject,
    fingerprint: authoringFingerprint,
  });
  return commitProject(journalCandidate(capture, rebuilt), capture.hash);
}

export async function loadAuthoredGame(projectId: ProjectId): Promise<CachedGameData | null> {
  const recovery =
    typeof localStorage === "undefined"
      ? undefined
      : resumeProjectSaveJournals(localStorage, projectId, commitProject, recoverProjectJournal);
  if (recovery !== undefined) await recovery;
  return serializeWrite(projectId, () => readBody(projectId));
}

/** Body and lifetime are read from one snapshot before a worker can start. */
export async function loadAuthoredGameWithHistoryLifetime(
  projectId: ProjectId,
): Promise<{ data: CachedGameData; lifetime: string | null } | null> {
  const recovery =
    typeof localStorage === "undefined"
      ? undefined
      : resumeProjectSaveJournals(localStorage, projectId, commitProject, recoverProjectJournal);
  if (recovery !== undefined) await recovery;
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
export async function saveAuthoredGameWithLifetime(
  projectId: ProjectId,
  data: Omit<CachedGameData, "projectId" | "authoredAt">,
  options?: ProjectWriteOptions,
): Promise<string | null> {
  return (await saveAuthoredGameCapture(projectId, data, options))?.lifetime ?? null;
}

/** The first session uses the exact saved body and lifetime from its own transaction. */
export function saveAuthoredGameCapture(
  projectId: ProjectId,
  data: Omit<CachedGameData, "projectId" | "authoredAt">,
  options?: ProjectWriteOptions,
): Promise<{ data: CachedGameData; lifetime: string } | null> {
  return serializeWrite(projectId, async () => {
    try {
      const gen = options?.expectedGeneration;
      const saved = structuredClone({ ...data, projectId, authoredAt: new Date().toISOString() });
      const lifetime = await writeBody(saved, {
        expectedGeneration: gen,
        expectedLifetime: options?.expectedLifetime,
        requireNew: options?.requireNew,
      });
      return { data: structuredClone(saved), lifetime };
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
    data.provider !== undefined &&
    data.model !== undefined &&
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
  backgroundChats?: readonly AgentChat[],
): Promise<boolean> {
  return serializeWrite(projectId, async () => {
    try {
      const data = await readBody(projectId);
      if (!data) return false;
      const gen = expectedGeneration ?? data.generation;
      if (backgroundChats?.length) data.chats = appendAgentTasks(data, backgroundChats);
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

/** What one removal transaction committed — the capture id and the lifetime it ended. */
interface ProjectRemovalResult {
  /** The durable recovery capture's record key, or null when nothing was observed. */
  readonly recoveryId: string | null;
  /** The history lifetime this removal ended — null when none was still live. */
  readonly removedLifetime: string | null;
}

/**
 * One read-write transaction retiring a saved project and every record its
 * progress owned. Reads run first and delete nothing — body, lifetime
 * receipt, conversation, the `history/<id>` manifest and a cursor over every
 * `history/<id>/` descendant (`/next` timelines, unknown children and orphan
 * records alike). An explicit `target` then demands the live body still
 * exist at its captured epoch, so a stale selection can never delete a body
 * recreated under the same id. Only once the checks pass is whatever legacy
 * progress was observed copied raw — structured-clone values are captured
 * untouched, never decoded — into an immutable `legacy-progress/` record
 * queued with `store.add` beside the owned deletes: the lifetime receipt's
 * retirement, the namespaced tape of the resolved epoch, the body,
 * conversation, drafts and creative records. A guard, cursor, clone or
 * quota failure aborts capture and removal together; nothing leaves unless
 * everything was captured.
 *
 * Without `target` (the compatibility entrypoint) the live epoch is
 * resolved inside the transaction and an absent body is an idempotent
 * no-op: legacy keys, the receipt and any captures stay exactly as found,
 * and no deletion UUID or recovery record is minted — data is never retired
 * without a live body to own it. localStorage is never touched here — the
 * caller detaches the observed legacy strings beforehand and clears its own
 * retired namespaced keys after; the two stores are not claimed to commit
 * atomically.
 */
async function removeProjectRecords(
  project: ProjectId,
  options?: {
    target?: ProjectProgressTarget;
    observedLocal?: readonly RawLocalEntry[];
  },
): Promise<ProjectRemovalResult> {
  const db = await openDatabase();
  return new Promise<ProjectRemovalResult>((resolve, reject) => {
    const transaction = db.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    let contractError: Error | undefined;
    let outcome: ProjectRemovalResult | undefined;
    const fail = (error: unknown): void => {
      contractError ??= error instanceof Error ? error : new Error(String(error));
      transaction.abort();
    };
    const captured: CapturedRecord[] = [];
    const requests = [
      store.get(project),
      store.get(`lifetime/${project}`),
      store.get(`conversation/${project}`),
      store.get(`history/${project}`),
    ];
    let arrived = 0;
    const settle = (): void => {
      if (++arrived === requests.length + 1) remove();
    };
    for (const each of requests) each.onsuccess = settle;
    // Observe every descendant without deleting — even when the root
    // manifest is already absent. Whether anything leaves is decided only
    // after the body and receipt have been checked.
    queuePrefixScan(
      store,
      `history/${project}/`,
      (key, cursor) => {
        captured.push({ key, value: cursor.value });
      },
      settle,
    );
    const remove = (): void => {
      try {
        const body = requests[0]!.result;
        const receipt = requests[1]!.result as HistoryLifetime | undefined;
        const conversation = requests[2]!.result;
        const historyHead = requests[3]!.result;
        const target = options?.target;
        if (target !== undefined) {
          if (body === undefined)
            throw new ProjectDeletedError(`Project "${project}" was removed.`);
          if (!lifetimeHolds(target.bodyEpoch, liveLifetime(receipt)))
            throw new ProjectDeletedError(
              `Project "${project}" was removed or replaced by another window.`,
            );
        }
        // Without a live body the removal owns nothing: orphaned keys, the
        // receipt and earlier captures stay exactly as found.
        if (body === undefined) {
          outcome = { recoveryId: null, removedLifetime: null };
          return;
        }
        // The namespaced tape the resolved epoch owned — the `project:<id>:<epoch>`
        // locator layout progressTarget.ts defines.
        const locator =
          target?.locator ?? `project:${project}:${liveLifetime(receipt) ?? INITIAL_LIFETIME}`;
        const records: CapturedRecord[] = [];
        if (historyHead !== undefined)
          records.push({ key: `history/${project}`, value: historyHead });
        records.push(...captured);
        if (conversation !== undefined)
          records.push({ key: `conversation/${project}`, value: conversation });
        if (receipt !== undefined) records.push({ key: `lifetime/${project}`, value: receipt });
        const local = options?.observedLocal ?? [];
        let recoveryId: string | null = null;
        // A bare receipt alone is bookkeeping, not progress worth keeping.
        if (
          historyHead !== undefined ||
          captured.length > 0 ||
          conversation !== undefined ||
          local.length > 0
        ) {
          const record = newLegacyProgressRecord(project, local, records);
          recoveryId = record.projectId;
          store.add(record);
        }
        store.delete(`history/${project}`);
        for (const entry of captured) store.delete(entry.key);
        store.delete(`conversation/${project}`);
        store.delete(`draft/${project}`);
        // Obsolete creative storage rows belong to this
        // lifetime: a reimport under the same id must not inherit them.
        store.delete(`creative/${project}`);
        queuePrefixScan(store, `project-history/${project}/`, (_key, cursor) => cursor.delete());
        // The namespaced tape the resolved epoch owned leaves with it.
        store.delete(`history/${locator}`);
        queuePrefixScan(store, `history/${locator}/`, (_key, cursor) => {
          cursor.delete();
        });
        queuePrefixScan(store, `draft/${project}/`, (_key, cursor) => {
          cursor.delete();
        });
        queuePrefixScan(store, `creative/${project}/`, (_key, cursor) => {
          cursor.delete();
        });
        // Keep a small deletion receipt outside the history prefix. A writer
        // in another tab must not recreate a tape, even if its boot arrives
        // late.
        store.put({
          projectId: `lifetime/${project}`,
          epoch: crypto.randomUUID(),
          deleted: true,
        } satisfies HistoryLifetime);
        store.delete(project);
        outcome = { recoveryId, removedLifetime: liveLifetime(receipt) };
      } catch (error) {
        fail(error);
      }
    };
    transaction.oncomplete = () => {
      if (outcome === undefined) reject(new Error("Project storage transaction closed early."));
      else resolve(outcome);
    };
    transaction.onerror = () => reject(contractError ?? transaction.error);
    transaction.onabort = () =>
      reject(
        contractError ?? transaction.error ?? new Error("Project storage transaction aborted."),
      );
  });
}

export function clearCachedGame(projectId: ProjectId): Promise<void> {
  return serializeWrite(projectId, async () => {
    // The body, its conversation and its history leave together: projectIds are
    // deterministic, so a game added again must not inherit the removed one's
    // history — and the legacy progress under its bare id is captured into a
    // durable recovery record before any of it leaves.
    const removed = await removeProjectRecords(projectId);
    localStorage.removeItem(getStorageKey(projectId));
    // A tab running the removed lifetime stops writing for it at once; one
    // already removed has no lifetime left to end.
    if (removed.removedLifetime !== null)
      announceProjectWrite({ projectId, removed: removed.removedLifetime });
  });
}

/**
 * Remove a saved project together with the progress its bound body epoch
 * owns. `target` is the progress address captured with the live body — a
 * stale selection refuses instead of deleting a body recreated under the
 * same id. Whatever legacy progress still sits at the released unscoped
 * keys is captured into an immutable recovery record inside the same
 * transaction, so nothing is deleted when the capture cannot commit.
 * `retiredLocator` names the namespaced tape the epoch owned; the caller
 * clears only that prefix's localStorage sidecars afterward — legacy
 * localStorage strings are preserved inside the capture, never rewritten.
 */
export function removeProjectWithProgress(
  target: ProjectProgressTarget,
  observedLegacyLocal: readonly RawLocalEntry[],
): Promise<{ recoveryId: string | null; retiredLocator: string }> {
  return serializeWrite(target.project, async () => {
    const removed = await removeProjectRecords(target.project, {
      target,
      observedLocal: observedLegacyLocal,
    });
    // The body is durably gone once the transaction resolves — an index or
    // broadcast failure afterward must not read as a refusal, since the
    // metadata index is a disposable cache reconcileGameIndex rebuilds.
    try {
      localStorage.removeItem(getStorageKey(target.project));
      if (removed.removedLifetime !== null)
        announceProjectWrite({ projectId: target.project, removed: removed.removedLifetime });
    } catch (error) {
      console.error("Project removal cleanup failed after the records left:", error);
    }
    return { recoveryId: removed.recoveryId, retiredLocator: target.locator };
  });
}

/**
 * Every recovery capture stored for one legacy source id — a bare project
 * id, or an installed instance's released folder/hash spelling — or all
 * captures when `source` is omitted. Read-only and independent of the
 * removed body, so a deleted project's progress stays findable. A capture
 * whose version or layout this build does not know refuses the listing,
 * never rewrites the record.
 */
export async function listLegacyProgress(source?: string): Promise<LegacyProgressRecord[]> {
  const db = await openDatabase();
  return new Promise<LegacyProgressRecord[]>((resolve, reject) => {
    const transaction = db.transaction("projects", "readonly");
    const found: LegacyProgressRecord[] = [];
    queuePrefixScan(
      transaction.objectStore("projects"),
      legacyProgressPrefix(source),
      (_key, cursor) => {
        const record = readLegacyProgressRecord(cursor.value);
        if (record !== null) found.push(record);
      },
      () => resolve(found),
    );
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Recovery listing was aborted."));
  });
}

/**
 * Load one recovery capture by its record key — the `recoveryId` a removal
 * returned. `null` when no such record exists or the record is not a
 * capture; a capture this build does not know is refused, never rewritten.
 */
export async function loadLegacyProgressRecord(
  recoveryId: string,
): Promise<LegacyProgressRecord | null> {
  const db = await openDatabase();
  return new Promise<LegacyProgressRecord | null>((resolve, reject) => {
    const transaction = db.transaction("projects", "readonly");
    const request = transaction.objectStore("projects").get(recoveryId);
    request.onsuccess = () => resolve(readLegacyProgressRecord(request.result));
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Recovery lookup was aborted."));
  });
}

/**
 * Every `legacy-progress/` row stored for one source id — or all rows when
 * `source` is omitted — each with the state this build can honestly report:
 * `available` decodes into a capture, `unsupported` is a capture envelope of
 * a version this build does not know, `unreadable` holds the prefix without
 * a readable capture. One future or malformed row can never hide its
 * neighbours, and refused rows carry their raw stored value untouched.
 * `bounds.limit`/`bounds.after` page the listing for callers that render it;
 * read-only and independent of the removed body.
 */
export async function listLegacyProgressRows(
  source?: string,
  bounds?: { after?: string; limit?: number },
): Promise<LegacyProgressRow[]> {
  const db = await openDatabase();
  return new Promise<LegacyProgressRow[]>((resolve, reject) => {
    const transaction = db.transaction("projects", "readonly");
    const rows: LegacyProgressRow[] = [];
    queuePrefixScan(
      transaction.objectStore("projects"),
      legacyProgressPrefix(source),
      (key, cursor) => {
        const state = classifyLegacyProgressRecord(cursor.value);
        rows.push(
          state === "available"
            ? { key, state, record: cursor.value as LegacyProgressRecord }
            : { key, state, value: cursor.value },
        );
      },
      () => resolve(rows),
      bounds,
    );
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Recovery listing was aborted."));
  });
}

/**
 * One recovery row by its exact record key — `legacy-progress/<source>/<id>`.
 * Any other key refuses up front, so the read can never be aimed at an
 * unrelated record. A missing record reports `absent`; a capture this build
 * cannot read reports `unsupported` or `unreadable` with its raw value —
 * format refusal is never presented as missing data. Read-only and
 * independent of whether a body still exists for the source.
 */
export async function readLegacyProgressRow(key: string): Promise<LegacyProgressRow> {
  if (!isLegacyProgressKey(key)) throw new Error(`"${key}" is not a legacy progress record key.`);
  const db = await openDatabase();
  return new Promise<LegacyProgressRow>((resolve, reject) => {
    const transaction = db.transaction("projects", "readonly");
    const request = transaction.objectStore("projects").get(key);
    let row: LegacyProgressRow | undefined;
    request.onsuccess = () => {
      const value = request.result as unknown;
      if (value === undefined) {
        row = { key, state: "absent" };
        return;
      }
      const state = classifyLegacyProgressRecord(value);
      row =
        state === "available"
          ? { key, state, record: value as LegacyProgressRecord }
          : { key, state, value };
    };
    transaction.oncomplete = () => resolve(row ?? { key, state: "absent" });
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Recovery lookup was aborted."));
  });
}

/**
 * One legacy source's complete live unscoped records: `history/<source>` and
 * every `history/<source>/` descendant — `/next` timelines, orphans and
 * unknown record shapes alike — plus `conversation/<source>` and
 * `lifetime/<source>`, all read inside a single readonly transaction and
 * returned as detached raw clone entries: exact keys, structured-clone
 * values never decoded, rewritten or reconstructed.
 *
 * `source` is an explicitly identified released storage key — a bare project
 * id or an installed instance's released folder/hash spelling. Every
 * recognized progress namespace spelling is refused — the current
 * `installed:`/`project:` locators and the unreleased folder-only
 * `installed:<digest>` predecessor alike: namespaced tapes have their own
 * owner and never read through the legacy surface. The read needs
 * no live body or current epoch — it only ever reads — and it fabricates no
 * ownership: callers decide what the returned rows mean. localStorage
 * observations are supplied separately by the caller's adapter; nothing here
 * claims the two stores were observed atomically.
 */
export interface LegacySourceSnapshot {
  /** The explicitly identified legacy storage id that was read. */
  readonly source: string;
  /** Every live record under the source's unscoped keys, in key order. */
  readonly records: readonly CapturedRecord[];
}

export async function readLegacySourceSnapshot(source: string): Promise<LegacySourceSnapshot> {
  if (typeof source !== "string" || source === "")
    throw new Error("A legacy source names a released storage key.");
  if (isProgressNamespace(source)) throw new Error("A progress locator is not a legacy source.");
  const db = await openDatabase();
  return new Promise<LegacySourceSnapshot>((resolve, reject) => {
    const transaction = db.transaction("projects", "readonly");
    const store = transaction.objectStore("projects");
    const historyHead = store.get(`history/${source}`);
    const conversation = store.get(`conversation/${source}`);
    const receipt = store.get(`lifetime/${source}`);
    const descendants: CapturedRecord[] = [];
    queuePrefixScan(store, `history/${source}/`, (key, cursor) => {
      descendants.push({ key, value: cursor.value });
    });
    transaction.oncomplete = () => {
      const records: CapturedRecord[] = [];
      if (historyHead.result !== undefined)
        records.push({ key: `history/${source}`, value: historyHead.result });
      records.push(...descendants);
      if (conversation.result !== undefined)
        records.push({ key: `conversation/${source}`, value: conversation.result });
      if (receipt.result !== undefined)
        records.push({ key: `lifetime/${source}`, value: receipt.result });
      resolve({ source, records });
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Legacy source read was aborted."));
  });
}

/** One bounded page of raw `history/` record keys for legacy-source discovery. */
export interface LegacyHistoryKeyPage {
  /** Up to `bounds.limit` keys under `history/`, in the store's ascending key order. */
  readonly keys: readonly string[];
  /**
   * Resume key for the next page — the last key this page returned. Absent
   * once the `history/` namespace drained: an exhausted page and a short
   * final page both end discovery, and no key is ever skipped.
   */
  readonly after?: string | undefined;
}

/**
 * Paged enumeration of the raw `history/` record keys — the unscoped tape
 * namespace released builds wrote under bare storage keys. Read-only, and
 * only record keys are consumed: the cursor never inspects values, so a page
 * stays cheap even over large tapes. `bounds.limit` caps the records a page
 * visits (default 256); a caller that wants every source keeps calling with
 * `after` set to the previous page's resume key until it comes back absent.
 * What a key belongs to is the caller's grammar — this reports raw keys only.
 */
export async function scanLegacyHistoryKeys(
  page?: { after?: string },
  bounds?: { limit?: number },
): Promise<LegacyHistoryKeyPage> {
  const limit = Math.max(1, bounds?.limit ?? 256);
  const db = await openDatabase();
  return new Promise<LegacyHistoryKeyPage>((resolve, reject) => {
    const transaction = db.transaction("projects", "readonly");
    const keys: string[] = [];
    let more = false;
    // One extra visit beyond the page size separates "the namespace drained"
    // from "the page is full": the probe key is not returned, and the next
    // page resumes strictly after this page's last key — no key is skipped
    // or visited twice.
    queuePrefixScan(
      transaction.objectStore("projects"),
      "history/",
      (key) => {
        if (keys.length < limit) keys.push(key);
        else more = true;
      },
      () => resolve(more ? { keys, after: keys[keys.length - 1]! } : { keys }),
      {
        ...(page?.after === undefined ? {} : { after: page.after }),
        limit: limit + 1,
      },
    );
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("History key scan was aborted."));
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

async function storedProjectRecords(): Promise<CapturedRecord[]> {
  // Keys first: the shared store also carries history batch/blob bodies, and
  // getAll() would clone every tape into memory just to name the projects.
  // Only the candidate project bodies are read — history keys all live under
  // `history/` and `conversation/` prefixes.
  return (async (): Promise<CapturedRecord[]> => {
    const db = await openDatabase();
    return new Promise<CapturedRecord[]>((resolve, reject) => {
      const transaction = db.transaction("projects", "readonly");
      const store = transaction.objectStore("projects");
      const found: CapturedRecord[] = [];
      const keysRequest = store.getAllKeys();
      keysRequest.onsuccess = () => {
        for (const key of keysRequest.result) {
          if (typeof key !== "string" || key.includes("/")) continue;
          const each = store.get(key);
          each.onsuccess = () => {
            if (each.result !== undefined) found.push({ key, value: each.result });
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

async function storedProjects(): Promise<StoredGameBody[]> {
  return (await storedProjectRecords()).flatMap(({ key, value }) => {
    const data = value as StoredGameBody | undefined;
    return data?.format === "monotio.agi.stored-project" &&
      data.version === 1 &&
      data.projectId === key &&
      data.files &&
      typeof data.files === "object"
      ? [data]
      : [];
  });
}

export interface UnsupportedStoredProject {
  readonly projectId: ProjectId;
  readonly title: string;
}

function unsupportedStoredProject(key: string, value: unknown): UnsupportedStoredProject | null {
  const id = projectId(key);
  if (!id || value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record["format"] !== "monotio.agi.stored-project" || record["version"] === 1) return null;
  return {
    projectId: id,
    title:
      typeof record["title"] === "string" && record["title"].trim()
        ? record["title"]
        : "Saved project",
  };
}

/** Opaque future bodies stay visible even when their resources and index cannot be read. */
export async function listUnsupportedStoredProjects(): Promise<UnsupportedStoredProject[]> {
  return (await storedProjectRecords()).flatMap(({ key, value }) => {
    const entry = unsupportedStoredProject(key, value);
    return entry ? [entry] : [];
  });
}

/** Recovery download: retain the raw envelope, additive fields and every resource byte. */
export async function downloadUnsupportedStoredProject(id: ProjectId): Promise<string> {
  const db = await openDatabase();
  const { raw, records } = await new Promise<{ raw: unknown; records: CapturedRecord[] }>(
    (resolve, reject) => {
      const transaction = db.transaction("projects", "readonly");
      const store = transaction.objectStore("projects");
      const body = store.get(id);
      const records: CapturedRecord[] = [];
      // History's content lives beside the body. Capture every sibling layout,
      // including future versions, in the same snapshot without interpreting it.
      queuePrefixScan(store, `project-history/${id}/`, (key, cursor) => {
        records.push({ key, value: cursor.value });
      });
      transaction.oncomplete = () => resolve({ raw: body.result, records });
      transaction.onerror = () => reject(transaction.error ?? body.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Project download was aborted."));
    },
  );
  if (!unsupportedStoredProject(id, raw))
    throw new Error("The saved project changed. Refresh the library before downloading it.");
  return JSON.stringify({
    format: "monotio.agi.stored-project-recovery",
    version: 1,
    record: encodeJournalValue(raw),
    records: encodeJournalValue(records),
    index: localStorage.getItem(getStorageKey(id)),
  });
}

/** Discover committed projects even when the disposable metadata cache is unavailable. */
export async function listStoredProjects(): Promise<CachedGameMeta[]> {
  const bodies = await storedProjects();
  const entries: CachedGameMeta[] = [];
  for (const body of bodies) {
    if (typeof body.title !== "string" || typeof body.authoredAt !== "string") continue;
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
