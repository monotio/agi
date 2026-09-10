import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { readGameFiles, readGameZip } from "../src/gameZip.ts";
import { gameRevision, normalizeLibraryMetadata, readPublicMetadata } from "../src/gameMetadata.ts";
import { addLibraryGame, copyLibraryGame } from "../src/gameLibrary.ts";
import { loadAuthoredGame, updateAuthoredGameFiles } from "../src/gameStorage.ts";
import { inspectGame } from "../src/gameInspection.ts";
import { buildPublicGameZip } from "../src/projectArchive.ts";
import {
  readGameProgress,
  type AutosaveRecord,
  type GameProgress,
  type ImportStorageReport,
} from "../src/gameProgress.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

installIndexedDbFixture();

function game(
  source = 'display(5, 2, "Hello apprentice"); accept.input(); return;',
): Record<string, Uint8Array> {
  const c = createContainer();
  c.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  return { ...Object.fromEntries(c.files), "WORDS.TOK": buildWordsTok([]) };
}

function installLocalStorage(t: { after(callback: () => void): void }): void {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        values.set(key, value);
        Object.defineProperty(this, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      },
      removeItem(key: string): void {
        values.delete(key);
        Reflect.deleteProperty(this, key);
      },
    },
  });
}

const opening = {
  preview: "data:image/png;base64,iVBORw0KGgo=",
  status: "ready" as const,
  message: "Opening checked.",
  profile: "2.936",
};

test("folder and ZIP resource identity is independent of path, case and entry order", async () => {
  const files = game();
  const folder = readGameFiles(
    new Map(Object.entries(files).map(([n, b]) => [`My Game/${n.toLowerCase()}`, b])),
  );
  assert.deepEqual(folder.files, files);
  assert.equal(
    await gameRevision(folder.files),
    await gameRevision(Object.fromEntries(Object.entries(files).reverse())),
  );
  assert.equal(
    await gameRevision(folder.files),
    await gameRevision(
      Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name.toLowerCase(), bytes])),
    ),
  );
  const changed = game('display(5, 2, "Different game"); return;');
  assert.notEqual(await gameRevision(changed), await gameRevision(files));
  assert.throws(
    () => readGameFiles(new Map([...Object.entries(files), ["other/LOGDIR", files["LOGDIR"]!]])),
    /one AGI game/,
  );
  assert.throws(
    () => readGameFiles(new Map([...Object.entries(files), ["logdir", files["LOGDIR"]!]])),
    /Duplicate/,
  );
});

test("opening inspection captures real text and rejects missing boot resources and runaway logic", () => {
  const opened = readGameFiles(new Map(Object.entries(game())));
  const result = inspectGame(opened);
  assert.equal(result.status, "ready");
  assert.ok(result.rows.join(" ").includes("Hello apprentice"));
  assert.equal(result.rgba.length, 320 * 200 * 4);
  assert.throws(
    () => inspectGame(readGameFiles(new Map(Object.entries(game("call(99); return;"))))),
    /logic.*99/i,
  );
  assert.throws(
    () => inspectGame(readGameFiles(new Map(Object.entries(game("loop: goto loop;"))))),
    /budget/i,
  );
});

test("public metadata is versioned, bounded and cannot carry private history or local validation", () => {
  assert.deepEqual(readPublicMetadata({ format: "monotio.agi", version: 1, title: "Game" }), {
    title: "Game",
    roomGeneration: false,
    metadata: {},
  });
  assert.throws(
    () => readPublicMetadata({ format: "monotio.agi", version: 99, title: "Future" }),
    /version/i,
  );
  for (const blank of ["", "   ", "\n\t"]) {
    assert.equal(
      readPublicMetadata({ format: "monotio.agi", version: 1, title: blank }).title,
      undefined,
      `A blank title ${JSON.stringify(blank)} falls back to the importer's name.`,
    );
  }
  assert.equal(
    readPublicMetadata({ format: "monotio.agi", version: 1, title: "  Padded  " }).title,
    "Padded",
  );
  assert.equal(
    readPublicMetadata({ format: "monotio.agi", version: 1, title: "x".repeat(200) }).title,
    "x".repeat(160),
  );
  const metadata = readPublicMetadata({
    format: "monotio.agi",
    version: 1,
    title: "Game",
    metadata: {
      description: "A room",
      author: "Author",
      license: "MIT",
      transcript: ["private"],
      preview: "https://tracker.example/image",
      validation: { status: "ready" },
    },
  });
  assert.deepEqual(metadata.metadata, { description: "A room", author: "Author", license: "MIT" });
  assert.equal(
    normalizeLibraryMetadata(
      { version: 1, source: "toString" },
      { gameId: "safe", revision: "1".repeat(64), source: "zip" },
    ).source,
    "zip",
  );
});

