/**
 * Logic Studio's recovery sidecar: what the reopen dialog offers (stored
 * workspace drafts and a portable draft carried in the body) and the
 * debounced, serialized writer that keeps this tab's unfinished work beside
 * the kept project — never inside playable bytes.
 *
 * Writes chain on the reviewed receipt: each save names the receipt of the
 * previous one, so a second tab cannot silently claim or overwrite this
 * tab's record, and an error never updates the chain. The snapshot is
 * captured synchronously when a write runs — typing during the write is a
 * later draft, not this one.
 */
import {
  readProjectRecovery,
  type PortableProjectRecovery,
} from "../../../../src/authoring/projectRecovery.ts";
import type { CachedGameData } from "../../project/gameTypes.ts";
import { recoveryBaseOf } from "../../project/editableProject.ts";
import {
  discardProjectDraft,
  listProjectDrafts,
  saveProjectDraft,
  type DraftReceipt,
} from "../../project/projectDrafts.ts";
import type { ProjectId } from "../../project/gameTypes.ts";

/** What the host captures synchronously when a write runs, or null for a clean draft. */
export type LogicDraftCapture = () => {
  readonly expected: { readonly generation: number; readonly lifetime: string };
  readonly recovery: unknown;
} | null;

/** One restorable draft the reopen dialog offers. */
export type LogicRecoveryEntry =
  | {
      readonly kind: "stored";
      readonly status: "current" | "stale";
      readonly workspaceId: string;
      readonly receipt: DraftReceipt;
      readonly recovery: PortableProjectRecovery;
      /** Document keys the draft carries, for a one-line summary. */
      readonly keys: readonly string[];
    }
  | {
      readonly kind: "portable";
      readonly status: "current" | "stale";
      readonly recovery: PortableProjectRecovery | undefined;
      readonly keys: readonly string[];
    };

/**
 * Every draft a reopened project should offer: the per-workspace records
 * plus the portable draft the stored body carries. A portable draft is
 * exposed, never consumed. Stale entries stay listed for review, download
 * and discard.
 */
export async function recoveryEntries(stored: CachedGameData): Promise<LogicRecoveryEntry[]> {
  const entries: LogicRecoveryEntry[] = (await listProjectDrafts(stored.projectId)).map(
    (draft) => ({
      kind: "stored",
      status: draft.status,
      workspaceId: draft.workspaceId,
      receipt: draft.receipt,
      recovery: draft.recovery,
      keys: draft.recovery.documents.map((document) => document.key),
    }),
  );
  if (stored.recoveryDraft !== undefined) {
    let status: "current" | "stale" = "stale";
    let recovery: PortableProjectRecovery | undefined;
    let keys: readonly string[] = [];
    try {
      const decoded = readProjectRecovery(stored.recoveryDraft);
      recovery = stored.recoveryDraft;
      keys = decoded.recovery.changes.map((change) => change.key);
      const base = recoveryBaseOf(stored);
      status =
        decoded.base.revision === base.revision &&
        decoded.base.authoring === base.authoring &&
        decoded.base.profileId === base.profileId
          ? "current"
          : "stale";
    } catch {
      // A carried draft that fails to parse stays listed as stale work.
    }
    entries.push({ kind: "portable", status, recovery, keys });
  }
  return entries;
}

/**
 * This workspace's debounced draft writer. schedule() batches typing;
 * flush() writes now; discard() deletes exactly the receipt this persister
 * last wrote. flush() and discard() resolve true when the record was
 * durably written or removed, false when the attempt was reported through
 * onError instead — callers use that to keep a close guard honest.
 * Persistence failures never poison the write chain.
 */
export class LogicDraftPersister {
  private readonly projectId: ProjectId;
  private readonly workspaceId: string;
  private readonly capture: LogicDraftCapture;
  private readonly delay: number;
  private readonly onError: ((message: string) => void) | undefined;
  private receipt: DraftReceipt | null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: {
    readonly projectId: ProjectId;
    readonly workspaceId: string;
    readonly capture: LogicDraftCapture;
    /** Debounce for schedule(); flush() always writes immediately. */
    readonly delay?: number | undefined;
    readonly onError?: ((message: string) => void) | undefined;
    /** Resume writing under a restored draft's identity and receipt. */
    readonly receipt?: DraftReceipt | null | undefined;
  }) {
    this.projectId = options.projectId;
    this.workspaceId = options.workspaceId;
    this.capture = options.capture;
    this.delay = options.delay ?? 500;
    this.onError = options.onError;
    // The receipt is the CAS authority for the next write: own a detached
    // copy so a caller's later mutation cannot retarget it.
    this.receipt = options.receipt ? { ...options.receipt } : null;
  }

  /**
   * The receipt a later restore must name, for the host's own bookkeeping.
   * Frozen and detached: displaying it must not retarget the next write.
   */
  get currentReceipt(): DraftReceipt | null {
    return this.receipt === null ? null : Object.freeze({ ...this.receipt });
  }

  schedule(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.enqueue();
    }, this.delay);
  }

  /**
   * Write a snapshot now if the draft is dirty. Resolves false when the
   * attempt failed (and was reported through onError), true otherwise.
   */
  flush(): Promise<boolean> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return this.enqueue();
  }

  /**
   * Delete exactly this workspace's reviewed record, after any write in
   * flight lands. Resolves false when the deletion failed — the record and
   * the receipt it was written against both survive for an explicit retry.
   */
  async discard(): Promise<boolean> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const run = this.tail.then(async (): Promise<boolean> => {
      const receipt = this.receipt;
      if (receipt === null) return true;
      // Only a confirmed delete clears the chain: a refused discard keeps the
      // receipt so the next write still names the record it would succeed.
      try {
        await discardProjectDraft(this.projectId, this.workspaceId, receipt);
      } catch (error) {
        this.report(error);
        return false;
      }
      if (
        this.receipt !== null &&
        this.receipt.incarnation === receipt.incarnation &&
        this.receipt.sequence === receipt.sequence
      )
        this.receipt = null;
      return true;
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private report(error: unknown): void {
    this.onError?.(error instanceof Error ? error.message : String(error));
  }

  private enqueue(): Promise<boolean> {
    const run = this.tail.then(() => this.write());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * One serialized write attempt. Capture runs inside the same error path
   * as the storage write: a draft that cannot yet be serialized is reported
   * and resolves false, and the chain stays healthy for the next attempt.
   */
  private async write(): Promise<boolean> {
    if (this.disposed) return true;
    let captured: ReturnType<LogicDraftCapture>;
    try {
      captured = this.capture();
    } catch (error) {
      this.report(error);
      return false;
    }
    if (captured === null) return true;
    try {
      const receipt = await saveProjectDraft({
        projectId: this.projectId,
        workspaceId: this.workspaceId,
        expectedReceipt: this.receipt,
        expected: captured.expected,
        recovery: captured.recovery,
      });
      this.receipt = { incarnation: receipt.incarnation, sequence: receipt.sequence };
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }
}
