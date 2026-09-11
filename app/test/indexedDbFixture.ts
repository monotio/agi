interface MemoryRequest<T> {
  result: T;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

/** The smallest IndexedDB surface needed by game storage tests. */
export function installIndexedDbFixture(): Map<IDBValidKey, unknown> {
  const records = new Map<IDBValidKey, unknown>();
  const request = <T>(transaction: Record<string, unknown>, operation: () => T): IDBRequest<T> => {
    transaction["pending"] = Number(transaction["pending"]) + 1;
    const value: MemoryRequest<T> = {
      result: undefined as T,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => {
      try {
        value.result = operation();
        value.onsuccess?.();
        transaction["pending"] = Number(transaction["pending"]) - 1;
        queueMicrotask(() => {
          if (!transaction["aborted"] && transaction["pending"] === 0)
            (transaction["oncomplete"] as (() => void) | null)?.();
        });
      } catch (error) {
        // A failed request settles its transaction the way IndexedDB does:
        // the request errors, then the transaction errors and aborts.
        value.error = error as DOMException;
        value.onerror?.();
        transaction["pending"] = Number(transaction["pending"]) - 1;
        transaction["aborted"] = true;
        transaction["error"] = error;
        queueMicrotask(() => {
          (transaction["onerror"] as (() => void) | null)?.();
          (transaction["onabort"] as (() => void) | null)?.();
        });
      }
    });
    return value as unknown as IDBRequest<T>;
  };
  const database = {
    onversionchange: null,
    close: () => {},
    createObjectStore: () => ({}),
    transaction: () => {
      const transaction: Record<string, unknown> = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        aborted: false,
        pending: 0,
      };
      transaction["abort"] = () => {
        transaction["aborted"] = true;
        queueMicrotask(() => (transaction["onabort"] as (() => void) | null)?.());
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
