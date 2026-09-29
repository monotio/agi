interface MemoryRequest<T> {
  result: T;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

/**
 * The smallest IndexedDB surface needed by game storage tests.
 *
 * Read-write transactions serialize the way real IndexedDB serializes them
 * per object store: a second transaction's requests wait until the first
 * commits or aborts. Without this, two storage clients interleaved on the
 * fake could never reproduce the lost-update the single-transaction merge
 * guards against.
 */
export function installIndexedDbFixture(): Map<IDBValidKey, unknown> {
  const records = new Map<IDBValidKey, unknown>();
  let writeTail: Promise<void> = Promise.resolve();
  // A read-write transaction journals its writes into a private overlay
  // instead of the committed map: reads fall through to `records`, puts and
  // deletes stage on top, and the journal applies only when the transaction
  // completes. An abort or failed request drops the journal, and the overlay
  // is taken lazily so a queued writer starts from what the previous one
  // committed. Read-only transactions keep reading the committed map
  // directly. Reads and the commit-time apply go through the map's own
  // methods so tests that fault-inject them see the same calls as before.
  interface StoreView {
    get(key: IDBValidKey): unknown;
    set(key: IDBValidKey, value: unknown): void;
    delete(key: IDBValidKey): void;
    keys(): Iterable<IDBValidKey>;
    values(): Iterable<unknown>;
  }
  interface Stage {
    puts: Map<IDBValidKey, unknown>;
    deletes: Set<IDBValidKey>;
  }
  const view = (transaction: Record<string, unknown>): StoreView => {
    if (transaction["mode"] !== "readwrite") return records;
    let stage = transaction["stage"] as Stage | undefined;
    if (stage === undefined) {
      const puts = new Map<IDBValidKey, unknown>();
      const deletes = new Set<IDBValidKey>();
      stage = {
        puts,
        deletes,
      };
      transaction["stage"] = stage;
    }
    const { puts, deletes } = stage;
    const keys = () => {
      const merged = new Set<IDBValidKey>();
      for (const key of records.keys()) if (!deletes.has(key)) merged.add(key);
      for (const key of puts.keys()) merged.add(key);
      return merged;
    };
    const get = (key: IDBValidKey) =>
      deletes.has(key) ? undefined : puts.has(key) ? puts.get(key) : records.get(key);
    return {
      get,
      set: (key, value) => {
        puts.set(key, value);
        deletes.delete(key);
      },
      delete: (key) => {
        puts.delete(key);
        deletes.add(key);
      },
      keys: () => keys(),
      values: () => [...keys()].map(get),
    };
  };
  const complete = (transaction: Record<string, unknown>) => {
    if (transaction["settled"]) return;
    const stage = transaction["stage"] as Stage | undefined;
    const before = new Map(records);
    try {
      if (stage !== undefined) {
        for (const key of stage.deletes) records.delete(key);
        for (const [key, value] of stage.puts) records.set(key, value);
      }
    } catch (error) {
      // Publication hooks can fail after earlier writes. Restore through the
      // native Map methods so the same injected fault cannot break rollback.
      Map.prototype.clear.call(records);
      for (const [key, value] of before) Map.prototype.set.call(records, key, value);
      transaction["aborted"] = true;
      transaction["settled"] = true;
      transaction["error"] = error;
      queueMicrotask(() => {
        (transaction["onerror"] as (() => void) | null)?.();
        (transaction["onabort"] as (() => void) | null)?.();
        (transaction["release"] as (() => void) | undefined)?.();
      });
      return;
    }
    transaction["settled"] = true;
    (transaction["oncomplete"] as (() => void) | null)?.();
    (transaction["release"] as (() => void) | undefined)?.();
  };
  const request = <T>(transaction: Record<string, unknown>, operation: () => T): IDBRequest<T> => {
    transaction["pending"] = Number(transaction["pending"]) + 1;
    const value: MemoryRequest<T> = {
      result: undefined as T,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => {
      const gate = transaction["gate"] as Promise<void> | undefined;
      const run = () => {
        if (transaction["settled"]) return;
        try {
          value.result = operation();
          value.onsuccess?.();
          transaction["pending"] = Number(transaction["pending"]) - 1;
          queueMicrotask(() => {
            if (!transaction["aborted"] && transaction["pending"] === 0) complete(transaction);
          });
        } catch (error) {
          // A failed request settles its transaction the way IndexedDB does:
          // the request errors, then the transaction errors and aborts.
          value.error = error as DOMException;
          value.onerror?.();
          transaction["pending"] = Number(transaction["pending"]) - 1;
          transaction["aborted"] = true;
          transaction["settled"] = true;
          transaction["error"] = error;
          queueMicrotask(() => {
            (transaction["onerror"] as (() => void) | null)?.();
            (transaction["onabort"] as (() => void) | null)?.();
            (transaction["release"] as (() => void) | undefined)?.();
          });
        }
      };
      if (gate === undefined) run();
      else void gate.then(run);
    });
    return value as unknown as IDBRequest<T>;
  };
  const database = {
    onversionchange: null,
    close: () => {},
    createObjectStore: () => ({}),
    transaction: (_stores: string, mode: string) => {
      const transaction: Record<string, unknown> = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        aborted: false,
        settled: false,
        pending: 0,
        mode,
      };
      if (mode === "readwrite") {
        transaction["gate"] = writeTail;
        writeTail = new Promise<void>((resolve) => {
          transaction["release"] = resolve;
        });
        // An empty transaction commits as soon as the creating task yields.
        queueMicrotask(() =>
          queueMicrotask(() => {
            if (transaction["pending"] === 0 && !transaction["settled"]) complete(transaction);
          }),
        );
      }
      transaction["abort"] = () => {
        if (transaction["settled"]) return;
        transaction["aborted"] = true;
        transaction["settled"] = true;
        queueMicrotask(() => {
          (transaction["onabort"] as (() => void) | null)?.();
          (transaction["release"] as (() => void) | undefined)?.();
        });
      };
      transaction["objectStore"] = () => ({
        get: (key: IDBValidKey) =>
          request(transaction, () => {
            const value = view(transaction).get(key);
            return value === undefined ? undefined : structuredClone(value);
          }),
        getAll: () => request(transaction, () => structuredClone([...view(transaction).values()])),
        getAllKeys: () =>
          request(transaction, () => [...view(transaction).keys()].sort() as IDBValidKey[]),
        openCursor: (range?: { lower?: IDBValidKey | null; upper?: IDBValidKey | null }) => {
          // Cursor over a key snapshot, in key order — enough surface for
          // prefix deletes (key + delete() + continue()).
          const cursorRequest: Record<string, unknown> = {
            result: null,
            error: null,
            onsuccess: null,
            onerror: null,
          };
          transaction["pending"] = Number(transaction["pending"]) + 1;
          let keys: IDBValidKey[] = [];
          let index = -1;
          const advance = () => {
            if (transaction["settled"]) return;
            index++;
            const key = keys[index];
            cursorRequest["result"] =
              key === undefined
                ? null
                : {
                    key,
                    delete: () => {
                      view(transaction).delete(key);
                    },
                    continue: () => advance(),
                  };
            (cursorRequest["onsuccess"] as (() => void) | null)?.();
            if (key === undefined) {
              transaction["pending"] = Number(transaction["pending"]) - 1;
              queueMicrotask(() => {
                if (!transaction["aborted"] && transaction["pending"] === 0) complete(transaction);
              });
            }
          };
          queueMicrotask(() => {
            const run = () => {
              keys = [...view(transaction).keys()]
                .filter(
                  (key) =>
                    typeof key === "string" &&
                    (range?.lower == null || key >= range.lower) &&
                    (range?.upper == null || key <= range.upper),
                )
                .sort();
              advance();
            };
            const gate = transaction["gate"] as Promise<void> | undefined;
            if (gate === undefined) run();
            else void gate.then(run);
          });
          return cursorRequest as unknown as IDBRequest;
        },
        put: (value: { projectId?: IDBValidKey }) =>
          request(transaction, () => {
            const key = value.projectId!;
            view(transaction).set(key, structuredClone(value));
            return key;
          }),
        delete: (key: IDBValidKey) =>
          request(transaction, () => {
            view(transaction).delete(key);
            return undefined;
          }),
      });
      return transaction;
    },
  };
  // The prefix-delete surface needs a key-range value; only bound() is used.
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: {
      bound: (lower: IDBValidKey, upper: IDBValidKey) => ({ lower, upper }),
    },
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        const openRequest: Record<string, unknown> = {
          result: database,
          error: null,
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
          onblocked: null,
        };
        queueMicrotask(() => {
          (openRequest["onupgradeneeded"] as (() => void) | null)?.();
          (openRequest["onsuccess"] as (() => void) | null)?.();
        });
        return openRequest;
      },
    },
  });
  return records;
}
