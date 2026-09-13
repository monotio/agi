export interface WorkerQueries {
  readonly query: <T>(
    getWorker: () => Worker | null,
    type: string,
    extra?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<T>;
  readonly resolveQuery: (id: number, value: unknown) => boolean;
  readonly drainPendingQueries: (err?: Error) => void;
}

/**
 * Manages synchronous-style promise queries sent to the engine web worker.
 * Answers are resolved between interpreter cycles while execution is paused.
 */
export function createWorkerQueries(): WorkerQueries {
  let nextQueryId = 1;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  function drainPendingQueries(err: Error = new Error("Operation aborted")): void {
    for (const q of pending.values()) {
      clearTimeout(q.timer);
      q.reject(err);
    }
    pending.clear();
  }

  function query<T>(
    getWorker: () => Worker | null,
    type: string,
    extra: Record<string, unknown> = {},
    timeoutMs = 5000,
  ): Promise<T> {
    const worker = getWorker();
    if (!worker) return Promise.reject(new Error("no engine running"));
    const id = nextQueryId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`worker query ${type} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      // The query envelope is assembled here; callers are typed through
      // WorkerQueryFn, so this is the one legitimate untyped literal.
      // ast-grep-ignore: worker-postmessage-satisfies
      worker.postMessage({ type, id, ...extra });
    });
  }

  function resolveQuery(id: number, value: unknown): boolean {
    const q = pending.get(id);
    if (!q) return false;
    pending.delete(id);
    clearTimeout(q.timer);
    q.resolve(value);
    return true;
  }

  return { query, resolveQuery, drainPendingQueries };
}
