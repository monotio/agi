import type { PatchKind, WorkerControl } from "./workerProtocol.ts";

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

/** A worker's confirmed install of one patched resource. */
export type PatchAck = Omit<Extract<WorkerControl, { type: "patched" }>, "type" | "error"> & {
  hint: string;
};

/** Settle when the worker acks `kind`/`num` holding the bytes `hint` names. */
export type AwaitPatchedFn = (
  kind: PatchKind,
  num: number,
  hint: string,
  timeoutMs?: number,
) => Promise<PatchAck>;

export interface PatchWaiters {
  readonly awaitPatched: AwaitPatchedFn;
  /** Deliver one `patched` ack to the oldest waiter on its resource. */
  readonly settlePatched: (msg: Extract<WorkerControl, { type: "patched" }>) => void;
  readonly drainPatchWaiters: (err?: Error) => void;
}

/**
 * Waiters for `patched` acknowledgements. Patches to one resource are acked
 * in the order they were posted, so the oldest waiter on a resource owns the
 * next ack; a register-before-post caller can never miss its own. The ack
 * resolves only when it names the bytes the caller sent — a refused install
 * or different bytes reject.
 */
export function createPatchWaiters(): PatchWaiters {
  interface Waiter {
    kind: PatchKind;
    num: number;
    hint: string;
    resolve: (ack: PatchAck) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  const waiters: Waiter[] = [];

  function awaitPatched(
    kind: PatchKind,
    num: number,
    hint: string,
    timeoutMs = 5000,
  ): Promise<PatchAck> {
    return new Promise<PatchAck>((resolve, reject) => {
      const waiter: Waiter = {
        kind,
        num,
        hint,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`the running game did not acknowledge ${kind} ${num}`));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  }

  function settlePatched(msg: Extract<WorkerControl, { type: "patched" }>): void {
    const index = waiters.findIndex((w) => w.kind === msg.kind && w.num === msg.num);
    if (index < 0) return;
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter!.timer);
    if (msg.error !== undefined || msg.hint === null)
      waiter!.reject(new Error(msg.error ?? `the running game refused ${msg.kind} ${msg.num}`));
    else if (msg.hint !== waiter!.hint)
      waiter!.reject(
        new Error(`the running game holds different ${msg.kind} ${msg.num} bytes than were sent`),
      );
    else waiter!.resolve({ kind: msg.kind, num: msg.num, patchGen: msg.patchGen, hint: msg.hint });
  }

  function drainPatchWaiters(err: Error = new Error("Operation aborted")): void {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  return { awaitPatched, settlePatched, drainPatchWaiters };
}