test("malformed public metadata reports a useful import error", () => {
  assert.throws(
    () =>
      readGameFiles(
        new Map([...Object.entries(game()), ["GAME.JSON", new TextEncoder().encode("{")]]),
      ),
    /GAME\.JSON contains invalid JSON\. Obtain a fresh copy of the game or correct its metadata\./,
  );
});

test("ZIP and folder imports deduplicate the same resources and normalize room generation", async (t) => {
  installLocalStorage(t);
  const files = game();
  const zipGame = await readGameZip(buildPublicGameZip({ title: "ZIP title", files }));
  const folderGame = readGameFiles(
    new Map(
      Object.entries(zipGame.files).map(([name, bytes]) => [`Folder/${name.toLowerCase()}`, bytes]),
    ),
  );
  const zipGameId = await addLibraryGame(zipGame, "ZIP title", "zip", opening);
  const folderGameId = await addLibraryGame(folderGame, "Folder title", "folder", opening);
  assert.equal(folderGameId, zipGameId);
  assert.equal(
    await addLibraryGame({ files: zipGame.files, words: zipGame.words }, "No flag", "zip", opening),
    zipGameId,
  );
  assert.equal((await loadAuthoredGame(zipGameId))?.title, "ZIP title");
});

test("room authoring is kept only for project imports, never from public metadata", async (t) => {
  installLocalStorage(t);
  const files = game();
  const publicGameId = await addLibraryGame(
    { files, words: [], roomGeneration: true },
    "Public claim",
    "zip",
    opening,
  );
  assert.equal((await loadAuthoredGame(publicGameId))?.roomGeneration, false);
  const projectGameId = await addLibraryGame(
    {
      files,
      words: [],
      roomGeneration: true,
      project: { provider: "stub", model: "one", transcript: [{ role: "user", content: "one" }] },
    },
    "Own project",
    "zip",
    opening,
  );
  assert.equal((await loadAuthoredGame(projectGameId))?.roomGeneration, true);
  const catalogGameId = await addLibraryGame(
    { files, words: [], roomGeneration: true },
    "Hosted",
    "catalog",
    opening,
    { id: "hosted", version: "1.0.0" },
  );
  assert.equal((await loadAuthoredGame(catalogGameId))?.roomGeneration, false);
});

test("project imports with identical resources retain separate private histories", async (t) => {
  installLocalStorage(t);
  const files = game();
  const first = await addLibraryGame(
    {
      files,
      words: [],
      project: { provider: "stub", model: "one", transcript: [{ role: "user", content: "one" }] },
    },
    "First project",
    "zip",
    opening,
  );
  const second = await addLibraryGame(
    {
      files,
      words: [],
      project: { provider: "stub", model: "two", transcript: [{ role: "user", content: "two" }] },
    },
    "Second project",
    "zip",
    opening,
  );
  assert.notEqual(second, first);
  assert.equal((await loadAuthoredGame(first))?.model, "one");
  assert.equal((await loadAuthoredGame(second))?.model, "two");
});

test("a remix copy gets independent identity and bytes while preserving its original", async (t) => {
  installLocalStorage(t);
  const originalGameId = await addLibraryGame(
    { files: game(), words: [] },
    "Garden",
    "zip",
    opening,
  );
  const before = (await loadAuthoredGame(originalGameId))!;
  const copyGameId = await copyLibraryGame(originalGameId);
  const copy = (await loadAuthoredGame(copyGameId))!;
  assert.notEqual(copy.library?.gameId, before.library?.gameId);
  assert.deepEqual(copy.library?.parent, {
    gameId: before.library?.gameId,
    revision: before.library?.revision,
  });
  assert.equal(
    await updateAuthoredGameFiles(copyGameId, {
      ...copy.files,
      "VOL.0": Uint8Array.of(...copy.files["VOL.0"]!, 1),
    }),
    true,
  );
  assert.deepEqual((await loadAuthoredGame(originalGameId))!, before);
});

test("catalog resources cannot be overwritten in place", async (t) => {
  installLocalStorage(t);
  const errors: string[] = [];
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
  });
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  const gameId = await addLibraryGame(
    { files: game(), words: [] },
    "Catalog game",
    "catalog",
    opening,
    { id: "garden", version: "1" },
  );
  const before = (await loadAuthoredGame(gameId))!;
  assert.equal(
    await updateAuthoredGameFiles(gameId, {
      ...before.files,
      "VOL.0": Uint8Array.of(...before.files["VOL.0"]!, 1),
    }),
    false,
  );
  assert.deepEqual(await loadAuthoredGame(gameId), before);
  assert.match(errors.join("\n"), /Catalog resources are immutable/);
});

