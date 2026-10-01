/**
 * Earlier progress — read-only discovery and inspection of the progress a
 * released build stored at unscoped addresses, plus the durable
 * `legacy-progress/` removal captures the current build writes.
 *
 * A "legacy source" is a raw released storage spelling: a bare project id,
 * or an installed instance's folder/hash spelling (the same spellings a
 * progress target carries as `legacyKeys`). Discovery returns those
 * spellings as *candidates* — they name storage addresses, never
 * identities. Nothing is matched by vocabulary, title or catalog alias, and
 * a source that reads empty stays a candidate its evidence named.
 *
 * Everything reported here is detached storage content: IndexedDB reads
 * hand back structured clones and localStorage reads hand back the exact
 * stored strings. Nothing writes, deletes, bumps an epoch, mints a capture
 * or attaches progress to a body, and a live source's localStorage strings
 * are a separate observation from its IndexedDB records — never claimed
 * atomic with them.
 */
import {
  listLegacyProgressRows,
  readLegacyProgressRow,
  readLegacySourceSnapshot,
  scanLegacyHistoryKeys,
} from "./gameStorage.ts";
import {
  legacyProgressPrefix,
  type CapturedRecord,
  type LegacyProgressRecord,
  type LegacyProgressRow,
  type LegacyProgressRowState,
  type RawLocalEntry,
} from "./legacyProgressRecovery.ts";
import { isProgressNamespace } from "./progressTarget.ts";

/**
 * How one earlier-progress row is read. A `capture` is the immutable record
 * a removal committed — its exact key and timestamp are its identity, and
 * two captures of the same source spelling stay separate. A `live` source is
 * the current storage content under a released unscoped spelling, observed
 * at read time. A `local` row carries exact localStorage keys whose source
 * could not be determined — its strings are still readable as raw data.
 */
export type EarlierSource =
  | { readonly kind: "capture"; readonly recoveryId: string }
  | { readonly kind: "live"; readonly legacyKey: string }
  | { readonly kind: "local"; readonly keys: readonly string[] };

/** The localStorage view reads are made against; injected in tests. */
export interface EarlierLocalSource {
  getItem(key: string): string | null;
  listKeys(): readonly string[];
}

/**
 * One durable removal capture in a listing. `state` is this build's honest
 * read of the row: `available` decodes into a known capture, `unsupported`
 * is a capture envelope of a version this build does not know and
 * `unreadable` holds the prefix without a readable capture — refused rows
 * keep their exact key and stay visible beside readable ones.
 */
export interface EarlierCaptureEntry {
  readonly kind: "capture";
  /** The exact `legacy-progress/<source>/<id>` record key. */
  readonly key: string;
  /**
   * The source spelling this capture observed: the decoded record's own
   * `source` field when readable, the key's `<source>` segment when not —
   * raw spelling preserved, never resolved to an identity.
   */
  readonly source: string | null;
  /** The capture's recorded removal timestamp, when the row decodes. */
  readonly capturedAt: string | null;
  readonly state: LegacyProgressRowState;
}

/**
 * Which discovery avenues observed a live spelling. Point-in-time
 * provenance, not a contents summary: an avenue not listed was not
 * consulted or saw nothing — `readEarlierProgress` reports what is actually
 * stored.
 */
export interface EarlierLiveEvidence {
  /** The caller supplied this spelling as an explicit candidate. */
  readonly candidate?: true | undefined;
  /** Exact localStorage keys under `monotio_agi.autosave.<source>`. */
  readonly autosave?: readonly string[] | undefined;
  /** Exact localStorage keys under `monotio_agi.saves.<encoded source>`. */
  readonly saves?: readonly string[] | undefined;
  /** Exact localStorage keys under `monotio_agi.map.<source>`. */
  readonly map?: readonly string[] | undefined;
  /** `history/<source>` or a `history/<source>/…` descendant record exists. */
  readonly history?: true | undefined;
}

