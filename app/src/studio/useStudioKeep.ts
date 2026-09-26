/**
 * Room Studio's Keep: the draft's compiled bytes and annotated source go
 * through the resource transaction (useStudioCommit) against the revision the
 * draft was opened or last kept on. A kept draft rebases on the new revision.
 * Each refusal maps to the one next step it allows: a stale game reopens
 * Studio from the running game, a failed install reloads the game from
 * storage (editing stops until then), anything else can be retried.
 */

import { computed, shallowRef } from "vue";
import type { PictureEdit, ResourceCommitResult } from "../resourceCommit.ts";
import { useStudioCommit } from "./useStudioCommit.ts";
import type { StudioDraft } from "./useStudioDraft.ts";

export type KeepFn = (edit: PictureEdit) => Promise<ResourceCommitResult>;

/** What the Keep banner offers after a failure. */
export type KeepRecovery = "reopen" | "reload" | "retry";

export interface KeepBanner {
  readonly message: string;
  readonly recovery: KeepRecovery;
}

export function useStudioKeep(options: {
  readonly draft: StudioDraft;
  readonly pictureNumber: () => number;
  /** The transaction; the engine's commitPictureEdit when omitted. */
  readonly keep?: KeepFn | undefined;
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
    return { message: failure.message, recovery };
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

  async function keep(): Promise<boolean> {
    const revision = draft.kept.value.revision;
    if (!canKeep.value || revision === undefined) return false;
    const changes = draft.changes.value;
    const result = await commit({
      pictureNumber: options.pictureNumber(),
      bytes: draft.compiled.value.bytes,
      source: draft.source.value,
      baseRevision: revision,
      reason: `${changes} ${changes === 1 ? "change" : "changes"}`,
    });
    if (!result) return false;
    draft.markKept(result.revision);
    lastKept.value = result;
    return true;
  }

  /** Hide the banner (the recovery it offered was taken elsewhere). */
  function dismiss(): void {
    dismissed.value = lastError.value;
  }

  return { keep, busy, banner, canKeep, kept, needsReload, lastKept, dismiss };
}
