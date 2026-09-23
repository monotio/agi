import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { testProjectId } from "./identity.ts";
import { requireResourceRevision } from "../../src/gameIdentity.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { readGameFiles, readGameZip } from "../src/gameZip.ts";
import {
  gameRevision,
  isPlayableFileName,
  normalizeLibraryMetadata,
  readPublicMetadata,
} from "../src/gameMetadata.ts";
import { addLibraryGame, copyLibraryGame } from "../src/gameLibrary.ts";
import { loadAuthoredGame, updateAuthoredGameFiles } from "../src/gameStorage.ts";
import { inspectGame } from "../src/gameInspection.ts";
import { stageCharacterView, stagedRefusal, type DecodedImage } from "../src/referenceArt.ts";
import { buildProjectZip, buildPublicGameZip } from "../src/projectArchive.ts";
import {
  readGameProgress,
  type AutosaveRecord,
  type GameProgress,
  type ImportStorageReport,
} from "../src/gameProgress.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import type { CachedGameData } from "../src/gameTypes.ts";

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

  // Authoring records never move the revision: tests, notes, and the map are
  // not part of the canonical playable file set.
  const base = await gameRevision(files);
  for (const extra of ["TESTS.JSON", "NOTES.TXT", "MAP.JSON"]) {
    assert.equal(await gameRevision({ ...files, [extra]: new Uint8Array([1, 2, 3]) }), base);
  }

  // Archive timestamps are irrelevant: the same zip with different mod-time
  // fields reads back to the same revision.
  const zip = buildPublicGameZip({ title: "T", roomGeneration: false, files });
  const stamped = zip.slice();
  const view = new DataView(stamped.buffer, stamped.byteOffset, stamped.byteLength);
  for (let i = 0; i + 4 <= stamped.length; i++) {
    const sig = view.getUint32(i, true);
    if (sig === 0x04034b50) {
      view.setUint16(i + 10, 0xbeef, true); // local header mod time
      view.setUint16(i + 12, 0x7c21, true); // local header mod date
    } else if (sig === 0x02014b50) {
      view.setUint16(i + 12, 0xbeef, true); // central header mod time
      view.setUint16(i + 14, 0x7c21, true); // central header mod date
    }
  }
  assert.notDeepEqual([...stamped], [...zip]);
  assert.equal(
    await gameRevision((await readGameZip(stamped)).files),
    await gameRevision((await readGameZip(zip)).files),
  );
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
    workInProgress: false,
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
      { revision: requireResourceRevision("1".repeat(64)), source: "zip" },
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
  const zipProjectId = await addLibraryGame(zipGame, "ZIP title", "zip", opening);
  const folderProjectId = await addLibraryGame(folderGame, "Folder title", "folder", opening);
  assert.equal(folderProjectId, zipProjectId);
  assert.equal(
    await addLibraryGame({ files: zipGame.files, words: zipGame.words }, "No flag", "zip", opening),
    zipProjectId,
  );
  assert.equal((await loadAuthoredGame(zipProjectId))?.title, "ZIP title");
});

