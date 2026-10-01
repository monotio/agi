/**
 * Imported sidecars land under the published body's bound progress target:
 * slots, autosave, map and tape all write to the `project:<id>:<epoch>`
 * locator of the body that was actually stored — never the released bare
 * project id and never a fabricated key — and a body that cannot be bound
 * reports every carried sidecar refused instead of writing anywhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { addLibraryGame } from "../src/library/gameLibrary.ts";
import { bindSavedProgressTarget } from "../src/project/progressBinding.ts";
import {
  loadAuthoredGame,
  readHistoryLifetime,
  saveAuthoredGame,
} from "../src/project/gameStorage.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import { buildProjectZip } from "../src/archive/projectArchive.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { openContainer } from "../../src/container/container.ts";
import { HISTORY_FORMAT_VERSION, stampBoot } from "../../src/agent/history.ts";
import type { ProjectHistory } from "../src/archive/historyArchive.ts";
import {
  readGameProgress,
  writeAutosave,
  type AutosaveRecord,
  type ImportStorageReport,
} from "../src/saves/gameProgress.ts";
import { writeGameSave } from "../src/saves/gameSaves.ts";
import { readMapSidecar, writeMapSidecar } from "../src/world/roomMapStore.ts";
import type { RoomMapSidecar } from "../../src/agent/roomMap.ts";
import { importGameHistory, loadProjectHistory } from "../src/history/historyStorage.ts";

const records = installIndexedDbFixture();
const local = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => void local.set(key, value),
    removeItem: (key: string) => void local.delete(key),
  },
});

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const OPENING = {
  preview: "data:image/png;base64,iVBORw0KGgo=",
  status: "ready" as const,
  message: "Opening checked.",
  profile: "2.936",
};

const HOST = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

/**
 * A saved native Starter project that has actually been played: a real
 * engine slot image and autosave envelope, a map sidecar and a recorded
 * tape — all stored under the source body's bound target, the way Play
 * leaves them — and its complete project archive.
 */
async function playedSource(title: string) {
  const seed = prepareLocalProject({ title, kind: "starter" });
  assert.equal(await saveAuthoredGame(seed.projectId, seed.data()), true);
  const stored = (await loadAuthoredGame(seed.projectId))!;
  const profile = stored.library?.profile;
  const engine = new Engine(
    openContainer(new Map(Object.entries(stored.files)), profile ? { profile } : {}),
    HOST,
    new Map(stored.words),
    profile ? { profile } : undefined,
  );
  for (let i = 0; i < 8 && !engine.autosaveImage(); i++) engine.tick();
  const image = engine.autosaveImage();
  assert.ok(image, "the starter draws a resumable room");
  const slot = engine.serialize();
  const source = await bindSavedProgressTarget(seed.projectId);
  assert.ok(source);
  assert.equal(source.identity.project, seed.projectId);
  assert.equal(source.bodyEpoch, await readHistoryLifetime(seed.projectId));
  const autosave: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    image: toBase64(image),
    cycle: 8,
    room: engine.readState().room,
    savedAt: 1_757_000_000_000,
    game: { installed: false, identity: source.identity },
  };
  assert.equal(writeGameSave(localStorage, source.locator, 3, toBase64(slot)), true);
  assert.ok(writeAutosave(localStorage, source, autosave));
  const map: RoomMapSidecar = {
    journal: [
      {
        seq: 0,
        session: 1,
        from: null,
        to: 0,
        cause: "boot",
        cycle: 1,
        resourceSet: source.identity.revision,
        scoreDelta: 0,
        gained: [],
        lost: [],
      },
    ],
    discovered: { rooms: { "0": 1 }, edges: [] },
    layout: { "0": { x: 40, y: 24 } },
    notes: { "0": "First clearing." },
    edgeNotes: {},
  };
  assert.equal(writeMapSidecar(localStorage, source.locator, map), true);
  const tape: ProjectHistory = {
    recording: {
      version: HISTORY_FORMAT_VERSION,
      identity: source.identity,
      profile: "2.936",
      resourceSet: source.identity.revision,
      startedAt: 1_757_000_000_000,
      segments: [
        {
          id: "session.1",
          boot: stampBoot({
            files: Object.fromEntries(
              Object.entries(stored.files).map(([name, bytes]) => [name, toBase64(bytes)]),
            ),
            dictionary: [...stored.words],
            authorRooms: false,
            rng: 7,
            soundDevice: 1,
            resourceSet: source.identity.revision,
            requestSerial: 0,
          }),
          anchors: [],
          events: [{ seq: 0, tick: 3, cycle: 3, cause: { kind: "key" as const, code: 65 } }],
          marks: [],
          sync: [],
        },
      ],
    },
  };
  assert.equal(await importGameHistory(source, tape, source.bodyEpoch), true);
  const progress = readGameProgress(localStorage, source);
  const archive = await buildProjectZip(stored, progress, map, tape);
  return { seed, stored, source, slot, autosave, map, tape, archive };
}

