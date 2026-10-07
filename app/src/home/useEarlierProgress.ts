/**
 * The Details dialog's "Earlier progress" controller: a bounded listing of the
 * sources earlierProgress.ts discovers, the pinned read of the selected one,
 * and the download the export adapter proved exact.
 *
 * Both storage adapters load through dynamic `import()` on first use, so
 * discovery and export code stays off the Play boot path; tests inject `hooks`
 * to drive fakes and `local` to supply a storage view. Everything is
 * read-only — context changes, dialog close, a new selection and scope
 * disposal retire in-flight work through generations, and each await
 * re-checks ownership before publishing. The selected read is the snapshot a
 * download ships until Refresh explicitly re-reads it.
 */
import { onScopeDispose, ref, shallowRef, watch, type WatchSource } from "vue";
import {
  legacyProgressPrefix,
  type CapturedRecord,
  type RawLocalEntry,
} from "../project/legacyProgressRecovery.ts";
import { listenForProjectWrites } from "../project/projectBroadcast.ts";
import { parseAutosaveRecord } from "../saves/gameProgress.ts";
import { readGameSaves } from "../saves/gameSaves.ts";
import { readMapSidecar } from "../world/roomMapStore.ts";
import type { EarlierDetailsContext } from "./cardDetails.ts";
import type {
  EarlierEntry,
  EarlierLocalSource,
  EarlierProgressPage,
  EarlierProgressQuery,
  EarlierRead,
  EarlierSource,
} from "../project/earlierProgress.ts";
import type { EarlierExport } from "../project/earlierProgressExport.ts";

/** The adapter surface; tests replace any leg, the app loads the real modules lazily. */
export interface EarlierProgressHooks {
  listEarlierProgress?: (query: EarlierProgressQuery) => Promise<EarlierProgressPage>;
  readEarlierProgress?: (
    source: EarlierSource,
    options?: { local?: EarlierLocalSource },
  ) => Promise<EarlierRead>;
  exportEarlierProgress?: (read: EarlierRead) => EarlierExport;
}

interface EarlierProgressAdapters {
  listEarlierProgress: NonNullable<EarlierProgressHooks["listEarlierProgress"]>;
  readEarlierProgress: NonNullable<EarlierProgressHooks["readEarlierProgress"]>;
  exportEarlierProgress: NonNullable<EarlierProgressHooks["exportEarlierProgress"]>;
}

let realAdapters: Promise<EarlierProgressAdapters> | undefined;

function loadAdapters(): Promise<EarlierProgressAdapters> {
  realAdapters ??= Promise.all([
    import("../project/earlierProgress.ts"),
    import("../project/earlierProgressExport.ts"),
  ]).then(([progress, exporter]) => ({
    listEarlierProgress: progress.listEarlierProgress,
    readEarlierProgress: progress.readEarlierProgress,
    exportEarlierProgress: exporter.exportEarlierProgress,
  }));
  return realAdapters;
}

function resolveAdapters(hooks?: EarlierProgressHooks): Promise<EarlierProgressAdapters> {
  if (hooks?.listEarlierProgress && hooks.readEarlierProgress && hooks.exportEarlierProgress)
    return Promise.resolve({
      listEarlierProgress: hooks.listEarlierProgress,
      readEarlierProgress: hooks.readEarlierProgress,
      exportEarlierProgress: hooks.exportEarlierProgress,
    });
  return loadAdapters().then((real) => ({
    listEarlierProgress: hooks?.listEarlierProgress ?? real.listEarlierProgress,
    readEarlierProgress: hooks?.readEarlierProgress ?? real.readEarlierProgress,
    exportEarlierProgress: hooks?.exportEarlierProgress ?? real.exportEarlierProgress,
  }));
}

function describe(error: unknown): string {
  return String(error).replace(/^Error: /, "");
}

/** The source an entry names — the spelling a row carries is context, never an identity. */
export function earlierEntrySource(entry: EarlierEntry): EarlierSource {
  switch (entry.kind) {
    case "capture":
      return { kind: "capture", recoveryId: entry.key };
    case "live":
      return { kind: "live", legacyKey: entry.source };
    case "local":
      return { kind: "local", keys: entry.keys };
  }
}

/** A stable identity for row keys and selection comparison. */
export function earlierSourceTag(source: EarlierSource): string {
  switch (source.kind) {
    case "capture":
      return `capture ${source.recoveryId}`;
    case "live":
      return `live ${source.legacyKey}`;
    case "local":
      return `local ${source.keys.join("\n")}`;
  }
}

/**
 * The selected source's read state. `ready` pins the read and the export
 * result it produced — Refresh is the only way to observe newer storage, and
 * a download ships exactly this snapshot.
 */