test("room authoring is kept only for project imports, never from public metadata", async (t) => {
  installLocalStorage(t);
  const files = game();
  const publicProjectId = await addLibraryGame(
    { files, words: [], roomGeneration: true },
    "Public claim",
    "zip",
    opening,
  );
  assert.equal((await loadAuthoredGame(publicProjectId))?.roomGeneration, false);
  const projectProjectId = await addLibraryGame(
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
  assert.equal((await loadAuthoredGame(projectProjectId))?.roomGeneration, true);
  const catalogProjectId = await addLibraryGame(
    { files, words: [], roomGeneration: true },
    "Hosted",
    "catalog",
    opening,
    { id: "hosted", version: "1.0.0" },
  );
  assert.equal((await loadAuthoredGame(catalogProjectId))?.roomGeneration, false);
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

/** A decoded upload without DOM — the smallest sheet stageCharacterView accepts. */
function decodedSheet(): DecodedImage {
  const width = 64;
  const height = 12;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = Math.floor(x / 16);
      const lx = x - cell * 16;
      const figure = lx >= 5 && lx < 11 && y >= 2;
      rgba.set(figure ? [0xff, 0, 0, 0xff] : [0xff, 0, 0xff, 0xff], (y * width + x) * 4);
    }
  }
  return { width, height, rgba, mime: "image/png", bytes: Uint8Array.of(1, 2, 3) };
}

test("import and copy rebind a verified staged reference; a stale one keeps its refusal", async (t) => {
  installLocalStorage(t);
  const files = game();
  const revision = await gameRevision(files);
  // Attached to a different project, at this revision — the candidate is
  // verified-current wherever these exact bytes land.
  const staged = stageCharacterView(
    "ref-move",
    0,
    "the hero",
    { project: testProjectId("elsewhere"), revision },
    [{ decoded: decodedSheet(), facing: "right" }],
    { poses: 4 },
  );
  const stale = stageCharacterView(
    "ref-stale",
    0,
    "an old draft",
    { project: testProjectId("elsewhere"), revision: requireResourceRevision("0".repeat(64)) },
    [{ decoded: decodedSheet(), facing: "right" }],
    { poses: 4 },
  );
  const importedId = await addLibraryGame(
    {
      files,
      words: [],
      project: {
        provider: "stub",
        model: "stub",
        transcript: [],
        references: [staged, stale],
      },
    },
    "Imported",
    "zip",
    opening,
  );
  const imported = (await loadAuthoredGame(importedId))!;
  const [rebound, stillStale] = imported.references!;
  // The import's fresh project id adopts the verified candidate — Keep can
  // proceed — while the stale draft stays refused.
  assert.equal(
    stagedRefusal(rebound!, { project: importedId, revision: imported.library!.revision }),
    null,
  );
  assert.equal(rebound!.origin?.project, testProjectId("elsewhere"));
  assert.notEqual(stagedRefusal(stillStale!, { project: importedId, revision }), null);

  // The same contract on copy: the remix's new identity takes the verified
  // candidate.
  const copyId = await copyLibraryGame(importedId);
  const copy = (await loadAuthoredGame(copyId))!;
  assert.equal(
    stagedRefusal(copy.references![0]!, {
      project: copyId,
      revision: copy.library!.revision,
    }),
    null,
  );
  assert.notEqual(
    stagedRefusal(copy.references![1]!, { project: copyId, revision: copy.library!.revision }),
    null,
  );
});

test("exports ship stored bytes; a supplied OBJECT keeps current staging and refuses stale staging through repeated imports and copies", async (t) => {
  installLocalStorage(t);
  // Stored bytes ship as they are, slack after the last record included: an
  // untouched original exports as the same bytes and the same revision.
  const exported = (await readGameZip(buildPublicGameZip({ files: game(), title: "Port" }))).files;
  const slack = { ...exported, "VOL.0": Uint8Array.of(...exported["VOL.0"]!, 1, 2, 3, 4) };
  assert.deepEqual(
    (await readGameZip(buildPublicGameZip({ files: slack, title: "Port" }))).files,
    slack,
  );
  // Export supplies a missing OBJECT, which moves the revision.
  const { OBJECT: _object, ...files } = exported;
  const originalIdentity = {
    project: testProjectId("objectless"),
    revision: await gameRevision(files),
  };
  // This old attachment already equals the exported revision. Export must
  // preserve its refusal rather than accidentally reviving it on import.
  const staleIdentity = { ...originalIdentity, revision: await gameRevision(exported) };
  assert.notEqual(originalIdentity.revision, staleIdentity.revision);
  const fresh = stageCharacterView(
    "fresh",
    0,
    "hero",
    originalIdentity,
    [{ decoded: decodedSheet(), facing: "right" }],
    { poses: 4 },
  );
  const stale = stageCharacterView(
    "stale",
    0,
    "old hero",
    staleIdentity,
    [{ decoded: decodedSheet(), facing: "right" }],
    { poses: 4 },
  );
  let project: CachedGameData = {
    projectId: originalIdentity.project,
    title: "Port",
    provider: "stub",
    model: "offline-stub",
    authoredAt: "2026-09-16",
    files,
    words: [] as [string, number][],
    transcript: [],
    references: [fresh, stale],
  };
  for (let round = 0; round < 2; round++) {
    const opened = await readGameZip(await buildProjectZip(project));
    assert.deepEqual(opened.files, exported, "export adds only the missing OBJECT");
    const importedId = await addLibraryGame(opened, "Port", "zip", opening);
    const imported = (await loadAuthoredGame(importedId))!;
    for (const candidate of [
      imported,
      (await loadAuthoredGame(await copyLibraryGame(importedId)))!,
    ]) {
      const identity = {
        project: candidate.projectId,
        revision: await gameRevision(candidate.files),
      };
      assert.equal(stagedRefusal(candidate.references![0]!, identity), null);
      assert.deepEqual(candidate.references![0]!.origin, originalIdentity);
      assert.deepEqual(candidate.references![0]!.staged, fresh.staged);
      assert.match(
        stagedRefusal(candidate.references![1]!, identity)!,
        /changed since this reference/,
      );
      assert.deepEqual(candidate.references![1]!.attachedAt, staleIdentity);
    }
    project = imported;
  }
  assert.deepEqual(fresh.attachedAt, originalIdentity, "export does not mutate live staging");
  assert.equal(fresh.origin, undefined);
});

test("a remix copy gets independent identity and bytes while preserving its original", async (t) => {
  installLocalStorage(t);
  const originalProjectId = await addLibraryGame(
    { files: game(), words: [] },
    "Garden",
    "zip",
    opening,
  );
  const before = (await loadAuthoredGame(originalProjectId))!;
  const copyProjectId = await copyLibraryGame(originalProjectId);
  const copy = (await loadAuthoredGame(copyProjectId))!;
  assert.notEqual(copy.projectId, before.projectId);
  assert.deepEqual(copy.library?.parent, {
    project: before.projectId,
    revision: before.library?.revision,
  });
  assert.equal(
    await updateAuthoredGameFiles(copyProjectId, {
      ...copy.files,
      "VOL.0": Uint8Array.of(...copy.files["VOL.0"]!, 1),
    }),
    true,
  );
  assert.deepEqual((await loadAuthoredGame(originalProjectId))!, before);
});

test("catalog resources cannot be overwritten in place", async (t) => {
  installLocalStorage(t);
  const errors: string[] = [];
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
  });
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  const projectId = await addLibraryGame(
    { files: game(), words: [] },
    "Catalog game",
    "catalog",
    opening,
    { id: "garden", version: "1" },
  );
  const before = (await loadAuthoredGame(projectId))!;
  assert.equal(
    await updateAuthoredGameFiles(projectId, {
      ...before.files,
      "VOL.0": Uint8Array.of(...before.files["VOL.0"]!, 1),
    }),
    false,
  );
  assert.deepEqual(await loadAuthoredGame(projectId), before);
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
    (await loadAuthoredGame(second))?.library?.catalog?.id,
    (await loadAuthoredGame(first))?.library?.catalog?.id,
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
      game: {
        installed: false,
        identity: {
          project: testProjectId("source"),
          revision: requireResourceRevision("ab".repeat(32)),
        },
      },
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
  assert.equal(stored.autosave?.game.identity.project, projectId);
  assert.equal(stored.autosave?.game.identity.revision, await gameRevision(files));
});

