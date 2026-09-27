/**
 * A Studio's Keep: commits one edit — Room Studio's PIC bytes and the
 * annotated source that compiles to them, Sprite Studio's VIEW bytes —
 * through the engine's resource transaction (useAuthoringController's
 * commitPictureEdit, commitViewEdit, keepStagedView), and exposes the state
 * the Keep button needs. The transaction itself is all-or-nothing up to the
 * durable save; see commitResourceEdit for the steps and recovery.
 */
import { readonly, ref, shallowRef } from "vue";
import type { ProjectId } from "../../../src/gameIdentity.ts";
import {
  ResourceCommitError,
  type ResourceCommitErrorCode,
} from "../project/projectTransaction.ts";
import type { ResourceCommitResult } from "../project/resourceCommit.ts";

export type { ResourceCommitResult };

/** The last Keep's failure, worded for the Studio's error line. */
export interface StudioCommitFailure {
  /** "unexpected" is a failure outside the transaction's typed refusals. */
  readonly code: ResourceCommitErrorCode | "unexpected";
  readonly message: string;
  /** Where the edit was saved when only the live install failed. */
  readonly projectId?: ProjectId | undefined;
  /** A stale refusal because the stored project moved past the running game. */
  readonly behindStorage?: boolean | undefined;
}

/**
 * A stale refusal because the project was removed in another tab: reopening
 * cannot help, so the Keep banner shows the transaction's own words. Read
 * from a typed `reason: "removed"` on the error when the transaction sets
 * one, else from the removed-project wording (projectTransaction.ts
 * PROJECT_REMOVED_MESSAGE).
 */
function projectRemoved(error: ResourceCommitError): boolean {
  if (error.code !== "stale") return false;
  if ((error as { readonly reason?: unknown }).reason === "removed") return true;
  return error.message.startsWith("This game was removed in another tab");
}

/** The Studio's wording for a refusal; the transaction's own text otherwise. */
export function studioCommitFailure(error: unknown): StudioCommitFailure {
  if (!(error instanceof ResourceCommitError))
    return { code: "unexpected", message: error instanceof Error ? error.message : String(error) };
  if (error.code === "stale")
    return {
      code: "stale",
      message: projectRemoved(error)
        ? error.message
        : "The game changed since you opened Studio. Reopen to continue.",
      behindStorage: error.behindStorage,
    };
  return { code: error.code, message: error.message, projectId: error.projectId };
}

/**
 * `commit` resolves to the transaction's result, or null when it refused or
 * failed (`lastError` says why) or another Keep is still running.
 */
export function useStudioCommit<E>(commitEdit: (edit: E) => Promise<ResourceCommitResult>) {
  const busy = ref(false);
  const lastError = shallowRef<StudioCommitFailure | null>(null);

  async function commit(edit: E): Promise<ResourceCommitResult | null> {
    if (busy.value) return null;
    busy.value = true;
    lastError.value = null;
    try {
      return await commitEdit(edit);
    } catch (error) {
      lastError.value = studioCommitFailure(error);
      return null;
    } finally {
      busy.value = false;
    }
  }

  return { commit, busy: readonly(busy), lastError: readonly(lastError) };
}