test("catalog identity remains stable across separately stored releases", async (t) => {
  installLocalStorage(t);
  const first = await addLibraryGame(
    { files: game(), words: [] },
    "Catalog game",
    "catalog",
    opening,
    { id: "garden", version: "1" },
  );
  const second = await addLibraryGame(
    { files: game('display(5, 2, "New release"); return;'), words: [] },
    "Catalog game",
    "catalog",
    opening,
    { id: "garden", version: "2" },
  );
  assert.notEqual(second, first);
  assert.equal(
    (await loadAuthoredGame(second))?.library?.gameId,
    (await loadAuthoredGame(first))?.library?.gameId,
  );
  assert.equal((await loadAuthoredGame(first))?.library?.catalog?.version, "1");
  assert.equal((await loadAuthoredGame(second))?.library?.catalog?.version, "2");
});

test("trusted catalog projects deduplicate while imported project archives remain separate", async (t) => {
  installLocalStorage(t);
  const catalogGame = {
    files: game(),
    words: [] as [string, number][],
    project: {
      provider: "stub",
      model: "tutorial",
      transcript: [] as unknown[],
      authoringState: { sources: { logics: [[0, 'display(5, 2, "Hello apprentice"); return;']] } },
    },
  };
  const first = await addLibraryGame(catalogGame, "Tutorial", "catalog", opening, {
    id: "tutorial",
    version: "1",
  });
  const repeated = await addLibraryGame(catalogGame, "Tutorial", "catalog", opening, {
    id: "tutorial",
    version: "1",
  });
  assert.equal(repeated, first);
});

test("import stores saves and autosave without a progress observer", async (t) => {
  installLocalStorage(t);
  const container = createContainer();
  container.putResource("picture", 0, Uint8Array.of(0xff));
  container.putResource(
    "logic",
    0,
    assembleLogic("load.pic(v0); draw.pic(v0); show.pic(); return;", { dictionary: new Map() })
      .payload,
  );
  const engine = new Engine(container, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  });
  engine.tick();
  const image = engine.autosaveImage();
  assert.ok(image);
  const slot = engine.serialize();
  const files = Object.fromEntries(container.files);
  const progress: GameProgress = {
    saves: { "3": slot },
    autosave: {
      format: "monotio.agi.autosave",
      version: 1,
      image: toBase64(image),
      cycle: 1,
      room: 0,
      savedAt: 1757000000000,
      game: { projectId: "source", installed: false, revision: "ab".repeat(32) },
    },
  };
  const projectId = await addLibraryGame(
    { files, words: [], progress },
    "No observer",
    "zip",
    opening,
  );
  const stored = readGameProgress(localStorage, projectId);
  assert.deepEqual(stored.saves["3"], slot);
  assert.equal(stored.autosave?.image, progress.autosave?.image);
  assert.equal(stored.autosave?.game.projectId, projectId);
  assert.equal(stored.autosave?.game.revision, await gameRevision(files));
});

test("import reports which progress entries browser storage refused", async (t) => {
  installLocalStorage(t);
  // A game the engine has played one cycle, saved as a slot and an autosave.
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) { set(f200); assignn(v0, 1); new.room.v(v0); } call.v(v0); return;`,
      { dictionary: new Map() },
    ).payload,
  );
  container.putResource(
    "logic",
    1,
    assembleLogic(`load.pic(1); draw.pic(1); show.pic(); accept.input(); return;`, {
      dictionary: new Map(),
    }).payload,
  );
  container.putResource("picture", 1, Uint8Array.of(0xf0, 2, 0xf8, 0, 0, 0xff));
  container.putFile("WORDS.TOK", buildWordsTok([]));
  const engine = new Engine(container, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  });
  engine.tick();
  const slot = engine.serialize();
  const autosave: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    image: toBase64(engine.autosaveImage()!),
    cycle: 1,
    room: 1,
    savedAt: 1_757_000_000_000,
    game: { projectId: "refused", installed: false, revision: "ab".repeat(32) },
  };
  const progress: GameProgress = { saves: { "1": slot, "7": slot }, autosave };
  // Browser storage refuses every progress write after the first. Install a
  // fresh storage object: the suite's IndexedDB fixture proxies localStorage,
  // so patching setItem on it is unreliable.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
  });
  const values = new Map<string, string>();
  let writes = 0;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem(key: string, value: string): void {
        if (key.startsWith("monotio_agi.saves.") || key.startsWith("monotio_agi.autosave")) {
          writes += 1;
          if (writes > 1) throw new Error("quota exceeded");
        }
        values.set(key, value);
      },
      removeItem: (key: string): void => {
        values.delete(key);
      },
    },
  });
  let report: ImportStorageReport | null = null;
  const gameId = await addLibraryGame(
    { files: Object.fromEntries(container.files), words: [], progress },
    "Refused",
    "zip",
    opening,
    undefined,
    (stored) => (report = stored),
  );
  assert.ok(gameId);
  assert.deepEqual(report, { slots: [1], failedSlots: [7], autosave: null });
});
