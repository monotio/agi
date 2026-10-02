/** Edited document journals survive teardown while IndexedDB commits settle. */
import type { ProjectId } from "../../../src/gameIdentity.ts";
import type { ProjectCommitRequest, ProjectCommitReceipt } from "./gameStorage.ts";
import {
  encodeJournalValue,
  decodeJournalValue,
  type ProjectJournalCapture,
} from "./projectJournalCapture.ts";
import { sha256Hex } from "../../../src/crypto.ts";

interface JournalEntry {
  request?: ProjectCommitRequest;
  capture?: ProjectJournalCapture;
  attempted: boolean;
}
const PREFIX = "monotio_agi.project-writes.";
const recovering = new Map<string, Promise<void>>();
const live = new Set<string>();

export function claimProjectSaveJournal(key: string): () => void {
  live.add(key);
  return () => {
    live.delete(key);
  };
}

export function projectSaveJournalKey(project: ProjectId, owner: string): string {
  return `${PREFIX}${project}.${owner}`;
}
export function writeProjectSaveJournal(
  storage: Storage,
  key: string,
  entries: readonly JournalEntry[],
): void {
  if (entries.length === 0) storage.removeItem(key);
  else {
    const raw = JSON.stringify({
      version: entries[0]?.capture === undefined ? 1 : 2,
      entries: encodeJournalValue(entries),
    });
    try {
      storage.setItem(key, raw);
    } catch (error) {
      try {
        storage.removeItem(key);
      } catch {
        /* Storage may be unavailable. */
      }
      throw error;
    }
  }
}

/** Replay exact attempted requests; only an unattempted successor takes its predecessor's receipt. */
export function resumeProjectSaveJournals(
  storage: Storage,
  project: ProjectId,
  write: (request: ProjectCommitRequest) => Promise<{ receipt: ProjectCommitReceipt }>,
  rebuild?: (capture: ProjectJournalCapture) => Promise<{ receipt: ProjectCommitReceipt }>,
): Promise<void> | undefined {
  const active = recovering.get(project);
  if (active) return active;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(`${PREFIX}${project}.`) && !live.has(key)) keys.push(key);
  }
  if (keys.length === 0) return undefined;
  const run = (async () => {
    for (const key of keys.sort()) {
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const journal = JSON.parse(raw) as { version: number; entries: unknown };
      if (journal.version !== 1 && journal.version !== 2)
        throw new Error("This pending project write version is not supported.");
      const entries = decodeJournalValue(journal.entries) as JournalEntry[];
      if (!Array.isArray(entries)) throw new Error("Invalid pending project writes.");
      let previous: ProjectCommitReceipt | undefined;
      while (entries.length > 0) {
        const entry = entries[0]!;
        const beforeAttempt = storage.getItem(key)!;
        if (!entry.attempted && previous !== undefined && entry.request !== undefined)
          entry.request = { ...entry.request, expected: previous.saved };
        entry.attempted = true;
        writeProjectSaveJournal(storage, key, entries);
        try {
          if (entry.capture !== undefined) {
            if (rebuild === undefined) throw new Error("Project journal recovery is unavailable.");
            previous = (await rebuild(entry.capture)).receipt;
          } else previous = (await write(entry.request!)).receipt;
        } catch (error) {
          if (
            error instanceof Error &&
            ["ConcurrencyConflictError", "ProjectDeletedError", "ProjectExistsError"].includes(
              error.name,
            )
          ) {
            storage.setItem(key, beforeAttempt);
            break;
          }
          throw error;
        }
        entries.shift();
        // Keep the successor's resolved base durable before dropping its predecessor.
        const successor = entries[0];
        if (successor && !successor.attempted) {
          if (successor.capture !== undefined && entry.capture !== undefined) {
            const { hash: _hash, ...capture } = successor.capture;
            const next = {
              ...capture,
              base: previous.saved,
              identity: { ...capture.identity, expected: previous.saved },
              operations:
                capture.base.generation === entry.capture.base.generation &&
                capture.base.lifetime === entry.capture.base.lifetime
                  ? capture.operations.slice(entry.capture.operations.length)
                  : capture.operations,
            };
            successor.capture = {
              ...next,
              hash: sha256Hex(new TextEncoder().encode(JSON.stringify(encodeJournalValue(next)))),
            };
          } else successor.request = { ...successor.request!, expected: previous.saved };
        }
        writeProjectSaveJournal(storage, key, entries);
      }
    }
  })().finally(() => recovering.delete(project));
  recovering.set(project, run);
  return run;
}
