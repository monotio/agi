/**
 * Sound Studio's recovery sidecar: the reopen dialog's entries (stored
 * workspace drafts plus the portable draft the body carries) and this tab's
 * debounced, serialized draft writer. Each write names the previous receipt,
 * so a second tab cannot silently claim the record, and a failed write never
 * poisons the chain — it reports through onError and resolves false.
 */
import {
  readProjectRecovery,
  type PortableProjectRecovery,
} from "../../../../src/authoring/projectRecovery.ts";
import { recoveryBaseOf } from "../../project/editableProject.ts";
import type { CachedGameData, ProjectId } from "../../project/gameTypes.ts";
import {
  discardProjectDraft,
  listProjectDrafts,
  saveProjectDraft,
  type DraftReceipt,
} from "../../project/projectDrafts.ts";

/** What the host captures synchronously when a write runs; null = clean. */
export type SoundDraftCapture = () => {
  readonly expected: { readonly generation: number; readonly lifetime: string };
  readonly recovery: unknown;
} | null;

/** One restorable draft the reopen dialog offers. */
export type SoundRecoveryEntry =
  | {
      readonly kind: "stored";
      readonly status: "current" | "stale";
      readonly workspaceId: string;
      readonly receipt: DraftReceipt;
      readonly recovery: PortableProjectRecovery;
      readonly keys: readonly string[];
    }
  | {
      readonly kind: "portable";
      readonly status: "current" | "stale";
      readonly recovery: PortableProjectRecovery | undefined;
      readonly keys: readonly string[];
    };

/**
 * Every draft a reopened project should offer: the per-workspace records plus
 * the body's portable draft. Stale entries stay listed for review, download
 * and discard — a carried draft is exposed, never consumed.
 */
export async function soundRecoveryEntries(stored: CachedGameData): Promise<SoundRecoveryEntry[]> {
  const entries: SoundRecoveryEntry[] = (await listProjectDrafts(stored.projectId)).map(
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
 * This workspace's debounced draft writer. schedule() batches edits; flush()
 * writes now; discard() deletes exactly the receipt this persister last wrote.
 * flush()/discard() resolve true when the record was durably written or
 * removed, false when the attempt was reported through onError — callers use
 * that to keep a close guard honest.
 */
export class SoundDraftPersister {
  private readonly projectId: ProjectId;
  private readonly workspaceId: string;
  private readonly capture: SoundDraftCapture;
  private readonly delay: number;
  private readonly onError: ((message: string) => void) | undefined;
  private receipt: DraftReceipt | null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: {
    readonly projectId: ProjectId;
    readonly workspaceId: string;
    readonly capture: SoundDraftCapture;
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
    this.receipt = options.receipt ? { ...options.receipt } : null;
  }

  /** The receipt a later restore must name; frozen and detached. */
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
   * Delete exactly this workspace's reviewed record. Resolves false when the
   * deletion failed — the record and the receipt survive for a retry.
   */
  async discard(): Promise<boolean> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const run = this.tail.then(async (): Promise<boolean> => {
      const receipt = this.receipt;
      if (receipt === null) return true;
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
   * One serialized write attempt. Capture runs inside the same error path as
   * the storage write: a draft that cannot yet serialize reports and resolves
   * false, and the chain stays healthy for the next attempt.
   */
  private async write(): Promise<boolean> {
    if (this.disposed) return true;
    let captured: ReturnType<SoundDraftCapture>;
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
