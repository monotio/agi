/**
 * Earlier checkpoint preparation — the read-side half of "Open checkpoint":
 * which localStorage strings of a pinned EarlierRead are supported
 * checkpoints, and the proof that one selected string restores into an
 * explicitly chosen destination's actual bytes under its selected
 * interpreter. Checkpoints are real Engine-made Starter images; reads come
 * from the real earlierProgress reader over the fake IndexedDB and an
 * injected localStorage view. Nothing here may write storage.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../../src/runtime/engine.ts";
import { openContainer } from "../../src/container/container.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import {
  requireProjectId,
  type GameIdentity,
  type ResourceRevision,
} from "../../src/gameIdentity.ts";
import type { ProfileId } from "../../src/runtime/profile.ts";
import {
  readEarlierProgress,
  type EarlierLocalSource,
  type EarlierRead,
} from "../src/project/earlierProgress.ts";
import {
  newLegacyProgressRecord,
  type CapturedRecord,
  type LegacyProgressRecord,
  type RawLocalEntry,
} from "../src/project/legacyProgressRecovery.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import { bytesToBase64 } from "../src/project/bytes.ts";
import {
  installedProgressTarget,
  projectProgressTarget,
  type ProgressTarget,
} from "../src/project/progressTarget.ts";
import {
  autosaveKey,
  parseAutosaveRecord,
  type AutosaveRecord,
} from "../src/saves/gameProgress.ts";
import {
  listEarlierCheckpoints,
  prepareEarlierCheckpoint,
} from "../src/saves/earlierCheckpoint.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

const RECORDS = installIndexedDbFixture();
const localValues = new Map<string, string>();
const localSource = (): EarlierLocalSource => ({
  getItem: (key) => localValues.get(key) ?? null,
  listKeys: () => [...localValues.keys()],
});
const clearStores = (): void => {
  RECORDS.clear();
  localValues.clear();
};

const HOST = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

interface Rig {
  readonly files: Record<string, Uint8Array>;
  readonly words: Map<string, number>;
  readonly profileId: ProfileId;
  readonly revision: ResourceRevision;
}

/** A detached native Starter build plus the revision its bytes hash to. */
async function starterRig(): Promise<Rig> {
  const starter = createStarterProject("starter");
  const files = Object.fromEntries(starter.files());
  return {
    files,
    words: new Map(starter.sources.words),
    profileId: starter.profileId,
    revision: await gameRevision(files),
  };
}

/** A real Engine checkpoint: boot the starter until the first resumable room draw. */
function starterCheckpoint(rig: Rig): { image: Uint8Array; room: number } {
  const engine = new Engine(
    openContainer(new Map(Object.entries(rig.files)), { profile: rig.profileId }),
    HOST,
    rig.words,
    { profile: rig.profileId },
  );
  for (let i = 0; i < 8 && !engine.autosaveImage(); i++) engine.tick();
  const image = engine.autosaveImage();
  assert.ok(image, "the starter draws a resumable room");
  return { image, room: engine.readState().room };
}

function checkpointRaw(
  image: Uint8Array,
  room: number,
  game: AutosaveRecord["game"],
  extra?: Record<string, unknown>,
  pretty = false,
): string {
  const record: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    image: bytesToBase64(image),
    cycle: 8,
    room,
    savedAt: 1_757_000_000_000,
    game,
  };
  return JSON.stringify({ ...record, ...extra }, null, pretty ? 2 : undefined);
}

function sourceGame(source: string, revision: ResourceRevision): GameIdentity {
  return { project: requireProjectId(source), revision };
}

const liveRead = (source: string): Promise<EarlierRead> =>
  readEarlierProgress({ kind: "live", legacyKey: source }, { local: localSource() });

async function captureRead(
  source: string,
  local: readonly RawLocalEntry[],
  records: readonly CapturedRecord[] = [],
): Promise<{ read: EarlierRead; record: LegacyProgressRecord }> {
  const record = newLegacyProgressRecord(source, local, records);
  RECORDS.set(record.projectId, record);
  const read = await readEarlierProgress({ kind: "capture", recoveryId: record.projectId });
  if (read.kind !== "capture" || read.state !== "available") assert.fail("capture must decode");
  return { read, record };
}

function savedTarget(project: string, revision: ResourceRevision): ProgressTarget {
  const target = projectProgressTarget(project, revision, "initial");
  assert.ok(target);
  return target;
}

