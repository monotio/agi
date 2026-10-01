/**
 * The guided panel's controller over the real ProjectDraft: each action calls
 * one provider-free `prepareGuided*` operation against the workspace's current
 * context, holds the detached outcome for review, and applies it as the draft's
 * single atomic transaction with that transaction's own undo/redo. Nothing
 * mutates before Apply; a stale, foreign or closed workspace refuses through
 * the draft's own guards — replayed against the live workspace here so an old
 * preview can never write into a reopened or recreated project.
 */
import { computed, ref, shallowRef, type ComputedRef, type Ref, type ShallowRef } from "vue";
import type { ProjectDraft } from "../../../../../src/authoring/projectDraft.ts";
import {
  prepareGuidedAddRoom,
  prepareGuidedConnectDoor,
  prepareGuidedPlaceHero,
  prepareGuidedPlaySound,
  prepareGuidedRespondToCommand,
  type GuidedAddRoomInput,
  type GuidedConnectDoorInput,
  type GuidedContext,
  type GuidedOperationKind,
  type GuidedOutcome,
  type GuidedPlaceHeroInput,
  type GuidedPlaySoundInput,
  type GuidedRefusal,
  type GuidedRespondInput,
  type GuidedSourcePreview,
  type PreparedGuidedOperation,
} from "../../../../../src/authoring/guidedProject.ts";

export interface GuidedInputs {
  readonly "add-room": GuidedAddRoomInput;
  readonly "place-hero": GuidedPlaceHeroInput;
  readonly "respond-to-command": GuidedRespondInput;
  readonly "connect-door": GuidedConnectDoorInput;
  readonly "play-sound": GuidedPlaySoundInput;
}

/** The Logic Studio seam: the live workspace context plus its resync sink. */
export interface GuidedActionsHost {
  /**
   * The mounted workspace's consulted image — the genuine ProjectDraft, the
   * current saved native files and the profile. Throws when no project is open.
   */
  context(): GuidedContext;
  /** A reactive revision so the staleness flag tracks edits made elsewhere. */
  revisionTick(): number;
  /** Called synchronously after a draft transaction lands (apply/undo/redo). */
  onDraftChanged(keys: readonly string[]): void;
}

/** The transaction a guided Apply landed, kept for its undo and Show code. */
interface GuidedApplied {
  /** The workspace lifetime that owns the transaction — undo checks identity. */
  readonly draft: ProjectDraft;
  readonly transaction: ReturnType<ProjectDraft["apply"]>;
  /** The proposed ranges, still valid as locations in the applied documents. */
  readonly showCode: readonly GuidedSourcePreview[];
  readonly undone: boolean;
}

export interface GuidedActions {
  /** The outcome under review — detached; it has written nothing. */
  readonly pending: ShallowRef<PreparedGuidedOperation | null>;
  /** The last typed refusal, cleared by the next prepare or cancel. */
  readonly refusal: ShallowRef<GuidedRefusal | null>;
  /** True once the draft moved past the preview's consulted snapshot. */
  readonly pendingStale: ComputedRef<boolean>;
  /** The transaction the panel last applied, with its Show-code ranges. */
  readonly applied: ShallowRef<GuidedApplied | null>;
  /** The last apply/undo failure line (stale, foreign, consumed, conflict). */
  readonly notice: Ref<string>;
  /** Run one prepare operation; the outcome is stored for review either way. */
  prepare<K extends GuidedOperationKind>(kind: K, input: GuidedInputs[K]): GuidedOutcome | null;
  /** Apply the pending outcome through the issuing draft; false on refusal. */
  apply(): boolean;
  /** Discard the pending outcome and refusal without a write. */
  cancel(): void;
  undo(): boolean;
  redo(): boolean;
  /** The workspace closed or swapped: every held outcome loses authority here. */
  close(): void;
}

