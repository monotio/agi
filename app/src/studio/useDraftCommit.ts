/**
 * A Studio's commit: the draft goes through the resource transaction
 * (useStudioCommit) against the revision it was opened or last saved on —
 * PICTURE editor's compiled bytes and annotated source (bytes equal to the saved
 * ones save only the text), VIEW editor's VIEW bytes. A saved draft rebases
 * on the new revision.
 * Each refusal maps to the one next step it allows: a stale game reopens
 * Studio from the running game, a failed install reloads the game from
 * storage (editing stops until then), anything else can be retried. When the
 * stored project moved past the running game (another tab saved an edit),
 * Reopen reloads the game from storage first: reopening on the running game
 * would only refuse again.
 */

import { computed, shallowRef, type Ref } from "vue";
import type { ResourceRevision } from "../../../src/gameIdentity.ts";
import type { ResourceCommitResult } from "../project/resourceCommit.ts";
import type { DraftStatus } from "./StudioDraftControls.vue";
import { useStudioCommit } from "./useStudioCommit.ts";

/** PICTURE editor's commit transaction. */

/** What a commit reads from a Studio draft and tells it back. */
export interface CommittableDraft {
  /** The draft differs from what the game holds. */
  readonly dirty: Readonly<Ref<boolean>>;
  /** A drag or stroke is open: nothing is saved mid-gesture. */
  readonly gesturing: Readonly<Ref<boolean>>;
  /** The revision the draft was opened or last saved on; undefined when it cannot be saved. */
  readonly saved: Readonly<Ref<{ readonly revision: ResourceRevision | undefined }>>;
  /** The game now holds the draft at `revision`. */
  markSaved(revision: ResourceRevision): void;
}

/** What the commit banner offers after a failure. */
export type CommitRecovery = "reopen" | "reload" | "retry";

export interface CommitBanner {
  readonly message: string;
  readonly recovery: CommitRecovery;
  /** The recovery reloads the game from storage before Studio reopens. */
  readonly fromStorage: boolean;
}

export function useDraftCommit(options: {
  readonly draft: CommittableDraft;
  /** The transaction: the draft's edit, made against `baseRevision`. */
  readonly commit: (baseRevision: ResourceRevision) => Promise<ResourceCommitResult>;
}) {
  const { draft } = options;
  const { commit: runCommit, busy, lastError } = useStudioCommit(options.commit);
  /** The last successful commit while the draft still matches it. */
  const lastSaved = shallowRef<ResourceCommitResult | null>(null);
  /** The game was saved but not installed: nothing is edited until it reloads. */
  const needsReload = computed(() => lastError.value?.code === "install");
  const dismissed = shallowRef<unknown>(null);
  const banner = computed<CommitBanner | null>(() => {
    const failure = lastError.value;
    if (!failure || dismissed.value === failure) return null;
    const recovery: CommitRecovery =
      failure.code === "stale" ? "reopen" : failure.code === "install" ? "reload" : "retry";
    const fromStorage = recovery === "reload" || failure.behindStorage === true;
    return { message: failure.message, recovery, fromStorage };
  });
  const canCommit = computed(
    () =>
      draft.dirty.value &&
      !draft.gesturing.value &&
      draft.saved.value.revision !== undefined &&
      !busy.value &&
      !needsReload.value,
  );
  const saved = computed(() => lastSaved.value !== null && !draft.dirty.value);
  /** Where the draft stands, for the top bar's chip. */
  const status = computed<DraftStatus>(() => {
    if (draft.saved.value.revision === undefined) return "view-only";
    if (needsReload.value) return "reload";
    if (busy.value) return "saving";
    if (draft.dirty.value) return "changed";
    return saved.value ? "saved" : "clean";
  });

  async function commit(): Promise<boolean> {
    const revision = draft.saved.value.revision;
    if (!canCommit.value || revision === undefined) return false;
    const result = await runCommit(revision);
    if (!result) return false;
    draft.markSaved(result.revision);
    lastSaved.value = result;
    return true;
  }

  /** Hide the banner (the recovery it offered was taken elsewhere). */
  function dismiss(): void {
    dismissed.value = lastError.value;
  }

  return { commit, busy, banner, canCommit, saved, status, needsReload, lastSaved, dismiss };
}
