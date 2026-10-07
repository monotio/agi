/**
 * Provider-free, in-memory authoring documents and atomic draft transactions.
 * Drafts may be incomplete. Resource validation, durable Keep and run installation
 * belong to their respective services; accepting a proposal performs none of them.
 */
import { checkProjectDocumentKey } from "./projectDocumentKey.ts";
export { checkProjectDocumentKey } from "./projectDocumentKey.ts";

type DocumentContent = string | Uint8Array;
interface DocumentChange {
  readonly key: string;
  readonly content: DocumentContent | null;
}
/**
 * Issued by `edit` for one authorized write. Identity is the object itself —
 * a caller-built lookalike confers nothing — and content images stay private:
 * the issuer restores origins, never bytes matched by a caller.
 */
export interface DraftEditReceipt {
  readonly key: string;
}

/**
 * Issued by `acquireHistoryMutation` for one native history step. Object
 * identity is the authority; cancellation revokes its privileged writes while
 * exclusion lasts until release.
 */
export interface DraftHistoryLease {
  readonly kind: "native-history";
}

/**
 * Issued by `admitKeep` for one admitted storage attempt. The reservation
 * holds baseline acknowledgement authority for its exact selection until the
 * attempt settles; it is not an exclusive lock on ordinary editing.
 */
export interface DraftKeepAdmission {
  readonly kind: "keep-admission";
}

/** Why an ordinary mutation is currently refused. */
export type DraftBusyReason = "native-history" | "keep-pending";

/** The typed refusal a busy draft gives ordinary writers before any mutation. */
export class DraftBusyError extends Error {
  readonly reason: DraftBusyReason;
  constructor(reason: DraftBusyReason, message: string) {
    super(message);
    this.name = "DraftBusyError";
    this.reason = reason;
  }
}

/** Detached recovery data; the persistence adapter validates its envelope and base. */
export interface DraftRecovery {
  readonly changes: readonly (DocumentChange & { readonly version: number })[];
  /** Connected groups retain coordinated selection, not session-local undo authority. */
  readonly groups: readonly (readonly string[])[];
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
interface EditReceiptState {
  readonly before: DocumentChange;
  readonly after: DocumentChange;
  readonly beforeOrigin: number;
  readonly afterOrigin: number;
  // Origins are restored identities, not the timeline clock: versions are never
  // restored, so a version chain detects a write that landed between receipts
  // even when it is later walked back to the same origin or bytes.
  readonly beforeVersion: number;
  readonly afterVersion: number;
  applied: boolean;
}
interface HistoryLeaseState {
  cancelled: boolean;
  released: boolean;
}
interface KeepAdmissionState {
  readonly selection: DraftSelection;
  resolved: boolean;
}
/**
 * Authority a public mutator resolved before writing — produced only by the
 * guard helpers, so no caller can bypass the busy check with a flag. `write`
 * requires one; the `open` token exists for construction/recovery only.
 */
interface WriteAuthority {
  readonly via: "open" | "ordinary" | "native-history";
}
const OPEN_WRITE: WriteAuthority = Object.freeze({ via: "open" });
const ORDINARY_WRITE: WriteAuthority = Object.freeze({ via: "ordinary" });
const HISTORY_WRITE: WriteAuthority = Object.freeze({ via: "native-history" });

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
      checkProjectDocumentKey(key);
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
  private editReceipts = new WeakMap<DraftEditReceipt, EditReceiptState>();
  private historyLeases = new WeakMap<DraftHistoryLease, HistoryLeaseState>();
  private keepAdmissions = new WeakMap<DraftKeepAdmission, KeepAdmissionState>();
  /** The currently held native-history lease; its exclusion outlives cancel. */
  private historyLease: DraftHistoryLease | undefined;
  /** Admitted Keep attempts whose durable settlement has not yet been reported. */
  private unresolvedKeeps = new Set<DraftKeepAdmission>();
  private nextTransaction = 1;
  private kept: Readonly<Record<string, DocumentSlot>> = Object.create(null);
  private keptRevision = 0;
  private selections = new WeakMap<DraftSelection, SelectionState>();
  private pendingGroups: { readonly revision: number; readonly keys: readonly string[] }[] = [];