export interface EarlierSelection {
  readonly source: EarlierSource;
  readonly state: "reading" | "ready" | "failed";
  readonly read?: EarlierRead | undefined;
  readonly exportResult?: EarlierExport | undefined;
  readonly error?: string | undefined;
}

const UNSAFE_FILENAME = /[^A-Za-z0-9._-]+/g;

function filenameTag(source: EarlierSource): string {
  const raw =
    source.kind === "capture"
      ? source.recoveryId.slice(legacyProgressPrefix().length)
      : source.kind === "live"
        ? source.legacyKey
        : "";
  return raw
    .replace(UNSAFE_FILENAME, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** A download name that says what it is, disambiguated by the source spelling. */
export function earlierDownloadName(source: EarlierSource | undefined, local = false): string {
  const tag = source === undefined ? "" : filenameTag(source);
  return `earlier-progress-data${tag ? `-${tag}` : ""}${local ? "-local" : ""}.json`;
}

/**
 * What one pinned read holds, in plain words: component labels established by
 * the released parsers (a parseable checkpoint, counted save slots, a valid
 * map), the IndexedDB record families by their released key spelling, and
 * "Stored data" for everything else — never a JSON dump of an opaque value.
 */
export interface EarlierReadSummary {
  readonly parts: readonly string[];
  readonly missing: readonly string[];
}

export function summarizeEarlierRead(read: EarlierRead): EarlierReadSummary {
  let checkpoint = false;
  let saves = 0;
  let map = false;
  let history = false;
  let conversation = false;
  let lifetime = false;
  let opaque = 0;
  const missing: string[] = [];

  const localEntry = (entry: RawLocalEntry): void => {
    if (entry.key.startsWith("monotio_agi.autosave.")) {
      if (parseAutosaveRecord(entry.value) === null) opaque++;
      else checkpoint = true;
    } else if (entry.key.startsWith("monotio_agi.saves.")) {
      try {
        saves += Object.keys(
          readGameSaves({ getItem: () => entry.value, setItem: () => {} }, "_"),
        ).length;
      } catch {
        opaque++;
      }
    } else if (entry.key.startsWith("monotio_agi.map.")) {
      try {
        readMapSidecar({ getItem: () => entry.value }, "_");
        map = true;
      } catch {
        opaque++;
      }
    } else opaque++;
  };

  const recordEntry = (entry: CapturedRecord): void => {
    if (entry.key.startsWith("history/")) history = true;
    else if (entry.key.startsWith("conversation/")) conversation = true;
    else if (entry.key.startsWith("lifetime/")) lifetime = true;
    else opaque++;
  };

  switch (read.kind) {
    case "capture":
      if (read.state === "available") {
        for (const entry of read.record.local) localEntry(entry);
        for (const entry of read.record.records) recordEntry(entry);
      }
      break;
    case "live":
      for (const entry of read.local) localEntry(entry);
      for (const entry of read.records) recordEntry(entry);
      break;
    case "local":
      for (const entry of read.entries) {
        if (entry.state === "missing") missing.push(entry.key);
        else localEntry({ key: entry.key, value: entry.value });
      }
      break;
  }

  const parts: string[] = [];
  if (checkpoint) parts.push("Checkpoint");
  if (saves > 0) parts.push(saves === 1 ? "1 save" : `${saves} saves`);
  if (map) parts.push("Map");
  if (history) parts.push("History");
  if (conversation) parts.push("Conversation");
  if (lifetime) parts.push("Lifetime record");
  if (opaque > 0) parts.push("Stored data");
  return { parts, missing };
}

/** What the section renders for one pinned read; all strings are user-facing. */
export interface EarlierReadView {
  /** "Saved when removed" · "Earlier progress" · "From another version" · "Stored data". */
  readonly heading: string;
  /** Label/value pairs; a `mono` third element marks a support-sized code value. */
  readonly facts: readonly (readonly [term: string, value: string, mono?: boolean])[];
  /** The component summary, or the empty/missing statement. */
  readonly summary: string;
  readonly missing: readonly string[];
  readonly canDownload: boolean;
  readonly canDownloadLocal: boolean;
  readonly exportNote: string | undefined;
  /** The exporter's technical refusal line, kept inside the Stored items disclosure. */
  readonly exportDetail: string | undefined;
  readonly retained: readonly string[];
}

export function describeEarlierSelection(
  selection: EarlierSelection,
  removedAt: (capturedAt: string) => string,
): EarlierReadView | undefined {
  const read = selection.read;
  if (!read || selection.state !== "ready") return undefined;

  const facts: [string, string, boolean?][] = [];
  let heading = "Stored data";
  if (read.kind === "capture") {
    if (read.state === "available") heading = "Saved when removed";
    else if (read.state === "unsupported") heading = "From another version";
    facts.push(["Stored as", read.key, true]);
    if (read.state === "available") {
      facts.push(["Earlier name", read.record.source]);
      facts.push(["Removed", removedAt(read.record.capturedAt)]);
    }
  } else if (read.kind === "live") {
    heading = "Earlier progress";
    facts.push(["Earlier name", read.source]);
  }

  if (read.kind === "capture" && read.state === "absent")
    return {
      heading,
      facts,
      summary: "Missing capture.",
      missing: [],
      canDownload: false,
      canDownloadLocal: false,
      exportNote: undefined,
      exportDetail: undefined,
      retained: [],
    };

  const { parts, missing } = summarizeEarlierRead(read);
  // Empty parser parts prove emptiness only for a capture this build decoded;
  // an opaque capture's value is stored data either way.
  const summary = parts.length
    ? parts.join(" · ")
    : read.kind === "capture"
      ? read.state === "available"
        ? "Empty capture."
        : "Stored data"
      : read.kind === "local"
        ? "Empty stored items."
        : "Empty entry.";

  const result = selection.exportResult;
  const canDownload = result?.status === "complete" && result.json !== undefined;
  const canDownloadLocal = result?.status === "partial" && result.localJson !== undefined;
  const retained = result?.status === "partial" ? (result.retained ?? []) : [];
  const exportNote =
    result?.status === "partial"
      ? result.localJson !== undefined
        ? "Part of this progress fits in a file. The rest stays in this browser."
        : "This progress stays in this browser."
      : undefined;
  const exportDetail = result?.status === "partial" ? result.reason : undefined;

  return {
    heading,
    facts,
    summary,
    missing,
    canDownload,
    canDownloadLocal,
    exportNote,
    exportDetail,
    retained,
  };
}

/**
 * Listing, reading and download state for one Earlier progress section. The
 * getter supplies the current context; a new context resets the section.
 */
export function useEarlierProgress(
  context: () => EarlierDetailsContext | undefined,
  options?: {
    local?: EarlierLocalSource | undefined;
    pageSize?: number;
    hooks?: EarlierProgressHooks | undefined;
  },
) {
  const entries = shallowRef<readonly EarlierEntry[]>([]);
  const listing = ref(false);
  const listError = ref("");
  const hasMore = ref(false);
  const selected = shallowRef<EarlierSelection>();
  /** The line shown under the actions after a download ships. */
  const notice = ref("");

  let cursor: string | undefined;
  let baseQuery: Pick<EarlierProgressQuery, "candidates" | "includeAll"> = {};
  let generation = 0;
  let readGeneration = 0;
  let disposed = false;

  const owns = (gen: number) => !disposed && gen === generation;
  const ownsRead = (gen: number) => !disposed && gen === readGeneration;
  const localOption = () => (options?.local === undefined ? undefined : { local: options.local });

  async function runList(gen: number, resume: string | undefined): Promise<void> {
    listing.value = true;
    listError.value = "";
    try {
      const api = await resolveAdapters(options?.hooks);
      if (!owns(gen)) return;
      const page = await api.listEarlierProgress({
        ...baseQuery,
        limit: options?.pageSize ?? 50,
        ...(resume === undefined ? {} : { cursor: resume }),
        ...(localOption() ?? {}),
      });
      if (!owns(gen)) return;
      entries.value = resume === undefined ? page.entries : [...entries.value, ...page.entries];
      cursor = page.cursor;
      hasMore.value = cursor !== undefined;
    } catch (error) {
      if (!owns(gen)) return;
      listError.value = describe(error);
    } finally {
      if (owns(gen)) listing.value = false;
    }
  }

  function retryList(): void {
    if (listing.value) return;
    void runList(generation, undefined);
  }

  function loadMore(): void {
    if (listing.value || cursor === undefined) return;
    void runList(generation, cursor);
  }

  function selectSource(source: EarlierSource): void {
    const gen = ++readGeneration;
    notice.value = "";
    selected.value = { source, state: "reading" };
    void runRead(gen, source);
  }

  function selectEntry(entry: EarlierEntry): void {
    selectSource(earlierEntrySource(entry));
  }

  async function runRead(gen: number, source: EarlierSource): Promise<void> {
    try {
      const api = await resolveAdapters(options?.hooks);
      if (!ownsRead(gen)) return;
      const read = await api.readEarlierProgress(source, localOption());
      if (!ownsRead(gen)) return;
      const exportResult = api.exportEarlierProgress(read);
      if (!ownsRead(gen)) return;
      selected.value = { source, state: "ready", read, exportResult };
    } catch (error) {
      if (!ownsRead(gen)) return;
      selected.value = { source, state: "failed", error: describe(error) };
    }
  }

  /** The only way a ready selection observes newer storage. */
  function refreshSelected(): void {
    const sel = selected.value;
    if (sel) selectSource(sel.source);
  }

  /** The pinned snapshot as a download payload, or null when nothing ships. */
  function selectionDownload(): { name: string; text: string } | null {
    const sel = selected.value;
    const result = sel?.exportResult;
    if (sel?.state !== "ready" || result?.status !== "complete" || result.json === undefined)
      return null;
    return { name: earlierDownloadName(sel.source), text: result.json };
  }

  /** The refused export's local-only payload, or null when none was proven. */
  function localDownload(): { name: string; text: string } | null {
    const sel = selected.value;
    const result = sel?.exportResult;
    if (sel?.state !== "ready" || result?.status !== "partial" || result.localJson === undefined)
      return null;
    return { name: earlierDownloadName(sel.source, true), text: result.localJson };
  }

  function deliver(file: { name: string; text: string }, note: string): void {
    const url = URL.createObjectURL(new Blob([file.text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
    notice.value = note;
  }

  function downloadSelection(): void {
    const file = selectionDownload();
    if (file) deliver(file, `Downloaded ${file.name}. This progress stays in this browser.`);
  }

  function downloadLocalSelection(): void {
    const file = localDownload();
    if (file) deliver(file, `Downloaded ${file.name}. The rest stays in this browser.`);
  }

  watch(
    context,
    (ctx) => {
      generation++;
      readGeneration++;
      cursor = undefined;
      baseQuery = {};
      entries.value = [];
      listError.value = "";
      hasMore.value = false;
      selected.value = undefined;
      notice.value = "";
      if (ctx === undefined) {
        listing.value = false;
        return;
      }
      if (ctx.kind === "capture") {
        listing.value = false;
        selectSource({ kind: "capture", recoveryId: ctx.recoveryId });
        return;
      }
      baseQuery = ctx.kind === "all" ? { includeAll: true } : { candidates: ctx.candidates };
      void runList(generation, undefined);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    disposed = true;
    generation++;
    readGeneration++;
  });

  return {
    entries,
    listing,
    listError,
    hasMore,
    selected,
    notice,
    retryList,
    loadMore,
    selectEntry,
    refreshSelected,
    selectionDownload,
    localDownload,
    downloadSelection,
    downloadLocalSelection,
  };
}

/** Whether the shelf footer offers the Earlier progress link. */
export type EarlierPresence = "checking" | "present" | "empty" | "failed";

/**
 * Presence scans follow the real cursor past empty pages — the adapter can
 * spend a page's scan budget without emitting a row — until the first row or
 * the genuine end; a bound on pages keeps a runaway cursor an honest error.
 */
const PRESENCE_PAGE_BOUND = 32;

/**
 * The footer's presence check: one bounded includeAll listing per trigger —
 * mount, the watched library state, a `storage` event or another tab's
 * project write. No polling, and every result is visible or retryable.
 */
export function useEarlierProgressPresence(
  notify: WatchSource<unknown>,
  options?: {
    local?: EarlierLocalSource | undefined;
    hooks?: EarlierProgressHooks | undefined;
  },
) {
  const presence = shallowRef<EarlierPresence>("checking");
  const presenceError = ref("");
  let run = 0;
  let disposed = false;

  async function check(): Promise<void> {
    const token = ++run;
    presence.value = "checking";
    presenceError.value = "";
    try {
      const listEarlierProgress =
        options?.hooks?.listEarlierProgress ??
        (await import("../project/earlierProgress.ts")).listEarlierProgress;
      let cursor: string | undefined;
      for (let page = 0; page < PRESENCE_PAGE_BOUND; page++) {
        const result = await listEarlierProgress({
          includeAll: true,
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
          ...(options?.local === undefined ? {} : { local: options.local }),
        });
        if (disposed || token !== run) return;
        if (result.entries.length > 0) {
          presence.value = "present";
          return;
        }
        if (result.cursor === undefined) {
          presence.value = "empty";
          return;
        }
        cursor = result.cursor;
      }
      throw new Error("The earlier progress check did not finish. Try again.");
    } catch (error) {
      if (disposed || token !== run) return;
      presence.value = "failed";
      presenceError.value = describe(error);
    }
  }

  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key.startsWith("monotio_agi.")) void check();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  const unsubscribe = listenForProjectWrites(() => void check());
  watch(notify, () => void check());
  onScopeDispose(() => {
    disposed = true;
    run++;
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    unsubscribe();
  });
  void check();

  return { presence, presenceError, retryPresence: check };
}
