/**
 * Earlier-progress read adapter tests — discovery, read paths and listing
 * honesty against the fake IndexedDB fixture plus an injected localStorage
 * source. Exports live in earlier-progress-export.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listEarlierProgress,
  readEarlierProgress,
  type EarlierCaptureEntry,
  type EarlierEntry,
  type EarlierLiveEntry,
  type EarlierLiveEvidence,
  type EarlierLocalEntry,
  type EarlierLocalRecord,
  type EarlierLocalSource,
  type EarlierProgressPage,
} from "../src/project/earlierProgress.ts";
import { exportEarlierProgress } from "../src/project/earlierProgressExport.ts";
import { newLegacyProgressRecord } from "../src/project/legacyProgressRecovery.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

const RECORDS = installIndexedDbFixture();
const localValues = new Map<string, string>();
const localSource = (): EarlierLocalSource => ({
  getItem: (key) => localValues.get(key) ?? null,
  listKeys: () => [...localValues.keys()],
});
const opaqueRecord = (tag: string): Record<string, unknown> => ({
  format: "monotio.agi.legacy-progress",
  version: 99,
  tag,
  nested: { deep: [1, "two"] },
});

const clearStores = (): void => {
  RECORDS.clear();
  localValues.clear();
};

const seedCapture = (
  source: string,
  overrides?: {
    local?: { key: string; value: string }[];
    records?: { key: string; value: unknown }[];
  },
) =>
  newLegacyProgressRecord(
    source,
    overrides?.local ?? [],
    overrides?.records ?? [{ key: `history/${source}`, value: { format: "x", version: 1 } }],
  );

const seedLive = (source: string, records?: [string, unknown][]): Map<string, unknown> => {
  const stored = new Map<string, unknown>([
    [`history/${source}`, { format: "monotio.agi.stored-history", version: 1, name: source }],
    [`history/${source}/next`, { format: "x", version: 1, epoch: "next" }],
    [`history/${source}/s/old.1/00000001`, { format: "x", version: 1, checkpoint: true }],
    ...(records ?? []),
  ]);
  for (const [key, value] of stored) RECORDS.set(key, value);
  return stored;
};

const collectAll = async (
  query: Parameters<typeof listEarlierProgress>[0],
): Promise<EarlierEntry[]> => {
  const entries: EarlierEntry[] = [];
  let cursor: string | undefined;
  const seenPages: EarlierProgressPage[] = [];
  for (let guard = 0; guard < 200; guard++) {
    const page = await listEarlierProgress({
      ...query,
      ...(cursor === undefined ? {} : { cursor }),
    });
    seenPages.push(page);
    entries.push(...page.entries);
    cursor = page.cursor;
    if (cursor === undefined) return entries;
  }
  throw new Error("pagination did not terminate");
};

test("capture rows of every readability stay individually visible beside live sources", async () => {
  clearStores();
  RECORDS.set(
    "legacy-progress/recent-box/cap-1",
    seedCapture("recent-box", { local: [{ key: "k1", value: "autosave-text" }] }),
  );
  RECORDS.set("legacy-progress/recent-box/cap-2", opaqueRecord("two"));
  RECORDS.set("legacy-progress/recent-box/cap-3", null);
  seedLive("recent-box");

  const { entries, cursor } = await listEarlierProgress({
    includeAll: true,
    local: localSource(),
  });
  assert.equal(cursor, undefined);
  assert.deepEqual(
    entries.map((entry) =>
      entry.kind === "capture" ? `${entry.kind}:${entry.state}` : entry.kind,
    ),
    ["capture:available", "capture:unsupported", "capture:unreadable", "live"],
  );
  const [known, future, unreadable] = entries.filter(
    (entry): entry is EarlierCaptureEntry => entry.kind === "capture",
  );
  assert.equal(known?.key, "legacy-progress/recent-box/cap-1");
  assert.equal(known?.source, "recent-box");
  assert.match(String(known?.capturedAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(future?.key, "legacy-progress/recent-box/cap-2");
  assert.equal(unreadable?.key, "legacy-progress/recent-box/cap-3");
  const live: EarlierLiveEntry | undefined = entries.find(
    (entry): entry is EarlierLiveEntry => entry.kind === "live",
  );
  assert.equal(live?.source, "recent-box");
  assert.equal(live?.evidence.history, true);
});

test("a capture reads verbatim through its exact key with no live body anywhere", async () => {
  clearStores();
  const record = seedCapture("gone-folder", {
    local: [{ key: "monotio_agi.autosave.gone-folder", value: "  exact\tbytes " }],
    records: [
      { key: "history/gone-folder", value: { format: "x", version: 1 } },
      { key: "history/gone-folder/next", value: { format: "x", version: 1, epoch: "next" } },
      { key: "history/gone-folder/s/old.2/00000001", value: { orphan: true } },
      { key: "lifetime/gone-folder", value: { plays: 2 } },
    ],
  });
  RECORDS.set("legacy-progress/gone-folder/xyz", record);

  const read = await readEarlierProgress({
    kind: "capture",
    recoveryId: "legacy-progress/gone-folder/xyz",
  });
  assert.equal(read.kind === "capture" && read.state, "available");
  assert.equal(
    read.kind === "capture" && read.state === "available" && read.record.source,
    "gone-folder",
  );
  assert.equal(
    read.kind === "capture" && read.state === "available" && read.record.capturedAt,
    record.capturedAt,
  );
  assert.equal(
    read.kind === "capture" && read.state === "available" && read.record.local[0]?.value,
    "  exact\tbytes ",
  );
  assert.equal(
    read.kind === "capture" && read.state === "available" && read.record.records.length,
    4,
  );
  assert.equal(RECORDS.get("legacy-progress/gone-folder/xyz"), record);
});

test("unsupported and unreadable capture rows read their raw value unchanged", async () => {
  clearStores();
  const future = opaqueRecord("ahead");
  RECORDS.set("legacy-progress/src/nine", future);
  RECORDS.set("legacy-progress/src/none", null);
  RECORDS.set("legacy-progress/src/bad", "a plain string");

  const unsupported = await readEarlierProgress({
    kind: "capture",
    recoveryId: "legacy-progress/src/nine",
  });
  assert.deepEqual(unsupported, {
    kind: "capture",
    key: "legacy-progress/src/nine",
    state: "unsupported",
    value: future,
  });
  const unreadable = await readEarlierProgress({
    kind: "capture",
    recoveryId: "legacy-progress/src/none",
  });
  assert.deepEqual(unreadable, {
    kind: "capture",
    key: "legacy-progress/src/none",
    state: "unreadable",
    value: null,
  });
  const stringed = await readEarlierProgress({
    kind: "capture",
    recoveryId: "legacy-progress/src/bad",
  });
  assert.deepEqual(stringed, {
    kind: "capture",
    key: "legacy-progress/src/bad",
    state: "unreadable",
    value: "a plain string",
  });
  const absent = await readEarlierProgress({
    kind: "capture",
    recoveryId: "legacy-progress/src/gone",
  });
  assert.deepEqual(absent, { kind: "capture", key: "legacy-progress/src/gone", state: "absent" });
});

test("a live source reads its full history subtree plus conversation and lifetime records", async () => {
  clearStores();
  seedLive("floppy:QFG1", [
    ["conversation/floppy:QFG1", { format: "c", version: 1, notes: ["hi"] }],
    ["lifetime/floppy:QFG1", { format: "l", version: 1, plays: 7 }],
    ["history/floppy:QFG1/future/unknown-record", { shape: "not yet known" }],
    ["conversation/other-source", { format: "c", version: 1 }],
    ["lifetime/not-this", { format: "l", version: 1 }],
    ["history/totally-other", { format: "x", version: 1 }],
    ["progress/project:demo-1:initial", { format: "s", version: 1 }],
  ]);
  localValues.set("monotio_agi.autosave.floppy:QFG1", "A U T O");
  localValues.set("monotio_agi.saves.floppy%3AQFG1", "S A V E");
  localValues.set("monotio_agi.map.floppy:QFG1", "M A P");
  localValues.set("monotio_agi.autosave.someone-else", "not this");

  const read = await readEarlierProgress(
    { kind: "live", legacyKey: "floppy:QFG1" },
    { local: localSource() },
  );
  assert.equal(read.kind, "live");
  if (read.kind !== "live") assert.fail();
  assert.equal(read.source, "floppy:QFG1");
  assert.deepEqual(
    read.records.map(({ key }) => key),
    [
      "history/floppy:QFG1",
      "history/floppy:QFG1/future/unknown-record",
      "history/floppy:QFG1/next",
      "history/floppy:QFG1/s/old.1/00000001",
      "conversation/floppy:QFG1",
      "lifetime/floppy:QFG1",
    ],
  );
  assert.deepEqual(read.records.find(({ key }) => key === "lifetime/floppy:QFG1")?.value, {
    format: "l",
    version: 1,
    plays: 7,
  });
  assert.deepEqual(read.local, [
    { key: "monotio_agi.autosave.floppy:QFG1", value: "A U T O" },
    { key: "monotio_agi.map.floppy:QFG1", value: "M A P" },
    { key: "monotio_agi.saves.floppy%3AQFG1", value: "S A V E" },
  ]);
});

test("live reads keep exact UTF-16 strings and structured-clone values", async () => {
  clearStores();
  const recordValue = {
    format: "x",
    version: 1,
    label: "名字 🀄 \u0001",
    blobish: new Uint8Array([9, 8]),
  };
  seedLive("uni", [["history/uni/x", recordValue]]);
  localValues.set("monotio_agi.autosave.uni", "名字\n\t\u0001🀄");

  const read = await readEarlierProgress(
    { kind: "live", legacyKey: "uni" },
    { local: localSource() },
  );
  assert.equal(read.kind, "live");
  if (read.kind !== "live") assert.fail();
  assert.equal(read.local[0]?.value, "名字\n\t\u0001🀄");
  const found = read.records.find(({ key }) => key === "history/uni/x");
  assert.deepEqual(found?.value, recordValue);
  // Detached from the stored clone: mutating the result never touches storage.
  assert.notEqual(found?.value, recordValue);
  assert.deepEqual(RECORDS.get("history/uni/x"), recordValue);
});

test("current project:/installed: locators are never legacy sources", async () => {
  clearStores();
  await assert.rejects(
    () => readEarlierProgress({ kind: "live", legacyKey: "project:demo-1:initial" }),
    /progress locator/,
  );
  // The unreleased folder-only predecessor refuses through the same
  // namespace classification, and so does the current revision-suffixed
  // installed locator.
  await assert.rejects(
    () => readEarlierProgress({ kind: "live", legacyKey: `installed:${"0".repeat(64)}` }),
    /progress locator/,
  );
  await assert.rejects(
    () =>
      readEarlierProgress({
        kind: "live",
        legacyKey: `installed:${"0".repeat(64)}:${"1".repeat(64)}`,
      }),
    /progress locator/,
  );
  await assert.rejects(() => readEarlierProgress({ kind: "live", legacyKey: "" }), /legacy source/);
  // Near-match spellings that never matched either grammar stay readable
  // ordinary live sources.
  for (const spelling of [
    "installed:trap",
    `installed:${"A".repeat(64)}`,
    `installed:${"0".repeat(63)}`,
    `installed:${"0".repeat(64)}:not-a-revision`,
    "project:ordinary-folder",
  ]) {
    const read = await readEarlierProgress(
      { kind: "live", legacyKey: spelling },
      { local: localSource() },
    );
    assert.equal(read.kind === "live" && read.source, spelling, spelling);
    assert.deepEqual(read.kind === "live" ? read.records : undefined, [], spelling);
  }
});

test("browsing lists local, history and orphan-only sources once, with encoded spellings kept", async () => {
  clearStores();
  seedLive("orphans-only", []); // only descendants
  RECORDS.delete("history/orphans-only"); // leave just /next + the save
  RECORDS.set("history/tapeonly", { format: "x", version: 1 });
  localValues.set("monotio_agi.autosave.München Folder", "A");
  localValues.set("monotio_agi.saves.M%C3%BCnchen%20Folder", "S");
  localValues.set("monotio_agi.map.München Folder", "M");
  localValues.set("monotio_agi.autosave.UPPER", "upper auto");
  localValues.set("monotio_agi.saves.bad%", "undecodable");
  localValues.set("monotio_agi.autosave.", "empty source");
  // Current locators and unrelated keys are never earlier sources.
  localValues.set("monotio_agi.autosave.project:demo-1:initial", "namespaced");
  localValues.set(`monotio_agi.saves.${encodeURIComponent(`installed:${"0".repeat(64)}`)}`, "inst");
  localValues.set("some_other_key", "noise");
  RECORDS.set("history/project:demo-1:initial", { format: "s", version: 1 });
  RECORDS.set("history/project:demo-1:initial/next", { format: "s", version: 1 });
  RECORDS.set(`history/installed:${"0".repeat(64)}/x`, { format: "x", version: 1 });
  // Conversation/lifetime-only data does not invent a source.
  RECORDS.set("lifetime/lonely", { format: "l", version: 1 });
  RECORDS.set("conversation/lonely", { format: "c", version: 1 });

  const entries = await collectAll({ includeAll: true, local: localSource(), limit: 3 });
  const lives = entries.filter((entry): entry is EarlierLiveEntry => entry.kind === "live");
  assert.deepEqual(
    lives.map((entry) => entry.source),
    ["München Folder", "UPPER", "orphans-only", "tapeonly"],
  );
  const munich = lives.find((entry) => entry.source === "München Folder");
  const evidence: EarlierLiveEvidence | undefined = munich?.evidence;
  assert.equal(evidence?.autosave?.length, 1);
  assert.equal(evidence?.saves?.length, 1);
  assert.equal(evidence?.map?.length, 1);
  const orphans = lives.find((entry) => entry.source === "orphans-only");
  assert.equal(orphans?.evidence.history, true);
  const locals: EarlierLocalEntry[] = entries.filter(
    (entry): entry is EarlierLocalEntry => entry.kind === "local",
  );
  assert.deepEqual(
    locals.map((entry) => entry.keys[0]),
    ["monotio_agi.autosave.", "monotio_agi.saves.bad%"],
  );
});

test("the unreleased installed namespace is excluded at every discovery avenue", async () => {
  clearStores();
  // Three distinct old-grammar spellings, one per avenue, so each boundary
  // classification is exercised independently of the deduped others.
  const oldCandidate = `installed:${"a".repeat(64)}`;
  const oldLocal = `installed:${"b".repeat(64)}`;
  const oldHistory = `installed:${"c".repeat(64)}`;
  const savesKey = `monotio_agi.saves.${encodeURIComponent(oldLocal)}`;
  localValues.set(`monotio_agi.autosave.${oldLocal}`, "auto");
  localValues.set(savesKey, "opaque 文字\n { not decoded }");
  RECORDS.set(`history/${oldHistory}`, { format: "x", version: 1 });
  RECORDS.set(`history/${oldHistory}/next`, { format: "x", version: 1 });
  // Near-match released spellings stay ordinary live sources per avenue.
  const upperCandidate = `installed:${"D".repeat(64)}`;
  localValues.set("monotio_agi.autosave.installed:trap", "trap auto");
  RECORDS.set("history/project:ordinary-folder", { format: "x", version: 1 });

  const entries = await collectAll({
    candidates: [oldCandidate, upperCandidate],
    includeAll: true,
    local: localSource(),
  });
  const lives = entries.filter((entry): entry is EarlierLiveEntry => entry.kind === "live");
  assert.deepEqual(
    lives.map((entry) => entry.source),
    [upperCandidate, "installed:trap", "project:ordinary-folder"],
  );
  assert.equal(lives[0]?.evidence.candidate, true);
  assert.equal(lives[1]?.evidence.autosave?.length, 1);
  assert.equal(lives[2]?.evidence.history, true);
  // The old namespace's decodable keys never leak into undecodable rows.
  assert.equal(
    entries.some((entry) => entry.kind === "local"),
    false,
  );

  // Explicit exact-key raw access stays byte-preserving and read-only, and
  // the local export route carries the same exact string.
  const before = new Map(localValues);
  const read = await readEarlierProgress(
    { kind: "local", keys: [savesKey] },
    { local: localSource() },
  );
  assert.deepEqual(read, {
    kind: "local",
    entries: [{ key: savesKey, state: "present", value: "opaque 文字\n { not decoded }" }],
  });
  const exported = exportEarlierProgress(read);
  assert.equal(exported.status, "complete");
  assert.equal(exported.kind, "local");
  assert.ok(exported.json!.includes(JSON.stringify("opaque 文字\n { not decoded }")));
  assert.deepEqual([...localValues.entries()], [...before.entries()]);
});

test("bounded pages resume exactly through captures, locals and history keys", async () => {
  clearStores();
  for (const tag of ["a1", "a2", "a3"])
    RECORDS.set(
      `legacy-progress/disk/${tag}`,
      seedCapture("disk", { records: [{ key: `history/disk/${tag}`, value: 1 }] }),
    );
  for (const name of ["b1", "b2", "b3", "b4", "b5"]) seedLive(`s-${name}`, []);
  for (const name of ["l1", "l2"]) localValues.set(`monotio_agi.autosave.${name}`, "x");
  localValues.set("monotio_agi.saves.bad%", "u");

  const entries = await collectAll({ includeAll: true, local: localSource(), limit: 2 });
  const tags = entries.map((entry) =>
    entry.kind === "capture"
      ? `c:${entry.key}`
      : entry.kind === "live"
        ? `l:${entry.source}`
        : `u:${entry.keys[0]}`,
  );
  const expected = [
    "c:legacy-progress/disk/a1",
    "c:legacy-progress/disk/a2",
    "c:legacy-progress/disk/a3",
    "l:l1",
    "l:l2",
    "l:s-b1",
    "l:s-b2",
    "l:s-b3",
    "l:s-b4",
    "l:s-b5",
    "u:monotio_agi.saves.bad%",
  ];
  assert.deepEqual(tags, expected);
});

test("contextual listing emits explicit candidates only, in order, captures before live rows", async () => {
  clearStores();
  RECORDS.set("legacy-progress/disk/cap-1", seedCapture("disk"));
  seedLive("disk");
  seedLive("elsewhere");
  localValues.set("monotio_agi.autosave.elsewhere", "x");

  const { entries, cursor } = await listEarlierProgress({
    candidates: ["disk", "project:demo-1:initial", "unseen"],
    local: localSource(),
  });
  assert.equal(cursor, undefined);
  assert.deepEqual(
    entries.map((entry) =>
      entry.kind === "capture"
        ? `capture:${entry.key}`
        : `live:${entry.kind === "live" ? entry.source : ""}`,
    ),
    ["capture:legacy-progress/disk/cap-1", "live:disk", "live:unseen"],
  );
  // Namespaced candidates are not earlier sources at all.
  assert.ok(
    entries.every((entry) => !(entry.kind === "live" && entry.source.startsWith("project:"))),
  );
});

test("local-only rows read their raw keys back exactly", async () => {
  clearStores();
  localValues.set("monotio_agi.saves.bad%", "still here");
  const read = await readEarlierProgress(
    { kind: "local", keys: ["monotio_agi.saves.bad%", "monotio_agi.autosave.gone"] },
    { local: localSource() },
  );
  const expected: { kind: "local"; entries: EarlierLocalRecord[] } = {
    kind: "local",
    entries: [
      { key: "monotio_agi.saves.bad%", state: "present", value: "still here" },
      { key: "monotio_agi.autosave.gone", state: "missing" },
    ],
  };
  assert.deepEqual(read, expected);
});

test("read and listing failures propagate for UI retry", async () => {
  clearStores();
  seedLive("flaky");
  const originalGet = RECORDS.get.bind(RECORDS);
  try {
    RECORDS.get = () => {
      throw new Error("record read failed");
    };
    await assert.rejects(() => readEarlierProgress({ kind: "live", legacyKey: "flaky" }));
    RECORDS.get = originalGet;
    RECORDS.keys = () => {
      throw new Error("cursor enumeration failed");
    };
    await assert.rejects(() => listEarlierProgress({ includeAll: true, local: localSource() }));
  } finally {
    RECORDS.get = originalGet;
    RECORDS.keys = Map.prototype.keys.bind(RECORDS);
  }
});

test("storage is untouched after reads and listings", async () => {
  clearStores();
  RECORDS.set("legacy-progress/disk/c1", seedCapture("disk"));
  seedLive("disk");
  localValues.set("monotio_agi.autosave.disk", "A");
  const before = new Map(RECORDS);
  const beforeLocal = new Map(localValues);

  await collectAll({ includeAll: true, local: localSource(), limit: 1 });
  await readEarlierProgress({ kind: "capture", recoveryId: "legacy-progress/disk/c1" });
  await readEarlierProgress({ kind: "live", legacyKey: "disk" }, { local: localSource() });
  await readEarlierProgress(
    { kind: "local", keys: ["monotio_agi.autosave.disk"] },
    { local: localSource() },
  );

  assert.deepEqual([...RECORDS.entries()], [...before.entries()]);
  assert.deepEqual([...localValues.entries()], [...beforeLocal.entries()]);
});
