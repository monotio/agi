import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import {
  decodeHostImage,
  decodeSave,
  encodeHostImage,
  encodeSave,
} from "../src/runtime/persistence.ts";
import { detectProfile } from "../src/runtime/profile.ts";
import {
  autosaveKey,
  parseAutosaveRecord,
  readGameProgress,
  storeImportedProgress,
  type AutosaveRecord,
  type GameProgress,
} from "../app/src/gameProgress.ts";
import { readGameSaves } from "../app/src/gameSaves.ts";
import { gameRevision } from "../app/src/gameMetadata.ts";
import { readGameZip } from "../app/src/gameZip.ts";
import { buildProjectZip, buildPublicGameZip } from "../app/src/projectArchive.ts";
import { buildZip, type ZipFileInput } from "../app/src/zip.ts";
import type { CachedGameData } from "../app/src/gameTypes.ts";

/**
 * A player's progress travels with the project archive only: the numbered
 * slots as the interpreter's own save files, the autosave as the app's record.
 * A published game carries neither. Every image here is one the engine wrote.
 */
const host: EngineHost = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};
const DICT = new Map([["look", 10]]);
const REVISION_A = "ab".repeat(32);
const REVISION_B = "cd".repeat(32);

function game() {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) { set(f200); assignn(v0, 1); new.room.v(v0); } call.v(v0); return;`,
      { dictionary: DICT },
    ).payload,
  );
  container.putResource(
    "logic",
    1,
    assembleLogic(
      `if (isset(f5)) { load.pic(1); draw.pic(1); show.pic(); accept.input(); } return;`,
      {
        dictionary: DICT,
      },
    ).payload,
  );
  container.putResource("picture", 1, Uint8Array.of(0xf0, 2, 0xf8, 0, 0, 0xff));
  container.putFile("WORDS.TOK", buildWordsTok([{ word: "look", id: 10 }]));
  return container;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** Entry names of an uncompressed PKZIP archive, read from its central directory. */
function zipNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= 0; at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  assert.notEqual(end, -1, "the archive has an end-of-directory record");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const names: string[] = [];
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, "central directory entry");
    const nameLength = view.getUint16(at + 28, true);
    names.push(decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)));
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return names;
}

/** A game the engine has played one cycle, with a slot save and an autosave of that moment. */
function played(): { files: Record<string, Uint8Array>; progress: GameProgress } {
  const container = game();
  const engine = new Engine(container, host, DICT);
  engine.tick();
  const slot = engine.serialize();
  const autosave: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    image: toBase64(engine.autosaveImage()!),
    cycle: 1,
    room: 1,
    savedAt: 1_757_000_000_000,
    game: { gameId: "on-the-laptop", installed: false, revision: REVISION_A },
  };
  return {
    files: Object.fromEntries(container.files),
    progress: { saves: { "1": slot, "7": slot }, autosave },
  };
}

function cachedGame(files: Record<string, Uint8Array>): CachedGameData {
  return {
    projectId: "on-the-laptop",
    title: "Laptop",
    authoredAt: "2026-09-07T00:00:00.000Z",
    provider: "stub",
    model: "local-playback",
    files,
    words: [["look", 10]],
  };
}

function archiveEntries(files: Record<string, Uint8Array>, project: boolean): ZipFileInput[] {
  const entries: ZipFileInput[] = Object.entries(files).map(([name, data]) => ({ name, data }));
  entries.push({
    name: "GAME.JSON",
    data: JSON.stringify({ format: "monotio.agi", version: 1, title: "Laptop" }),
  });
  if (project)
    entries.push({
      name: "PROJECT.JSON",
      data: JSON.stringify({
        format: "monotio.agi.project",
        version: 1,
        provider: "stub",
        model: "local-playback",
        conversation: { formatVersion: 1, messages: [] },
        authoringState: {},
      }),
    });
  return entries;
}

test("the project archive carries the slots and the autosave; the game export carries neither", async () => {
  const { files, progress } = played();
  const project = await readGameZip(await buildProjectZip(cachedGame(files), progress));
  assert.deepEqual(Object.keys(project.progress?.saves ?? {}), ["1", "7"]);
  assert.deepEqual(Array.from(project.progress!.saves["7"]!), Array.from(progress.saves["7"]!));
  assert.deepEqual(project.progress?.autosave, progress.autosave);
  const publishedBytes = buildPublicGameZip(cachedGame(files));
  assert.ok(!new TextDecoder().decode(publishedBytes).includes("SAVES/"), "no SAVES/ entry");
  assert.equal((await readGameZip(publishedBytes)).progress, undefined);
  // A project without progress writes no SAVES/ folder either.
  const empty = await readGameZip(
    await buildProjectZip(cachedGame(files), { saves: {}, autosave: null }),
  );
  assert.equal(empty.progress, undefined);
});

test("SAVES/ counts only beside PROJECT.JSON, ignores other names, and refuses what is not a save", async () => {
  const { files, progress } = played();
  const slot: ZipFileInput = { name: "SAVES/SG.1", data: progress.saves["1"]! };
  const published = await readGameZip(buildZip([...archiveEntries(files, false), slot]));
  assert.equal(published.progress, undefined, "a published game's archive has no progress");
  const project = archiveEntries(files, true);
  const withSlot = await readGameZip(buildZip([...project, slot]));
  assert.deepEqual(Object.keys(withSlot.progress!.saves), ["1"]);
  assert.equal(withSlot.progress!.autosave, null);
  const extras = await readGameZip(
    buildZip([
      ...project,
      slot,
      { name: "SAVES/README.TXT", data: "notes" },
      { name: "SAVES/SG.13", data: progress.saves["1"]! },
    ]),
  );
  assert.deepEqual(Object.keys(extras.progress!.saves), ["1"], "SG.13 and notes are not slots");
  await assert.rejects(
    readGameZip(buildZip([...project, { name: "SAVES/SG.3", data: Uint8Array.of(1, 2, 3) }])),
    /SAVES\/SG\.3 is not a save file/,
  );
  await assert.rejects(
    readGameZip(buildZip([...project, { name: "SAVES/AUTOSAVE.JSON", data: "{}" }])),
    /SAVES\/AUTOSAVE\.JSON is not an autosave record/,
  );
  const foreign = { ...progress.autosave!, image: toBase64(Uint8Array.of(9, 9, 9)) };
  await assert.rejects(
    readGameZip(
      buildZip([...project, { name: "SAVES/AUTOSAVE.JSON", data: JSON.stringify(foreign) }]),
    ),
    /does not hold a save image/,
  );
});

test("a malformed-base64 autosave image fails with the SAVES/AUTOSAVE.JSON import error", async () => {
  const { files, progress } = played();
  const malformed = { ...progress.autosave!, image: "%%%" };
  const entries = archiveEntries(files, true);
  entries.push({ name: "SAVES/AUTOSAVE.JSON", data: JSON.stringify(malformed) });
  await assert.rejects(
    readGameZip(buildZip(entries)),
    /SAVES\/AUTOSAVE\.JSON does not hold a save image for this game/,
  );
});

test("imported progress is stored under the library game ID and re-addressed to it", () => {
  const { progress } = played();
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
  };
  const report = storeImportedProgress(storage, "imported-1234", REVISION_B, progress);
  assert.deepEqual(report.slots, [1, 7]);
  assert.deepEqual(report.failedSlots, []);
  assert.deepEqual(Object.keys(readGameSaves(storage, "imported-1234")), ["1", "7"]);
  const stored = parseAutosaveRecord(storage.getItem("monotio_agi.autosave.imported-1234"));
  assert.deepEqual(stored?.game, {
    gameId: "imported-1234",
    installed: false,
    revision: REVISION_B,
  });
  assert.equal(stored?.image, progress.autosave!.image);
  assert.deepEqual(report.autosave, stored, "the report carries the record as stored");
  // What the export reads back is what was stored.
  const back = readGameProgress(storage, "imported-1234");
  assert.deepEqual(Array.from(back.saves["1"]!), Array.from(progress.saves["1"]!));
  assert.deepEqual(back.autosave, stored);
  // Another game's autosave under this game ID's key is not this game's progress.
  backing.set(
    "monotio_agi.autosave.imported-1234",
    JSON.stringify({ ...progress.autosave, game: { ...progress.autosave!.game, gameId: "other" } }),
  );
  assert.equal(readGameProgress(storage, "imported-1234").autosave, null);
  assert.equal(parseAutosaveRecord("{"), null);
  assert.equal(parseAutosaveRecord({ format: "monotio.agi.autosave", version: 2 }), null);
});

test("import rejects progress whose resource replay does not execute against the imported game", async () => {
  const { files, progress } = played();
  const project = archiveEntries(files, true);
  const profile = detectProfile(new Map(Object.entries(files)));
  const state = decodeSave(progress.saves["1"]!, profile);
  assert.ok(state.replayActive > 0, "the fixture save has a replay sequence");
  // Structural decode still passes for every corruption below; only executing
  // the replay against the imported archive exposes it.
  const missing = decodeSave(progress.saves["1"]!, profile);
  missing.replay[0] = { kind: 2, value: 99 }; // load.pic of a picture the game does not carry
  const missingBytes = encodeSave(missing, profile);
  decodeSave(missingBytes, profile);
  await assert.rejects(
    readGameZip(buildZip([...project, { name: "SAVES/SG.4", data: missingBytes }])),
    /SAVES\/SG\.4 cannot be restored into this game/,
  );
  const alien = decodeSave(progress.saves["1"]!, profile);
  alien.replay[0] = { kind: 42, value: 0 }; // a replay pair kind the interpreter does not know
  await assert.rejects(
    readGameZip(buildZip([...project, { name: "SAVES/SG.4", data: encodeSave(alien, profile) }])),
    /SAVES\/SG\.4 cannot be restored into this game: unknown replay pair kind 42/,
  );
  // The autosave record decodes and its save image is intact, but the screen
  // sequence it resumes from references a resource the archive does not carry.
  const hostImage = decodeHostImage(fromBase64(progress.autosave!.image));
  const badScreen = encodeHostImage(
    hostImage.image,
    [{ kind: 2, value: 99 }],
    hostImage.presentation,
  );
  const record = { ...progress.autosave!, image: toBase64(badScreen) };
  decodeSave(decodeHostImage(fromBase64(record.image)).image, profile);
  await assert.rejects(
    readGameZip(
      buildZip([...project, { name: "SAVES/AUTOSAVE.JSON", data: JSON.stringify(record) }]),
    ),
    /SAVES\/AUTOSAVE\.JSON cannot be restored into this game/,
  );
});

test("a store that fails mid-import is reported entry by entry; nothing claims to be complete", () => {
  const { progress } = played();
  const backing = new Map<string, string>();
  let writes = 0;
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes += 1;
      if (writes > 1) throw new Error("quota exceeded");
      backing.set(key, value);
    },
  };
  const report = storeImportedProgress(storage, "imported-1234", REVISION_B, progress);
  assert.deepEqual(report, { slots: [1], failedSlots: [7], autosave: null });
  // Storage holds exactly what the report says landed: slot 1, no autosave.
  assert.deepEqual(Object.keys(readGameSaves(storage, "imported-1234")), ["1"]);
  assert.equal(storage.getItem(autosaveKey("imported-1234")), null);
  const back = readGameProgress(storage, "imported-1234");
  assert.deepEqual(Object.keys(back.saves), ["1"]);
  assert.equal(back.autosave, null);
});

test("an imported autosave restores in a real engine boot of the imported game's profile", async () => {
  const { files, progress } = played();
  const imported = await readGameZip(await buildProjectZip(cachedGame(files), progress));
  const dictionary = new Map(imported.words);
  // The host resume path: boot the imported game fresh, then restore the image.
  const resumed = new Engine(
    openContainer(new Map(Object.entries(imported.files))),
    host,
    dictionary,
  );
  resumed.tick();
  resumed.restoreImage(fromBase64(imported.progress!.autosave!.image));
  assert.equal(resumed.profile.id, "2.936");
  assert.equal(resumed.vars[0], 1, "the restored game is in room 1, not a fresh boot");
  assert.notEqual(resumed.flags[200], 0, "the flag the game's logic set survives the trip");
  // A numbered slot image restores the same way.
  const fromSlot = new Engine(
    openContainer(new Map(Object.entries(imported.files))),
    host,
    dictionary,
  );
  fromSlot.restoreImage(imported.progress!.saves["7"]!);
  assert.equal(fromSlot.vars[0], 1);
  assert.notEqual(fromSlot.flags[200], 0);
});

test("re-addressing is the revision contract: export compaction makes equality impossible", async () => {
  // A container with orphan volume bytes, as an imported or externally patched
  // game has: packing rewrites the bytes, so a hash of the files cannot survive
  // the export. The save image itself is game data and travels byte for byte.
  const container = game();
  const engine = new Engine(container, host, DICT);
  engine.tick();
  const files = Object.fromEntries(container.files);
  const volume = Object.keys(files).find((name) => name.startsWith("VOL."))!;
  const padded = new Uint8Array(files[volume]!.length + 128);
  padded.set(files[volume]!);
  padded.fill(0xaa, files[volume]!.length);
  files[volume] = padded;
  const preExportRevision = await gameRevision(files);
  const autosave: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    image: toBase64(engine.autosaveImage()!),
    cycle: 1,
    room: 1,
    savedAt: 1_757_000_000_000,
    game: { gameId: "on-the-laptop", installed: false, revision: preExportRevision },
  };
  const progress: GameProgress = { saves: { "1": engine.serialize() }, autosave };
  const imported = await readGameZip(await buildProjectZip(cachedGame(files), progress));
  // The record crosses the archive still naming the pre-compaction revision…
  assert.equal(imported.progress?.autosave?.game.revision, preExportRevision);
  // …but the export compacted the container, so the imported files hash to a
  // different revision: enforcing equality would reject every such project.
  const importedRevision = await gameRevision(imported.files);
  assert.notEqual(importedRevision, preExportRevision);
  // The save image needs no such check: it is identical after the trip.
  assert.equal(imported.progress?.autosave?.image, autosave.image);
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
  };
  const report = storeImportedProgress(
    storage,
    "imported-xyz",
    importedRevision,
    imported.progress!,
  );
  assert.equal(report.autosave?.game.revision, importedRevision);
  assert.equal(report.autosave?.image, autosave.image);
});

test("the public export excludes tests, saves and authoring context — one check per exclusion", async () => {
  const { files, progress } = played();
  const withTests = {
    ...files,
    "TESTS.JSON": new TextEncoder().encode(
      JSON.stringify({ format: "monotio.agi.tests.v1", tests: [] }),
    ),
  };
  const names = zipNames(buildPublicGameZip(cachedGame(withTests)));
  assert.ok(!names.includes("TESTS.JSON"), "tests travel with the project archive only");
  assert.ok(
    !names.some((name) => name.startsWith("SAVES/")),
    "saves travel with the project archive only",
  );
  assert.ok(
    !names.includes("PROJECT.JSON") && !names.some((name) => name.startsWith("IMAGES/")),
    "authoring context travels with the project archive only",
  );
  // The checks are not vacuous: the project archive carries all three.
  const projectNames = zipNames(await buildProjectZip(cachedGame(withTests), progress));
  assert.ok(projectNames.includes("TESTS.JSON"));
  assert.ok(projectNames.includes("SAVES/SG.1") && projectNames.includes("SAVES/AUTOSAVE.JSON"));
  assert.ok(projectNames.includes("PROJECT.JSON"));
});