function dispatch(
  kind: GuidedOperationKind,
  ctx: GuidedContext,
  input: GuidedInputs[GuidedOperationKind],
): GuidedOutcome {
  switch (kind) {
    case "add-room":
      return prepareGuidedAddRoom(ctx, input as GuidedAddRoomInput);
    case "place-hero":
      return prepareGuidedPlaceHero(ctx, input as GuidedPlaceHeroInput);
    case "respond-to-command":
      return prepareGuidedRespondToCommand(ctx, input as GuidedRespondInput);
    case "connect-door":
      return prepareGuidedConnectDoor(ctx, input as GuidedConnectDoorInput);
    case "play-sound":
      return prepareGuidedPlaySound(ctx, input as GuidedPlaySoundInput);
  }
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGuidedActions(host: GuidedActionsHost): GuidedActions {
  const pending = shallowRef<PreparedGuidedOperation | null>(null);
  /** The draft the pending outcome was issued by — apply checks identity. */
  let pendingDraft: ProjectDraft | null = null;
  const refusal = shallowRef<GuidedRefusal | null>(null);
  const applied = shallowRef<GuidedApplied | null>(null);
  const notice = ref("");

  /** The draft the panel is operating on right now; null when unmounted. */
  function currentDraft(): ProjectDraft | null {
    try {
      return host.context().draft;
    } catch {
      return null;
    }
  }

  const pendingStale = computed(() => {
    host.revisionTick();
    const draft = currentDraft();
    if (pending.value === null) return false;
    if (draft === null || draft !== pendingDraft) return true;
    return draft.capture().revision !== pending.value.proposal.baseRevision;
  });

  function prepare<K extends GuidedOperationKind>(
    kind: K,
    input: GuidedInputs[K],
  ): GuidedOutcome | null {
    notice.value = "";
    let outcome: GuidedOutcome;
    try {
      const ctx = host.context();
      outcome = dispatch(kind, ctx, input);
    } catch (error) {
      // No workspace to consult: a held preview can never apply here either.
      pending.value = null;
      pendingDraft = null;
      notice.value = detail(error);
      return null;
    }
    // Every new attempt supersedes the one under review.
    pending.value = outcome.ok ? outcome : null;
    pendingDraft = outcome.ok ? currentDraft() : null;
    refusal.value = outcome.ok ? null : outcome;
    return outcome;
  }

  function apply(): boolean {
    const op = pending.value;
    if (op === null) return false;
    notice.value = "";
    const draft = currentDraft();
    if (draft === null || draft !== pendingDraft) {
      notice.value = "The open project changed since this preview; prepare the action again.";
      return false;
    }
    try {
      const transaction = op.apply();
      applied.value = { draft, transaction, showCode: op.showCode, undone: false };
      pending.value = null;
      pendingDraft = null;
      host.onDraftChanged(transaction.keys);
      return true;
    } catch (error) {
      notice.value = detail(error);
      return false;
    }
  }

  function cancel(): void {
    pending.value = null;
    pendingDraft = null;
    refusal.value = null;
    notice.value = "";
  }

  function move(back: boolean): boolean {
    const held = applied.value;
    if (held === null) return false;
    notice.value = "";
    const draft = currentDraft();
    if (draft === null || draft !== held.draft) {
      notice.value = "The open project changed. This step belongs to the previous draft.";
      return false;
    }
    try {
      if (back) draft.undo(held.transaction.id);
      else draft.redo(held.transaction.id);
    } catch (error) {
      notice.value = detail(error);
      return false;
    }
    applied.value = { ...held, undone: back };
    host.onDraftChanged(held.transaction.keys);
    return true;
  }

  function close(): void {
    pending.value = null;
    pendingDraft = null;
    refusal.value = null;
    applied.value = null;
    notice.value = "";
  }

  return {
    pending,
    refusal,
    pendingStale,
    applied,
    notice,
    prepare,
    apply,
    cancel,
    undo: () => move(true),
    redo: () => move(false),
    close,
  };
}
