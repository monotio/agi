/**
 * Earlier-progress export tests — the complete-download JSON gate and the
 * separate partial local-strings payload, against the fake IndexedDB
 * fixture and an injected localStorage source.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readEarlierProgress,
  type EarlierLocalSource,
  type EarlierRead,
} from "../src/project/earlierProgress.ts";
import {
  EARLIER_PROGRESS_EXPORT_FORMAT,
  checkJsonLossless,
  exportEarlierProgress,
} from "../src/project/earlierProgressExport.ts";
import {
  newLegacyProgressRecord,
  type RawLocalEntry,
} from "../src/project/legacyProgressRecovery.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

const RECORDS = installIndexedDbFixture();
const localValues = new Map<string, string>();
const localSource = (): EarlierLocalSource => ({
  getItem: (key) => localValues.get(key) ?? null,
  listKeys: () => [...localValues.keys()],
});
const utf8 = (text: string): number => new TextEncoder().encode(text).length;

const clearStores = (): void => {
  RECORDS.clear();
  localValues.clear();
};

const seedLive = (source: string, records?: [string, unknown][]): void => {
  for (const [key, value] of [
    [`history/${source}`, { format: "x", version: 1 }],
    [`conversation/${source}`, { format: "c", version: 1 }],
    [`lifetime/${source}`, { format: "l", version: 1 }],
    ...(records ?? []),
  ] as [string, unknown][])
    RECORDS.set(key, value);
};

const readLive = async (source: string): Promise<EarlierRead> =>
  readEarlierProgress({ kind: "live", legacyKey: source }, { local: localSource() });

test("a live source exports its complete local strings and record values losslessly", async () => {
  clearStores();
  seedLive("tape", [["history/tape/s/old.1/00000001", { when: "then", n: 3.5, flag: true }]]);
  localValues.set("monotio_agi.autosave.tape", "auto  文字\n");
  localValues.set("monotio_agi.saves.tape", "save\tbytes");

  const read = await readLive("tape");
  const exported = exportEarlierProgress(read);
  assert.equal(exported.status, "complete");
  assert.equal(exported.kind, "live");
  assert.equal(exported.bytes, utf8(exported.json!));
  const doc = JSON.parse(exported.json!);
  assert.equal(doc.format, EARLIER_PROGRESS_EXPORT_FORMAT);
  assert.equal(doc.kind, "live");
  assert.equal(doc.source, "tape");
  assert.deepEqual(doc.local, [
    { key: "monotio_agi.autosave.tape", value: "auto  文字\n" },
    { key: "monotio_agi.saves.tape", value: "save\tbytes" },
  ]);
  assert.deepEqual(doc.records, [
    { key: "history/tape", value: { format: "x", version: 1 } },
    { key: "history/tape/s/old.1/00000001", value: { when: "then", n: 3.5, flag: true } },
    { key: "conversation/tape", value: { format: "c", version: 1 } },
    { key: "lifetime/tape", value: { format: "l", version: 1 } },
  ]);
  // Round trip is exact — reparse keeps byte equality.
  assert.equal(JSON.stringify(doc), exported.json);
});

test("a removal capture exports its envelope and records verbatim", async () => {
  clearStores();
  const record = newLegacyProgressRecord(
    "floppy-2",
    [{ key: "monotio_agi.autosave.floppy-2", value: "RAW" }],
    [
      { key: "history/floppy-2", value: { format: "x", version: 1 } },
      { key: "history/floppy-2/next", value: { epoch: "next" } },
      { key: "lifetime/floppy-2", value: { plays: 9 } },
    ],
  );
  RECORDS.set("legacy-progress/floppy-2/cap", record);

  const read = await readEarlierProgress({
    kind: "capture",
    recoveryId: "legacy-progress/floppy-2/cap",
  });
  const exported = exportEarlierProgress(read);
  assert.equal(exported.status, "complete");
  assert.equal(exported.kind, "capture");
  const doc = JSON.parse(exported.json!);
  assert.equal(doc.kind, "capture");
  assert.equal(doc.key, "legacy-progress/floppy-2/cap");
  assert.deepEqual(doc.capture, JSON.parse(JSON.stringify(record)));
});

test("an unknown capture version exports opaquely when its raw shape is lossless", async () => {
  clearStores();
  const future = {
    format: "monotio.agi.legacy-progress",
    version: 99,
    payload: { a: [1, 2] },
  };
  RECORDS.set("legacy-progress/src/fut", future);
  const read = await readEarlierProgress({
    kind: "capture",
    recoveryId: "legacy-progress/src/fut",
  });
  const exported = exportEarlierProgress(read);
  assert.equal(exported.status, "complete");
  const doc = JSON.parse(exported.json!);
  assert.equal(doc.state, "unsupported");
  assert.deepEqual(doc.value, future);
  assert.equal(doc.capture, undefined);
});

test("an absent capture has nothing to export", async () => {
  clearStores();
  const read = await readEarlierProgress({ kind: "capture", recoveryId: "legacy-progress/x/gone" });
  const exported = exportEarlierProgress(read);
  assert.equal(exported.status, "unavailable");
  assert.equal(exported.json, undefined);
});

test("local-only entries export as their own complete document, missing keys named", async () => {
  clearStores();
  localValues.set("monotio_agi.autosave.x", "one");
  const read = await readEarlierProgress(
    { kind: "local", keys: ["monotio_agi.autosave.x", "monotio_agi.autosave.gone"] },
    { local: localSource() },
  );
  const exported = exportEarlierProgress(read);
  assert.equal(exported.status, "complete");
  const doc = JSON.parse(exported.json!);
  assert.equal(doc.kind, "local");
  assert.deepEqual(doc.entries, [{ key: "monotio_agi.autosave.x", value: "one" }]);
  assert.deepEqual(doc.missing, ["monotio_agi.autosave.gone"]);

  const none = exportEarlierProgress(
    await readEarlierProgress(
      { kind: "local", keys: ["monotio_agi.autosave.gone"] },
      { local: localSource() },
    ),
  );
  assert.equal(none.status, "unavailable");
});

test("the JSON gate refuses exactly the lossy shapes", () => {
  const cycle: Record<string, unknown> = {};
  cycle["self"] = cycle;
  assert.match(failReason(cycle), /cyclic/);

  const shared = { v: 1 };
  assert.match(failReason({ a: shared, b: shared }), /shared/);
  assert.match(failReason([shared, shared]), /shared/);

  assert.match(failReason({ n: -0 }), /-0/);
  assert.match(failReason({ n: Number.NaN }), /NaN/);
  assert.match(failReason({ n: Number.POSITIVE_INFINITY }), /Infinity/);
  assert.match(failReason({ n: 10n }), /bigint/);
  assert.match(failReason({ u: undefined }), /undefined/);
  assert.match(
    failReason(() => 1),
    /function/,
  );
  assert.match(failReason(Symbol("s")), /symbol/);
  assert.match(failReason(new Map()), /non-plain/);
  assert.match(failReason(new Set()), /non-plain/);
  assert.match(failReason(new Date()), /non-plain/);
  assert.match(failReason(new Uint8Array(2)), /non-plain/);
  assert.match(failReason(new ArrayBuffer(4)), /non-plain/);
  assert.match(failReason(Object.create({ x: 1 })), /non-plain/);

  const sparse = new Array(3);
  sparse[0] = 1;
  assert.match(failReason(sparse), /sparse/);
  const extra = Object.assign([1, 2], { extra: true });
  assert.match(failReason(extra), /extra property/);
  const symkey = { a: 1 } as Record<string | symbol, unknown>;
  symkey[Symbol("k")] = 2;
  assert.match(failReason(symkey), /symbol-keyed/);
  const hidden = { a: 1 };
  Object.defineProperty(hidden, "secret", { value: 2, enumerable: false });
  assert.match(failReason(hidden), /non-enumerable/);
  const getter = {
    get x() {
      return 1;
    },
  };
  assert.match(failReason(getter), /accessor/);
  // A toJSON hook is a function-valued field: refused, never consulted.
  assert.match(failReason({ toJSON: () => ({ safe: true }), real: "data" }), /function/);

  // Deep and wide bounds refuse rather than truncate.
  const deep: Record<string, unknown> = {};
  let cursor = deep;
  for (let i = 0; i < 80; i++) {
    const next: Record<string, unknown> = {};
    cursor["n"] = next;
    cursor = next;
  }
  assert.match(failReason(deep), /deeper than/);
  assert.match(
    failReason({ f: Array.from({ length: 5 }, (_, i) => ({ i })) }, { maxNodes: 4 }),
    /more than 4/,
  );

  assert.equal(checkJsonLossless({ a: [1, "two", null, true, 3.25] }).ok, true);
});

function failReason(value: unknown, bounds?: Parameters<typeof checkJsonLossless>[1]): string {
  const check = checkJsonLossless(value, bounds);
  assert.equal(check.ok, false);
  if (check.ok) assert.fail();
  return check.reason;
}

test("a refused complete export reports partial and still offers the local strings", async () => {
  clearStores();
  seedLive("mixed", [["history/mixed/blob/rec", { data: new Map([["k", 1]]) }]]);
  localValues.set("monotio_agi.autosave.mixed", "EXACT BYTES \u0001");

  const read = await readLive("mixed");
  const exported = exportEarlierProgress(read);
  assert.equal(exported.status, "partial");
  assert.match(exported.reason!, /non-plain object/);
  assert.equal(exported.json, undefined);
  assert.deepEqual(exported.retained, [
    "history/mixed",
    "history/mixed/blob/rec",
    "conversation/mixed",
    "lifetime/mixed",
  ]);
  const localDoc = JSON.parse(exported.localJson!);
  assert.equal(localDoc.kind, "local");
  assert.deepEqual(localDoc.entries, [
    { key: "monotio_agi.autosave.mixed", value: "EXACT BYTES \u0001" },
  ]);
  // Refusal never rewrote the stored bytes.
  assert.deepEqual(RECORDS.get("history/mixed/blob/rec"), { data: new Map([["k", 1]]) });
});

test("cycles, shared references and non-JSON clones inside records refuse the whole export", async () => {
  clearStores();
  const cycle: Record<string, unknown> = {};
  cycle["loop"] = cycle;
  seedLive("badref", [["history/badref/cyc", cycle]]);
  const shared = { v: 7 };
  seedLive("shared", [["history/shared/pair", { a: shared, b: shared }]]);
  seedLive("neg", [["history/neg/n", { value: -0 }]]);
  seedLive("inf", [["history/inf/n", Number.NEGATIVE_INFINITY]]);
  seedLive("big", [["history/big/n", { n: 5n }]]);
  seedLive("undef", [["history/undef/u", { gone: undefined }]]);
  seedLive("typed", [["history/typed/b", new Uint8Array([1, 2])]]);
  seedLive("date", [["history/date/d", new Date(0)]]);

  for (const [source, pattern] of [
    ["badref", /cyclic/],
    ["shared", /shared/],
    ["neg", /-0/],
    ["inf", /-Infinity|Infinity/],
    ["big", /bigint/],
    ["undef", /undefined/],
    ["typed", /non-plain/],
    ["date", /non-plain/],
  ] as const) {
    const exported = exportEarlierProgress(await readLive(source));
    assert.equal(exported.status, "partial", source);
    assert.match(exported.reason!, pattern, source);
  }
});

test("a capture with unsafe record data refuses complete but ships its local strings", async () => {
  clearStores();
  const record = newLegacyProgressRecord(
    "unsafe",
    [{ key: "monotio_agi.autosave.unsafe", value: "kept" }],
    [{ key: "history/unsafe", value: { structured: new Set([1]) } }],
  );
  RECORDS.set("legacy-progress/unsafe/c", record);
  const exported = exportEarlierProgress(
    await readEarlierProgress({ kind: "capture", recoveryId: "legacy-progress/unsafe/c" }),
  );
  assert.equal(exported.status, "partial");
  assert.deepEqual(exported.retained, ["legacy-progress/unsafe/c"]);
  assert.deepEqual(JSON.parse(exported.localJson!).entries, [
    { key: "monotio_agi.autosave.unsafe", value: "kept" },
  ]);
});

test("an opaque capture row with unsafe raw data refuses without a local payload", async () => {
  clearStores();
  RECORDS.set("legacy-progress/o/raw", { format: "nope", version: 1, m: new Map() });
  const exported = exportEarlierProgress(
    await readEarlierProgress({ kind: "capture", recoveryId: "legacy-progress/o/raw" }),
  );
  assert.equal(exported.status, "partial");
  assert.equal(exported.localJson, undefined);
  assert.deepEqual(exported.retained, ["legacy-progress/o/raw"]);
});

test("oversized and over-budget exports refuse and keep every stored byte", async () => {
  clearStores();
  const big = "x".repeat(9000);
  seedLive("huge", [["history/huge/big", { payload: big }]]);
  localValues.set("monotio_agi.autosave.huge", "z".repeat(6000));

  const byBytes = exportEarlierProgress(await readLive("huge"), { maxJsonBytes: 4096 });
  assert.equal(byBytes.status, "partial");
  assert.match(byBytes.reason!, /byte limit/);
  // Even the local-only document refuses when it alone exceeds the bound.
  assert.equal(byBytes.localJson, undefined);
  const byLocalFits = exportEarlierProgress(await readLive("huge"), { maxJsonBytes: 8000 });
  assert.equal(byLocalFits.status, "partial");
  assert.ok(byLocalFits.localJson !== undefined);
  assert.deepEqual(RECORDS.get("history/huge/big"), { payload: big });
});

test("a stored capture with a sparse local array ships no invented fallback entries", async () => {
  clearStores();
  const record = newLegacyProgressRecord("sparse-cap", [], []);
  // The released layout check uses every(): a hole reads as available and
  // the stored structured clone keeps it. The export must not invent a
  // null entry for it.
  (record.local as RawLocalEntry[]).length = 1;
  RECORDS.set(record.projectId, structuredClone(record));

  const read = await readEarlierProgress({ kind: "capture", recoveryId: record.projectId });
  if (read.kind !== "capture" || read.state !== "available") assert.fail();
  const exported = exportEarlierProgress(read);
  assert.equal(exported.status, "partial");
  assert.match(exported.reason!, /sparse/);
  assert.equal(exported.localJson, undefined);
  assert.deepEqual(exported.retained, [record.projectId]);
  const stored = RECORDS.get(record.projectId) as typeof record;
  assert.equal(Object.hasOwn(stored.local, 0), false);
});

test("a stored capture with a malformed local entry ships no rewritten fallback", async () => {
  clearStores();
  const record = newLegacyProgressRecord(
    "odd-cap",
    [],
    [{ key: "history/odd-cap", value: { opaque: new Map([["k", 1]]) } }],
  );
  // A captured entry carrying a third field is not a raw {key, value}
  // string: the fallback must not quietly drop the extra field.
  (record.local as unknown[]).push({
    key: "monotio_agi.autosave.odd-cap",
    value: "v",
    extra: true,
  });
  RECORDS.set(record.projectId, structuredClone(record));

  const read = await readEarlierProgress({ kind: "capture", recoveryId: record.projectId });
  if (read.kind !== "capture" || read.state !== "available") assert.fail();
  const exported = exportEarlierProgress(read);
  assert.equal(exported.status, "partial");
  assert.equal(exported.localJson, undefined);
  assert.deepEqual(exported.retained, [record.projectId]);
});

test("a refused local-only export names the present keys it leaves behind", async () => {
  clearStores();
  const key = "monotio_agi.saves.bad%";
  localValues.set(key, "x".repeat(2048));
  const read = await readEarlierProgress(
    { kind: "local", keys: [key, "monotio_agi.saves.gone%"] },
    { local: localSource() },
  );
  const exported = exportEarlierProgress(read, { maxJsonBytes: 1024 });
  assert.equal(exported.status, "partial");
  assert.equal(exported.localJson, undefined);
  assert.deepEqual(exported.retained, [key]);
  assert.equal(localValues.get(key), "x".repeat(2048));
});

test("a refused live export retains its records and its unexported local keys", async () => {
  clearStores();
  seedLive("mislive", [["history/mislive/blob", { opaque: new Map([["keep", 1]]) }]]);
  localValues.set("monotio_agi.autosave.mislive", "y".repeat(2048));

  const exported = exportEarlierProgress(await readLive("mislive"), { maxJsonBytes: 1024 });
  assert.equal(exported.status, "partial");
  assert.equal(exported.localJson, undefined);
  assert.deepEqual(exported.retained, [
    "history/mislive",
    "history/mislive/blob",
    "conversation/mislive",
    "lifetime/mislive",
    "monotio_agi.autosave.mislive",
  ]);
  assert.ok((RECORDS.get("history/mislive/blob") as { opaque: unknown }).opaque instanceof Map);
  assert.equal(localValues.get("monotio_agi.autosave.mislive"), "y".repeat(2048));
});

test("a live source with no records and no local strings has nothing to export", async () => {
  clearStores();
  const exported = exportEarlierProgress(await readLive("ghost"));
  assert.equal(exported.status, "unavailable");
  assert.equal(exported.json, undefined);
  assert.equal(exported.localJson, undefined);
});

test("stored data is identical after refused and complete exports", async () => {
  clearStores();
  seedLive("keep", [["history/keep/m", { m: new Map([["a", 1]]) }]]);
  const before = [...RECORDS.entries()].map(([k, v]) => [k, structuredClone(v)] as const);
  exportEarlierProgress(await readLive("keep"));
  assert.deepEqual(
    [...RECORDS.entries()].map(([k, v]) => [k, structuredClone(v)] as const),
    before,
  );
});
