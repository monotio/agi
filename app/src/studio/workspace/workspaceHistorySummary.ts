import type {
  ProjectHistoryCommit,
  ProjectHistoryState,
} from "../../../../src/authoring/projectHistoryData.ts";

interface Navigation {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/** Draft notifications need navigation flags, without capturing committed document payloads. */
export function createWorkspaceHistorySummary() {
  let committed: Navigation = { canUndo: false, canRedo: false };
  return {
    update(
      history:
        | (Pick<ProjectHistoryState, "cursor" | "future"> & {
            readonly commits: readonly Pick<ProjectHistoryCommit, "id" | "parent">[];
          })
        | undefined,
    ) {
      const parent = history?.commits.find((commit) => commit.id === history.cursor)?.parent;
      committed = {
        canUndo: parent != null && history!.commits.some((commit) => commit.id === parent),
        canRedo: (history?.future.length ?? 0) > 0,
      };
    },
    read(draft: Navigation): Navigation {
      return {
        canUndo: draft.canUndo || committed.canUndo,
        canRedo: draft.canRedo || (!draft.canUndo && committed.canRedo),
      };
    },
  };
}