test("an interpreter override travels with both exports and decodes the saves they carry", async (t) => {
  installLocalStorage(t);
  // A synthetic v2 game boots 2.936 by default. The player chose 2.089,
  // whose save has another block-1 layout (0x3db bytes, not 0x5e1), so a
  // slot written under the override is unreadable under detection.
  const container = createContainer();
  container.putResource("picture", 0, Uint8Array.of(0xff));
  container.putResource(
    "logic",
    0,
    assembleLogic("load.pic(v0); draw.pic(v0); show.pic(); return;", { dictionary: new Map() })
      .payload,
  );
  container.putFile("WORDS.TOK", buildWordsTok([]));
  const host = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  };
  const engine = new Engine(container, host, undefined, { profile: "2.089" });
  engine.tick();
  const slot = engine.serialize();
  const files = Object.fromEntries(container.files);
  const data: CachedGameData = {
    projectId: testProjectId("override"),
    title: "Override",
    provider: "stub",
    model: "offline-stub",
    authoredAt: "2026-09-23",
    files,
    words: [],
    transcript: [],
    library: {
      version: 1,
      revision: await gameRevision(files),
      source: "zip",
      profile: "2.089",
      validation: { status: "unverified", message: "Opening not checked yet." },
    },
  };
  const progress: GameProgress = { saves: { "1": slot }, autosave: null };
  assert.equal((await readGameZip(buildPublicGameZip(data))).profile, "2.089");
  const project = await readGameZip(await buildProjectZip(data, progress));
  assert.equal(project.profile, "2.089");
  assert.deepEqual(project.progress?.saves["1"], slot);
  const id = await addLibraryGame(project, "Override", "zip", opening);
  assert.equal((await loadAuthoredGame(id))?.library?.profile, "2.089");
  // Detection alone refuses the same slot.
  const automatic = { ...data, library: { ...data.library!, profile: undefined } };
  const plain = await buildProjectZip(automatic, progress);
  assert.equal(new TextDecoder().decode(plain).includes('"profile"'), false);
  await assert.rejects(readGameZip(plain), /SAVES\/SG\.1 is not a save file for this game/);
  // An interpreter this build does not ship is newer data: a Game or Project
  // naming one is refused before anything is staged, saves or not, rather
  // than played under another interpreter that would drop the choice.
  const future = {
    ...data,
    // The export's own OBJECT, so no fallback runs under the unknown id.
    files: { ...files, OBJECT: project.files["OBJECT"]! },
    library: { ...data.library!, profile: "9.999" as never },
  };
  for (const archive of [buildPublicGameZip(future), await buildProjectZip(future, progress)])
    await assert.rejects(
      readGameZip(archive),
      /asks for interpreter 9\.999, which this version of the app does not know\. Update the app/,
    );
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
    game: {
      installed: false,
      identity: {
        project: testProjectId("refused"),
        revision: requireResourceRevision("ab".repeat(32)),
      },
    },
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
  const projectId = await addLibraryGame(
    { files: Object.fromEntries(container.files), words: [], progress },
    "Refused",
    "zip",
    opening,
    undefined,
    (stored) => (report = stored),
  );
  assert.ok(projectId);
  assert.deepEqual(report, { slots: [1], failedSlots: [7], autosave: null });
});

