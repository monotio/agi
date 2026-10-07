import {
  sameProjectContent,
  type ProjectChange,
  type ProjectContent,
} from "../../../../src/authoring/projectContent.ts";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import { sameWorldGameContent } from "../../project/projectWorld.ts";

/** Reuse unchanged draft comparisons and metadata until the accepted image changes. */
export function createWorkspacePending(partKeys: (change: ProjectChange) => readonly string[]) {
  let previous: ProjectSnapshot | undefined;
  let compared: Record<string, { content: ProjectContent | null; pending: boolean }> = {};
  let derived: Record<string, { content: ProjectContent | null; keys: readonly string[] }> = {};
  function align(snapshot: ProjectSnapshot | undefined): void {
    if (snapshot === previous) return;
    previous = snapshot;
    compared = {};
    derived = {};
  }
  return {
    changes(snapshot: ProjectSnapshot | undefined, edits: readonly ProjectChange[]) {
      align(snapshot);
      return edits.filter((edit) => {
        let cached = compared[edit.key];
        if (!cached || cached.content !== edit.content) {
          cached = {
            content: edit.content,
            pending: !(edit.key === "world" ? sameWorldGameContent : sameProjectContent)(
              snapshot?.read(edit.key)?.content,
              edit.content,
            ),
          };
          compared[edit.key] = cached;
        }
        return cached.pending;
      });
    },
    parts(snapshot: ProjectSnapshot | undefined, changes: readonly ProjectChange[]) {
      align(snapshot);
      const parts = new Set<string>();
      for (const change of changes) {
        let cached = derived[change.key];
        if (!cached || cached.content !== change.content) {
          cached = { content: change.content, keys: partKeys(change) };
          derived[change.key] = cached;
        }
        for (const key of cached.keys) parts.add(key);
      }
      if (!parts.size && changes.length) parts.add(changes[0]!.key);
      return [...parts];
    },
  };
}
