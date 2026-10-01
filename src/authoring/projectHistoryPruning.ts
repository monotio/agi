/** Explicit retention policy: oldest unpinned commits first, preserving their identities. */
import {
  readProjectHistory,
  writeProjectHistory,
  PROJECT_HISTORY_LIMITS,
} from "./projectHistoryCodec.ts";
import type { ProjectHistoryState } from "./projectHistoryData.ts";
import type { ProjectDigest } from "./projectContent.ts";

export function pruneProjectHistory(
  state: ProjectHistoryState,
  digest: ProjectDigest,
  limits: { readonly maxCommits?: number; readonly maxBytes?: number } = {},
): { readonly state: ProjectHistoryState; readonly removed: readonly string[] } {
  const checked = readProjectHistory(writeProjectHistory(state, digest), digest);
  const maxCommits = limits.maxCommits ?? PROJECT_HISTORY_LIMITS.maxCommits;
  const maxBytes = limits.maxBytes ?? PROJECT_HISTORY_LIMITS.maxTotalBytes;
  if (
    !Number.isSafeInteger(maxCommits) ||
    maxCommits < 1 ||
    maxCommits > PROJECT_HISTORY_LIMITS.maxCommits ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > PROJECT_HISTORY_LIMITS.maxTotalBytes
  )
    throw new Error("Invalid project History retention limit.");
  const pinned = new Set([checked.cursor, ...checked.future, ...Object.values(checked.tags)]);
  const commits = [...checked.commits];
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
  while (commits.length > maxCommits || bytes() > maxBytes) {
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
  const next = {
    ...checked,
    commits,
    blobs: Object.fromEntries(Object.entries(checked.blobs).filter(([hash]) => hashes.has(hash))),
    prunedParents,
  };
  return Object.freeze({
    state: readProjectHistory(writeProjectHistory(next, digest), digest),
    removed: Object.freeze(removed),
  });
}
