/**
 * Stored projects this release cannot read. A card action that fails on one
 * marks its project, and the card then offers "Start fresh…": removing that
 * project's local records through the library's own delete path so the game
 * can be added again. The marks are session memory, never stored.
 */
import { ref } from "vue";
import { bodyTransaction, loadAuthoredGame } from "../gameStorage.ts";
import { projectId, type ProjectId } from "../../../src/gameIdentity.ts";
import { useEngineApi } from "../engineContext.ts";
import { useGameLibrary } from "../useGameLibrary.ts";

export const UNREADABLE_PROJECT_MESSAGE =
  "This saved project version is not supported by this app.";

const unreadable = ref<ReadonlySet<ProjectId>>(new Set());

/** The library project a catalog release is stored under (see addLibraryGame). */
export function catalogProjectId(entry: { id: string; version: string }): ProjectId | null {
  return projectId(`catalog-${entry.id}-${entry.version}`);
}

/**
 * Whether the project's stored copy is one this release refuses to read:
 * its body fails the stored-format check, or a body sits under the id with
 * no index — the index is rebuilt on start for every body this release can
 * read, so an unindexed body is one it could neither read nor replace.
 */
async function isUnreadable(id: ProjectId): Promise<boolean> {
  try {
    if (await loadAuthoredGame(id)) return false;
  } catch (error) {
    return String(error).includes(UNREADABLE_PROJECT_MESSAGE);
  }
  try {
    return (await bodyTransaction("readonly", (store) => store.get(id))) !== undefined;
  } catch {
    return false;
  }
}

export function useProjectRecovery() {
  const { state } = useEngineApi();
  const { libraryActionError, selectedProjectId, onClearSavedGame } = useGameLibrary();

  /** Run a card's play action; if it failed on an unreadable copy of `id`, mark it. */
  async function playGuarded(id: ProjectId | null, action: () => Promise<void>): Promise<void> {
    await action();
    if (!id || (!libraryActionError.value && state.phase !== "error")) return;
    if (!(await isUnreadable(id))) return;
    unreadable.value = new Set([...unreadable.value, id]);
    // The card says what happened; a generic storage message would mislead.
    libraryActionError.value = "";
  }

  /** Remove the unreadable copy the way the library's Remove game does. */
  async function startFresh(id: ProjectId): Promise<void> {
    selectedProjectId.value = id;
    await onClearSavedGame();
    unreadable.value = new Set([...unreadable.value].filter((item) => item !== id));
    libraryActionError.value = "";
  }

  return {
    isUnreadable: (id: ProjectId | null) => id !== null && unreadable.value.has(id),
    playGuarded,
    startFresh,
  };
}