test("a live source's checkpoint lists once and prepares for the selected destination", async () => {
  clearStores();
  const rig = await starterRig();
  const source = "earlier-garden";
  const { image, room } = starterCheckpoint(rig);
  const raw = checkpointRaw(image, room, {
    installed: false,
    identity: sourceGame(source, rig.revision),
  });
  localValues.set(autosaveKey(source), raw);
  localValues.set(`monotio_agi.saves.${encodeURIComponent(source)}`, "{corrupt");
  localValues.set(`monotio_agi.map.${source}`, "[not json");

  const read = await liveRead(source);
  const choices = listEarlierCheckpoints(read);
  assert.equal(choices.length, 1);
  assert.equal(choices[0]!.index, 0);
  assert.equal(choices[0]!.key, autosaveKey(source));
  assert.equal(choices[0]!.record.room, room);
  assert.equal(choices[0]!.record.image, bytesToBase64(image));

  const target = savedTarget(source, rig.revision);
  const prepared = await prepareEarlierCheckpoint({
    read,
    entryIndex: choices[0]!.index,
    target,
    files: rig.files,
    profile: rig.profileId,
  });
  assert.deepEqual(prepared.origin, { kind: "live", source });
  assert.equal(prepared.index, 0);
  assert.equal(prepared.key, autosaveKey(source));
  assert.equal(prepared.raw, raw);
  assert.deepEqual(prepared.target, target);
  assert.equal(prepared.profile, "2.936");
  // The rebound record is a separate value carrying the destination identity.
  assert.notEqual(prepared.record, choices[0]!.record);
  assert.equal(prepared.record.image, bytesToBase64(image));
  assert.equal(prepared.record.room, room);
  assert.equal(prepared.record.cycle, 8);
  assert.equal(prepared.record.savedAt, 1_757_000_000_000);
  assert.deepEqual(prepared.record.game, { installed: false, identity: target.identity });
  // The source string still embeds the original identity.
  assert.equal(JSON.parse(prepared.raw).game.identity.project, source);
});

test("the selected interpreter falls back to detection when none is chosen", async () => {
  clearStores();
  const rig = await starterRig();
  const source = "detected-profile";
  const { image, room } = starterCheckpoint(rig);
  localValues.set(
    autosaveKey(source),
    checkpointRaw(image, room, { installed: false, identity: sourceGame(source, rig.revision) }),
  );
  const read = await liveRead(source);
  const prepared = await prepareEarlierCheckpoint({
    read,
    entryIndex: 0,
    target: savedTarget(source, rig.revision),
    files: rig.files,
  });
  assert.equal(prepared.profile, "2.936");
});

test("duplicate checkpoint keys stay separate; the index selects the actual entry", async () => {
  clearStores();
  const rig = await starterRig();
  const source = "attic-copy";
  const { image, room } = starterCheckpoint(rig);
  const game = { installed: false, identity: sourceGame(source, rig.revision) };
  const rawA = checkpointRaw(image, room, game, { savedAtHint: "first" });
  const rawB = checkpointRaw(image, room, game, { savedAtHint: "second" });
  // A captured local array is not re-sorted: the checkpoint key can repeat.
  const { read, record } = await captureRead(
    source,
    [
      { key: `monotio_agi.saves.${encodeURIComponent(source)}`, value: "{corrupt" },
      { key: autosaveKey(source), value: rawB },
      { key: `monotio_agi.map.${source}`, value: "not json" },
      { key: autosaveKey(source), value: rawA },
    ],
    [{ key: `history/${source}`, value: { sealed: true } }],
  );

  const choices = listEarlierCheckpoints(read);
  assert.deepEqual(
    choices.map(({ index, key }) => ({ index, key })),
    [
      { index: 1, key: autosaveKey(source) },
      { index: 3, key: autosaveKey(source) },
    ],
  );

  const target = savedTarget("other-attic", rig.revision);
  const prepared = await prepareEarlierCheckpoint({
    read,
    entryIndex: 3,
    target,
    files: rig.files,
    profile: rig.profileId,
  });
  assert.equal(prepared.raw, rawA, "index 3 consumes entry A, never entry B");
  assert.equal(prepared.index, 3);
  assert.deepEqual(prepared.origin, { kind: "capture", key: record.projectId });
  const earlier = await prepareEarlierCheckpoint({
    read,
    entryIndex: 1,
    target,
    files: rig.files,
    profile: rig.profileId,
  });
  assert.equal(earlier.raw, rawB);
});

