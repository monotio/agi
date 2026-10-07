/**
 * Inspection downloads for earlier progress — the honest export half of the
 * read path in earlierProgress.ts.
 *
 * A download here is an inspection/recovery record, not a playable game or
 * project archive and not a format anything imports. The document keeps the
 * exact stored data: localStorage keys and raw strings byte-for-byte, and
 * IndexedDB record keys with their structured-clone values — but only when
 * every value has proven-lossless JSON shape. The gate refuses cycles,
 * shared references JSON would silently duplicate, numbers JSON cannot keep
 * (-0, NaN, infinities), bigint, symbols, undefined, functions, accessors,
 * non-enumerable or symbol-keyed fields, sparse or decorated arrays, and
 * every structured-clone-only shape (typed arrays, ArrayBuffer, Blob,
 * Map/Set, Date, custom prototypes). Refusal preserves the source bytes —
 * nothing is cast, truncated, re-encoded or quietly dropped, and no
 * `toJSON` hook or tagged re-serialization is ever consulted. When a
 * complete export refuses, the local strings may still ship as a clearly
 * separate payload marked partial — but only when they prove lossless
 * through the same gate — with the remaining components reported as
 * retained in this browser.
 *
 * Unknown capture versions export as opaque raw data when they pass the
 * gate — they are never decoded as a known layout.
 */
import type { EarlierRead } from "./earlierProgress.ts";
import type { RawLocalEntry } from "./legacyProgressRecovery.ts";

/** The download document's own format tag — an inspection record, not an archive. */
export const EARLIER_PROGRESS_EXPORT_FORMAT = "monotio.agi.earlier-progress-export";
const EARLIER_PROGRESS_EXPORT_VERSION = 1;

/** Read/export work bounds — limits on the export, never on stored data. */
export interface EarlierExportBounds {
  /** Deepest object nesting accepted (default 64). */
  readonly maxDepth?: number | undefined;
  /** Most values visited while proving lossless shape (default 200_000). */
  readonly maxNodes?: number | undefined;
  /** Largest serialized document accepted, in UTF-8 bytes (default 8 MiB). */
  readonly maxJsonBytes?: number | undefined;
}

export type JsonLosslessCheck =
  | { readonly ok: true; readonly nodes: number }
  | { readonly ok: false; readonly path: string; readonly reason: string };

/** Where a refused export's unexportable components remain. */
export interface EarlierExport {
  readonly status: "complete" | "partial" | "unavailable";
  /**
   * `complete`: the full inspection record as exact-lossless JSON text.
   * `partial`: the complete export was refused — `reason` says why and
   * `localJson` may still carry the separately exportable local strings.
   * `unavailable`: there is nothing to export at all.
   */
  readonly kind: "capture" | "live" | "local";
  /** The serialized complete document — `status: "complete"` only. */
  readonly json?: string | undefined;
  readonly bytes?: number | undefined;
  /** Why a complete export was refused (`partial`/`unavailable`). */
  readonly reason?: string | undefined;
  /**
   * The localStorage strings as their own small JSON document — offered
   * only when a complete export refused and this source actually holds
   * local strings. Clearly separate from the complete download.
   */
  readonly localJson?: string | undefined;
  readonly localBytes?: number | undefined;
  /** Storage keys whose raw values stayed in this browser (not exported). */
  readonly retained?: readonly string[] | undefined;
}

function isPlainObjectProto(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

const CANONICAL_INDEX = /^(?:0|[1-9][0-9]*)$/;

/**
 * An object's own fields as JSON would see them — every own enumerable
 * string-keyed data property. Anything JSON would drop or alter is an
 * `issue`: accessors, non-enumerable or symbol-keyed fields, a decorated or
 * sparse array, a non-plain prototype.
 */
function ownJsonEntries(
  value: object,
): { readonly entries: readonly [string, unknown][] } | { readonly issue: string } {
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      return { issue: "an array with a custom prototype" };
    if (Object.getOwnPropertySymbols(value).length > 0)
      return { issue: "symbol-keyed data JSON would drop" };
    const entries: [string, unknown][] = [];
    let indices = 0;
    for (const name of Object.getOwnPropertyNames(value)) {
      if (name === "length") continue;
      if (!CANONICAL_INDEX.test(name) || Number(name) >= value.length)
        return { issue: `the extra property "${name}" JSON would drop` };
      const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
      if (!("value" in descriptor)) return { issue: `an accessor at index ${name}` };
      entries.push([name, descriptor.value]);
      indices++;
    }
    if (indices !== value.length) return { issue: "a sparse array JSON would fill with null" };
    return { entries };
  }
  if (!isPlainObjectProto(value)) return { issue: "a non-plain object JSON cannot represent" };
  if (Object.getOwnPropertySymbols(value).length > 0)
    return { issue: "symbol-keyed data JSON would drop" };
  const entries: [string, unknown][] = [];
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
    if (!("value" in descriptor)) return { issue: `an accessor property "${name}"` };
    if (!descriptor.enumerable)
      return { issue: `the non-enumerable property "${name}" JSON would drop` };
    entries.push([name, descriptor.value]);
  }
  return { entries };
}

