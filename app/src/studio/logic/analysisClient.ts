import type { LogicLanguageProject } from "../../../../src/logic/lspServer.ts";
import type {
  LspMessage,
  LspOperations,
  LspResponse,
  LspNotification,
} from "../../../../src/logic/lspTypes.ts";

export interface LogicAnalysisProject extends LogicLanguageProject {
  readonly revision: number;
  readonly documents: Readonly<
    Record<string, { readonly version: number; readonly source: string; readonly uri?: string }>
  >;
}
interface AnalysisWorker {
  postMessage(request: LspMessage): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<LspResponse | LspNotification>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
interface Pending {
  readonly epoch: number;
  readonly revision: number;
  readonly version: number;
  readonly key: string;
  readonly accept: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

/**
 * One Studio workspace lifetime. Saved context replaces the consulted snapshot;
 * typing updates its document. Old results lose authority immediately, including after undo.
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
  private readonly uris = new Map<string, string>();
  private readonly createWorker: () => AnalysisWorker;
  private readonly timeoutMs: number;
  private contextSignature = "";
  private readonly changes = new Set<() => void>();

  constructor(
    createWorker: () => AnalysisWorker = () =>
      new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" }),
    timeoutMs = 5000,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid analysis timeout.");
    this.createWorker = createWorker;
    this.timeoutMs = timeoutMs;
  }

  setProject(project: LogicAnalysisProject): boolean {
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
        return [
          key,
          {
            ...document,
            uri: this.uris.get(key) ?? document.uri ?? `agi-project:///logic.${key.slice(6)}.lgc`,
          },
        ];
      }),
    );
    const next: LogicAnalysisProject = {
      revision: project.revision,
      profileId: project.profileId,
      objects: [...(project.objects ?? [])],
      ...(project.inventory ? { inventory: project.inventory.map((item) => ({ ...item })) } : {}),
      ...(project.inventoryDocument ? { inventoryDocument: { ...project.inventoryDocument } } : {}),
      ...(project.resources ? { resources: { ...project.resources } } : {}),
      words: project.words.map(([word, group]) => [word, group] as const),
      bindings: Object.fromEntries(
        Object.entries(project.bindings).map(([name, binding]) => [name, { ...binding }]),
      ),
      documents,
      ...(project.bindingDocument ? { bindingDocument: { ...project.bindingDocument } } : {}),
    };
    const { documents: _documents, revision: _revision, ...context } = next;
    const signature = JSON.stringify(context);
    const previous = this.project;
    const keys = Object.keys(documents);
    const replace =
      !previous ||
      signature !== this.contextSignature ||
      keys.length !== Object.keys(previous.documents).length ||
      keys.some((key) => documents[key]?.uri !== previous.documents[key]?.uri);
    const changed = keys.filter((key) => {
      const before = previous?.documents[key];
      const after = documents[key]!;
      return before?.version !== after.version || before.source !== after.source;
    });
    if (!replace && !changed.length && previous.revision === next.revision) return false;
    this.project = next;
    this.contextSignature = signature;
    this.supersede();
    if (this.worker) {
      if (replace) this.sendProject(this.worker);
      else for (const key of changed) this.sendDocument(this.worker, key);
    }
    this.changed();
    return true;
  }

  /** Update the typed document while retaining the other consulted sources. */
  changeDocument(key: string, version: number, source: string): boolean {
    if (this.closed) throw new Error("Logic analysis workspace is closed.");
    const previous = this.project?.documents[key];
    if (!this.project || !previous || !Object.hasOwn(this.project.documents, key)) return false;
    if (!Number.isSafeInteger(version) || version < 0 || typeof source !== "string")
      throw new Error("Invalid analysis document.");
    if (previous.version === version && previous.source === source) return false;
    this.project = {
      ...this.project,
      documents: { ...this.project.documents, [key]: { ...previous, version, source } },
    };
    this.supersede();
    if (this.worker) this.sendDocument(this.worker, key);
    this.changed();
    return true;
  }

  onDidChange(listener: () => void): () => void {
    this.changes.add(listener);
    return () => {
      this.changes.delete(listener);
    };
  }

  private changed(): void {
    for (const listener of this.changes) listener();
  }

  private supersede(): void {
    this.epoch++;
    for (const id of this.pending.keys())
      this.worker?.postMessage({
        jsonrpc: "2.0",
        method: "$/cancelRequest",
        params: { id },
      } satisfies LspMessage);
    this.rejectAll(new Error("Logic analysis was superseded by a newer workspace snapshot."));
  }

