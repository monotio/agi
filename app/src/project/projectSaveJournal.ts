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
function entryIdentity(entry: JournalEntry): string {
  return entry.capture?.identity.commitId ?? entry.request!.commitId;
}
function readEntries(storage: Storage, key: string): JournalEntry[] {
  const raw = storage.getItem(key);
  if (raw === null) return [];
  const journal = JSON.parse(raw) as { version: number; entries: unknown };
  if (journal.version !== 1 && journal.version !== 2)
    throw new Error("This pending project write version is not supported.");
  const entries = decodeJournalValue(journal.entries) as JournalEntry[];
  if (!Array.isArray(entries)) throw new Error("Invalid pending project writes.");
  return entries;
}
const PREFIX = "monotio_agi.project-writes.";
const recovering = new Map<string, Promise<void>>();
const live = new Set<string>();
const releasing = new Map<string, Promise<void>>();

export function claimProjectSaveJournal(key: string): () => void {
  live.add(key);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  const ownership = locks?.request(key, () => held).catch(() => {});
  return () => {
    live.delete(key);
    release();
    if (ownership) {
      releasing.set(key, ownership);
      void ownership.finally(() => {
        if (releasing.get(key) === ownership) releasing.delete(key);
      });
    }
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
    storage.setItem(key, raw);
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
      const recover = async () => {
        let entries = readEntries(storage, key);
        const observed = new Set(entries.map(entryIdentity));
        let previous: ProjectCommitReceipt | undefined;
        while (entries.length > 0) {
          const entry = entries[0]!;
          const beforeAttempt = structuredClone(entry);
          if (!entry.attempted && previous !== undefined && entry.request !== undefined)
            entry.request = { ...entry.request, expected: previous.saved };
          entry.attempted = true;
          const preparing = readEntries(storage, key);
          const preparingIndex = preparing.findIndex(
            (candidate) => entryIdentity(candidate) === entryIdentity(entry),
          );
          if (preparingIndex < 0) break;
          preparing[preparingIndex] = entry;
          writeProjectSaveJournal(storage, key, preparing);
          try {
            if (entry.capture !== undefined) {
              if (rebuild === undefined)
                throw new Error("Project journal recovery is unavailable.");
              previous = (await rebuild(entry.capture)).receipt;
            } else previous = (await write(entry.request!)).receipt;
          } catch (error) {
            if (
              error instanceof Error &&
              ["ConcurrencyConflictError", "ProjectDeletedError", "ProjectExistsError"].includes(
                error.name,
              )
            ) {
              const current = readEntries(storage, key);
              const index = current.findIndex(
                (candidate) => entryIdentity(candidate) === entryIdentity(entry),
              );
              if (index >= 0) current[index] = beforeAttempt;
              writeProjectSaveJournal(storage, key, current);
              break;
            }
            throw error;
          }
          const current = readEntries(storage, key);
          const index = current.findIndex(
            (candidate) => entryIdentity(candidate) === entryIdentity(entry),
          );
          if (index < 0) break;
          current.splice(index, 1);
          // Keep the successor's resolved base durable before dropping its predecessor.
          const successor = current[index];
          if (successor && !successor.attempted) {
            if (successor.capture !== undefined && entry.capture !== undefined) {
              const { hash: _hash, ...capture } = successor.capture;
              const next = {
                ...capture,
                base: previous.saved,
                baseImage: entry.capture.image,
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
          writeProjectSaveJournal(storage, key, current);
          entries = current.filter((candidate) => observed.has(entryIdentity(candidate)));
        }
      };
      await releasing.get(key);
      const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
      if (locks)
        await locks.request(key, { ifAvailable: true }, async (lock) => {
          if (lock && !live.has(key)) await recover();
        });
      else if (!live.has(key)) await recover();
    }
  })().finally(() => recovering.delete(project));
  recovering.set(project, run);
  return run;
}
