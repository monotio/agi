/** Explicit retention policy: oldest unpinned commits first, preserving their identities. */
import { checkProjectHistoryForPruning, PROJECT_HISTORY_LIMITS } from "./projectHistoryCodec.ts";
import type { ProjectHistoryState } from "./projectHistoryData.ts";
import type { ProjectContent, ProjectDigest } from "./projectContent.ts";

export function pruneProjectHistory(
  state: ProjectHistoryState,
  digest: ProjectDigest,
  limits: { readonly maxCommits?: number; readonly maxBytes?: number } = {},
): { readonly state: ProjectHistoryState; readonly removed: readonly string[] } {
  return pruneCheckedProjectHistory(checkProjectHistoryForPruning(state, digest), limits);
}

/**
 * Retention on a state the codec already admitted — the live history's own
 * over-limit append, whose commits and blobs never left checked memory, so
 * the codec's per-blob hashing does not repeat on every edit.
 */
export function pruneCheckedProjectHistory(
  checked: ProjectHistoryState,
  limits: { readonly maxCommits?: number; readonly maxBytes?: number } = {},
): { readonly state: ProjectHistoryState; readonly removed: readonly string[] } {
  const maxCommits = limits.maxCommits ?? PROJECT_HISTORY_LIMITS.maxCommits;
  const byteCeiling = () =>
    commits.some((commit) =>
      Object.keys(commit.documents).some((key) => key.startsWith("attachment:")),
    )
      ? PROJECT_HISTORY_LIMITS.maxImageTotalBytes
      : PROJECT_HISTORY_LIMITS.maxTotalBytes;
  const commits = [...checked.commits];
  const maxBytes = limits.maxBytes ?? byteCeiling();
  if (
    !Number.isSafeInteger(maxCommits) ||
    maxCommits < 1 ||
    maxCommits > PROJECT_HISTORY_LIMITS.maxCommits ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > byteCeiling()
  )
    throw new Error("Invalid project History retention limit.");
  const pinned = new Set([checked.cursor, ...checked.future, ...Object.values(checked.tags)]);
  const removed: string[] = [];
  const reachable = () =>
    new Set(
      commits.flatMap((commit) =>
        Object.values(commit.documents).filter((hash): hash is string => hash !== null),
      ),
    );
  const bytes = () =>
    [...reachable()].reduce((sum, hash) => {
      const content = checked.blobs[hash]!;
      return sum + (typeof content === "string" ? content.length * 2 : content.length);
    }, 0);
  while (
    commits.length > maxCommits ||
    bytes() > Math.min(maxBytes, byteCeiling()) ||
    reachable().size > PROJECT_HISTORY_LIMITS.maxBlobs
  ) {
    const index = commits.findIndex((commit) => !pinned.has(commit.id));
    if (index < 0) throw new Error("Pinned project History exceeds its retention limit.");
    removed.push(commits.splice(index, 1)[0]!.id);
  }
  const retained = new Set(commits.map((commit) => commit.id));
  const prunedParents = [
    ...new Set(
      commits.flatMap((commit) =>
        commit.parent !== null && !retained.has(commit.parent) ? [commit.parent] : [],
      ),
    ),
  ].sort();
  const hashes = reachable();
  // A subset of the checked commits preserves identities and metadata. Only its
  // explicit missing-parent boundaries and reachable blobs change during eviction.
  for (const commit of commits) Object.freeze(commit.changed);
  const blobs: Record<string, ProjectContent> = Object.create(null);
  for (const [hash, content] of Object.entries(checked.blobs))
    if (hashes.has(hash)) blobs[hash] = content;
  const next = Object.freeze({
    commits: Object.freeze(commits),
    blobs: Object.freeze(blobs),
    cursor: checked.cursor,
    future: checked.future,
    tags: checked.tags,
    ...(prunedParents.length === 0 ? {} : { prunedParents: Object.freeze(prunedParents) }),
  });
  return Object.freeze({
    state: next,
    removed: Object.freeze(removed),
  });
}
