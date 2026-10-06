/**
 * A Studio's Keep: the draft goes through the resource transaction
 * (useStudioCommit) against the revision it was opened or last kept on —
 * Room Studio's compiled bytes and annotated source (bytes equal to the kept
 * ones save only the text), Sprite Studio's VIEW bytes. A kept draft rebases
 * on the new revision.
 * Each refusal maps to the one next step it allows: a stale game reopens
 * Studio from the running game, a failed install reloads the game from
 * storage (editing stops until then), anything else can be retried. When the
 * stored project moved past the running game (another tab kept an edit),
 * Reopen reloads the game from storage first: reopening on the running game
 * would only refuse again.
 */

import { computed, shallowRef, type Ref } from "vue";
import type { ResourceRevision } from "../../../src/gameIdentity.ts";
import type { ResourceCommitResult } from "../project/resourceCommit.ts";
import type { DraftStatus } from "./StudioDraftControls.vue";
import { useStudioCommit } from "./useStudioCommit.ts";

/** Room Studio's Keep transaction. */

/** What a Keep reads from a Studio draft and tells it back. */
export interface KeepableDraft {
  /** The draft differs from what the game holds. */
  readonly dirty: Readonly<Ref<boolean>>;
  /** A drag or stroke is open: nothing is kept mid-gesture. */
  readonly gesturing: Readonly<Ref<boolean>>;
  /** The revision the draft was opened or last kept on; undefined when it cannot be kept. */
  readonly kept: Readonly<Ref<{ readonly revision: ResourceRevision | undefined }>>;
  /** The game now holds the draft at `revision`. */
  markKept(revision: ResourceRevision): void;
}

/** What the Keep banner offers after a failure. */
export type KeepRecovery = "reopen" | "reload" | "retry";

export interface KeepBanner {
  readonly message: string;
  readonly recovery: KeepRecovery;
  /** The recovery reloads the game from storage before Studio reopens. */
  readonly fromStorage: boolean;
}

export function useStudioKeep(options: {
  readonly draft: KeepableDraft;
  /** The transaction: the draft's edit, made against `baseRevision`. */
  readonly keep: (baseRevision: ResourceRevision) => Promise<ResourceCommitResult>;
}) {
  const { draft } = options;
  const { commit, busy, lastError } = useStudioCommit(options.keep);
  /** The last successful Keep while the draft still matches it. */
  const lastKept = shallowRef<ResourceCommitResult | null>(null);
  /** The game was saved but not installed: nothing is edited until it reloads. */
  const needsReload = computed(() => lastError.value?.code === "install");
  const dismissed = shallowRef<unknown>(null);
  const banner = computed<KeepBanner | null>(() => {
    const failure = lastError.value;
    if (!failure || dismissed.value === failure) return null;
    const recovery: KeepRecovery =
      failure.code === "stale" ? "reopen" : failure.code === "install" ? "reload" : "retry";
    const fromStorage = recovery === "reload" || failure.behindStorage === true;
    return { message: failure.message, recovery, fromStorage };
  });
  const canKeep = computed(
    () =>
      draft.dirty.value &&
      !draft.gesturing.value &&
      draft.kept.value.revision !== undefined &&
      !busy.value &&
      !needsReload.value,
  );
  const kept = computed(() => lastKept.value !== null && !draft.dirty.value);
  /** Where the draft stands, for the top bar's chip. */
  const status = computed<DraftStatus>(() => {
    if (draft.kept.value.revision === undefined) return "view-only";
    if (needsReload.value) return "reload";
    if (busy.value) return "keeping";
    if (draft.dirty.value) return "changed";
    return kept.value ? "kept" : "clean";
  });

  async function keep(): Promise<boolean> {
    const revision = draft.kept.value.revision;
    if (!canKeep.value || revision === undefined) return false;
    const result = await commit(revision);
    if (!result) return false;
    draft.markKept(result.revision);
    lastKept.value = result;
    return true;
  }

  /** Hide the banner (the recovery it offered was taken elsewhere). */
  function dismiss(): void {
    dismissed.value = lastError.value;
  }

  return { keep, busy, banner, canKeep, kept, status, needsReload, lastKept, dismiss };
}
