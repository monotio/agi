/**
 * Durable recovery captures for the legacy progress a saved project's
 * removal observed at its unscoped storage address.
 *
 * Released builds wrote progress under a project's bare id — the tape at
 * `history/<id>` and everything under `history/<id>/`, the conversation at
 * `conversation/<id>`, the lifetime receipt at `lifetime/<id>` and plain
 * localStorage strings. Removing the project ends that data too, so the
 * removal transaction first copies every one of those records into an
 * immutable `legacy-progress/` record in the same object store and commits
 * capture and deletion together: a cursor, clone or quota failure aborts
 * both and loses nothing.
 *
 * A capture is written once with `store.add` and never rewritten. It is a
 * plain data record — `projectId` carries its `legacy-progress/<source>/<id>`
 * key so the store's keyPath resolves — and a capture whose version this
 * build does not know is refused by `readLegacyProgressRecord`, not
 * migrated. No export representation is defined; one may only be added for
 * shapes proven lossless.
 */

/** A localStorage value observed just before removal — exact key, raw string. */
export interface RawLocalEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * One IndexedDB record captured during removal. `value` is the record's
 * structured-clone content exactly as stored — never decoded, re-encoded
 * or stringified, so unknown and future record layouts survive intact.
 */
export interface CapturedRecord {
  readonly key: string;
  readonly value: unknown;
}

/** The `format` tag every version of the recovery schema carries. */
const LEGACY_PROGRESS_FORMAT = "monotio.agi.legacy-progress" as const;

/** The only recovery layout this build writes or reads. */
const LEGACY_PROGRESS_VERSION = 1;

/**
 * The record-key prefix keeping captures out of the saved-project namespace:
 * `storedProjects` skips every key containing `/`, so these records can
 * never read as a body or a gallery item.
 */
const LEGACY_PROGRESS_PREFIX = "legacy-progress/";

/**
 * A stored recovery capture — one removal's complete view of the legacy
 * progress for one source id.
 */
export interface LegacyProgressRecord {
  /** The record's own key — the store's `projectId` keyPath field. */
  readonly projectId: string;
  readonly format: typeof LEGACY_PROGRESS_FORMAT;
  readonly version: typeof LEGACY_PROGRESS_VERSION;
  /** The legacy storage id the captured keys belong to (a bare project id). */
  readonly source: string;
  /** Why the capture exists — removal is the only writer this version knows. */
  readonly reason: "remove";
  /** When the removal transaction observed these records. */
  readonly capturedAt: string;
  /** The localStorage strings observed — exact keys, raw values. */
  readonly local: readonly RawLocalEntry[];
  /** The IndexedDB records captured — exact keys, untouched clone values. */
  readonly records: readonly CapturedRecord[];
}

/** A capture exists but its version or layout is not one this build reads. */
export class UnsupportedRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRecoveryError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The key range covering every record whose key starts with `prefix`. The
 * exclusive upper bound is the prefix's last code unit incremented — a run
 * of trailing U+FFFF carries past it, and an all-U+FFFF tail leaves the
 * range open-ended. `openCursor` bounds alone are never trusted: callers
 * still check `startsWith` per entry, so a prefix that ends at the top of
 * the key space cannot silently drop suffixes.
 */
function prefixKeyRange(prefix: string, after?: string): IDBKeyRange {
  let end = prefix.length;
  while (end > 0 && prefix.charCodeAt(end - 1) === 0xffff) end--;
  // A resume key at or past the prefix becomes the exclusive lower bound, so
  // a page never re-reads earlier rows; one below it cannot skip real keys.
  const lower = after !== undefined && after >= prefix ? after : prefix;
  const exclusive = lower !== prefix;
  if (end === 0) return IDBKeyRange.lowerBound(lower, exclusive);
  const upper = `${prefix.slice(0, end - 1)}${String.fromCharCode(prefix.charCodeAt(end - 1) + 1)}`;
  // Past the upper bound, the per-entry resume check rejects this closed
  // prefix range. IndexedDB cannot represent an empty open equal-key range.
  if (lower >= upper) return IDBKeyRange.bound(prefix, prefix);
  return IDBKeyRange.bound(lower, upper, exclusive, true);
}

/**
 * Queue an `openCursor` over every key under `prefix` inside `store`'s
 * current transaction. `visit` runs for each entry confirmed to carry the
 * prefix — it may `cursor.delete()`, read `cursor.value` or both — and the
 * cursor runs to exhaustion, so staged writes elsewhere in the transaction
 * never cut the scan short. `done` runs once the cursor drains, or as soon
 * as `bounds.limit` visits have run — an early `done` parks the cursor
 * instead of continuing it, which settles the transaction once nothing else
 * is pending. `bounds.after` resumes strictly after that key.
 */
