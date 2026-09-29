import type {
  LogicAnalysisOperations,
  LogicAnalysisProject,
  LogicAnalysisQuery,
  LogicAnalysisReply,
  LogicAnalysisRequest,
} from "./analysisProtocol.ts";

interface AnalysisWorker {
  postMessage(request: LogicAnalysisRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<LogicAnalysisReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
interface Pending {
  readonly request: LogicAnalysisRequest;
  readonly accept: (result: LogicAnalysisOperations[keyof LogicAnalysisOperations]) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

/**
 * One Studio workspace lifetime. Replace the complete consulted snapshot after
 * any project edit; old results lose authority immediately, including after undo.
 * Analysis never changes documents. A host must still review/apply rename edits
 * through its draft transaction service against the captured project revision.
 */
export class LogicAnalysisClient {
  private project: LogicAnalysisProject | undefined;
  private epoch = 0;
  private nextId = 1;
  private worker: AnalysisWorker | undefined;
  private pending = new Map<number, Pending>();
  private closed = false;
  private readonly createWorker: () => AnalysisWorker;
  private readonly timeoutMs: number;

  constructor(
    createWorker: () => AnalysisWorker = () =>
      new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" }),
    timeoutMs = 5000,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid analysis timeout.");
    this.createWorker = createWorker;
    this.timeoutMs = timeoutMs;
  }

  setProject(project: LogicAnalysisProject): void {
    if (this.closed) throw new Error("Logic analysis workspace is closed.");
    if (!Number.isSafeInteger(project.revision) || project.revision < 0)
      throw new Error("Invalid analysis project revision.");
    const documents = Object.fromEntries(
      Object.entries(project.documents).map(([key, document]) => {
        const match = /^logic:(0|[1-9]\d{0,2})$/.exec(key);
        if (
          !match ||
          Number(match[1]) > 255 ||
          !Number.isSafeInteger(document.version) ||
          document.version < 0 ||
          typeof document.source !== "string"
        )
          throw new Error("Invalid analysis document.");
        return [key, { ...document }];
      }),
    );
    this.project = {
      revision: project.revision,
      profileId: project.profileId,
      words: project.words.map(([word, group]) => [word, group] as const),
      bindings: Object.fromEntries(
        Object.entries(project.bindings).map(([name, binding]) => [name, { num: binding.num }]),
      ),
      documents,
    };
    this.epoch++;
    this.rejectAll(new Error("Logic analysis was superseded by a newer workspace snapshot."));
  }

  async request<Q extends LogicAnalysisQuery>(
    key: string,
    query: Q,
    signal?: AbortSignal,
  ): Promise<LogicAnalysisOperations[Q["method"]]> {
    if (this.closed) throw new Error("Logic analysis workspace is closed.");
    if (signal?.aborted) throw new Error("Logic analysis was cancelled.");
    const project = this.project;
    const document = project?.documents[key];
    if (!project || !document || !Object.hasOwn(project.documents, key))
      throw new Error("No authored logic document is open for analysis.");
    const request: LogicAnalysisRequest = {
      id: this.nextId++,
      epoch: this.epoch,
      revision: project.revision,
      key,
      version: document.version,
      source: document.source,
      profileId: project.profileId,
      words: project.words,
      bindings: project.bindings,
      query: { ...query },
    };
    return new Promise((resolve, reject) => {
      const cancel = () => this.rejectOne(request.id, new Error("Logic analysis was cancelled."));
      const timer = setTimeout(
        () =>
          this.failWorker(new Error("Logic analysis timed out. Try again to restart the worker.")),
        this.timeoutMs,
      );
      this.pending.set(request.id, {
        request,
        accept: (result) => resolve(result as LogicAnalysisOperations[Q["method"]]),
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
        },
      });
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        this.getWorker().postMessage(request);
      } catch (error) {
        this.failWorker(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    this.closed = true;
    this.project = undefined;
    this.failWorker(new Error("Logic analysis workspace is closed."));
  }

  private getWorker(): AnalysisWorker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(data.id);
      if (!pending) return;
      const request = pending.request;
      if (
        data.epoch !== request.epoch ||
        data.epoch !== this.epoch ||
        data.revision !== request.revision ||
        data.key !== request.key ||
        data.version !== request.version ||
        (data.ok && data.method !== request.query.method)
      ) {
        this.failWorker(new Error("Logic analysis reply did not match its requested snapshot."));
        return;
      }
      this.pending.delete(data.id);
      pending.cleanup();
      if (data.ok) pending.accept(data.result);
      else pending.reject(new Error(data.error));
    };
    worker.onerror = worker.onmessageerror = () => {
      if (this.worker === worker)
        this.failWorker(new Error("Logic analysis worker failed. Try again to restart it."));
    };
    return worker;
  }

  private rejectOne(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const id of this.pending.keys()) this.rejectOne(id, error);
  }

  private failWorker(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
    }
    this.rejectAll(error);
  }
}
