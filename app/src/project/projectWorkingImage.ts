/** Recover the last runnable source image beside current documents with errors. */
import { compileProjectDocuments } from "../../../src/authoring/projectDocuments.ts";
import { projectDocumentId, type ProjectContent } from "../../../src/authoring/projectContent.ts";
import type { ProjectHistoryState } from "../../../src/authoring/projectHistoryData.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import { computeResourceRevision } from "../../../src/authoring/resourceRevision.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";

export function compileWorkingProjectImage(input: {
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly profileId: ProfileId;
  readonly documents: Readonly<Record<string, ProjectContent>>;
  readonly fallback: Readonly<Record<string, ProjectContent>>;
  readonly history?: ProjectHistoryState;
  readonly documentId?: string;
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
    if (input.documentId !== undefined)
      for (const commit of [...history.commits].reverse())
        candidates.push(
          Object.fromEntries(
            Object.entries(commit.documents)
              .filter((entry): entry is [string, string] => entry[1] !== null)
              .map(([key, hash]) => [key, history.blobs[hash]!]),
          ),
        );
  }
  for (const documents of candidates) {
    try {
      if (
        input.documentId !== undefined &&
        projectDocumentId(documents, sha256Hex) !== input.documentId
      )
        continue;
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
  if (
    input.documentId !== undefined &&
    projectDocumentId(input.fallback, sha256Hex) !== input.documentId
  )
    throw new Error("The pending project's working documents are missing from History.");
  return compileProjectDocuments({
    files: input.files,
    profileId: input.profileId,
    documents: input.fallback,
  });
}