export function queuePrefixScan(
  store: IDBObjectStore,
  prefix: string,
  visit: (key: string, cursor: IDBCursorWithValue) => void,
  done?: () => void,
  bounds?: { after?: string; limit?: number },
): IDBRequest<IDBCursorWithValue | null> {
  if (bounds?.limit !== undefined && bounds.limit <= 0) {
    const request = store.openCursor(IDBKeyRange.bound(prefix, prefix));
    request.onsuccess = () => done?.();
    return request;
  }
  const after = bounds?.after;
  const request = store.openCursor(prefixKeyRange(prefix, after));
  let visited = 0;
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor === null) {
      done?.();
      return;
    }
    const { key } = cursor;
    if (typeof key === "string" && key.startsWith(prefix) && (after === undefined || key > after)) {
      visit(key, cursor);
      if (bounds?.limit !== undefined && ++visited >= bounds.limit) {
        done?.();
        return;
      }
    }
    cursor.continue();
  };
  return request;
}

/** The record-key prefix under which captures for `source` are stored. */
export function legacyProgressPrefix(source?: string): string {
  return source === undefined ? LEGACY_PROGRESS_PREFIX : `${LEGACY_PROGRESS_PREFIX}${source}/`;
}

/**
 * Build one immutable removal capture. `records` entries carry exact record
 * keys and raw structured-clone values; `local` entries are detached copies
 * of the caller's observations.
 */
export function newLegacyProgressRecord(
  source: string,
  local: readonly RawLocalEntry[],
  records: readonly CapturedRecord[],
): LegacyProgressRecord {
  return {
    projectId: `${legacyProgressPrefix(source)}${crypto.randomUUID()}`,
    format: LEGACY_PROGRESS_FORMAT,
    version: LEGACY_PROGRESS_VERSION,
    source,
    reason: "remove",
    capturedAt: new Date().toISOString(),
    local: local.map(({ key, value }) => ({ key, value })),
    records: records.map(({ key, value }) => ({ key, value })),
  };
}

/**
 * Read a raw store value as a recovery capture — `null` for a record that
 * is not a capture at all, a throw for a capture this build does not know:
 * an unknown version or a malformed layout is refused, never rewritten.
 */
export function readLegacyProgressRecord(raw: unknown): LegacyProgressRecord | null {
  if (!isObject(raw) || raw["format"] !== LEGACY_PROGRESS_FORMAT) return null;
  if (raw["version"] !== LEGACY_PROGRESS_VERSION)
    throw new UnsupportedRecoveryError(
      "This earlier progress capture was written by a newer version of the app.",
    );
  if (!hasCaptureLayout(raw))
    throw new UnsupportedRecoveryError(
      "This earlier progress capture is not in a layout this version can read.",
    );
  return raw as unknown as LegacyProgressRecord;
}

/** The version-1 field layout: every field the schema declares, correctly typed. */
const hasCaptureLayout = (raw: Record<string, unknown>): boolean =>
  typeof raw["projectId"] === "string" &&
  raw["projectId"].startsWith(LEGACY_PROGRESS_PREFIX) &&
  typeof raw["source"] === "string" &&
  raw["reason"] === "remove" &&
  typeof raw["capturedAt"] === "string" &&
  Array.isArray(raw["local"]) &&
  Array.isArray(raw["records"]) &&
  raw["local"].every(
    (entry: unknown) =>
      isObject(entry) && typeof entry["key"] === "string" && typeof entry["value"] === "string",
  ) &&
  raw["records"].every(
    (entry: unknown) => isObject(entry) && typeof entry["key"] === "string" && "value" in entry,
  );

/** How one record under the capture prefix reads under this build's schema. */
export type LegacyProgressRowState = "available" | "unsupported" | "unreadable";

/**
 * One row of a recovery read: the exact record key plus the state this build
 * can honestly report. An `available` row carries the decoded capture — the
 * stored record itself, not a copy. A refused row (`unsupported` for a
 * capture envelope of an unknown version, `unreadable` for a prefix record
 * that is not a readable capture) carries its raw stored value, untouched,
 * so a row this build cannot decode is still data — never missing. `absent`
 * answers an explicit key lookup only; a listing never invents rows.
 */
export type LegacyProgressRow =
  | {
      readonly key: string;
      readonly state: "available";
      readonly record: LegacyProgressRecord;
    }
  | {
      readonly key: string;
      readonly state: "unsupported" | "unreadable";
      readonly value: unknown;
    }
  | { readonly key: string; readonly state: "absent" };

/**
 * Classify a raw store value under the capture prefix without the strict
 * decoder's throws: `unreadable` when it is not a readable capture at all,
 * `unsupported` for a capture envelope of a version this build does not
 * know, `available` when `readLegacyProgressRecord` would decode it.
 */
export function classifyLegacyProgressRecord(raw: unknown): LegacyProgressRowState {
  if (!isObject(raw) || raw["format"] !== LEGACY_PROGRESS_FORMAT) return "unreadable";
  if (raw["version"] !== LEGACY_PROGRESS_VERSION) return "unsupported";
  return hasCaptureLayout(raw) ? "available" : "unreadable";
}

/**
 * Whether `key` names one capture record: `legacy-progress/<source>/<id>`
 * with a non-empty source and id. Anything else — another namespace's key,
 * the bare prefix, a source with no row id — is not a capture key, so a
 * validated reader can never be aimed at an unrelated record.
 */
export function isLegacyProgressKey(key: unknown): key is string {
  if (typeof key !== "string" || !key.startsWith(LEGACY_PROGRESS_PREFIX)) return false;
  const rest = key.slice(LEGACY_PROGRESS_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash > 0 && slash < rest.length - 1;
}