test("an explicit cross-id destination receives a rebound record; the raw source stays exact", async () => {
  clearStores();
  const rig = await starterRig();
  const source = "old-quest";
  const { image, room } = starterCheckpoint(rig);
  const raw = checkpointRaw(image, room, {
    installed: false,
    identity: sourceGame(source, rig.revision),
  });
  const { read } = await captureRead(source, [{ key: autosaveKey(source), value: raw }]);

  const target = savedTarget("reimported-quest", rig.revision);
  const prepared = await prepareEarlierCheckpoint({
    read,
    entryIndex: 0,
    target,
    files: rig.files,
    profile: rig.profileId,
  });
  assert.deepEqual(prepared.record.game, {
    installed: false,
    identity: { project: requireProjectId("reimported-quest"), revision: rig.revision },
  });
  // The raw string and the source record's embedded identity are untouched.
  assert.equal(prepared.raw, raw);
  assert.equal(parseAutosaveRecord(prepared.raw)?.game.identity.project, source);
});

test("an installed destination rebounds with the installed discriminator", async () => {
  clearStores();
  const rig = await starterRig();
  const source = "folder-quest";
  const { image, room } = starterCheckpoint(rig);
  localValues.set(
    autosaveKey(source),
    checkpointRaw(image, room, {
      installed: false,
      identity: sourceGame(source, rig.revision),
    }),
  );
  const read = await liveRead(source);
  const target = installedProgressTarget({ folder: "Shelf Copy" }, rig.revision);
  assert.ok(target);
  const prepared = await prepareEarlierCheckpoint({
    read,
    entryIndex: 0,
    target,
    files: rig.files,
    profile: rig.profileId,
  });
  assert.equal(prepared.record.game.installed, true);
  assert.deepEqual(prepared.record.game.identity, target.identity);
});

test("changed playable bytes under an identical WORDS.TOK refuse", async () => {
  clearStores();
  const rig = await starterRig();
  const source = "drifting";
  const { image, room } = starterCheckpoint(rig);
  const raw = checkpointRaw(image, room, {
    installed: false,
    identity: sourceGame(source, rig.revision),
  });
  localValues.set(autosaveKey(source), raw);
  const read = await liveRead(source);

  const changed = { ...rig.files };
  const object = new Uint8Array(rig.files["OBJECT"]!);
  object[0]! ^= 0xff;
  changed["OBJECT"] = object;
  assert.deepEqual(changed["WORDS.TOK"], rig.files["WORDS.TOK"], "vocabulary is identical");
  const changedRevision = await gameRevision(changed);
  assert.notEqual(changedRevision, rig.revision);

  // A destination bound to the changed bytes still refuses: the checkpoint
  // was taken under the old revision.
  await assert.rejects(
    prepareEarlierCheckpoint({
      read,
      entryIndex: 0,
      target: savedTarget(source, changedRevision),
      files: changed,
      profile: rig.profileId,
    }),
    /different game data/,
  );
  // A destination whose binding still names the old revision refuses on the
  // supplied bytes before the checkpoint is even compared.
  await assert.rejects(
    prepareEarlierCheckpoint({
      read,
      entryIndex: 0,
      target: savedTarget(source, rig.revision),
      files: changed,
      profile: rig.profileId,
    }),
    /progress binding/,
  );
});

test("unsupported, misassociated and foreign-keyed raw values refuse without writes", async () => {
  clearStores();
  const rig = await starterRig();
  const source = "mixed-raw";
  const { image, room } = starterCheckpoint(rig);
  const valid = checkpointRaw(image, room, {
    installed: false,
    identity: sourceGame(source, rig.revision),
  });
  const target = savedTarget(source, rig.revision);
  const files = rig.files;
  const profile = rig.profileId;

  // Unknown autosave version under the right key.
  const future = JSON.stringify({ ...JSON.parse(valid), version: 99 });
  localValues.set(autosaveKey(source), future);
  let read = await liveRead(source);
  assert.deepEqual(listEarlierCheckpoints(read), []);
  await assert.rejects(
    prepareEarlierCheckpoint({ read, entryIndex: 0, target, files, profile }),
    /autosave record/,
  );

  // A valid record naming different progress data under the right key.
  localValues.set(
    autosaveKey(source),
    checkpointRaw(image, room, {
      installed: false,
      identity: sourceGame("someone-else", rig.revision),
    }),
  );
  read = await liveRead(source);
  assert.deepEqual(listEarlierCheckpoints(read), []);
  await assert.rejects(
    prepareEarlierCheckpoint({ read, entryIndex: 0, target, files, profile }),
    /different progress source/,
  );

  // A valid checkpoint string under a key that is not the source's autosave key.
  const { read: capt } = await captureRead(
    source,
    [
      { key: `monotio_agi.saves.${encodeURIComponent(source)}`, value: valid },
      { key: autosaveKey(`${source}.bak`), value: valid },
    ],
    [],
  );
  assert.deepEqual(listEarlierCheckpoints(capt), []);
  await assert.rejects(
    prepareEarlierCheckpoint({ read: capt, entryIndex: 0, target, files, profile }),
    /not this source's checkpoint/,
  );
  await assert.rejects(
    prepareEarlierCheckpoint({ read: capt, entryIndex: 1, target, files, profile }),
    /not this source's checkpoint/,
  );
});

