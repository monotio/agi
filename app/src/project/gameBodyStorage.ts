/** IndexedDB records and lifetime fences shared by projects and part drafts. */
let database: Promise<IDBDatabase> | undefined;
export function openDatabase(): Promise<IDBDatabase> {
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
export type BodyRecordsOutcome<T> =
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
    const abortUpdate = (error: unknown): void => {
      if (contractError !== undefined) return;
      contractError = error instanceof Error ? error : new Error(String(error));
      try {
        transaction.abort();
      } catch (abortError) {
        // A refused operation can leave the transaction already aborted.
        // Preserve its original failure instead of throwing from the callback.
        if (!(abortError instanceof DOMException && abortError.name === "InvalidStateError")) {
          reject(abortError);
          return;
        }
      }
      reject(contractError);
    };
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
                    abortUpdate(error);
                  }
                }
              };
            }
            return;
          }
          settle(produced);
        } catch (error) {
          abortUpdate(error);
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
            abortUpdate(error);
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

export interface HistoryLifetime {
  projectId: string;
  epoch: string;
  deleted: boolean;
}

/** The lifetime of a project written before lifetime receipts existed. */
export const INITIAL_LIFETIME = "initial";

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
export class ProjectDeletedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectDeletedError";
  }
}
