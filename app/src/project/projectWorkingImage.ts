/** Recover the last runnable source image beside current documents with errors. */
import { compileProjectDocuments } from "../../../src/authoring/projectDocuments.ts";
import type { ProjectContent } from "../../../src/authoring/projectContent.ts";
import type { ProjectHistoryState } from "../../../src/authoring/projectHistoryData.ts";
import { computeResourceRevision } from "../../../src/authoring/resourceRevision.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";

export function compileWorkingProjectImage(input: {
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly profileId: ProfileId;
  readonly documents: Readonly<Record<string, ProjectContent>>;
  readonly fallback: Readonly<Record<string, ProjectContent>>;
  readonly history?: ProjectHistoryState;
}) {
  const revision = computeResourceRevision(input.files);
  const candidates = [input.documents];
  const history = input.history;
  if (history !== undefined) {
    const commits = Object.fromEntries(history.commits.map((commit) => [commit.id, commit]));
    let cursor = history.cursor;
    for (let n = 0; cursor !== null && n < history.commits.length; n++) {
      const commit = commits[cursor];
      if (commit === undefined) break;
      candidates.push(
        Object.fromEntries(
          Object.entries(commit.documents)
            .filter((entry): entry is [string, string] => entry[1] !== null)
            .map(([key, hash]) => [key, history.blobs[hash]!]),
        ),
      );
      cursor = commit.parent;
    }
  }
  for (const documents of candidates) {
    try {
      const compiled = compileProjectDocuments({
        files: input.files,
        profileId: input.profileId,
        documents,
      });
      if (compiled.build.identity.revision === revision) return compiled;
    } catch {
      /* Incomplete source remains current; another commit may describe the running bytes. */
    }
  }
  return compileProjectDocuments({
    files: input.files,
    profileId: input.profileId,
    documents: input.fallback,
  });
}