test("an imported Starter project lands its progress, map and tape under the published body's bound target", async () => {
  records.clear();
  local.clear();
  const { seed, stored, source, slot, autosave, map, tape, archive } =
    await playedSource("Source garden");

  let report: ImportStorageReport | undefined;
  const importedId = await addLibraryGame(
    await readGameZip(archive),
    "Imported garden",
    "zip",
    OPENING,
    undefined,
    (r) => (report = r),
  );
  assert.notEqual(importedId, seed.projectId);

  // The published body binds to its own live epoch — the receipt the write
  // committed, not a guess and never "initial".
  const target = await bindSavedProgressTarget(importedId);
  assert.ok(target);
  assert.equal(target.identity.project, importedId);
  assert.equal(target.identity.revision, await gameRevision(stored.files));
  assert.equal(target.bodyEpoch, await readHistoryLifetime(importedId));
  assert.notEqual(target.bodyEpoch, "initial");

  // Slots and the autosave sit under the bound locator, re-addressed to the
  // imported identity.
  const progress = readGameProgress(localStorage, target);
  assert.deepEqual(progress.saves["3"], slot);
  assert.equal(progress.autosave?.image, autosave.image);
  assert.deepEqual(progress.autosave?.game, { installed: false, identity: target.identity });
  assert.deepEqual(readMapSidecar(localStorage, target.locator), map);
  const landed = await loadProjectHistory(target.locator);
  assert.equal(landed?.recording.segments.length, 1);
  assert.deepEqual(landed?.recording.identity, target.identity);

  // Nothing lands under the released bare project id.
  assert.deepEqual(readGameProgress(localStorage, importedId), { saves: {}, autosave: null });
  for (const prefix of ["monotio_agi.saves.", "monotio_agi.autosave.", "monotio_agi.map."])
    assert.equal(local.get(`${prefix}${importedId}`), undefined, prefix);
  assert.equal(records.has(`history/${importedId}`), false);
  // The writes that did land carry the physical locator spelling.
  assert.ok(local.has(`monotio_agi.saves.${encodeURIComponent(target.locator)}`));
  assert.ok(local.has(`monotio_agi.autosave.${target.locator}`));
  assert.ok(local.has(`monotio_agi.map.${target.locator}`));
  assert.equal(records.has(`history/${target.locator}`), true);

  assert.deepEqual(report?.slots, [3]);
  assert.deepEqual(report?.failedSlots, []);
  assert.equal(report?.autosave?.image, autosave.image);
  assert.deepEqual(report?.autosave?.game, { installed: false, identity: target.identity });
  assert.equal(report?.map, true);
  assert.equal(report?.history, true);

  // The source body's own sidecars are untouched by the import.
  const sourceAfter = readGameProgress(localStorage, source);
  assert.deepEqual(sourceAfter.saves["3"], slot);
  assert.equal(sourceAfter.autosave?.image, autosave.image);
  assert.deepEqual(readMapSidecar(localStorage, source.locator), map);
  assert.deepEqual(
    (await loadProjectHistory(source.locator))?.recording.segments,
    tape.recording.segments,
  );
});

test("an import whose published body cannot be bound reports every carried sidecar refused and writes none", async (t) => {
  records.clear();
  local.clear();
  const { archive } = await playedSource("Refused garden");

  // The body's lifetime receipt reads as a removed lifetime — the state a
  // concurrent delete leaves — so the freshly published body cannot be
  // bound to a live target.
  const rawGet = records.get.bind(records);
  t.after(() => {
    records.get = rawGet;
  });
  records.get = ((key: IDBValidKey) =>
    typeof key === "string" && key.startsWith("lifetime/imported-")
      ? {
          projectId: key.slice("lifetime/".length),
          epoch: crypto.randomUUID(),
          deleted: true,
        }
      : rawGet(key)) as typeof records.get;

  let report: ImportStorageReport | undefined;
  const importedId = await addLibraryGame(
    await readGameZip(archive),
    "Refused import",
    "zip",
    OPENING,
    undefined,
    (r) => (report = r),
  );
  // The body itself published; only its sidecars are refused.
  assert.ok(await loadAuthoredGame(importedId));
  assert.deepEqual(report, {
    slots: [],
    failedSlots: [3],
    autosave: null,
    map: false,
    history: false,
  });
  // Nothing was written to progress storage under any spelling — no bare
  // id, no fabricated locator, no tape records. (The `monotio_agi.authored.`
  // index entry is the published body itself, which did land.)
  for (const prefix of ["monotio_agi.saves.", "monotio_agi.autosave.", "monotio_agi.map."])
    assert.deepEqual(
      [...local.keys()].filter((key) => key.startsWith(prefix) && key.includes(importedId)),
      [],
      prefix,
    );
  assert.deepEqual(
    [...records.keys()].filter(
      (key) => typeof key === "string" && key.startsWith("history/") && key.includes(importedId),
    ),
    [],
  );
  assert.equal(
    await bindSavedProgressTarget(importedId),
    null,
    "the doctored receipt still refuses",
  );
});
