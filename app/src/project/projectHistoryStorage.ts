/** History metadata lives in the body; each reachable content hash owns one sibling row. */
import {
  readProjectHistory,
  PROJECT_HISTORY_LIMITS,
  writeProjectHistory,
  type PortableProjectHistory,
} from "../../../src/authoring/projectHistoryCodec.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import {
  projectDocumentId,
  sameProjectContent,
  type ProjectContent,
} from "../../../src/authoring/projectContent.ts";
import { readProjectWorkspace } from "../../../src/authoring/projectWorkspace.ts";
import type { CachedGameData } from "./gameTypes.ts";

export { historyBlobKeys, projectHistoryBlobKey } from "./projectHistoryStorageHeader.ts";
export type { StoredProjectHistory } from "./projectHistoryStorageHeader.ts";
import {
  historyBlobKeys,
  projectHistoryBlobKey,
  type StoredProjectHistory,
} from "./projectHistoryStorageHeader.ts";

export function hydrateProjectHistory(
  id: string,
  history: StoredProjectHistory,
  rows: ReadonlyMap<string, unknown>,
): PortableProjectHistory {
  historyBlobKeys(id, history);
  let total = 0;
  const blobs = Object.fromEntries(
    history.blobs.map((hash) => {
      const key = projectHistoryBlobKey(id, hash);
      const row = rows.get(key) as
        { projectId?: unknown; format?: unknown; version?: unknown; content?: unknown } | undefined;
      if (
        row?.projectId !== key ||
        row.format !== "monotio.agi.project-history-blob" ||
        row.version !== 1
      )
        throw new Error("This project History blob is missing or has an unsupported version.");
      const content = row.content;
      if (typeof content !== "string" && !(content instanceof Uint8Array))
        throw new Error("Invalid stored project History blob content.");
      const size = typeof content === "string" ? content.length * 2 : content.length;
      total += size;
      if (
        size > PROJECT_HISTORY_LIMITS.maxBlobBytes ||
        total > PROJECT_HISTORY_LIMITS.maxTotalBytes
      )
        throw new Error("Stored project History exceeds its blob payload limit.");
      return [
        hash,
        typeof content === "string"
          ? { type: "text", text: content }
          : { type: "bytes", bytes: Array.from(content) },
      ];
    }),
  );
  return writeProjectHistory(readProjectHistory({ ...history, blobs }, sha256Hex), sha256Hex);
}
export function checkedProjectHistory(data: CachedGameData): PortableProjectHistory | undefined {
  if (data.projectHistory === undefined) return undefined;
  const state = readProjectHistory(data.projectHistory, sha256Hex);
  const reachable = new Set(
    state.commits.flatMap((commit) =>
      Object.values(commit.documents).filter((hash): hash is string => hash !== null),
    ),
  );
  const history = writeProjectHistory(
    {
      ...state,
      blobs: Object.fromEntries(
        Object.entries(state.blobs).filter(([hash]) => reachable.has(hash)),
      ),
    },
    sha256Hex,
  );
  if (data.workspace !== undefined) {
    const cursor = state.commits.find((commit) => commit.id === state.cursor);
    const documents = Object.fromEntries(
      Object.entries(cursor?.documents ?? {})
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .map(([key, hash]) => [key, state.blobs[hash]!]),
    );
    if (
      projectDocumentId(documents, sha256Hex) !==
      projectDocumentId(readProjectWorkspace(data.workspace), sha256Hex)
    )
      throw new Error("Project documents differ from the History cursor.");
  }
  return history;
}
export function projectHistoryWrites(
  id: string,
  previous: StoredProjectHistory | undefined,
  next: PortableProjectHistory | undefined,
  rows: ReadonlyMap<string, unknown>,
): { puts: unknown[]; deletes: string[] } {
  if (previous !== undefined) hydrateProjectHistory(id, previous, rows);
  if (next === undefined) return { puts: [], deletes: [] };
  const state = readProjectHistory(next, sha256Hex);
  const retained = new Set(Object.keys(state.blobs));
  const puts: unknown[] = [];
  for (const [hash, content] of Object.entries(state.blobs)) {
    const key = projectHistoryBlobKey(id, hash);
    const row = rows.get(key) as
      { projectId?: unknown; format?: unknown; version?: unknown; content?: unknown } | undefined;
    if (row !== undefined) {
      if (
        row.projectId !== key ||
        row.format !== "monotio.agi.project-history-blob" ||
        row.version !== 1
      )
        throw new Error("This project History blob has an unsupported version.");
      if (
        (typeof row.content !== "string" && !(row.content instanceof Uint8Array)) ||
        !sameProjectContent(row.content as ProjectContent, content)
      )
        throw new Error("Stored project History blob differs from its content hash.");
    } else
      puts.push({
        projectId: key,
        format: "monotio.agi.project-history-blob",
        version: 1,
        content,
      });
  }
  return {
    puts,
    deletes: (previous?.blobs ?? [])
      .filter((hash) => !retained.has(hash))
      .map((hash) => projectHistoryBlobKey(id, hash)),
  };
}
