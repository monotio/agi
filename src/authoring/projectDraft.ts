/**
 * Provider-free, in-memory authoring documents and atomic draft transactions.
 * Drafts may be incomplete. Resource validation, durable Keep and run installation
 * belong to their respective services; accepting a proposal performs none of them.
 */
type DocumentContent = string | Uint8Array;
interface DocumentChange {
  readonly key: string;
  readonly content: DocumentContent | null;
}
interface DraftDocument {
  readonly key: string;
  readonly version: number;
  readonly content: DocumentContent;
}
interface DraftSnapshot {
  readonly revision: number;
  readonly keys: readonly string[];
  read(key: string): DraftDocument | undefined;
  /** Deletions retain a version; a key never present has version zero. */
  version(key: string): number;
}
interface DraftProposal {
  /** Exact before image for review even after later typing makes this proposal stale. */
  readonly base: DraftSnapshot;
  readonly label: string;
  readonly baseRevision: number;
  /** Detached copies for diff presentation; editing them cannot change the proposal. */
  changes(): readonly DocumentChange[];
}
interface DraftSelection {
  readonly snapshot: DraftSnapshot;
  readonly keys: readonly string[];
  /** Kept documents overlaid with this selected draft closure, owned by the selection. */
  documents(): Readonly<Record<string, DocumentContent>>;
}
interface SelectionState {
  readonly snapshot: SnapshotState;
  readonly keys: readonly string[];
  readonly keptRevision: number;
  acknowledged: boolean;
}
interface TransactionId {
  /** Display ordering only; the issued object itself carries workspace identity. */
  readonly sequence: number;
}
interface DraftTransaction {
  readonly id: TransactionId;
  readonly label: string;
  readonly keys: readonly string[];
}
interface DocumentSlot {
  readonly version: number;
  /** Restored only by a verified undo/redo, never by matching text. */
  readonly origin: number;
  readonly content: DocumentContent | null;
}
interface SnapshotState {
  readonly revision: number;
  readonly documents: Readonly<Record<string, DocumentSlot>>;
}
interface ProposalState {
  readonly base: SnapshotState;
  readonly edits: readonly DocumentChange[];
  consumed: boolean;
}
interface UndoState {
  readonly before: readonly DocumentChange[];
  readonly after: readonly DocumentChange[];
  readonly beforeOrigins: Readonly<Record<string, number>>;
  readonly afterOrigins: Readonly<Record<string, number>>;
  applied: boolean;
}

function checkKey(key: string): void {
  if (
    !/^(?:logic|picture|view|sound):(0|[1-9]\d{0,2})$/.test(key) &&
    !["words", "inventory", "bindings", "world", "tests", "references"].includes(key)
  )
    throw new Error(`Invalid project document: ${key}`);
  const colon = key.indexOf(":");
  if (colon >= 0 && Number(key.slice(colon + 1)) > 255)
    throw new Error(`Invalid project document: ${key}`);
}

function copyContent(content: DocumentContent | null): DocumentContent | null {
  if (content === null || typeof content === "string") return content;
  if (content instanceof Uint8Array) return new Uint8Array(content);
  throw new Error("Project document content must be text, bytes or a deletion.");
}