  private sendDocument(worker: AnalysisWorker, key: string): void {
    const document = this.project!.documents[key]!;
    worker.postMessage({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: this.uri(key), version: document.version },
        contentChanges: [{ text: document.source }],
      },
    } satisfies LspMessage);
  }

  /**
   * The consulted context (the words or bindings document) cannot be read:
   * pending answers lose authority and the snapshot is dropped, so no further
   * request runs against an invalid context. This is invalidation, not a
   * failure — the worker stays alive and the next setProject resumes answers.
   */
  invalidateContext(message: string): void {
    if (this.closed) return;
    this.project = undefined;
    this.epoch++;
    for (const id of this.pending.keys())
      this.worker?.postMessage({
        jsonrpc: "2.0",
        method: "$/cancelRequest",
        params: { id },
      } satisfies LspMessage);
    this.rejectAll(new Error(message || "The logic analysis context is invalid."));
  }

  uri(key: string): string {
    return (
      this.uris.get(key) ??
      this.project?.documents[key]?.uri ??
      `agi-project:///logic.${key.slice(6)}.lgc`
    );
  }

  /** Text for a client-side location preview, detached by setProject. */
  documentSource(uri: string): string | undefined {
    const project = this.project;
    if (!project) return undefined;
    const bindings = project.bindingDocument ?? {
      uri: "agi-project:///bindings.json",
      source: JSON.stringify(project.bindings, null, 2),
    };
    if (bindings.uri === uri) return bindings.source;
    if (project.inventoryDocument?.uri === uri) return project.inventoryDocument.source;
    if (uri === "agi-project:///OBJECT.json")
      return JSON.stringify(
        project.inventory ?? (project.objects ?? []).map((name) => ({ name })),
        null,
        2,
      );
    return Object.values(project.documents).find((document) => document.uri === uri)?.source;
  }

  setDocumentUri(key: string, uri: string): void {
    if (this.uris.get(key) === uri) return;
    this.uris.set(key, uri);
    if (this.project) this.setProject(this.project);
  }

  async request<K extends keyof LspOperations>(
    key: string,
    method: K,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<LspOperations[K]> {
    if (this.closed) throw new Error("Logic analysis workspace is closed.");
    if (signal?.aborted) throw new Error("Logic analysis was cancelled.");
    const project = this.project;
    const document = project?.documents[key];
    if (!project || !document || !Object.hasOwn(project.documents, key))
      throw new Error("No authored logic document is open for analysis.");
    const id = this.nextId++;
    const request: LspMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, textDocument: { uri: this.uri(key) } },
    };
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.worker?.postMessage({
          jsonrpc: "2.0",
          method: "$/cancelRequest",
          params: { id },
        } satisfies LspMessage);
        this.rejectOne(id, new Error("Logic analysis was cancelled."));
      };
      const timer = setTimeout(
        () =>
          this.failWorker(new Error("Logic analysis timed out. Try again to restart the worker.")),
        this.timeoutMs,
      );
      this.pending.set(id, {
        epoch: this.epoch,
        revision: project.revision,
        version: document.version,
        key,
        accept: (result) => resolve(result as LspOperations[K]),
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

  private sendProject(worker: AnalysisWorker): void {
    worker.postMessage({
      jsonrpc: "2.0",
      method: "workspace/didChangeConfiguration",
      params: { settings: { agiLogic: { project: this.project } } },
    } satisfies LspMessage);
  }

  dispose(): void {
    this.closed = true;
    this.changes.clear();
    this.project = undefined;
    this.failWorker(new Error("Logic analysis workspace is closed."));
  }

  private getWorker(): AnalysisWorker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker) return;
      if (!("id" in data) || typeof data.id !== "number") return;
      const pending = this.pending.get(data.id);
      if (!pending) return;
      if (
        pending.epoch !== this.epoch ||
        pending.revision !== this.project?.revision ||
        pending.version !== this.project?.documents[pending.key]?.version
      ) {
        this.rejectOne(
          data.id,
          new Error("Logic analysis was superseded by a newer workspace snapshot."),
        );
        return;
      }
      this.pending.delete(data.id);
      pending.cleanup();
      if (data.error) pending.reject(new Error(data.error.message));
      else pending.accept(data.result);
    };
    worker.onerror = worker.onmessageerror = () => {
      if (this.worker === worker)
        this.failWorker(new Error("Logic analysis worker failed. Try again to restart it."));
    };
    worker.postMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        capabilities: {
          textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } },
        },
      },
    } satisfies LspMessage);
    worker.postMessage({ jsonrpc: "2.0", method: "initialized", params: {} } satisfies LspMessage);
    this.sendProject(worker);
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