  constructor(documents: Readonly<Record<string, DocumentContent>>) {
    this.write(
      copyChanges(Object.entries(documents).map(([key, content]) => ({ key, content }))),
      undefined,
      OPEN_WRITE,
    );
    this.kept = { ...this.documents };
    this.pendingGroups = [];
  }

  /**
   * Reopen accepted recovery against the kept document set. The caller must
   * first check its saved-base identities and obtain the user's Restore choice.
   * Document versions restart in this new workspace; old proposals, selections
   * and undo handles retain no authority here.
   */
  static recover(
    documents: Readonly<Record<string, DocumentContent>>,
    recovery: DraftRecovery,
  ): ProjectDraft {
    for (const change of recovery.changes) {
      if (!Number.isSafeInteger(change.version) || change.version < 1)
        throw new Error("Invalid recovered document version.");
    }
    const changes = copyChanges(recovery.changes);
    const groups = recovery.groups.map((group) => {
      group.forEach(checkProjectDocumentKey);
      if (group.length < 2 || new Set(group).size !== group.length)
        throw new Error("Invalid recovered operation group.");
      return Object.freeze([...group].sort());
    });
    const draft = new ProjectDraft(documents);
    draft.write(changes, undefined, OPEN_WRITE);
    const dirty = new Set(draft.dirtyKeys());
    // Restoring all text at once must not couple otherwise independent edits.
    draft.pendingGroups = groups
      .filter((keys) => keys.some((key) => dirty.has(key)))
      .map((keys) => ({ revision: draft.revision, keys }));
    return draft;
  }

