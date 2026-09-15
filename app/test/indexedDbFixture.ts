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
        try {
          value.result = operation();
          value.onsuccess?.();
          transaction["pending"] = Number(transaction["pending"]) - 1;
          queueMicrotask(() => {
            if (!transaction["aborted"] && transaction["pending"] === 0) {
              transaction["settled"] = true;
              (transaction["oncomplete"] as (() => void) | null)?.();
              (transaction["release"] as (() => void) | undefined)?.();
            }
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
      };
      if (mode === "readwrite") {
        transaction["gate"] = writeTail;
        writeTail = new Promise<void>((resolve) => {
          transaction["release"] = resolve;
        });
        // An empty transaction commits as soon as the creating task yields.
        queueMicrotask(() =>
          queueMicrotask(() => {
            if (transaction["pending"] === 0 && !transaction["settled"]) {
              transaction["settled"] = true;
              (transaction["release"] as (() => void) | undefined)?.();
            }
          }),
        );
      }
      transaction["abort"] = () => {
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
            const value = records.get(key);
            return value === undefined ? undefined : structuredClone(value);
          }),
        getAll: () => request(transaction, () => structuredClone([...records.values()])),
        put: (value: { projectId?: IDBValidKey }) =>
          request(transaction, () => {
            const key = value.projectId!;
            records.set(key, structuredClone(value));
            return key;
          }),
        delete: (key: IDBValidKey) =>
          request(transaction, () => {
            records.delete(key);
            return undefined;
          }),
      });
      return transaction;
    },
  };
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