function childPath(path: string, name: string): string {
  return CANONICAL_INDEX.test(name) ? `${path}[${name}]` : `${path}.${name}`;
}

/**
 * Prove a value survives `JSON.stringify`/`parse` exactly — checked
 * structurally and iteratively, before any serialization. Strings (exact
 * UTF-16, lone surrogates included — JSON escapes them), booleans, null and
 * finite numbers other than -0 pass; plain objects and dense arrays recurse
 * within `bounds`. Shared or cyclic references refuse even when JSON would
 * produce text, because the clone's reference identity would be lost.
 */
export function checkJsonLossless(value: unknown, bounds?: EarlierExportBounds): JsonLosslessCheck {
  const maxDepth = bounds?.maxDepth ?? 64;
  const maxNodes = bounds?.maxNodes ?? 200_000;
  const active = new Set<object>();
  const seen = new Set<object>();
  let nodes = 0;
  interface Frame {
    self: object;
    path: string;
    depth: number;
    entries: readonly [string, unknown][];
    index: number;
  }
  const stack: Frame[] = [];
  let current: { value: unknown; path: string; depth: number } | null = {
    value,
    path: "$",
    depth: 0,
  };
  for (;;) {
    while (current !== null) {
      if (++nodes > maxNodes)
        return { ok: false, path: current.path, reason: `more than ${maxNodes} values` };
      if (current.depth > maxDepth)
        return {
          ok: false,
          path: current.path,
          reason: `nesting deeper than ${maxDepth} levels`,
        };
      const v = current.value;
      const path = current.path;
      if (v === null || typeof v === "string" || typeof v === "boolean") {
        current = null;
        continue;
      }
      if (typeof v === "number") {
        if (!Number.isFinite(v))
          return { ok: false, path, reason: `${String(v)} is not a JSON number` };
        if (Object.is(v, -0)) return { ok: false, path, reason: "-0 would round-trip as 0" };
        current = null;
        continue;
      }
      if (typeof v !== "object")
        return { ok: false, path, reason: `${typeof v} has no JSON representation` };
      if (active.has(v))
        return { ok: false, path, reason: "a cyclic reference JSON cannot represent" };
      if (seen.has(v))
        return { ok: false, path, reason: "a shared reference JSON would duplicate" };
      const owned = ownJsonEntries(v);
      if ("issue" in owned) return { ok: false, path, reason: owned.issue };
      seen.add(v);
      active.add(v);
      stack.push({ self: v, path, depth: current.depth, entries: owned.entries, index: 0 });
      current = null;
    }
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    if (frame.index >= frame.entries.length) {
      active.delete(frame.self);
      stack.pop();
      continue;
    }
    const [name, child] = frame.entries[frame.index++]!;
    current = { value: child, path: childPath(frame.path, name), depth: frame.depth + 1 };
  }
  return { ok: true, nodes };
}

interface ExportDocument {
  readonly kind: "capture" | "live" | "local";
  readonly document: Record<string, unknown>;
  /** The source's local strings, when the read carried any. */
  readonly local: readonly RawLocalEntry[];
  /**
   * The live localStorage keys `local` was read under — added to
   * `retained` when no local-only payload ships. Empty for a capture: its
   * local entries live inside the captured envelope under the capture's
   * own key, never at live storage keys.
   */
  readonly localKeys: readonly string[];
  /** Storage keys whose raw values stay in this browser if this document cannot ship. */
  readonly retained: readonly string[];
}