/** A live earlier source spelling observed in browser storage. */
export interface EarlierLiveEntry {
  readonly kind: "live";
  /** The raw storage spelling — a candidate, never an identity match. */
  readonly source: string;
  readonly evidence: EarlierLiveEvidence;
}

/**
 * A localStorage progress key whose source cannot be determined — the
 * released `saves` encoding failed to decode, or the suffix is empty. Its
 * raw key is exact evidence and its stored string is still readable through
 * a `local` source read; nothing guesses at a spelling here.
 */
export interface EarlierLocalEntry {
  readonly kind: "local";
  readonly keys: readonly string[];
  readonly reason: string;
}

export type EarlierEntry = EarlierCaptureEntry | EarlierLiveEntry | EarlierLocalEntry;

export interface EarlierProgressQuery {
  /**
   * Explicit source spellings to surface (a current target's `legacyKeys`,
   * or a structured card context's candidates). Candidates are listed even
   * when nothing is stored under them today. Recognized progress namespace
   * spellings — current `project:`/`installed:` locators and the unreleased
   * folder-only `installed:<digest>` form — are not earlier progress and
   * are filtered out.
   */
  readonly candidates?: readonly string[] | undefined;
  /**
   * List every discovered source — removal captures, live history
   * spellings, observed localStorage progress keys and undecodable local
   * keys. Without it, only `candidates` are listed.
   */
  readonly includeAll?: boolean | undefined;
  /** Entries per page (default 50). */
  readonly limit?: number | undefined;
  /** Opaque resume token from the previous page. */
  readonly cursor?: string | undefined;
  /** The localStorage to observe; defaults to this window's. */
  readonly local?: EarlierLocalSource | undefined;
}

export interface EarlierProgressPage {
  readonly entries: readonly EarlierEntry[];
  /** Present while more entries may follow; feed back as `query.cursor`. */
  readonly cursor?: string | undefined;
}

/** One stored localStorage string observed for a key, or its absence. */
export type EarlierLocalRecord =
  | { readonly key: string; readonly state: "present"; readonly value: string }
  | { readonly key: string; readonly state: "missing" };

/**
 * The honest result of reading one earlier-progress source. A capture read
 * returns the immutable record — `available` carries the decoded capture,
 * `unsupported`/`unreadable` carry the raw stored value untouched and
 * `absent` names a key with nothing stored. A live read returns the
 * source's complete unscoped IndexedDB records (one readonly transaction)
 * plus its localStorage strings (a separate observation, made afterwards —
 * the two stores are never claimed atomic). A `local` read reports each
 * exact key's present raw string or its absence.
 */
export type EarlierRead =
  | {
      readonly kind: "capture";
      readonly key: string;
      readonly state: "available";
      readonly record: LegacyProgressRecord;
    }
  | {
      readonly kind: "capture";
      readonly key: string;
      readonly state: "unsupported" | "unreadable";
      readonly value: unknown;
    }
  | { readonly kind: "capture"; readonly key: string; readonly state: "absent" }
  | {
      readonly kind: "live";
      readonly source: string;
      readonly local: readonly RawLocalEntry[];
      readonly records: readonly CapturedRecord[];
    }
  | { readonly kind: "local"; readonly entries: readonly EarlierLocalRecord[] };

/**
 * The released localStorage progress key families. `autosave` and `map`
 * carry the raw target spelling; `saves` URI-encodes it once
 * (gameSaves.ts's `monotio_agi.saves.${encodeURIComponent(target)}`).
 */
const LOCAL_AUTOSAVE_PREFIX = "monotio_agi.autosave.";
const LOCAL_SAVES_PREFIX = "monotio_agi.saves.";
const LOCAL_MAP_PREFIX = "monotio_agi.map.";

const HISTORY_PREFIX = "history/";

/** Discovery work bounds — page sizes and per-call scan budgets, never storage truncation. */
const HISTORY_KEY_PAGE = 512;
const HISTORY_SCAN_BUDGET = 8192;
const EMITTED_BOUND = 4096;

