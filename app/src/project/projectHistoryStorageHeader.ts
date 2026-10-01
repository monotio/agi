/** Lightweight row references used before the History codec is needed. */
import type { PortableProjectHistory } from "../../../src/authoring/projectHistoryCodec.ts";

export type StoredProjectHistory = Omit<PortableProjectHistory, "blobs"> & {
  readonly blobs: readonly string[];
};
export function projectHistoryBlobKey(id: string, hash: string): string {
  return `project-history/${id}/blobs/${hash}`;
}
export function historyBlobKeys(id: string, history: StoredProjectHistory | undefined): string[] {
  if (history === undefined) return [];
  if (history.format !== "monotio.agi.project-history" || ![1, 2].includes(history.version))
    throw new Error("This project history version is not supported by this app.");
  if (
    !Array.isArray(history.blobs) ||
    history.blobs.length > 16_384 ||
    history.blobs.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) ||
    new Set(history.blobs).size !== history.blobs.length
  )
    throw new Error("Invalid stored project History blob list.");
  return history.blobs.map((hash) => projectHistoryBlobKey(id, hash));
}