  /**
   * Capture only unsaved differences. Overlapping operations are compacted into
   * connected groups, which preserves their exact transitive selection closure
   * without persisting session-local transaction handles or an unbounded log.
   */
  captureRecovery(): DraftRecovery {
    const changes = this.dirtyKeys().map((key) => {
      const slot = this.documents[key]!;
      return Object.freeze({ key, version: slot.version, content: copyContent(slot.content) });
    });
    const edges: Record<string, Set<string>> = Object.create(null);
    for (const group of this.pendingGroups) {
      const first = group.keys[0]!;
      for (const key of group.keys) {
        (edges[first] ??= new Set()).add(key);
        (edges[key] ??= new Set()).add(first);
      }
    }
    const visited = new Set<string>();
    const groups: (readonly string[])[] = [];
    for (const key of Object.keys(edges).sort()) {
      if (visited.has(key)) continue;
      const queue = [key];
      visited.add(key);
      for (let index = 0; index < queue.length; index++) {
        for (const next of edges[queue[index]!] ?? []) {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }
      groups.push(Object.freeze(queue.sort()));
    }
    return Object.freeze({ changes: Object.freeze(changes), groups: Object.freeze(groups) });
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
        checkProjectDocumentKey(key);
        const slot = documents[key];
        if (!slot || slot.content === null) return undefined;
        return Object.freeze({ key, version: slot.version, content: copyContent(slot.content)! });
      },
      version(key: string): number {
        checkProjectDocumentKey(key);
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
      checkProjectDocumentKey(key);
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
    this.ordinaryWrite();
    return this.acknowledgeSelection(selection);
  }

  /**
   * The admitted-Keep acknowledgement: the reservation issued for this exact
   * selection is the authority. History acquisition remains excluded until
   * the admitted save settles. Everything else matches acknowledgeKept.
   */
  acknowledgeAdmittedKeep(admission: DraftKeepAdmission): boolean {
    const state = this.keepAdmissions.get(admission);
    if (!state) throw new Error("Keep admission belongs to another workspace.");
    if (state.resolved) throw new Error("Keep admission is already settled.");
    return this.acknowledgeSelection(state.selection);
  }

  private acknowledgeSelection(selection: DraftSelection): boolean {
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

  /**
   * Reserve one document's native history step. Acquisition is synchronous and
   * pins the expected revision; it refuses while another lease is held — even
   * a cancelled one awaiting release — or while any admitted Keep is still
   * settling. The returned token is opaque: only this issuer recognizes it.
   */
  acquireHistoryMutation(expectedRevision: number): DraftHistoryLease {
    if (this.historyLease !== undefined)
      throw new DraftBusyError(
        "native-history",
        "A native history step is already running on this draft.",
      );
    if (this.unresolvedKeeps.size > 0)
      throw new DraftBusyError(
        "keep-pending",
        "A Keep is still settling; the next history step must wait for it.",
      );
    if (expectedRevision !== this.revision)
      throw new Error(
        `Stale revision: expected ${expectedRevision}, draft is at ${this.revision}.`,
      );
    const lease: DraftHistoryLease = Object.freeze({ kind: "native-history" });
    this.historyLeases.set(lease, { cancelled: false, released: false });
    this.historyLease = lease;
    return lease;
  }

  /**
   * Revoke the lease's privileged write authority immediately. The lease's
   * exclusion lasts until `releaseHistoryMutation`, so a cancelled step still
   * holds the draft closed until its holder finishes reconciling.
   */
  cancelHistoryMutation(lease: DraftHistoryLease): void {
    const state = this.historyLeases.get(lease);
    if (state === undefined) throw new Error("History lease belongs to another workspace.");
    if (state.released) return;
    state.cancelled = true;
  }

  /** End the lease. Idempotent for the issuing token; foreign tokens refuse. */
  releaseHistoryMutation(lease: DraftHistoryLease): void {
    const state = this.historyLeases.get(lease);
    if (state === undefined) throw new Error("History lease belongs to another workspace.");
    if (state.released) return;
    state.released = true;
    state.cancelled = true;
    if (this.historyLease === lease) this.historyLease = undefined;
  }

  /**
   * Admit one Keep's storage attempt for this exact selection: the caller has
   * already built and reviewed the request, so admission is synchronous —
   * selection identity and currentness plus native-history exclusion. Several
   * admissions may be pending at once; each blocks history acquisition until
   * its attempt settles. Not a lock on ordinary editing.
   */
  admitKeep(selection: DraftSelection): DraftKeepAdmission {
    if (this.historyLease !== undefined)
      throw new DraftBusyError(
        "native-history",
        "A native history step is running; this Keep must wait for it to settle.",
      );
    this.assertCurrent(selection);
    const admission: DraftKeepAdmission = Object.freeze({ kind: "keep-admission" });
    this.keepAdmissions.set(admission, { selection, resolved: false });
    this.unresolvedKeeps.add(admission);
    return admission;
  }

  /**
   * Report that an admitted Keep attempt settled — durably saved or failed.
   * Idempotent for the issuing token; foreign tokens refuse.
   */
  finishKeepAdmission(admission: DraftKeepAdmission): void {
    const state = this.keepAdmissions.get(admission);
    if (state === undefined) throw new Error("Keep admission belongs to another workspace.");
    if (state.resolved) return;
    state.resolved = true;
    this.unresolvedKeeps.delete(admission);
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
    const authority = this.ordinaryWrite();
    const state = this.proposals.get(proposal);
    if (!state) throw new Error("Proposal belongs to another workspace.");
    if (state.consumed) throw new Error("Proposal was already applied.");
    if (state.base.revision !== this.revision)
      throw new Error("Stale proposal: the consulted workspace changed. Review a fresh proposal.");
    if (!Number.isSafeInteger(this.nextTransaction))
      throw new Error("Draft transaction identity exhausted; reopen the workspace.");
    const change = this.write(state.edits, undefined, authority);
    state.consumed = true;
    const id = Object.freeze({ sequence: this.nextTransaction++ });
    this.transactions.set(id, { ...change, applied: true });
    return Object.freeze({
      id,
      label: proposal.label,
      keys: Object.freeze(change.after.map(({ key }) => key)),
    });
  }

  /**
   * Native editor typing/undo checks only that document, without an agent lock.
   * A real write issues a frozen receipt an authorized editor may later reverse
   * through `reverseEdits`; an identical-content call stays a no-op and issues
   * none. Callers that never reverse simply ignore the return.
   */
  edit(
    key: string,
    content: DocumentContent | null,
    expectedVersion: number,
  ): DraftEditReceipt | undefined {
    const authority = this.ordinaryWrite();
    checkProjectDocumentKey(key);
    const slot = this.documents[key];
    if ((slot?.version ?? 0) !== expectedVersion) throw new Error(`Stale document: ${key}`);
    const beforeVersion = slot?.version ?? 0;
    const beforeOrigin = slot?.origin ?? 0;
    const change = this.write(copyChanges([{ key, content }]), undefined, authority);
    if (change.after.length === 0) return undefined;
    const receipt: DraftEditReceipt = Object.freeze({ key });
    this.editReceipts.set(receipt, {
      before: change.before[0]!,
      after: change.after[0]!,
      beforeOrigin,
      afterOrigin: change.afterOrigins[key]!,
      beforeVersion,
      afterVersion: this.documents[key]!.version,
      applied: true,
    });
    return receipt;
  }

  /**
   * Reverse one contiguous oldest-to-newest group of this issuer's receipts on
   * a single document — the authority half of a native editor undo group. Every
   * receipt must resolve here, share the key, be currently applied, and chain
   * without a gap on the version clock; the newest receipt's origin must be the
   * document's current origin. Any failure refuses before the single aggregate
   * write, so nothing — content, origins, dirty keys, receipt states — moves.
   */
  reverseEdits(receipts: readonly DraftEditReceipt[], lease?: DraftHistoryLease): void {
    const authority = this.privilegedWrite(lease);
    const { key, states } = this.resolveReceiptGroup(receipts, true);
    const newest = states[states.length - 1]!;
    if ((this.documents[key]?.origin ?? 0) !== newest.afterOrigin)
      throw new Error(`Undo/redo conflict: ${key} has later edits. Review a revert instead.`);
    this.write(
      [{ key, content: states[0]!.before.content }],
      { [key]: states[0]!.beforeOrigin },
      authority,
    );
    for (const state of states) state.applied = false;
  }

  /** The symmetric redo of `reverseEdits`: same list, same ordering rules. */
  reapplyEdits(receipts: readonly DraftEditReceipt[], lease?: DraftHistoryLease): void {
    const authority = this.privilegedWrite(lease);
    const { key, states } = this.resolveReceiptGroup(receipts, false);
    const oldest = states[0]!;
    if ((this.documents[key]?.origin ?? 0) !== oldest.beforeOrigin)
      throw new Error(`Undo/redo conflict: ${key} has later edits. Review a revert instead.`);
    const newest = states[states.length - 1]!;
    this.write([{ key, content: newest.after.content }], { [key]: newest.afterOrigin }, authority);
    for (const state of states) state.applied = true;
  }

  /**
   * Validate a caller's receipt list into issuer states without mutating
   * anything: foreign or forged handles, duplicates, mixed applied states,
   * several keys, and non-contiguous ordering all refuse identically.
   */
  private resolveReceiptGroup(
    receipts: readonly DraftEditReceipt[],
    applied: boolean,
  ): { key: string; states: EditReceiptState[] } {
    if (receipts.length === 0) throw new Error("An edit group needs at least one receipt.");
    const seen = new Set<DraftEditReceipt>();
    const states: EditReceiptState[] = [];
    let key: string | undefined;
    for (const receipt of receipts) {
      const state = this.editReceipts.get(receipt);
      if (state === undefined) throw new Error("Edit receipt belongs to another workspace.");
      if (seen.has(receipt)) throw new Error("Duplicate edit receipt in a group.");
      seen.add(receipt);
      if (key === undefined) key = receipt.key;
      else if (receipt.key !== key)
        throw new Error("Edit receipts in one group must name a single document.");
      if (state.applied !== applied)
        throw new Error(
          applied
            ? "Edit receipt is not in the applied state."
            : "Edit receipt is not in the reversed state.",
        );
      states.push(state);
    }
    for (let index = 0; index + 1 < states.length; index++) {
      if (states[index]!.afterVersion !== states[index + 1]!.beforeVersion)
        throw new Error("Edit receipts are not a contiguous ordered group.");
    }
    return { key: key!, states };
  }

  /** Refuses a partial rollback; a conflict needs an explicitly reviewed new proposal. */
  undo(transactionId: TransactionId): void {
    const authority = this.ordinaryWrite();
    const state = this.transactions.get(transactionId);
    if (!state || !state.applied) throw new Error("No applied transaction to undo.");
    this.checkOrigins(state.afterOrigins);
    this.write(state.before, state.beforeOrigins, authority);
    state.applied = false;
  }

  redo(transactionId: TransactionId): void {
    const authority = this.ordinaryWrite();
    const state = this.transactions.get(transactionId);
    if (!state || state.applied) throw new Error("No undone transaction to redo.");
    this.checkOrigins(state.beforeOrigins);
    this.write(state.after, state.afterOrigins, authority);
    state.applied = true;
  }

  private checkOrigins(origins: Readonly<Record<string, number>>): void {
    for (const [key, origin] of Object.entries(origins)) {
      if ((this.documents[key]?.origin ?? 0) !== origin)
        throw new Error(`Undo/redo conflict: ${key} has later edits. Review a revert instead.`);
    }
  }

  /**
   * Every public mutator resolves its authority through these guards before it
   * touches state — a busy draft refuses before proposal consumption, no-op
   * detection, transaction flags, baseline or groups, not merely before bytes.
   */
  private ordinaryWrite(): WriteAuthority {
    if (this.historyLease !== undefined)
      throw new DraftBusyError(
        "native-history",
        "A native history step is running; this change must wait for it to settle.",
      );
    return ORDINARY_WRITE;
  }

  /**
   * Receipt reversal/reapplication are the privileged operations: with a lease
   * held, only the live, uncancelled, same-issuer token authorizes them. With
   * no lease they run as ordinary operations; a supplied token must still be a
   * live issued lease — a foreign, released or cancelled token confers nothing.
   */
  private privilegedWrite(lease: DraftHistoryLease | undefined): WriteAuthority {
    const held = this.historyLease;
    if (lease === undefined) {
      if (held !== undefined) return this.ordinaryWrite();
      return ORDINARY_WRITE;
    }
    const state = this.historyLeases.get(lease);
    if (state === undefined) throw new Error("History lease belongs to another workspace.");
    if (state.released) throw new Error("History lease is already released.");
    if (held !== lease)
      throw new DraftBusyError(
        "native-history",
        "A native history step is running; this lease is not the active one.",
      );
    if (state.cancelled)
      throw new DraftBusyError(
        "native-history",
        "This native history lease was cancelled; its privileged writes are revoked.",
      );
    return HISTORY_WRITE;
  }

  private write(
    edits: readonly DocumentChange[],
    restoredOrigins: Readonly<Record<string, number>> | undefined,
    authority: WriteAuthority,
  ): {
    before: readonly DocumentChange[];
    after: readonly DocumentChange[];
    beforeOrigins: Readonly<Record<string, number>>;
    afterOrigins: Readonly<Record<string, number>>;
  } {
    if (authority !== OPEN_WRITE && authority !== ORDINARY_WRITE && authority !== HISTORY_WRITE)
      throw new Error("Write authority is unresolved.");
    const changed = edits.filter(({ key, content }) => {
      if (!sameContent(this.documents[key]?.content ?? null, content)) return true;
      // A verified restoration also counts when only the origin moves: a
      // net-zero native group must still return the document's lineage
      // position, or the operation it sits over stays blocked forever. The
      // ordinary edit path never supplies restoredOrigins, so its
      // identical-content writes remain no-ops.
      const restored = restoredOrigins?.[key];
      return restored !== undefined && restored !== (this.documents[key]?.origin ?? 0);
    });
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