function defaultLocalSource(): EarlierLocalSource {
  if (typeof localStorage === "undefined") throw new Error("Browser local storage is unavailable.");
  return {
    getItem: (key) => localStorage.getItem(key),
    listKeys: () => Object.keys(localStorage),
  };
}

/** Deterministic listing order: code-point comparison, never locale collation. */
function compareCodePoints(a: string, b: string): number {
  const apoints = Array.from(a);
  const bpoints = Array.from(b);
  const shared = Math.min(apoints.length, bpoints.length);
  for (let i = 0; i < shared; i++) {
    const diff = apoints[i]!.codePointAt(0)! - bpoints[i]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return apoints.length - bpoints.length;
}

interface LocalEvidenceGroup {
  autosave: string[];
  saves: string[];
  map: string[];
}

interface LocalDiscovery {
  /** Decoded source spelling → the exact local keys observed under each family. */
  readonly sources: Map<string, LocalEvidenceGroup>;
  /** Exact keys whose source could not be determined, with the reason. */
  readonly undecodable: { key: string; reason: string }[];
}

/**
 * Enumerate the released localStorage progress prefixes once. The `saves`
 * suffix is URI-decoded exactly once — a failed decode lands in
 * `undecodable` with its exact key, never guessed at. Recognized progress
 * namespace spellings — the current `project:`/`installed:` locators and
 * the unreleased folder-only `installed:<digest>` form — are not earlier
 * progress and are excluded; every other spelling stays exact, case and
 * Unicode included.
 */
function discoverLocal(local: EarlierLocalSource): LocalDiscovery {
  const sources = new Map<string, LocalEvidenceGroup>();
  const undecodable: { key: string; reason: string }[] = [];
  const families = [
    { prefix: LOCAL_AUTOSAVE_PREFIX, family: "autosave" },
    { prefix: LOCAL_SAVES_PREFIX, family: "saves" },
    { prefix: LOCAL_MAP_PREFIX, family: "map" },
  ] as const;
  for (const key of local.listKeys()) {
    const matched = families.find(({ prefix }) => key.startsWith(prefix));
    if (matched === undefined) continue;
    const suffix = key.slice(matched.prefix.length);
    let source = suffix;
    if (matched.family === "saves") {
      try {
        source = decodeURIComponent(suffix);
      } catch {
        undecodable.push({
          key,
          reason: "The stored key's encoded source could not be decoded.",
        });
        continue;
      }
    }
    if (source === "") {
      undecodable.push({ key, reason: "The stored key names no source." });
      continue;
    }
    if (isProgressNamespace(source)) continue;
    const group = sources.get(source) ?? { autosave: [], saves: [], map: [] };
    group[matched.family].push(key);
    sources.set(source, group);
  }
  for (const group of sources.values()) {
    group.autosave.sort(compareCodePoints);
    group.saves.sort(compareCodePoints);
    group.map.sort(compareCodePoints);
  }
  undecodable.sort((a, b) => compareCodePoints(a.key, b.key));
  return { sources, undecodable };
}

/**
 * The source spelling a `history/` record key belongs to. Released sources
 * never contain `/` (a bare project id, a folder name, a hash or an alias
 * spelling), so the first path segment below `history/` is the source:
 * `history/<s>` is its manifest and `history/<s>/next`, `/s/<seg>/<batch>`,
 * `/blob/<hash>` or a future child layout are its descendants. A record
 * whose spelling genuinely contained a slash is reported under its first
 * segment — its data stays reachable through that candidate rather than
 * hidden.
 */
function historySourceCandidate(key: string): string | null {
  const rest = key.slice(HISTORY_PREFIX.length);
  if (rest === "") return null;
  const slash = rest.indexOf("/");
  const source = slash === -1 ? rest : rest.slice(0, slash);
  return source === "" ? null : source;
}

/** The source spelling embedded in a capture record key: `<source>/<id>` after the prefix. */
function sourceFromCaptureKey(key: string): string | null {
  const rest = key.slice(legacyProgressPrefix().length);
  const slash = rest.lastIndexOf("/");
  return slash > 0 ? rest.slice(0, slash) : null;
}

/** The source spelling a capture row claims, whatever its readability. */
function captureRowSource(row: LegacyProgressRow): string | null {
  if (row.state === "available") return row.record.source;
  if (row.state === "absent") return null;
  return sourceFromCaptureKey(row.key);
}

function captureEntry(row: LegacyProgressRow): EarlierCaptureEntry {
  if (row.state === "available")
    return {
      kind: "capture",
      key: row.key,
      source: row.record.source,
      capturedAt: row.record.capturedAt,
      state: "available",
    };
  return {
    kind: "capture",
    key: row.key,
    source: sourceFromCaptureKey(row.key),
    capturedAt: null,
    state: row.state === "absent" ? "unreadable" : row.state,
  };
}

/** Opaque resume state between listing pages. */
interface EarlierProgressCursor {
  readonly v: 1;
  /** Capture stage: last returned row key / candidate index, `capDone` when drained. */
  readonly capAfter?: string | undefined;
  readonly capIdx?: number | undefined;
  readonly capDone?: boolean | undefined;
  /** Live stage: positions in the candidate, local and undecodable lists. */
  readonly candIdx?: number | undefined;
  readonly locIdx?: number | undefined;
  readonly undecIdx?: number | undefined;
  /** History scan: the last raw key consumed, `histDone` once the namespace drained. */
  readonly histAfter?: string | undefined;
  readonly histDone?: boolean | undefined;
  /** Identity tags of entries already emitted — duplicate references never coalesce rows. */
  readonly emitted?: readonly string[] | undefined;
}

function parseEarlierCursor(raw: string | undefined): EarlierProgressCursor {
  if (raw === undefined) return { v: 1 };
  const invalid = (): Error =>
    new Error("This earlier progress cursor could not be read; start the listing again.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
  const p = parsed as Record<string, unknown>;
  if (p["v"] !== 1) throw invalid();
  const cursor: { v: 1 } & Record<string, unknown> = { v: 1 };
  for (const field of ["capAfter", "histAfter"] as const) {
    const value = p[field];
    if (value === undefined) continue;
    if (typeof value !== "string") throw invalid();
    cursor[field] = value;
  }
  for (const field of ["capIdx", "candIdx", "locIdx", "undecIdx"] as const) {
    const value = p[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid();
    cursor[field] = value;
  }
  for (const field of ["capDone", "histDone"] as const) {
    const value = p[field];
    if (value === undefined) continue;
    if (value !== true) throw invalid();
    cursor[field] = value;
  }
  const emitted = p["emitted"];
  if (emitted !== undefined) {
    if (!Array.isArray(emitted) || !emitted.every((entry) => typeof entry === "string"))
      throw invalid();
    cursor["emitted"] = emitted;
  }
  return cursor as EarlierProgressCursor;
}

/**
 * One page of earlier-progress entries: durable removal captures first, then
 * live sources — explicit candidates in supplied order, then localStorage
 * spellings in code-point order, then history spellings in key order — then
 * undecodable local keys. The cursor resumes exactly, including mid-source
 * in the history scan; deduped spellings ride in the cursor so a source
 * whose records straddle a page boundary never lists twice. Bounded work
 * per call: capture rows page by `limit`, the history scan visits at most
 * HISTORY_SCAN_BUDGET raw keys, and the emitted-source set caps at
 * EMITTED_BOUND before listing refuses rather than guessing.
 */
export async function listEarlierProgress(
  query: EarlierProgressQuery = {},
): Promise<EarlierProgressPage> {
  const limit = Math.max(1, Math.floor(query.limit ?? 50));
  const local = query.local ?? defaultLocalSource();
  const browse = query.includeAll === true;
  const state = parseEarlierCursor(query.cursor);

  const candidates: string[] = [];
  for (const raw of query.candidates ?? [])
    if (typeof raw === "string" && raw !== "" && !candidates.includes(raw)) candidates.push(raw);
  const legacyCandidates = candidates.filter((source) => !isProgressNamespace(source));

  const discovery = discoverLocal(local);
  const localSources = [...discovery.sources.keys()].sort(compareCodePoints);
  const emitted = new Set<string>(state.emitted ?? []);
  const entries: EarlierEntry[] = [];

  const claimTag = (tag: string): boolean => {
    if (emitted.has(tag)) return false;
    if (emitted.size >= EMITTED_BOUND)
      throw new Error(
        "Earlier progress discovery exceeded its source bound; narrow the source selection and list again.",
      );
    emitted.add(tag);
    return true;
  };

  const emitLive = (source: string, avenue: EarlierLiveEvidence): void => {
    if (!claimTag(`live${source}`)) return;
    const group = discovery.sources.get(source);
    const evidence: EarlierLiveEvidence = {
      ...avenue,
      ...(group !== undefined && group.autosave.length > 0 ? { autosave: group.autosave } : {}),
      ...(group !== undefined && group.saves.length > 0 ? { saves: group.saves } : {}),
      ...(group !== undefined && group.map.length > 0 ? { map: group.map } : {}),
    };
    entries.push({ kind: "live", source, evidence });
  };

  // Stage 1 — durable removal captures, each row its own entry.
  let capIdx = state.capIdx ?? 0;
  let capDone = state.capDone === true;
  let capAfter = state.capAfter;
  while (!capDone && entries.length < limit) {
    const want = limit - entries.length;
    if (browse) {
      const rows = await listLegacyProgressRows(undefined, {
        ...(capAfter === undefined ? {} : { after: capAfter }),
        limit: want,
      });
      if (rows.length < want) capDone = true;
      if (rows.length === 0) break;
      capAfter = rows[rows.length - 1]!.key;
      for (const row of rows) if (row.state !== "absent") entries.push(captureEntry(row));
    } else {
      if (capIdx >= legacyCandidates.length) {
        capDone = true;
        break;
      }
      const source = legacyCandidates[capIdx]!;
      const rows = await listLegacyProgressRows(source, {
        ...(capAfter === undefined ? {} : { after: capAfter }),
        limit: want,
      });
      if (rows.length < want) {
        capIdx++;
        capAfter = undefined;
      } else {
        capAfter = rows[rows.length - 1]!.key;
      }
      for (const row of rows)
        if (row.state !== "absent" && captureRowSource(row) === source)
          entries.push(captureEntry(row));
    }
  }

  // Stage 2 — live earlier sources: candidates, then local-only spellings,
  // then a bounded slice of the raw history keyspace.
  let candIdx = capDone ? (state.candIdx ?? 0) : 0;
  let locIdx = state.locIdx ?? 0;
  let undecIdx = state.undecIdx ?? 0;
  let histAfter = state.histAfter;
  let histDone = state.histDone === true;
  if (capDone) {
    while (candIdx < legacyCandidates.length && entries.length < limit) {
      emitLive(legacyCandidates[candIdx]!, { candidate: true });
      candIdx++;
    }
    if (browse) {
      while (locIdx < localSources.length && entries.length < limit) {
        emitLive(localSources[locIdx]!, {});
        locIdx++;
      }
      let scanned = 0;
      while (!histDone && entries.length < limit && scanned < HISTORY_SCAN_BUDGET) {
        const page = await scanLegacyHistoryKeys(
          histAfter === undefined ? undefined : { after: histAfter },
          { limit: HISTORY_KEY_PAGE },
        );
        scanned += page.keys.length;
        let early = false;
        for (const key of page.keys) {
          if (entries.length >= limit) {
            early = true;
            break;
          }
          histAfter = key;
          const source = historySourceCandidate(key);
          if (source !== null && !isProgressNamespace(source)) emitLive(source, { history: true });
        }
        // The namespace is done only when this was its last page and every
        // key on it was consumed — an early exit leaves the drained tail to
        // the next page, which resumes at the last key actually processed.
        histDone = page.after === undefined && !early;
      }
      const undecodable = discovery.undecodable;
      while (undecIdx < undecodable.length && entries.length < limit) {
        const row = undecodable[undecIdx]!;
        undecIdx++;
        if (claimTag(`local${row.key}`))
          entries.push({ kind: "local", keys: [row.key], reason: row.reason });
      }
    }
  }

  const more =
    !capDone ||
    (browse
      ? candIdx < legacyCandidates.length ||
        locIdx < localSources.length ||
        undecIdx < discovery.undecodable.length ||
        !histDone
      : candIdx < legacyCandidates.length);

  if (!more) return { entries };
  const cursor: EarlierProgressCursor = {
    v: 1,
    ...(capAfter === undefined ? {} : { capAfter }),
    capIdx,
    ...(capDone ? { capDone: true } : {}),
    candIdx,
    locIdx,
    undecIdx,
    ...(histAfter === undefined ? {} : { histAfter }),
    ...(histDone ? { histDone: true } : {}),
    emitted: [...emitted],
  };
  return { entries, cursor: JSON.stringify(cursor) };
}

/**
 * The exact localStorage progress strings stored for one source spelling —
 * every observed key under the three released prefixes whose decoded or raw
 * suffix is this source, in code-point key order, raw values untouched.
 */
function localEntriesFor(source: string, local: EarlierLocalSource): RawLocalEntry[] {
  const found: RawLocalEntry[] = [];
  const families = [
    { prefix: LOCAL_AUTOSAVE_PREFIX, encoded: false },
    { prefix: LOCAL_SAVES_PREFIX, encoded: true },
    { prefix: LOCAL_MAP_PREFIX, encoded: false },
  ];
  for (const key of local.listKeys()) {
    const matched = families.find(({ prefix }) => key.startsWith(prefix));
    if (matched === undefined) continue;
    const suffix = key.slice(matched.prefix.length);
    let candidate = suffix;
    if (matched.encoded) {
      try {
        candidate = decodeURIComponent(suffix);
      } catch {
        continue;
      }
    }
    if (candidate !== source) continue;
    const value = local.getItem(key);
    if (value !== null) found.push({ key, value });
  }
  found.sort((a, b) => compareCodePoints(a.key, b.key));
  return found;
}

/**
 * Read one earlier-progress source exactly as stored — read-only, and each
 * failure propagates so a caller can retry rather than seeing missing data.
 * A capture read consults only its record key, independent of any live body.
 * A live read observes the source's complete unscoped IndexedDB records in
 * one readonly transaction (history head plus every descendant — `/next`
 * timelines, orphans, unknown layouts — and its conversation and lifetime
 * records), then its localStorage strings separately.
 */
export async function readEarlierProgress(
  source: EarlierSource,
  options?: { local?: EarlierLocalSource },
): Promise<EarlierRead> {
  if (source.kind === "capture") {
    const row = await readLegacyProgressRow(source.recoveryId);
    if (row.state === "available")
      return { kind: "capture", key: row.key, state: "available", record: row.record };
    if (row.state === "absent") return { kind: "capture", key: row.key, state: "absent" };
    return { kind: "capture", key: row.key, state: row.state, value: row.value };
  }
  if (source.kind === "local") {
    const local = options?.local ?? defaultLocalSource();
    const entries: EarlierLocalRecord[] = [];
    for (const key of source.keys) {
      const value = local.getItem(key);
      entries.push(value === null ? { key, state: "missing" } : { key, state: "present", value });
    }
    return { kind: "local", entries };
  }
  // The snapshot's locator check runs before localStorage is touched: a
  // source naming current progress refuses on its own, and the local
  // strings stay a separate, never-atomic observation.
  const snapshot = await readLegacySourceSnapshot(source.legacyKey);
  const local = options?.local ?? defaultLocalSource();
  return {
    kind: "live",
    source: snapshot.source,
    local: localEntriesFor(source.legacyKey, local),
    records: snapshot.records,
  };
}
