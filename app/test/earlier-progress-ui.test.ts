/**
 * Earlier-progress UI controller tests — the Details dialog section's async
 * ownership (generations retire stale list/read work), the pinned snapshot a
 * download ships, cursor-following presence, and the summaries built from
 * released parsers. Storage facts come from the fake IndexedDB fixture plus
 * an injected localStorage view; timing legwork uses injected adapter hooks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { effectScope, ref, type Ref } from "vue";
import {
  describeEarlierSelection,
  earlierDownloadName,
  earlierEntrySource,
  summarizeEarlierRead,
  useEarlierProgress,
  useEarlierProgressPresence,
  type EarlierProgressHooks,
} from "../src/home/useEarlierProgress.ts";
import type { EarlierDetailsContext } from "../src/home/cardDetails.ts";
import { newLegacyProgressRecord } from "../src/project/legacyProgressRecovery.ts";
import { emptyMapSidecar } from "../src/world/roomMapStore.ts";
import { serializeMapSidecar } from "../../src/agent/roomMap.ts";
import type {
  EarlierLocalSource,
  EarlierProgressPage,
  EarlierProgressQuery,
  EarlierRead,
  EarlierSource,
} from "../src/project/earlierProgress.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

const RECORDS = installIndexedDbFixture();
const localValues = new Map<string, string>();
const local: EarlierLocalSource = {
  getItem: (key) => localValues.get(key) ?? null,
  listKeys: () => [...localValues.keys()],
};

const AUTOSAVE_VALUE = JSON.stringify({
  format: "monotio.agi.autosave",
  version: 1,
  image: "AA==",
  room: 3,
  cycle: 12,
  savedAt: 1_700_000_000_000,
  game: { installed: false, identity: { project: "floppy-era", revision: "a".repeat(64) } },
});
const SAVES_VALUE = JSON.stringify({
  format: "monotio.agi.saves",
  version: 1,
  slots: { "1": "AA==", "3": "BB==" },
});
const MAP_VALUE = JSON.stringify(serializeMapSidecar(emptyMapSidecar()));

const clearStores = (): void => {
  RECORDS.clear();
  localValues.clear();
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function settle(turns = 40): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await settle(1);
  assert.ok(condition());
}

const futureCapture = (tag: string): Record<string, unknown> => ({
  format: "monotio.agi.legacy-progress",
  version: 99,
  tag,
  nested: { deep: [1, "two"] },
});

function controller(
  ctx: Ref<EarlierDetailsContext | undefined>,
  hooks?: EarlierProgressHooks,
): { scope: ReturnType<typeof effectScope>; ctrl: ReturnType<typeof useEarlierProgress> } {
  const scope = effectScope();
  const ctrl = scope.run(() => useEarlierProgress(() => ctx.value, { local, hooks }))!;
  return { scope, ctrl };
}

function sourceKey(source: EarlierSource): string {
  return source.kind === "capture"
    ? source.recoveryId
    : source.kind === "live"
      ? source.legacyKey
      : source.keys.join("\n");
}

test("a slow read retired by a newer selection never publishes", async () => {
  clearStores();
  RECORDS.set("history/tape-a", { format: "monotio.agi.stored-history", version: 1 });
  RECORDS.set("history/tape-b", { format: "monotio.agi.stored-history", version: 1 });
  const calls = new Map<string, (read: EarlierRead) => void>();
  const hooks: EarlierProgressHooks = {
    readEarlierProgress: (source: EarlierSource) => {
      const gate = deferred<EarlierRead>();
      calls.set(sourceKey(source), gate.resolve);
      return gate.promise;
    },
  };

  const ctx = ref<EarlierDetailsContext | undefined>({ kind: "all" });
  const { scope, ctrl } = controller(ctx, hooks);
  await settle();
  const [first, second] = ctrl.entries.value;
  assert.ok(first && second);

  ctrl.selectEntry(first);
  await waitFor(() => calls.size === 1);
  ctrl.selectEntry(second);
  await waitFor(() => calls.size === 2);
  assert.equal(ctrl.selected.value?.state, "reading");

  // The newer selection answers while the older read is still pending.
  calls.get(sourceKey(earlierEntrySource(second)))!({
    kind: "live",
    source: "tape-b",
    local: [],
    records: [{ key: "history/tape-b", value: { note: "b" } }],
  });
  await settle();
  assert.equal(ctrl.selected.value?.state, "ready");
  const landed = ctrl.selected.value?.read;
  assert.ok(landed?.kind === "live" && landed.source === "tape-b");

  // The retired read answers late; the pinned snapshot stays.
  calls.get(sourceKey(earlierEntrySource(first)))!({
    kind: "live",
    source: "tape-a",
    local: [],
    records: [{ key: "history/tape-a", value: { note: "a" } }],
  });
  await settle();
  const still = ctrl.selected.value?.read;
  assert.ok(still?.kind === "live" && still.source === "tape-b");
  scope.stop();
});

test("a slow read retired by a context change never publishes", async () => {
  clearStores();
  RECORDS.set("history/tape-a", { format: "monotio.agi.stored-history", version: 1 });
  const gate = deferred<EarlierRead>();
  const hooks: EarlierProgressHooks = { readEarlierProgress: () => gate.promise };

  const ctx = ref<EarlierDetailsContext | undefined>({ kind: "all" });
  const { scope, ctrl } = controller(ctx, hooks);
  await settle();
  ctrl.selectEntry(ctrl.entries.value[0]!);
  await settle(4);
  assert.equal(ctrl.selected.value?.state, "reading");

  ctx.value = { kind: "candidates", candidates: ["elsewhere"] };
  await settle();
  gate.resolve({
    kind: "live",
    source: "tape-a",
    local: [],
    records: [{ key: "history/tape-a", value: {} }],
  });
  await settle();
  const read = ctrl.selected.value?.read;
  assert.ok(read === undefined || (read.kind === "live" && read.source === "elsewhere"));
  scope.stop();
});

test("a pending read retired by scope disposal never publishes", async () => {
  clearStores();
  RECORDS.set("history/tape-a", { format: "monotio.agi.stored-history", version: 1 });
  const gate = deferred<EarlierRead>();
  const hooks: EarlierProgressHooks = { readEarlierProgress: () => gate.promise };

  const ctx = ref<EarlierDetailsContext | undefined>({ kind: "all" });
  const { scope, ctrl } = controller(ctx, hooks);
  await settle();
  ctrl.selectEntry(ctrl.entries.value[0]!);
  await settle(4);
  scope.stop();
  gate.resolve({
    kind: "live",
    source: "tape-a",
    local: [],
    records: [{ key: "history/tape-a", value: {} }],
  });
  await settle();
  assert.equal(ctrl.selected.value?.state, "reading");
});

test("a slow list page retired by a context change never replaces the new listing", async () => {
  clearStores();
  const first = deferred<EarlierProgressPage>();
  let calls = 0;
  const hooks: EarlierProgressHooks = {
    listEarlierProgress: async () =>
      calls++ === 0
        ? first.promise
        : { entries: [{ kind: "live", source: "tape-b", evidence: {} }], cursor: undefined },
  };

  const ctx = ref<EarlierDetailsContext | undefined>({ kind: "all" });
  const { scope, ctrl } = controller(ctx, hooks);
  await settle(2);
  ctx.value = { kind: "candidates", candidates: ["tape-b"] };
  await settle();
  assert.deepEqual(
    ctrl.entries.value.map((entry) => (entry.kind === "live" ? entry.source : entry.kind)),
    ["tape-b"],
  );

  first.resolve({ entries: [], cursor: undefined });
  await settle();
  assert.deepEqual(
    ctrl.entries.value.map((entry) => (entry.kind === "live" ? entry.source : entry.kind)),
    ["tape-b"],
  );
  scope.stop();
});

test("readable and opaque captures list side by side; the opaque one still downloads", async () => {
  clearStores();
  const known = newLegacyProgressRecord(
    "disk-box",
    [],
    [{ key: "history/disk-box", value: { format: "x", version: 1 } }],
  );
  RECORDS.set(known.projectId, known);
  RECORDS.set("legacy-progress/mystery/future-1", futureCapture("ahead"));

  const ctx = ref<EarlierDetailsContext | undefined>({ kind: "all" });
  const { scope, ctrl } = controller(ctx);
  await settle();
  const states = ctrl.entries.value.map((entry) =>
    entry.kind === "capture" ? entry.state : entry.kind,
  );
  assert.deepEqual(states.sort(), ["available", "unsupported"]);

  const opaque = ctrl.entries.value.find(
    (entry) => entry.kind === "capture" && entry.state === "unsupported",
  );
  assert.ok(opaque);
  ctrl.selectEntry(opaque);
  await settle();
  const read = ctrl.selected.value?.read;
  assert.equal(read?.kind, "capture");
  assert.equal(read?.state, "unsupported");

  const view = describeEarlierSelection(ctrl.selected.value!, () => "then");
  // An opaque capture's value is unparsed, never proven empty.
  assert.equal(view?.summary, "Stored data");
  assert.equal(view?.heading, "From another version");
  assert.equal(view?.canDownload, true);

  const file = ctrl.selectionDownload();
  assert.ok(file);
  assert.equal(file.name, "earlier-progress-data-mystery-future-1.json");
  const parsed = JSON.parse(file.text) as { value: { tag: string; nested: { deep: unknown[] } } };
  assert.equal(parsed.value.tag, "ahead");
  assert.deepEqual(parsed.value.nested.deep, [1, "two"]);
  scope.stop();
});

test("a pinned read is the snapshot a download ships until Refresh re-reads", async () => {
  clearStores();
  RECORDS.set("history/tape-a", { format: "monotio.agi.stored-history", version: 1, n: 1 });
  const ctx = ref<EarlierDetailsContext | undefined>({ kind: "all" });
  const { scope, ctrl } = controller(ctx);
  await settle();
  ctrl.selectEntry(ctrl.entries.value[0]!);
  await settle();

  const first = ctrl.selectionDownload();
  assert.ok(first);
  assert.equal(first.name, "earlier-progress-data-tape-a.json");

  // Newer storage does not leak into the pinned snapshot.
  RECORDS.set("history/tape-a/extra", { format: "x", version: 1, n: 2 });
  const again = ctrl.selectionDownload();
  assert.equal(again?.text, first.text);
  assert.ok(!first.text.includes("tape-a/extra"));

  ctrl.refreshSelected();
  await settle();
  const refreshed = ctrl.selectionDownload();
  assert.ok(refreshed);
  assert.notEqual(refreshed.text, first.text);
  assert.ok(refreshed.text.includes("tape-a/extra"));
  scope.stop();
});

test("load more follows the opaque cursor past an empty page", async () => {
  clearStores();
  const queries: EarlierProgressQuery[] = [];
  const hooks: EarlierProgressHooks = {
    listEarlierProgress: async (query) => {
      queries.push(query);
      if (query.cursor === undefined) return { entries: [], cursor: "opaque-token" };
      return {
        entries: [{ kind: "live", source: "late-tape", evidence: { history: true } }],
        cursor: undefined,
      };
    },
  };
  const ctx = ref<EarlierDetailsContext | undefined>({ kind: "all" });
  const { scope, ctrl } = controller(ctx, hooks);
  await settle();
  assert.equal(ctrl.entries.value.length, 0);
  assert.equal(ctrl.hasMore.value, true);

  ctrl.loadMore();
  await settle();
  assert.equal(queries[1]?.cursor, "opaque-token");
  assert.deepEqual(
    ctrl.entries.value.map((entry) => (entry.kind === "live" ? entry.source : entry.kind)),
    ["late-tape"],
  );
  assert.equal(ctrl.hasMore.value, false);
  scope.stop();
});

test("a list failure stays a visible error until Retry succeeds", async () => {
  clearStores();
  let fail = true;
  const hooks: EarlierProgressHooks = {
    listEarlierProgress: async () => {
      if (fail) throw new Error("A storage scan was refused.");
      return { entries: [{ kind: "live", source: "back", evidence: {} }], cursor: undefined };
    },
  };
  const ctx = ref<EarlierDetailsContext | undefined>({ kind: "all" });
  const { scope, ctrl } = controller(ctx, hooks);
  await settle();
  assert.equal(ctrl.listError.value, "A storage scan was refused.");
  assert.equal(ctrl.entries.value.length, 0);

  fail = false;
  ctrl.retryList();
  await settle();
  assert.equal(ctrl.listError.value, "");
  assert.equal(ctrl.entries.value.length, 1);
  scope.stop();
});

test("a missing capture stays a visible, honest result", async () => {
  clearStores();
  const ctx = ref<EarlierDetailsContext | undefined>({
    kind: "capture",
    recoveryId: "legacy-progress/gone/never-stored",
  });
  const { scope, ctrl } = controller(ctx);
  await settle();
  const sel = ctrl.selected.value;
  assert.equal(sel?.state, "ready");
  assert.equal(sel?.read?.kind, "capture");
  assert.equal(sel?.read?.state, "absent");
  const view = describeEarlierSelection(sel!, () => "then");
  assert.equal(view?.summary, "Missing capture.");
  assert.equal(view?.canDownload, false);
  scope.stop();
});

test("a read failure stays a visible error until Retry succeeds", async () => {
  clearStores();
  RECORDS.set("history/tape-a", { format: "monotio.agi.stored-history", version: 1 });
  let fail = true;
  const hooks: EarlierProgressHooks = {
    readEarlierProgress: async () => {
      if (fail) throw new Error("The record could not be read.");
      return { kind: "live", source: "tape-a", local: [], records: [] };
    },
  };
  const ctx = ref<EarlierDetailsContext | undefined>({ kind: "all" });
  const { scope, ctrl } = controller(ctx, hooks);
  await settle();
  ctrl.selectEntry(ctrl.entries.value[0]!);
  await settle();
  assert.equal(ctrl.selected.value?.state, "failed");
  assert.equal(ctrl.selected.value?.error, "The record could not be read.");

  fail = false;
  ctrl.refreshSelected();
  await settle();
  assert.equal(ctrl.selected.value?.state, "ready");
  scope.stop();
});

test("presence follows empty continuation pages to the first row", async () => {
  clearStores();
  const hooks: EarlierProgressHooks = {
    listEarlierProgress: async (query) =>
      query.cursor === undefined
        ? { entries: [], cursor: "c1" }
        : { entries: [{ kind: "live", source: "found", evidence: {} }], cursor: undefined },
  };
  const notify = ref(0);
  const scope = effectScope();
  const presence = scope.run(() => useEarlierProgressPresence(notify, { local, hooks }))!;
  await settle();
  assert.equal(presence.presence.value, "present");
  scope.stop();
});

test("presence reports empty and failed honestly, and Retry recovers", async () => {
  clearStores();
  let fail = false;
  const hooks: EarlierProgressHooks = {
    listEarlierProgress: async () => {
      if (fail) throw new Error("The browser refused the listing.");
      return { entries: [], cursor: undefined };
    },
  };
  const notify = ref(0);
  const scope = effectScope();
  const presence = scope.run(() => useEarlierProgressPresence(notify, { local, hooks }))!;
  await settle();
  assert.equal(presence.presence.value, "empty");

  fail = true;
  notify.value++;
  await settle();
  assert.equal(presence.presence.value, "failed");
  assert.equal(presence.presenceError.value, "The browser refused the listing.");

  fail = false;
  await presence.retryPresence();
  assert.equal(presence.presence.value, "empty");
  scope.stop();
});

test("summaries name parser-proven components and leave opaque data as Stored data", () => {
  const read: EarlierRead = {
    kind: "live",
    source: "floppy-era",
    local: [
      { key: "monotio_agi.autosave.floppy-era", value: AUTOSAVE_VALUE },
      { key: "monotio_agi.saves.floppy-era", value: SAVES_VALUE },
      { key: "monotio_agi.map.floppy-era", value: MAP_VALUE },
      { key: "monotio_agi.autosave.floppy-era-x", value: "not json" },
    ],
    records: [
      { key: "history/floppy-era", value: { format: "x" } },
      { key: "conversation/floppy-era", value: { format: "x" } },
      { key: "other/thing", value: { tag: 1 } },
    ],
  };
  const summary = summarizeEarlierRead(read);
  assert.deepEqual(summary.parts, [
    "Checkpoint",
    "2 saves",
    "Map",
    "History",
    "Conversation",
    "Stored data",
  ]);
});

test("missing local keys are named exactly in the summary", () => {
  const read: EarlierRead = {
    kind: "local",
    entries: [
      { key: "monotio_agi.saves.odd%key", state: "present", value: SAVES_VALUE },
      { key: "monotio_agi.saves.gone", state: "missing" },
    ],
  };
  const summary = summarizeEarlierRead(read);
  assert.deepEqual(summary.missing, ["monotio_agi.saves.gone"]);
  assert.deepEqual(summary.parts, ["2 saves"]);
});

test("download names carry the source spelling safely", () => {
  assert.equal(
    earlierDownloadName({ kind: "capture", recoveryId: "legacy-progress/my game/x/1" }),
    "earlier-progress-data-my-game-x-1.json",
  );
  assert.equal(
    earlierDownloadName({ kind: "live", legacyKey: "folder/odd name" }, true),
    "earlier-progress-data-folder-odd-name-local.json",
  );
  assert.equal(
    earlierDownloadName({ kind: "local", keys: ["k1", "k2"] }),
    "earlier-progress-data.json",
  );
});