test("imports keep port executables and the IIgs wavetable under canonical names", async () => {
  // The Amiga hunk magic, a SYS16 stand-in and a wavetable stand-in: bytes
  // only need to survive import, not run.
  const ports = {
    Sierra: Uint8Array.of(0, 0, 3, 0xf3),
    "sq2.sys16": Uint8Array.of(1, 2, 3),
    sierrastandard: Uint8Array.of(4, 5, 6),
  };
  const opened = readGameFiles(
    new Map(
      [...Object.entries(game()), ...Object.entries(ports)].map(([n, b]) => [`Port/${n}`, b]),
    ),
  );
  assert.deepEqual(opened.files["SIERRA"], ports.Sierra);
  assert.deepEqual(opened.files["SQ2.SYS16"], ports["sq2.sys16"]);
  assert.deepEqual(opened.files["SIERRASTANDARD"], ports.sierrastandard);
  // Identity ignores spelling: the same bytes under the native and the
  // canonical names are one revision.
  assert.equal(await gameRevision({ ...game(), ...ports }), await gameRevision(opened.files));
  // Two spellings of one playable name are a duplicate, not two files.
  await assert.rejects(
    gameRevision({ ...game(), Sierra: ports.Sierra, SIERRA: ports.Sierra }),
    /Duplicate game resource name/,
  );
});

test("the resource revision is pinned: SHA-256 over the canonical playable set", async () => {
  // Stored autosaves, catalog entries, references and walkthroughs all keep
  // a revision, so its input and packing are part of the 1.0 contract. Each
  // playable file contributes, in code-point order of its canonical name, a
  // u32be name length, a u32be byte length, the ASCII name and the bytes;
  // authoring sidecars and other files do not contribute.
  const files = {
    "sq2.sys16": Uint8Array.of(4),
    Sierra: Uint8Array.of(1),
    dirs: Uint8Array.of(2, 3),
    sierrastandard: Uint8Array.of(5, 6, 7),
    "TESTS.JSON": Uint8Array.of(9),
    "ReadMe.txt": Uint8Array.of(8),
  };
  const packed = Buffer.concat(
    (
      [
        ["DIR", [2, 3]],
        ["SIERRA", [1]],
        ["SIERRASTANDARD", [5, 6, 7]],
        ["SQ2.SYS16", [4]],
      ] as const
    ).map(([name, bytes]) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(name.length, 0);
      head.writeUInt32BE(bytes.length, 4);
      return Buffer.concat([head, Buffer.from(name, "ascii"), Buffer.from(bytes)]);
    }),
  );
  assert.equal(await gameRevision(files), createHash("sha256").update(packed).digest("hex"));
});

