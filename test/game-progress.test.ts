import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import {
  parseAutosaveRecord,
  readGameProgress,
  storeImportedProgress,
  type AutosaveRecord,
  type GameProgress,
} from "../app/src/gameProgress.ts";
import { readGameSaves } from "../app/src/gameSaves.ts";
import { readGameZip } from "../app/src/gameZip.ts";
import { buildProjectZip, buildPublicGameZip } from "../app/src/projectArchive.ts";
import { buildZip, type ZipFileInput } from "../app/src/zip.ts";
import type { CachedCartridgeData } from "../app/src/cartridgeTypes.ts";

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
    game: { slug: "on-the-laptop", installed: false, revision: REVISION_A },
  };
  return {
    files: Object.fromEntries(container.files),
    progress: { saves: { "1": slot, "7": slot }, autosave },
  };
}

function cartridge(files: Record<string, Uint8Array>): CachedCartridgeData {
  return {
    slug: "on-the-laptop",
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
  const project = await readGameZip(await buildProjectZip(cartridge(files), progress));
  assert.deepEqual(Object.keys(project.progress?.saves ?? {}), ["1", "7"]);
  assert.deepEqual(Array.from(project.progress!.saves["7"]!), Array.from(progress.saves["7"]!));
  assert.deepEqual(project.progress?.autosave, progress.autosave);
  const publishedBytes = buildPublicGameZip(cartridge(files));
  assert.ok(!new TextDecoder().decode(publishedBytes).includes("SAVES/"), "no SAVES/ entry");
  assert.equal((await readGameZip(publishedBytes)).progress, undefined);
  // A project without progress writes no SAVES/ folder either.
  const empty = await readGameZip(
    await buildProjectZip(cartridge(files), { saves: {}, autosave: null }),
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

test("imported progress is stored under the library slug and re-addressed to it", () => {
  const { progress } = played();
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
  };
  storeImportedProgress(storage, "imported-1234", REVISION_B, progress);
  assert.deepEqual(Object.keys(readGameSaves(storage, "imported-1234")), ["1", "7"]);
  const stored = parseAutosaveRecord(storage.getItem("monotio_agi.autosave.imported-1234"));
  assert.deepEqual(stored?.game, { slug: "imported-1234", installed: false, revision: REVISION_B });
  assert.equal(stored?.image, progress.autosave!.image);
  // What the export reads back is what was stored.
  const back = readGameProgress(storage, "imported-1234");
  assert.deepEqual(Array.from(back.saves["1"]!), Array.from(progress.saves["1"]!));
  assert.deepEqual(back.autosave, stored);
  // Another game's autosave under this slug's key is not this game's progress.
  backing.set(
    "monotio_agi.autosave.imported-1234",
    JSON.stringify({ ...progress.autosave, game: { ...progress.autosave!.game, slug: "other" } }),
  );
  assert.equal(readGameProgress(storage, "imported-1234").autosave, null);
  assert.equal(parseAutosaveRecord("{"), null);
  assert.equal(parseAutosaveRecord({ format: "monotio.agi.autosave", version: 2 }), null);
});
