/**
 * Room Studio's Keep: commits one picture edit — the new PIC bytes and the
 * annotated source that compiles to them — through the engine's resource
 * transaction (useAuthoringController's commitPictureEdit), and exposes the
 * state the Keep button needs. The transaction itself is all-or-nothing up
 * to the durable save; see commitResourceEdit for the steps and recovery.
 */
import { readonly, ref, shallowRef } from "vue";
import { useEngineApi } from "../engineContext.ts";
import type { ProjectId } from "../../../src/gameIdentity.ts";
import {
  ResourceCommitError,
  type PictureEdit,
  type ResourceCommitErrorCode,
  type ResourceCommitResult,
} from "../resourceCommit.ts";

export type { PictureEdit, ResourceCommitResult };

/** The last Keep's failure, worded for the Studio's error line. */
export interface StudioCommitFailure {
  /** "unexpected" is a failure outside the transaction's typed refusals. */
  readonly code: ResourceCommitErrorCode | "unexpected";
  readonly message: string;
  /** Where the edit was saved when only the live install failed. */
  readonly projectId?: ProjectId | undefined;
}

/** The Studio's wording for a refusal; the transaction's own text otherwise. */
export function studioCommitFailure(error: unknown): StudioCommitFailure {
  if (!(error instanceof ResourceCommitError))
    return { code: "unexpected", message: error instanceof Error ? error.message : String(error) };
  if (error.code === "stale")
    return {
      code: "stale",
      message: "The game changed since you opened Studio. Reopen to continue.",
    };
  return { code: error.code, message: error.message, projectId: error.projectId };
}

/**
 * `commit` resolves to the transaction's result, or null when it refused or
 * failed (`lastError` says why) or another Keep is still running.
 */
export function useStudioCommit(
  commitPictureEdit: (edit: PictureEdit) => Promise<ResourceCommitResult> = useEngineApi()
    .commitPictureEdit,
) {
  const busy = ref(false);
  const lastError = shallowRef<StudioCommitFailure | null>(null);

  async function commit(edit: PictureEdit): Promise<ResourceCommitResult | null> {
    if (busy.value) return null;
    busy.value = true;
    lastError.value = null;
    try {
      return await commitPictureEdit(edit);
    } catch (error) {
      lastError.value = studioCommitFailure(error);
      return null;
    } finally {
      busy.value = false;
    }
  }

  return { commit, busy: readonly(busy), lastError: readonly(lastError) };
}