test("an archive declaring another interpreter imports as its own entry; one declaring none keeps the stored choice", async (t) => {
  installLocalStorage(t);
  // Automatic first, then the same bytes declaring 2.089: a separate entry,
  // the first untouched.
  const files = game('display(5, 2, "declared"); return;');
  const automaticId = await addLibraryGame({ files, words: [] }, "Automatic", "zip", opening);
  const automatic = await loadAuthoredGame(automaticId);
  const declaredId = await addLibraryGame(
    { files, words: [], profile: "2.089" },
    "Declared",
    "zip",
    opening,
  );
  assert.notEqual(declaredId, automaticId);
  assert.equal((await loadAuthoredGame(declaredId))?.library?.profile, "2.089");
  assert.deepEqual(await loadAuthoredGame(automaticId), automatic, "the first entry is untouched");
  // The same declaration again is the same entry.
  assert.equal(
    await addLibraryGame({ files, words: [], profile: "2.089" }, "Again", "zip", opening),
    declaredId,
  );
  // Declared first, then the same bytes declaring nothing: nothing different
  // is asked for, so the entry and its choice are reused as they are.
  const other = game('display(5, 2, "declared first"); return;');
  const firstId = await addLibraryGame(
    { files: other, words: [], profile: "2.089" },
    "First",
    "zip",
    opening,
  );
  const first = await loadAuthoredGame(firstId);
  assert.equal(await addLibraryGame({ files: other, words: [] }, "Plain", "zip", opening), firstId);
  assert.deepEqual(await loadAuthoredGame(firstId), first);
});

test("an unfinished world stays marked through every import and export, and never gains generation", async (t) => {
  installLocalStorage(t);
  const creator = {
    projectId: testProjectId("growing"),
    title: "Growing",
    provider: "stub",
    model: "offline-stub",
    authoredAt: "2026-09-23",
    files: game(),
    words: [] as [string, number][],
    transcript: [],
    roomGeneration: true,
  };
  // The creator's project keeps growing wherever it is imported, and says
  // it is unfinished.
  const project = await readGameZip(await buildProjectZip(creator));
  const continued = (await loadAuthoredGame(
    await addLibraryGame(project, "Growing", "zip", opening),
  ))!;
  assert.equal(continued.roomGeneration, true);
  assert.equal(continued.library?.workInProgress, true);

  // Creator → Game export → recipient: unfinished, and never generating.
  const published = await readGameZip(buildPublicGameZip(creator));
  assert.equal(published.workInProgress, true);
  let recipient = (await loadAuthoredGame(
    await addLibraryGame(published, "Growing", "zip", opening),
  ))!;
  assert.equal(recipient.library?.workInProgress, true);
  assert.equal(recipient.roomGeneration, false, "a public claim never enables authoring");

  // Recipient → Game and Project export → fresh import, twice over.
  for (let hop = 0; hop < 2; hop++) {
    for (const archive of [buildPublicGameZip(recipient), await buildProjectZip(recipient)]) {
      const opened = await readGameZip(archive);
      assert.equal(opened.workInProgress, true, `hop ${hop}: the archive says unfinished`);
      assert.equal(opened.roomGeneration, false, `hop ${hop}: and does not claim generation`);
    }
    const next = await readGameZip(await buildProjectZip(recipient));
    recipient = (await loadAuthoredGame(await addLibraryGame(next, `Hop ${hop}`, "zip", opening)))!;
    assert.equal(recipient.library?.workInProgress, true, `hop ${hop}: still unfinished`);
    assert.equal(recipient.roomGeneration, false, `hop ${hop}: still not generating`);
  }
});

test("a ZIP made by macOS Finder imports despite its AppleDouble metadata", () => {
  // Finder's Compress adds __MACOSX/<folder>/._<name> resource forks beside
  // every file; ._LOGDIR ends in DIR and once read as a second game root.
  const files = Object.entries(game());
  const opened = readGameFiles(
    new Map([
      ...files.map(([n, b]): [string, Uint8Array] => [`quest/${n}`, b]),
      ...files.map(([n]): [string, Uint8Array] => [`__MACOSX/quest/._${n}`, Uint8Array.of(0, 5)]),
      ["quest/._LOGDIR", Uint8Array.of(0, 5)],
    ]),
  );
  assert.deepEqual(Object.keys(opened.files).sort(), files.map(([n]) => n).sort());
});

test("interpreter executables stay in the playable file set so detection can read them", () => {
  for (const name of ["AGI", "AGIDATA.OVL", "SIERRA.COM", "GR", "Sierra", "mh2", "SQ2.SYS16"])
    assert.equal(isPlayableFileName(name), true, name);
  for (const name of [
    "GR.info",
    "Disk.info",
    "Pointer",
    "README.TXT",
    "SQ2.1",
    "../SIERRA.COM",
    "a/b.SYS16",
    "x?.COM",
    ".COM",
  ])
    assert.equal(isPlayableFileName(name), false, name);
});
