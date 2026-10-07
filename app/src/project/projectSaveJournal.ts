/** Accepted project captures recover interrupted storage acknowledgements. */
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
const RECOVERY_PREFIX = "monotio_agi.project-recovery.";
export const PROJECT_SAVE_JOURNAL_EVENT = "project-save-journal";
function belongsToProject(key: string | null, project: ProjectId, prefix = PREFIX): key is string {
  if (key === null || !key.startsWith(prefix)) return false;
  // Worker owner tokens contain no dots; project IDs may contain them.
  return key.slice(prefix.length, key.lastIndexOf(".")) === project;
}
function changed(): void {
  if (typeof dispatchEvent !== "undefined") dispatchEvent(new Event(PROJECT_SAVE_JOURNAL_EVENT));
}
export function clearProjectSaveJournals(storage: Storage, project: ProjectId): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys)
    if (belongsToProject(key, project) || belongsToProject(key, project, RECOVERY_PREFIX)) {
      storage.removeItem(key);
      delete terminal[key];
    }
}

export function discardProjectSaveRecoveries(
  storage: Storage,
  project: ProjectId,
  observed: readonly { key: string; raw: string }[],
): void {
  for (const { key, raw } of observed) {
    if (!belongsToProject(key, project) || storage.getItem(key) !== raw) continue;
    storage.removeItem(key);
    storage.removeItem(`${RECOVERY_PREFIX}${key.slice(PREFIX.length)}`);
    delete terminal[key];
  }
}
interface RecoveryMarker {
  version: 1;
  hash: string;
  reason: string;
}
const terminal: Record<string, RecoveryMarker> = {};

/** Retained journals whose base differs from the live project version. */
export function readProjectSaveRecoveries(
  storage: Storage,
  project: ProjectId,
): { key: string; raw: string; reason: string }[] {
  const found: { key: string; raw: string; reason: string }[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!belongsToProject(key, project)) continue;
    try {
      const stored = storage.getItem(`${RECOVERY_PREFIX}${key.slice(PREFIX.length)}`);
      const marker = stored === null ? terminal[key] : (JSON.parse(stored) as RecoveryMarker);
      if (marker === undefined) continue;
      const source = key;
      const raw = storage.getItem(source);
      if (
        marker.version === 1 &&
        raw !== null &&
        marker.hash === sha256Hex(new TextEncoder().encode(raw))
      )
        found.push({ key: source, raw, reason: marker.reason });
    } catch {
      // An unreadable marker grants no authority to suppress recovery.
    }
  }
  return found;
}

const recovering = new Map<string, Promise<void>>();
const live = new Set<string>();
const releasing = new Map<string, Promise<void>>();

export function claimProjectSaveJournal(key: string): { ready: Promise<boolean>; release(): void } {
  let settle!: (held: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  let release!: () => void;
  let released = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) settle(false);
  const ownership = locks
    ?.request(key, () => {
      if (released) {
        settle(false);
        return;
      }
      live.add(key);
      settle(true);
      return held;
    })
    .catch(() => {
      settle(false);
    });
  return {
    ready,
    release() {
      released = true;
      live.delete(key);
      settle(false);
      release();
      if (ownership) {
        releasing.set(key, ownership);
        void ownership.finally(() => {
          if (releasing.get(key) === ownership) releasing.delete(key);
        });
      }
    },
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

/** Surface accepted captures that could not be stored against their base. */
export function markProjectSaveRecovery(storage: Storage, key: string, reason: string): void {
  const raw = storage.getItem(key);
  if (raw === null) return;
  const marker: RecoveryMarker = {
    version: 1,
    hash: sha256Hex(new TextEncoder().encode(raw)),
    reason,
  };
  terminal[key] = marker;
  storage.setItem(`${RECOVERY_PREFIX}${key.slice(PREFIX.length)}`, JSON.stringify(marker));
  changed();
}

/** Replay exact attempted requests; only an unattempted successor takes its predecessor's receipt. */
export function resumeProjectSaveJournals(
  storage: Storage,
  project: ProjectId,
  write: (request: ProjectCommitRequest) => Promise<{ receipt: ProjectCommitReceipt }>,
  rebuild?: (capture: ProjectJournalCapture) => Promise<{ receipt: ProjectCommitReceipt }>,
): Promise<void> | undefined {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return undefined;
  const active = recovering.get(project);
  if (active) return active;
  const retired = new Set(readProjectSaveRecoveries(storage, project).map(({ key }) => key));
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (belongsToProject(key, project) && !live.has(key) && !retired.has(key)) keys.push(key);
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
            if (error instanceof Error && error.name === "ProjectDeletedError") {
              const current = readEntries(storage, key);
              const index = current.findIndex(
                (candidate) => entryIdentity(candidate) === entryIdentity(entry),
              );
              if (index < 0) break;
              current.splice(index, 1);
              writeProjectSaveJournal(storage, key, current);
              entries = current.filter((candidate) => observed.has(entryIdentity(candidate)));
              continue;
            }
            if (
              error instanceof Error &&
              ["ConcurrencyConflictError", "ProjectExistsError"].includes(error.name)
            ) {
              const current = readEntries(storage, key);
              const index = current.findIndex(
                (candidate) => entryIdentity(candidate) === entryIdentity(entry),
              );
              if (index >= 0) current[index] = beforeAttempt;
              writeProjectSaveJournal(storage, key, current);
              const raw = storage.getItem(key);
              if (
                raw !== null &&
                current.every((candidate) => observed.has(entryIdentity(candidate)))
              ) {
                const marker: RecoveryMarker = {
                  version: 1,
                  hash: sha256Hex(new TextEncoder().encode(raw)),
                  reason: error.message,
                };
                terminal[key] = marker;
                try {
                  storage.setItem(
                    `${RECOVERY_PREFIX}${key.slice(PREFIX.length)}`,
                    JSON.stringify(marker),
                  );
                } catch {
                  // Original bytes remain in the journal; this page can still surface recovery.
                }
              }
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
      await locks.request(key, { ifAvailable: true }, async (lock) => {
        if (lock && !live.has(key)) await recover();
      });
    }
  })().finally(() => recovering.delete(project));
  recovering.set(project, run);
  return run;
}
