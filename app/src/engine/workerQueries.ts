import type { PatchKind, WorkerControl } from "../worker/workerProtocol.ts";

export class WorkerQueryTimeoutError extends Error {
  readonly id: number;
  constructor(id: number, type: string) {
    super(`worker query ${type} timed out`);
    this.id = id;
  }
}

export interface WorkerQueries {
  readonly query: <T>(
    getWorker: () => Worker | null,
    type: string,
    extra?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<T>;
  readonly resolveQuery: (id: number, value: unknown) => boolean;
  /** Settle a pending query as refused — a structured worker error reply. */
  readonly rejectQuery: (id: number, err: Error) => boolean;
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
        reject(new WorkerQueryTimeoutError(id, type));
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

  function rejectQuery(id: number, err: Error): boolean {
    const q = pending.get(id);
    if (!q) return false;
    pending.delete(id);
    clearTimeout(q.timer);
    q.reject(err);
    return true;
  }

  return { query, resolveQuery, rejectQuery, drainPendingQueries };
}

/** One resource a `patch` sends, named by the hint of its bytes. */
interface PatchExpectation {
  readonly kind: PatchKind;
  readonly num: number;
  readonly hint: string;
}

/** A worker's confirmed install of one `patch` message's resources. */
interface PatchAck {
  readonly resources: readonly PatchExpectation[];
  readonly patchGen: number;
}

/**
 * Settle when the worker acks a `patch` of exactly these resources, each
 * holding the bytes its hint names.
 */
export type AwaitPatchedFn = (
  resources: readonly PatchExpectation[],
  timeoutMs?: number,
) => Promise<PatchAck>;

export interface PatchWaiters {
  readonly awaitPatched: AwaitPatchedFn;
  /** Deliver one `patched` ack to the oldest waiter on its resources; false when none waited. */
  readonly settlePatched: (msg: Extract<WorkerControl, { type: "patched" }>) => boolean;
  readonly drainPatchWaiters: (err?: Error) => void;
}

const resourceList = (resources: readonly { kind: PatchKind; num: number }[]): string =>
  resources.map(({ kind, num }) => `${kind} ${num}`).join(", ");

/**
 * Waiters for `patched` acknowledgements. The worker acks patches in the
 * order they were posted, so the oldest waiter on the same resource list
 * owns the next ack for it; a register-before-post caller can never miss its
 * own. The ack resolves only when every resource holds the bytes the caller
 * sent — a refused install or different bytes reject.
 */
export function createPatchWaiters(): PatchWaiters {
  interface Waiter {
    key: string;
    resources: readonly PatchExpectation[];
    resolve: (ack: PatchAck) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  const waiters: Waiter[] = [];

  function awaitPatched(
    resources: readonly PatchExpectation[],
    timeoutMs = 5000,
  ): Promise<PatchAck> {
    return new Promise<PatchAck>((resolve, reject) => {
      const waiter: Waiter = {
        key: resourceList(resources),
        resources,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`the running game did not acknowledge ${waiter.key}`));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  }

  function settlePatched(msg: Extract<WorkerControl, { type: "patched" }>): boolean {
    const key = resourceList(msg.resources);
    const index = waiters.findIndex((w) => w.key === key);
    if (index < 0) return false;
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter!.timer);
    const wrong = msg.resources.find((resource, i) => resource.hint !== waiter!.resources[i]!.hint);
    if (msg.error !== undefined || msg.resources.some(({ hint }) => hint === null))
      waiter!.reject(new Error(msg.error ?? `the running game refused ${key}`));
    else if (wrong)
      waiter!.reject(
        new Error(
          `the running game holds different ${wrong.kind} ${wrong.num} bytes than were sent`,
        ),
      );
    else waiter!.resolve({ resources: waiter!.resources, patchGen: msg.patchGen });
    return true;
  }

  function drainPatchWaiters(err: Error = new Error("Operation aborted")): void {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  return { awaitPatched, settlePatched, drainPatchWaiters };
}