test("source whitespace and additional fields stay byte-exact", async () => {
  clearStores();
  const rig = await starterRig();
  const source = "kept-fields";
  const { image, room } = starterCheckpoint(rig);
  const raw = checkpointRaw(
    image,
    room,
    { installed: false, identity: sourceGame(source, rig.revision) },
    { note: { kept: [1, 2, "two"] }, "trailing ": true },
    true,
  );
  assert.match(raw, /\n {2}"/, "the stored string is pretty-printed");
  const { read } = await captureRead(source, [{ key: autosaveKey(source), value: raw }], []);
  const before = structuredClone(read);

  const prepared = await prepareEarlierCheckpoint({
    read,
    entryIndex: 0,
    target: savedTarget(source, rig.revision),
    files: rig.files,
    profile: rig.profileId,
  });
  assert.equal(prepared.raw, raw, "the original string is carried unmodified");
  assert.deepEqual(read, before, "the pinned snapshot is untouched");
  // Additional fields are consumed per the existing reader and pass through.
  const rebound = prepared.record as unknown as Record<string, unknown>;
  assert.deepEqual(rebound["note"], { kept: [1, 2, "two"] });
  assert.equal(rebound["trailing "], true);
});

test("unsafe neighbouring capture data neither blocks nor travels with the checkpoint", async () => {
  clearStores();
  const rig = await starterRig();
  const source = "mixed-unsafe";
  const { image, room } = starterCheckpoint(rig);
  const raw = checkpointRaw(image, room, {
    installed: false,
    identity: sourceGame(source, rig.revision),
  });
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  const { read, record } = await captureRead(
    source,
    [
      { key: `monotio_agi.saves.${encodeURIComponent(source)}`, value: "{not json" },
      { key: autosaveKey(source), value: raw },
    ],
    [
      { key: `history/${source}`, value: cyclic },
      { key: `history/${source}/blob/1`, value: { n: 7n } },
      { key: `conversation/${source}`, value: { when: undefined } },
    ],
  );

  const prepared = await prepareEarlierCheckpoint({
    read,
    entryIndex: 1,
    target: savedTarget("safe-elsewhere", rig.revision),
    files: rig.files,
    profile: rig.profileId,
  });
  assert.equal(prepared.raw, raw);
  assert.deepEqual(
    Object.keys(prepared.record).sort(),
    ["cycle", "format", "game", "image", "room", "savedAt", "version"],
    "only autosave fields are adopted",
  );
  const stored = RECORDS.get(record.projectId) as LegacyProgressRecord;
  const held = stored.records[0]!.value as Record<string, unknown>;
  assert.equal(held["self"], held, "the cyclic neighbour is untouched");
});

test("opaque reads — unsupported, unreadable, absent and orphan — offer no checkpoint", async () => {
  clearStores();
  const rig = await starterRig();
  const target = savedTarget("anywhere", rig.revision);
  const files = rig.files;
  const profile = rig.profileId;

  RECORDS.set("legacy-progress/fut/cap", {
    format: "monotio.agi.legacy-progress",
    version: 99,
    payload: { a: 1 },
  });
  const unsupported = await readEarlierProgress({
    kind: "capture",
    recoveryId: "legacy-progress/fut/cap",
  });
  assert.equal(unsupported.kind, "capture");
  assert.equal(unsupported.state, "unsupported");
  assert.deepEqual(listEarlierCheckpoints(unsupported), []);
  await assert.rejects(
    prepareEarlierCheckpoint({ read: unsupported, entryIndex: 0, target, files, profile }),
    /no checkpoint/,
  );

  RECORDS.set("legacy-progress/raw/cap", { format: "other", version: 1 });
  const unreadable = await readEarlierProgress({
    kind: "capture",
    recoveryId: "legacy-progress/raw/cap",
  });
  assert.deepEqual(listEarlierCheckpoints(unreadable), []);
  await assert.rejects(
    prepareEarlierCheckpoint({ read: unreadable, entryIndex: 0, target, files, profile }),
    /no checkpoint/,
  );

  const absent = await readEarlierProgress({
    kind: "capture",
    recoveryId: "legacy-progress/x/gone",
  });
  assert.deepEqual(listEarlierCheckpoints(absent), []);
  await assert.rejects(
    prepareEarlierCheckpoint({ read: absent, entryIndex: 0, target, files, profile }),
    /no checkpoint/,
  );

  // An orphan local row holds valid checkpoint data but no source spelling.
  const { image, room } = starterCheckpoint(rig);
  localValues.set(
    autosaveKey("orphan"),
    checkpointRaw(image, room, {
      installed: false,
      identity: sourceGame("orphan", rig.revision),
    }),
  );
  const orphan = await readEarlierProgress(
    { kind: "local", keys: [autosaveKey("orphan")] },
    { local: localSource() },
  );
  assert.deepEqual(listEarlierCheckpoints(orphan), []);
  await assert.rejects(
    prepareEarlierCheckpoint({ read: orphan, entryIndex: 0, target, files, profile }),
    /no checkpoint/,
  );
});

test("a checkpoint whose stored image does not decode fails verification", async () => {
  clearStores();
  const rig = await starterRig();
  const source = "broken-image";
  const { room } = starterCheckpoint(rig);
  localValues.set(
    autosaveKey(source),
    checkpointRaw(new Uint8Array([1, 2, 3, 4]), room, {
      installed: false,
      identity: sourceGame(source, rig.revision),
    }),
  );
  const read = await liveRead(source);
  // Listing is parse-level; the restore proof belongs to preparation.
  assert.equal(listEarlierCheckpoints(read).length, 1);
  await assert.rejects(
    prepareEarlierCheckpoint({
      read,
      entryIndex: 0,
      target: savedTarget(source, rig.revision),
      files: rig.files,
      profile: rig.profileId,
    }),
    /save image/,
  );
});

test("the destination bytes are owned before the first await", async () => {
  clearStores();
  const rig = await starterRig();
  const source = "borrowed-buffers";
  const { image, room } = starterCheckpoint(rig);
  localValues.set(
    autosaveKey(source),
    checkpointRaw(image, room, {
      installed: false,
      identity: sourceGame(source, rig.revision),
    }),
  );
  const read = await liveRead(source);
  const files = { ...rig.files };
  const pending = prepareEarlierCheckpoint({
    read,
    entryIndex: 0,
    target: savedTarget(source, rig.revision),
    files,
    profile: rig.profileId,
  });
  files["OBJECT"]!.fill(0xee);
  const prepared = await pending;
  assert.equal(prepared.record.room, room, "the pre-await byte copy proves restore");
});

test("listing and preparation change no storage and no snapshot", async () => {
  clearStores();
  const rig = await starterRig();
  const source = "frozen";
  const { image, room } = starterCheckpoint(rig);
  const raw = checkpointRaw(image, room, {
    installed: false,
    identity: sourceGame(source, rig.revision),
  });
  localValues.set(autosaveKey(source), raw);
  localValues.set(`monotio_agi.map.${source}`, "{corrupt");
  RECORDS.set(`history/${source}`, { format: "h", version: 1 });

  const read = await liveRead(source);
  const before = structuredClone(read);
  const beforeRecords = [...RECORDS.entries()].map(([key, value]) => [key, structuredClone(value)]);
  const beforeLocal = [...localValues.entries()];

  const choices = listEarlierCheckpoints(read);
  assert.equal(choices.length, 1);
  const prepared = await prepareEarlierCheckpoint({
    read,
    entryIndex: 0,
    target: savedTarget("new-home", rig.revision),
    files: rig.files,
    profile: rig.profileId,
  });
  assert.equal(prepared.raw, raw);
  assert.deepEqual(
    [...RECORDS.entries()].map(([key, value]) => [key, structuredClone(value)]),
    beforeRecords,
  );
  assert.deepEqual([...localValues.entries()], beforeLocal);
  assert.deepEqual(read, before);
});