function exportDocument(read: EarlierRead): ExportDocument | null {
  switch (read.kind) {
    case "capture":
      if (read.state === "absent") return null;
      if (read.state === "available")
        return {
          kind: "capture",
          // The capture's own envelope is preserved verbatim: its format,
          // version, source, reason and capturedAt travel as stored.
          document: {
            format: EARLIER_PROGRESS_EXPORT_FORMAT,
            version: EARLIER_PROGRESS_EXPORT_VERSION,
            kind: "capture",
            key: read.key,
            capture: read.record,
          },
          local: read.record.local,
          localKeys: [],
          retained: [read.key],
        };
      return {
        kind: "capture",
        // An unknown or malformed row ships as opaque raw data — never
        // decoded as a known capture layout.
        document: {
          format: EARLIER_PROGRESS_EXPORT_FORMAT,
          version: EARLIER_PROGRESS_EXPORT_VERSION,
          kind: "capture",
          key: read.key,
          state: read.state,
          value: read.value,
        },
        local: [],
        localKeys: [],
        retained: [read.key],
      };
    case "live":
      if (read.records.length === 0 && read.local.length === 0) return null;
      return {
        kind: "live",
        document: {
          format: EARLIER_PROGRESS_EXPORT_FORMAT,
          version: EARLIER_PROGRESS_EXPORT_VERSION,
          kind: "live",
          source: read.source,
          local: read.local.map(({ key, value }) => ({ key, value })),
          records: read.records.map(({ key, value }) => ({ key, value })),
        },
        local: read.local,
        localKeys: read.local.map(({ key }) => key),
        retained: read.records.map(({ key }) => key),
      };
    case "local": {
      const present = read.entries.filter(
        (entry): entry is { key: string; state: "present"; value: string } =>
          entry.state === "present",
      );
      if (present.length === 0) return null;
      const missing = read.entries.flatMap((entry) =>
        entry.state === "missing" ? [entry.key] : [],
      );
      return {
        kind: "local",
        document: {
          format: EARLIER_PROGRESS_EXPORT_FORMAT,
          version: EARLIER_PROGRESS_EXPORT_VERSION,
          kind: "local",
          entries: present.map(({ key, value }) => ({ key, value })),
          ...(missing.length > 0 ? { missing } : {}),
        },
        local: [],
        localKeys: [],
        // The local document is the whole export: a refused one leaves
        // every present key in storage, so they are the retained set.
        retained: present.map(({ key }) => key),
      };
    }
  }
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

function localOnlyDocument(entries: readonly RawLocalEntry[]): Record<string, unknown> {
  return {
    format: EARLIER_PROGRESS_EXPORT_FORMAT,
    version: EARLIER_PROGRESS_EXPORT_VERSION,
    kind: "local",
    entries: entries.map(({ key, value }) => ({ key, value })),
  };
}

/**
 * Serialize the local strings as their own small document — only when the
 * stored array is exactly raw `{key, value}` entries and the built
 * document passes the same lossless gate a complete export does. A sparse
 * or otherwise malformed stored array ships nothing: its JSON would invent
 * or drop entries the source never held. The gate reads property
 * descriptors only, so accessors and `toJSON` hooks are never executed.
 */
function localOnlyJson(
  entries: readonly RawLocalEntry[],
  bounds?: EarlierExportBounds,
): string | undefined {
  if (!checkJsonLossless(entries, bounds).ok) return undefined;
  for (const entry of entries as readonly unknown[]) {
    const record = entry as Record<string, unknown>;
    if (
      Object.getOwnPropertyNames(record).length !== 2 ||
      typeof record["key"] !== "string" ||
      typeof record["value"] !== "string"
    )
      return undefined;
  }
  const document = localOnlyDocument(entries);
  return checkJsonLossless(document, bounds).ok ? JSON.stringify(document) : undefined;
}

/**
 * Build the inspection download for one read source. `complete` only when
 * the entire raw data proved JSON-lossless — the serialized `json` then
 * holds every local key/string and every record key/value exactly. Any
 * refusal keeps the source untouched and reports `partial` with the reason
 * plus a clearly separate local-strings document when the source held any,
 * or `unavailable` when there was nothing to export.
 */
export function exportEarlierProgress(
  read: EarlierRead,
  bounds?: EarlierExportBounds,
): EarlierExport {
  const maxJsonBytes = bounds?.maxJsonBytes ?? 8 * 1024 * 1024;
  const built = exportDocument(read);
  if (built === null)
    return {
      status: "unavailable",
      kind: read.kind,
      reason: "Nothing is stored under this source to export.",
    };
  const check = checkJsonLossless(built.document, bounds);
  const partial = (reason: string): EarlierExport => {
    let localJson: string | undefined;
    let localBytes: number | undefined;
    if (built.local.length > 0) {
      const serialized = localOnlyJson(built.local, bounds);
      if (serialized === undefined)
        reason += " The stored local entries are not exportable raw key/value strings.";
      else if (utf8Bytes(serialized) <= maxJsonBytes) {
        localJson = serialized;
        localBytes = utf8Bytes(serialized);
      } else reason += " The local strings alone also exceed the export byte limit.";
    }
    // Local strings that shipped in no payload stay at their live storage
    // keys, so a refused fallback adds them to the retained report.
    const retained =
      localJson === undefined && built.localKeys.length > 0
        ? [...new Set([...built.retained, ...built.localKeys])]
        : built.retained;
    return {
      status: "partial",
      kind: built.kind,
      reason,
      retained,
      ...(localJson === undefined ? {} : { localJson, localBytes }),
    };
  };
  if (!check.ok) return partial(`A complete export was refused: ${check.reason} at ${check.path}.`);
  const json = JSON.stringify(built.document);
  const bytes = utf8Bytes(json);
  if (bytes > maxJsonBytes)
    return partial(
      `A complete export was refused: the document is ${bytes} bytes, over the ${maxJsonBytes}-byte limit.`,
    );
  return { status: "complete", kind: built.kind, json, bytes };
}
