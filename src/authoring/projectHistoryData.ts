import { projectContentHash, type ProjectContent, type ProjectDigest } from "./projectContent.ts";

export const PROJECT_HISTORY_ORIGINS = [
  "picture",
  "view",
  "logic",
  "words",
  "inventory",
  "sound",
  "guided",
  "agent",
  "history",
  "template",
] as const;
export type ProjectEditOrigin = (typeof PROJECT_HISTORY_ORIGINS)[number];
export interface ProjectCommitMetadata {
  readonly label: string;
  readonly origin: ProjectEditOrigin;
  readonly author: "creator" | "agent";
  readonly time: number;
}
export interface ProjectHistoryCommit extends ProjectCommitMetadata {
  readonly id: string;
  readonly parent: string | null;
  /** Full manifest, including deletion tombstones. */
  readonly documents: Readonly<Record<string, string | null>>;
  readonly changed: readonly string[];
}
export interface ProjectHistoryState {
  readonly blobs: Readonly<Record<string, ProjectContent>>;
  readonly commits: readonly ProjectHistoryCommit[];
  readonly cursor: string | null;
  /** Immediate next Redo first; discarded branches remain in commits. */
  readonly future: readonly string[];
  readonly tags: Readonly<Record<string, string>>;
}

export function projectCommitId(
  commit: Omit<ProjectHistoryCommit, "id">,
  digest: ProjectDigest,
): string {
  return projectContentHash(
    JSON.stringify([
      commit.parent,
      Object.entries(commit.documents).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      commit.changed,
      commit.label,
      commit.origin,
      commit.author,
      commit.time,
    ]),
    digest,
  );
}

export function changedProjectManifest(
  before: Readonly<Record<string, string | null>>,
  after: Readonly<Record<string, string | null>>,
): readonly string[] {
  return Object.freeze(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .filter((key) => (before[key] ?? null) !== (after[key] ?? null)),
  );
}