function sameContent(left: DocumentContent | null, right: DocumentContent | null): boolean {
  if (left === right) return true;
  return (
    left instanceof Uint8Array &&
    right instanceof Uint8Array &&
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function copyChanges(changes: readonly DocumentChange[]): readonly DocumentChange[] {
  const seen = new Set<string>();
  return Object.freeze(
    changes.map(({ key, content }) => {
      checkKey(key);
      if (seen.has(key)) throw new Error(`Duplicate project document: ${key}`);
      seen.add(key);
      return Object.freeze({ key, content: copyContent(content) });
    }),
  );
}

/**
 * One open workspace lifetime. Closing a tab does not delete its document.
 * Reopening a project creates another instance, so old snapshots/proposals never
 * regain authority even if text, IDs and revision numbers happen to match.
 * Content is authored text or retained native bytes; adapters own its format.
 */
export class ProjectDraft {
  private revision = 0;
  private documents: Record<string, DocumentSlot> = Object.create(null);
  private snapshots = new WeakMap<DraftSnapshot, SnapshotState>();
  private proposals = new WeakMap<DraftProposal, ProposalState>();
  private transactions = new WeakMap<TransactionId, UndoState>();
  private nextTransaction = 1;
  private kept: Readonly<Record<string, DocumentSlot>> = Object.create(null);
  private keptRevision = 0;
  private selections = new WeakMap<DraftSelection, SelectionState>();
  private pendingGroups: { readonly revision: number; readonly keys: readonly string[] }[] = [];

  constructor(documents: Readonly<Record<string, DocumentContent>>) {
    this.write(copyChanges(Object.entries(documents).map(([key, content]) => ({ key, content }))));
    this.kept = { ...this.documents };
    this.pendingGroups = [];
  }

  capture(): DraftSnapshot {
    // Internal slots/buffers are replaced, never mutated; snapshots may share them.
    const documents = Object.freeze({ ...this.documents });
    const state = { revision: this.revision, documents };
    const snapshot = Object.freeze({
      revision: this.revision,
      keys: Object.freeze(
        Object.keys(documents)
          .filter((key) => documents[key]!.content !== null)
          .sort(),
      ),
      read(key: string): DraftDocument | undefined {
        checkKey(key);
        const slot = documents[key];
        if (!slot || slot.content === null) return undefined;
        return Object.freeze({ key, version: slot.version, content: copyContent(slot.content)! });
      },
      version(key: string): number {
        checkKey(key);
        return documents[key]?.version ?? 0;
      },
    });
    this.snapshots.set(snapshot, state);
    return snapshot;
  }

  /** Documents whose current content differs from the acknowledged saved baseline. */
  dirtyKeys(): readonly string[] {
    const keys = new Set([...Object.keys(this.documents), ...Object.keys(this.kept)]);
    return [...keys]
      .filter(
        (key) =>
          !sameContent(this.documents[key]?.content ?? null, this.kept[key]?.content ?? null),
      )
      .sort();
  }

  /**
   * Select complete pending operations and the analysis-supplied dependency closure.
   * Unselected documents come from the kept baseline, not unrelated unfinished edits.
   * Dependency analysis must describe this current workspace and include any compiler
   * context it changes (for example, vocabulary or named bindings).
   */
  select(
    keys: readonly string[],
    dependencies: Readonly<Record<string, readonly string[]>> = {},
  ): DraftSelection {
    const snapshot = this.capture();
    const state = this.snapshots.get(snapshot)!;
    const selected = new Set<string>();
    const queue: string[] = [];
    const add = (key: string): void => {
      checkKey(key);
      if (!selected.has(key)) {
        selected.add(key);
        queue.push(key);
      }
    };
    keys.forEach(add);
    for (let i = 0; i < queue.length; i++) {
      const key = queue[i]!;
      for (const dependency of dependencies[key] ?? []) add(dependency);
      for (const group of this.pendingGroups) {
        if (group.keys.includes(key)) group.keys.forEach(add);
      }
    }
    const closedKeys = Object.freeze([...selected].sort());
    const documents = { ...this.kept };
    for (const key of closedKeys) {
      const slot = state.documents[key];
      if (slot) documents[key] = slot;
      else delete documents[key];
    }
    const selection = Object.freeze({
      snapshot,
      keys: closedKeys,
      documents(): Readonly<Record<string, DocumentContent>> {
        return Object.freeze(
          Object.fromEntries(
            Object.entries(documents)
              .filter(([, slot]) => slot.content !== null)
              .map(([key, slot]) => [key, copyContent(slot.content)!]),
          ),
        );
      },
    });
    this.selections.set(selection, {
      snapshot: state,
      keys: closedKeys,
      keptRevision: this.keptRevision,
      acknowledged: false,
    });
    return selection;
  }

  /** Recheck immediately before the caller admits a compiled candidate to storage. */
  assertCurrent(selection: DraftSelection): void {
    const state = this.selections.get(selection);
    if (!state) throw new Error("Selection belongs to another workspace.");
    if (state.snapshot.revision !== this.revision || state.keptRevision !== this.keptRevision)
      throw new Error("Stale selection: rebuild against the current draft and kept project.");
  }

  /**
   * Call only after a successful durable receipt for this exact selected candidate.
   * This is a local acknowledgement, not a save. Newer typing stays dirty. False
   * means another save baseline superseded this selection: reconcile with storage,
   * without turning a durable success into a failure or rolling back newer content.
   */
  acknowledgeKept(selection: DraftSelection): boolean {
    const state = this.selections.get(selection);
    if (!state) throw new Error("Selection belongs to another workspace.");
    if (state.acknowledged) return true;
    if (state.keptRevision !== this.keptRevision) return false;
    if (!Number.isSafeInteger(this.keptRevision + 1))
      throw new Error("Kept revision exhausted; reopen the workspace.");
    const kept = { ...this.kept };
    for (const key of state.keys) {
      const slot = state.snapshot.documents[key];
      if (slot) kept[key] = slot;
      else delete kept[key];
    }
    this.kept = kept;
    this.keptRevision++;
    state.acknowledged = true;
    const dirty = new Set(this.dirtyKeys());
    this.pendingGroups = this.pendingGroups.filter(
      (group) =>
        group.keys.some((key) => dirty.has(key)) &&
        !(
          group.revision <= state.snapshot.revision &&
          group.keys.every((key) => state.keys.includes(key))
        ),
    );
    return true;
  }

  /** Capture the complete consulted workspace, including dependencies not written. */
  propose(base: DraftSnapshot, label: string, changes: readonly DocumentChange[]): DraftProposal {
    const state = this.snapshots.get(base);
    if (!state) throw new Error("Snapshot belongs to another workspace.");
    if (typeof label !== "string" || !label.trim() || label.length > 160)
      throw new Error("A draft transaction needs a label of 1..160 characters.");
    const edits = copyChanges(changes);
    const proposal = Object.freeze({
      base,
      label,
      baseRevision: state.revision,
      changes: () => copyChanges(edits),
    });
    this.proposals.set(proposal, { base: state, edits, consumed: false });
    return proposal;
  }

  /** Review and auto-approval use this same atomic compare-and-apply path. */
  apply(proposal: DraftProposal): DraftTransaction {
    const state = this.proposals.get(proposal);
    if (!state) throw new Error("Proposal belongs to another workspace.");
    if (state.consumed) throw new Error("Proposal was already applied.");
    if (state.base.revision !== this.revision)
      throw new Error("Stale proposal: the consulted workspace changed. Review a fresh proposal.");
    if (!Number.isSafeInteger(this.nextTransaction))
      throw new Error("Draft transaction identity exhausted; reopen the workspace.");
    const change = this.write(state.edits);
    state.consumed = true;
    const id = Object.freeze({ sequence: this.nextTransaction++ });
    this.transactions.set(id, { ...change, applied: true });
    return Object.freeze({
      id,
      label: proposal.label,
      keys: Object.freeze(change.after.map(({ key }) => key)),
    });
  }

  /** Native editor typing/undo checks only that document, without an agent lock. */
  edit(key: string, content: DocumentContent | null, expectedVersion: number): void {
    checkKey(key);
    if ((this.documents[key]?.version ?? 0) !== expectedVersion)
      throw new Error(`Stale document: ${key}`);
    this.write(copyChanges([{ key, content }]));
  }

  /** Refuses a partial rollback; a conflict needs an explicitly reviewed new proposal. */
  undo(transactionId: TransactionId): void {
    const state = this.transactions.get(transactionId);
    if (!state || !state.applied) throw new Error("No applied transaction to undo.");
    this.checkOrigins(state.afterOrigins);
    this.write(state.before, state.beforeOrigins);
    state.applied = false;
  }

  redo(transactionId: TransactionId): void {
    const state = this.transactions.get(transactionId);
    if (!state || state.applied) throw new Error("No undone transaction to redo.");
    this.checkOrigins(state.beforeOrigins);
    this.write(state.after, state.afterOrigins);
    state.applied = true;
  }

  private checkOrigins(origins: Readonly<Record<string, number>>): void {
    for (const [key, origin] of Object.entries(origins)) {
      if ((this.documents[key]?.origin ?? 0) !== origin)
        throw new Error(`Undo/redo conflict: ${key} has later edits. Review a revert instead.`);
    }
  }

  private write(
    edits: readonly DocumentChange[],
    restoredOrigins?: Readonly<Record<string, number>>,
  ): {
    before: readonly DocumentChange[];
    after: readonly DocumentChange[];
    beforeOrigins: Readonly<Record<string, number>>;
    afterOrigins: Readonly<Record<string, number>>;
  } {
    const changed = edits.filter(
      ({ key, content }) => !sameContent(this.documents[key]?.content ?? null, content),
    );
    const before = copyChanges(
      changed.map(({ key }) => ({ key, content: this.documents[key]?.content ?? null })),
    );
    const after = copyChanges(changed);
    const beforeOrigins: Record<string, number> = Object.create(null);
    const afterOrigins: Record<string, number> = Object.create(null);
    if (after.length === 0) return { before, after, beforeOrigins, afterOrigins };
    const revision = this.revision + 1;
    if (!Number.isSafeInteger(revision))
      throw new Error("Draft revision exhausted; reopen the workspace.");
    const documents = { ...this.documents };
    for (const { key, content } of after) {
      const origin = restoredOrigins?.[key] ?? revision;
      beforeOrigins[key] = this.documents[key]?.origin ?? 0;
      afterOrigins[key] = origin;
      documents[key] = { version: revision, origin, content };
    }
    this.documents = documents;
    this.revision = revision;
    if (after.length > 1)
      this.pendingGroups.push({ revision, keys: Object.freeze(after.map(({ key }) => key)) });
    const dirty = new Set(this.dirtyKeys());
    this.pendingGroups = this.pendingGroups.filter((group) =>
      group.keys.some((key) => dirty.has(key)),
    );
    return {
      before,
      after,
      beforeOrigins: Object.freeze(beforeOrigins),
      afterOrigins: Object.freeze(afterOrigins),
    };
  }
}
