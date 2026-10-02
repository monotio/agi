/** Synchronous write-ahead copies survive teardown while IndexedDB commits settle. */
import type { ProjectId } from "../../../src/gameIdentity.ts";
import type { ProjectCommitRequest, ProjectCommitReceipt } from "./gameStorage.ts";

interface JournalEntry {
  request: ProjectCommitRequest;
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

function encode(value: unknown): unknown {
  if (value === undefined) return ["undefined"];
  if (Object.is(value, -0)) return ["negative-zero"];
  if (value instanceof Uint8Array) return ["bytes", Array.from(value)];
  if (Array.isArray(value)) return ["array", value.map(encode)];
  if (value !== null && typeof value === "object")
    return ["record", Object.entries(value).map(([key, item]) => [key, encode(item)])];
  return value;
}
function decode(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const [tag, items] = value;
  if (tag === "undefined") return undefined;
  if (tag === "negative-zero") return -0;
  if (!Array.isArray(items)) throw new Error("Invalid pending project write.");
  if (tag === "bytes") return Uint8Array.from(items as number[]);
  if (tag === "array") return items.map(decode);
  if (tag === "record")
    return Object.fromEntries(
      (items as [string, unknown][]).map(([key, item]) => [key, decode(item)]),
    );
  throw new Error("Invalid pending project write.");
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
  else storage.setItem(key, JSON.stringify({ version: 1, entries: encode(entries) }));
}

/** Replay exact attempted requests; only an unattempted successor takes its predecessor's receipt. */
export function resumeProjectSaveJournals(
  storage: Storage,
  project: ProjectId,
  write: (request: ProjectCommitRequest) => Promise<{ receipt: ProjectCommitReceipt }>,
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
      if (journal.version !== 1)
        throw new Error("This pending project write version is not supported.");
      const entries = decode(journal.entries) as JournalEntry[];
      if (!Array.isArray(entries)) throw new Error("Invalid pending project writes.");
      let previous: ProjectCommitReceipt | undefined;
      while (entries.length > 0) {
        const entry = entries[0]!;
        if (!entry.attempted && previous !== undefined)
          entry.request = { ...entry.request, expected: previous.saved };
        entry.attempted = true;
        writeProjectSaveJournal(storage, key, entries);
        try {
          previous = (await write(entry.request)).receipt;
        } catch (error) {
          if (
            error instanceof Error &&
            ["ConcurrencyConflictError", "ProjectDeletedError", "ProjectExistsError"].includes(
              error.name,
            )
          )
            break;
          throw error;
        }
        entries.shift();
        // Keep the successor's resolved base durable before dropping its predecessor.
        if (entries[0] && !entries[0].attempted)
          entries[0].request = { ...entries[0].request, expected: previous.saved };
        writeProjectSaveJournal(storage, key, entries);
      }
    }
  })().finally(() => recovering.delete(project));
  recovering.set(project, run);
  return run;
}
