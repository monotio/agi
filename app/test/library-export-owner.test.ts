/**
 * Project download ownership: a card's private archive must come from one
 * physical owner — the saved body's exact incarnation (project id + body
 * lifetime epoch + full native revision) — with progress, map, history and
 * Creative evidence read under that owner's typed target, never a bare
 * legacy spelling. A body recreated under the same id while the download
 * prepares must refuse rather than ship a mixed archive.
 *
 * Everything runs against real stored bodies, real assembled resources and
 * the real archive reader; the only seams are the deferred-storage fixture,
 * a fake engine surface the stored path never calls, and the download
 * capture (Blob/anchor) in place of a browser click.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { computeResourceRevision } from "../../src/authoring/resourceRevision.ts";
import { readInventoryObjects } from "../../src/authoring/inventory.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { CREATIVE_SOURCE_FORMAT, type CreativeSource } from "../../src/creative/catalog.ts";
import { stampBoot, type HistoryBoot } from "../../src/agent/history.ts";
import type { RoomMapSidecar } from "../../src/agent/roomMap.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { gameRevision, updateBootedResources } from "../src/project/gameMetadata.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import { bindSavedProgressTarget } from "../src/project/progressBinding.ts";
import { markRemoved } from "../src/project/projectTransaction.ts";
import type { GameIdentity } from "../../src/gameIdentity.ts";
import {
  installedProgressTarget,
  projectProgressTarget,
  type ProgressTarget,
  type ProjectProgressTarget,
} from "../src/project/progressTarget.ts";
import {
  commitProject,
  getCachedGameMeta,
  loadAuthoredGameWithHistoryLifetime,
  removeProjectWithProgress,
  saveAuthoredGame,
  updateAuthoredGameFiles,
} from "../src/project/gameStorage.ts";
import { stageCreativeBlobs } from "../src/project/creativeStore.ts";
import { captureCreativeProject } from "../src/project/creativeProjectSnapshot.ts";
import { importGameHistory, type ProjectHistory } from "../src/history/historyStorage.ts";
import { autosaveKey, writeAutosave, type AutosaveRecord } from "../src/saves/gameProgress.ts";
import { writeGameSave } from "../src/saves/gameSaves.ts";
import { emptyMapSidecar, readMapSidecar, writeMapSidecar } from "../src/world/roomMapStore.ts";
import type { EngineApi } from "../src/engine/engineContext.ts";
import type { AiSettingsApi } from "../src/settings/useAiSettings.ts";
import { createShellBridge } from "../src/shell/shellBridge.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";

// gameTemplates.ts loads the bundled adventure briefs as `?raw` text — a
// Vite transform Node does not know. The controller paths under test never
// read them, so each resolves to an empty string module. The writer hook
// parks `collectProjectArchiveEntries` mid-flight when a test installs
// `globalThis.__exportOwnerHeldWriter` — the same real await the browser
// crosses while ZIP entries are collected — so a test can recreate or
// remove the owner during genuine asynchronous preparation, not a
// shortcut around it.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("?raw")) return { url: `test-raw:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("test-raw:"))
      return { format: "module", source: 'export default "";', shortCircuit: true };
    if (!url.endsWith("/src/archive/projectArchiveWriter.ts")) return nextLoad(url, context);
    const result = nextLoad(url, context);
    const source =
      typeof result.source === "string"
        ? result.source
        : result.source instanceof Uint8Array
          ? new TextDecoder().decode(result.source)
          : null;
    if (source === null) return result;
    return {
      format: result.format,
      source:
        source +
        `
;{
  const __collectProjectArchiveEntries = collectProjectArchiveEntries;
  collectProjectArchiveEntries = async (...args) => {
    const gate = globalThis.__exportOwnerHeldWriter;
    if (gate) {
      gate.entered = true;
      await gate.wait;
    }
    return __collectProjectArchiveEntries(...args);
  };
}`,
      shortCircuit: true,
    };
  },
});

/** A gate parked inside the real ZIP writer's entry collection. */
function holdArchiveWriter(): { held(): Promise<void>; release(): void } {
  let release!: () => void;
  const gate = { entered: false, wait: new Promise<void>((resolve) => (release = resolve)) };
  (globalThis as { __exportOwnerHeldWriter?: typeof gate }).__exportOwnerHeldWriter = gate;
  return {
    async held() {
      for (let i = 0; i < 10_000 && !gate.entered; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(gate.entered, "the export reached the real writer boundary");
    },
    release: () => {
      Reflect.deleteProperty(globalThis, "__exportOwnerHeldWriter");
      release();
    },
  };
}

const { createGameLibrary } = await import("../src/library/useGameLibrary.ts");

const records = installIndexedDbFixture();

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
      clear(): void {
        values.clear();
      },
    },
  });
}

/** The anchor click becomes a captured download the test decodes itself. */
function installDownloads(t: { after(callback: () => void): void }): {
  downloads: { name: string; bytes: () => Promise<Uint8Array> }[];
} {
  const downloads: { name: string; bytes: () => Promise<Uint8Array> }[] = [];
  const urls = new Map<string, Blob>();
  const createUrl = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeUrl = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  t.after(() => {
    if (createUrl) Object.defineProperty(URL, "createObjectURL", createUrl);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (revokeUrl) Object.defineProperty(URL, "revokeObjectURL", revokeUrl);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      const url = `download://${downloads.length + urls.size}`;
      urls.set(url, blob);
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: () => {},
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement() {
        const anchor = {
          href: "",
          download: "",
          click(): void {
            const blob = urls.get(anchor.href);
            assert.ok(blob !== undefined, "the anchor carries the produced archive");
            downloads.push({
              name: anchor.download,
              bytes: async () => new Uint8Array(await blob.arrayBuffer()),
            });
          },
        };
        return anchor;
      },
    },
  });
  return { downloads };
}

/** Stored-body teardown with an inert storage, mirroring the pending-offer suite. */
function cleanupAfter(t: { after(callback: () => void): void }): {
  later(fn: () => Promise<unknown>): void;
} {
  const queue: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
      },
    });
    try {
      for (const run of queue) await run();
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
  return { later: (fn) => queue.push(fn) };
}

const HOST = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

/**
 * A hand-computed empty OBJECT under "Avis Durgan": the plaintext image is
 * `[0, 0, 0xff]` (empty u16 name table, terminating free byte 255), XORed
 * with the key's first three bytes `0x41 0x76 0x69`. The writer's
 * supplyInventory synthesis must never add a second one.
 */
const EMPTY_OBJECT = Uint8Array.of(0x41, 0x76, 0x96);

/** A real assembled v2 game: container bytes plus the shared vocabulary file. */
function gameContainer(
  source = "load.pic(v0); draw.pic(v0); show.pic(); accept.input(); return;",
): { container: ReturnType<typeof createContainer>; files: Record<string, Uint8Array> } {
  const container = createContainer();
  container.putResource("picture", 0, Uint8Array.of(0xff));
  container.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  container.putFile("OBJECT", EMPTY_OBJECT);
  container.putFile("WORDS.TOK", buildWordsTok([]));
  return { container, files: Object.fromEntries(container.files) };
}
assert.deepEqual(
  readInventoryObjects(EMPTY_OBJECT, PROFILES["2.936"]),
  [],
  "the hand-computed OBJECT is a real encrypted empty inventory",
);

/** Real checkpoint material for one assembled game, produced by a real Engine. */
function playOnce(container: ReturnType<typeof createContainer>): {
  slot: string;
  autosaveImage: string;
} {
  const engine = new Engine(container, HOST);
  engine.tick();
  const slot = engine.serialize();
  const image = engine.autosaveImage();
  assert.ok(image !== null, "the fixture game must reach a resumable boundary");
  return { slot: bytesToB64(slot), autosaveImage: bytesToB64(image) };
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A real autosave record that embeds its target's own identity. */
function autosaveFor(target: ProgressTarget, room: number, image: string): AutosaveRecord {
  return {
    format: "monotio.agi.autosave",
    version: 1,
    image,
    cycle: room * 10,
    room,
    savedAt: 1_700_000_000_000 + room,
    game: { installed: target.kind === "installed", identity: target.identity },
  };
}

const BOOT: HistoryBoot = stampBoot({
  files: { "VOL.0": "eA==" },
  dictionary: [],
  authorRooms: false,
  rng: 7,
  soundDevice: 1,
  resourceSet: "rev-1",
  requestSerial: 0,
});

function importedTape(target: ProgressTarget): ProjectHistory {
  return {
    recording: {
      version: 1,
      identity: target.identity,
      profile: "2.936",
      resourceSet: "rev-1",
      startedAt: 1_757_000_000_000,
      segments: [{ id: "imp.s1", boot: BOOT, anchors: [], events: [], marks: [], sync: [] }],
    },
  };
}

function mapWith(note: string): RoomMapSidecar {
  return { ...emptyMapSidecar(), notes: { "7": note } };
}

/** The stored sidecar the real roomMap returns for a target it has not loaded. */
function storedSidecar(target: string): RoomMapSidecar {
  try {
    return readMapSidecar(localStorage, target);
  } catch {
    return emptyMapSidecar();
  }
}

/**
 * The smallest EngineApi surface the stored-download path reaches. Every
 * worker/live method is inert here: a card export never pauses the engine,
 * flushes autosave or queries a worker.
 */
function fakeEngine(): EngineApi {
  const api = {
    state: {
      installedGames: [] as never[],
      powerUp: { busy: false },
      phase: "idle",
      profile: null,
      staleTab: false,
      walkthrough: { active: false },
    },
    resumeAudio: () => Promise.resolve(),
    bootGame: () => Promise.resolve(),
    bootAuthoredGame: () => Promise.resolve(),
    resumeLastGame: () => Promise.resolve(true),
    resumeFromRecord: () => Promise.resolve(true),
    startOver: () => Promise.resolve(),
    currentGame: () => null,
    getBootedGame: () => null,
    flushAutosave: () => Promise.resolve(true),
    exportCurrentGame: () => Promise.reject(new Error("unused")),
    pauseEngine: () => {},
    resumeEngine: () => {},
    drainHistoryCommits: () => Promise.resolve(),
    recoverHistory: () => Promise.resolve({ batches: [], boot: null, cycle: 0, room: 0 }),
    roomMap: { storedSidecar },
  } as unknown as EngineApi;
  return api;
}

const ai = {
  llmConfig: () => ({ provider: "stub", apiKey: "", model: "offline-stub" }),
  openAiSettings: () => {},
  aiConfigured: { value: true },
} as unknown as AiSettingsApi;

function library(engine: EngineApi): ReturnType<typeof createGameLibrary> {
  return createGameLibrary(engine, ai, createShellBridge());
}

/**
 * A live engine surface that answers as one real runtime. `game.booted` is
 * the runtime's own boot object — the same reference the controller must
 * still hold at the download boundary — and `recoverHistory` replays a
 * HistoryBoot stamped on the container bytes the runtime actually booted,
 * with a checkpoint image a real Engine produced. Swap `game.booted` to
 * move the runtime, or override `exportTarget` to make the worker answer
 * for another binding.
 */
function liveEngine(opts: {
  files: Record<string, Uint8Array>;
  image: string;
  target: ProgressTarget | undefined;
  installed?: { folder: string; hash?: string; alias?: string };
  parent?: GameIdentity;
  projectId?: string;
  title?: string;
  words?: [string, number][];
  authoredGame?: Record<string, unknown>;
  generation?: number;
  creative?: { kept: number };
  library?: { profile?: string; revision?: string; source?: string };
  bootFiles?: Record<string, Uint8Array>;
  bootDictionary?: [string, number][];
  bootProfile?: string;
  cycle?: number;
  room?: number;
  flush?: () => Promise<boolean>;
  exportTarget?: ProgressTarget | undefined;
}): { engine: EngineApi; game: { booted: object | null } } {
  const revision = computeResourceRevision(opts.files);
  const projectId = opts.installed
    ? opts.target!.identity.project
    : (opts.projectId ?? opts.target?.identity.project ?? testProjectId("live"));
  const data = {
    projectId,
    title: opts.title ?? "Live game",
    provider: "stub",
    model: "2.936",
    authoredAt: "",
    files: opts.files,
    words: opts.words ?? [],
    ...(opts.generation !== undefined ? { generation: opts.generation } : {}),
    ...(opts.creative ? { creative: opts.creative } : {}),
    ...(opts.library ? { library: opts.library } : {}),
  };
  const game = {
    booted: {
      installed: opts.installed !== undefined,
      title: opts.title ?? "Live game",
      revision,
      files: opts.files,
      words: opts.words ?? [],
      progressTarget: opts.target,
      historyLifetime: null,
      ...(opts.parent ? { parent: opts.parent } : {}),
      ...(opts.installed
        ? { folder: opts.installed.folder, hash: opts.installed.hash, alias: opts.installed.alias }
        : { projectId, authoredGame: opts.authoredGame ?? data }),
    } as object | null,
  };
  const boot = stampBoot({
    files: Object.fromEntries(
      Object.entries(opts.bootFiles ?? opts.files).map(([name, bytes]) => [
        name,
        bytesToB64(bytes),
      ]),
    ),
    dictionary: opts.bootDictionary ?? [],
    authorRooms: false,
    ...(opts.bootProfile ? { profile: opts.bootProfile as never } : {}),
    image: opts.image,
    rng: 7,
    soundDevice: 1,
    resourceSet: "rev-1",
    requestSerial: 0,
  });
  const engine = {
    state: {
      installedGames: [] as never[],
      powerUp: { busy: false },
      phase: "running",
      profile: "2.936",
      staleTab: false,
      walkthrough: { active: false },
    },
    resumeAudio: () => Promise.resolve(),
    bootGame: () => Promise.resolve(),
    bootAuthoredGame: () => Promise.resolve(),
    resumeLastGame: () => Promise.resolve(true),
    resumeFromRecord: () => Promise.resolve(true),
    startOver: () => Promise.resolve(),
    // currentGame hands back a fresh DTO each call, like production —
    // nothing downstream may lean on its object identity.
    currentGame: () => (game.booted === null ? null : { ...(game.booted as object) }),
    getBootedGame: () => game.booted,
    flushAutosave: opts.flush ?? (() => Promise.resolve(true)),
    exportCurrentGame: () =>
      Promise.resolve({
        data,
        progressKey: opts.target?.locator ?? projectId,
        progressTarget: "exportTarget" in opts ? opts.exportTarget : opts.target,
      }),
    pauseEngine: () => {},
    resumeEngine: () => {},
    drainHistoryCommits: () => Promise.resolve(),
    recoverHistory: () =>
      Promise.resolve({ batches: [], boot, cycle: opts.cycle ?? 4, room: opts.room ?? 9 }),
    roomMap: { storedSidecar },
  } as unknown as EngineApi;
  return { engine, game };
}

/** A real host checkpoint image for these exact playable bytes. */
function checkpointImage(files: Record<string, Uint8Array>): string {
  const engine = new Engine(openContainer(new Map(Object.entries(files))), HOST);
  engine.tick();
  const image = engine.autosaveImage();
  assert.ok(image !== null, "the fixture game must reach a resumable boundary");
  return bytesToB64(image);
}

test("a stored project archive carries only the card's own physical sidecars", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { container, files } = gameContainer();
  const { slot, autosaveImage } = playOnce(container);
  const id = testProjectId("export-owner");
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Owner game",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  const meta = getCachedGameMeta(id);
  assert.ok(meta !== null);

  // The owner's own records, each under the bound locator.
  assert.ok(writeAutosave(localStorage, target, autosaveFor(target, 7, autosaveImage)));
  assert.equal(writeGameSave(localStorage, target.locator, 2, slot), true);
  assert.equal(writeMapSidecar(localStorage, target.locator, mapWith("own map")), true);
  assert.equal(await importGameHistory(target, importedTape(target)), true);

  // Look-alike records under the released bare-id spelling and a retired
  // epoch: a download must not reach either.
  const decoy = autosaveFor(target, 99, autosaveImage);
  localStorage.setItem(autosaveKey(id), JSON.stringify(decoy));
  assert.equal(writeGameSave(localStorage, id, 5, slot), true);
  assert.equal(writeMapSidecar(localStorage, id, mapWith("not this map")), true);
  const retired = projectProgressTarget(
    id,
    target.identity.revision,
    "11111111-2222-4333-8444-555555555555",
  );
  assert.ok(retired !== null && retired.locator !== target.locator);

  const lib = library(fakeEngine());
  await lib.onExportLibraryGame(meta, true);
  assert.equal(lib.exportRefusal.value, "", "the private download completed without notes");
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0]!.name, `agi-${id}-project.zip`);
  const opened = await readGameZip(await downloads[0]!.bytes());
  assert.deepEqual(opened.progress?.saves["2"] === undefined, false);
  assert.equal(
    opened.progress?.saves["5"],
    undefined,
    "a slot written under the bare legacy id is not this body's",
  );
  assert.equal(opened.progress?.autosave?.room, 7);
  assert.equal(opened.progress?.autosave?.game.installed, false);
  assert.equal(opened.progress?.autosave?.game.identity.project, id);
  assert.equal(opened.progress?.autosave?.game.identity.revision, await gameRevision(files));
  assert.equal(opened.map?.notes["7"], "own map");
  assert.equal(opened.history?.recording.segments.map((s) => s.id).join(","), "imp.s1");
  assert.equal(opened.backupWarning, undefined, "a complete backup carries no warning");
});

test("a stored download refuses when the body is recreated while it prepares", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { files } = gameContainer();
  const id = testProjectId("export-recreated");
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Recreated game",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  const meta = getCachedGameMeta(id);
  assert.ok(meta !== null);

  const lib = library(fakeEngine());
  const running = lib.onExportLibraryGame(meta, true);
  // Delete and recreate the same id with identical bytes while the export's
  // atomic body+lifetime read is still parked: the recreated body owns a new
  // epoch, and the in-flight download may never ship the removed body's
  // archive as if nothing moved.
  await removeProjectWithProgress(target, []);
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Recreated game",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  const recreated = await bindSavedProgressTarget(id);
  assert.ok(recreated !== null && recreated.locator !== target.locator);
  cleanup.later(() => removeProjectWithProgress(recreated, []));
  await running;
  assert.equal(downloads.length, 0, "no archive ships for a body that no longer exists");
  assert.notEqual(lib.exportRefusal.value, "");
});

test("a stored download refuses when the native revision moves while it prepares", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { files } = gameContainer();
  const other = gameContainer('display(5, 2, "Different bytes"); return;').files;
  assert.notEqual(await gameRevision(other), await gameRevision(files));
  const id = testProjectId("export-edited");
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Edited game",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  const meta = getCachedGameMeta(id);
  assert.ok(meta !== null);

  const lib = library(fakeEngine());
  const running = lib.onExportLibraryGame(meta, true);
  // The same body epoch holds, but the playable bytes changed under it: an
  // archive assembled from the earlier read is not this body anymore.
  assert.equal(await updateAuthoredGameFiles(id, other), true);
  await running;
  assert.equal(downloads.length, 0);
  assert.notEqual(lib.exportRefusal.value, "");
});

test("a removed stored body refuses the private download instead of exporting a ghost", async (t) => {
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { files } = gameContainer();
  const id = testProjectId("export-removed");
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Removed game",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  const meta = getCachedGameMeta(id);
  assert.ok(meta !== null);
  await removeProjectWithProgress(target, []);

  const lib = library(fakeEngine());
  await lib.onExportLibraryGame(meta, true);
  assert.equal(downloads.length, 0);
  assert.notEqual(lib.exportRefusal.value, "");
});

test("a stored public export stays a playable game archive — no private entries", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { container, files } = gameContainer();
  const { autosaveImage } = playOnce(container);
  const id = testProjectId("export-public");
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Public game",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  assert.ok(writeAutosave(localStorage, target, autosaveFor(target, 3, autosaveImage)));
  const meta = getCachedGameMeta(id);
  assert.ok(meta !== null);

  const lib = library(fakeEngine());
  await lib.onExportLibraryGame(meta, false);
  assert.equal(lib.exportRefusal.value, "");
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0]!.name, `agi-${id}-game.zip`);
  const opened = await readGameZip(await downloads[0]!.bytes());
  assert.equal(opened.title, "Public game");
  assert.equal(opened.project, undefined);
  assert.equal(opened.progress, undefined, "a public archive never carries saves");
  assert.equal(opened.map, undefined);
  assert.equal(opened.history, undefined);
  assert.deepEqual(opened.files["WORDS.TOK"], files["WORDS.TOK"]);
});

test("selection moving during a held download never redirects it to another body", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const idA = testProjectId("export-card-a");
  const idB = testProjectId("export-card-b");
  assert.equal(
    await saveAuthoredGame(idA, {
      title: "Game A",
      provider: "stub",
      model: "offline-stub",
      files: gameContainer("load.pic(v0); draw.pic(v0); show.pic(); return;").files,
      words: [],
    }),
    true,
  );
  assert.equal(
    await saveAuthoredGame(idB, {
      title: "Game B",
      provider: "stub",
      model: "offline-stub",
      files: gameContainer('display(5, 1, "other"); return;').files,
      words: [],
    }),
    true,
  );
  const targetA = await bindSavedProgressTarget(idA);
  const targetB = await bindSavedProgressTarget(idB);
  assert.ok(targetA !== null && targetB !== null);
  cleanup.later(async () => {
    await removeProjectWithProgress(targetA, []);
    await removeProjectWithProgress(targetB, []);
  });
  const metaA = getCachedGameMeta(idA);
  assert.ok(metaA !== null);

  const lib = library(fakeEngine());
  const running = lib.onExportLibraryGame(metaA, true);
  // The shelf moves to another card while the export's body read is parked.
  lib.selectedProjectId.value = idB;
  await running;
  assert.equal(lib.exportRefusal.value, "");
  assert.equal(downloads.length, 1);
  assert.equal(
    downloads[0]!.name,
    `agi-${idA}-project.zip`,
    "the archive is still card A's — selection is not the download's owner",
  );
  const opened = await readGameZip(await downloads[0]!.bytes());
  assert.equal(opened.title, "Game A");
});

test("a second download while one is in flight refuses rather than doubling the export", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { files } = gameContainer();
  const id = testProjectId("export-busy");
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Busy game",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  const meta = getCachedGameMeta(id);
  assert.ok(meta !== null);

  const lib = library(fakeEngine());
  await Promise.all([lib.onExportLibraryGame(meta, true), lib.onExportLibraryGame(meta, true)]);
  assert.equal(downloads.length, 1, "the overlapping call produced no second archive");
});

test("a stored download refuses when the body is recreated during ZIP entry collection", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { files } = gameContainer();
  const id = testProjectId("export-late-recreate");
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Late recreate",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  const meta = getCachedGameMeta(id);
  assert.ok(meta !== null);

  const lib = library(fakeEngine());
  const held = holdArchiveWriter();
  const running = lib.onExportLibraryGame(meta, true);
  await held.held();
  // The owner is replaced at the deepest real await the download crosses —
  // inside the ZIP writer itself, after every sidecar was already captured.
  // Admission has to hold here, not before the work began.
  await removeProjectWithProgress(target, []);
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Late recreate",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  const recreated = await bindSavedProgressTarget(id);
  assert.ok(recreated !== null && recreated.locator !== target.locator);
  cleanup.later(() => removeProjectWithProgress(recreated, []));
  held.release();
  await running;
  assert.equal(downloads.length, 0, "an archive for a replaced body never reaches the click");
  assert.notEqual(lib.exportRefusal.value, "");
});

test("an installed game's download carries only its own locator's records and its real checkpoint", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { container, files } = gameContainer();
  const { slot, autosaveImage } = playOnce(container);
  const revision = computeResourceRevision(files);
  const targetA = installedProgressTarget({ folder: "games/live-a" }, revision);
  const targetB = installedProgressTarget({ folder: "games/live-b" }, revision);
  assert.ok(targetA !== null && targetB !== null && targetA.locator !== targetB.locator);

  // A saved project colliding on the installed game's logical id: records
  // under its locator and the released bare-id spelling are never A's.
  const savedId = targetA.identity.project;
  assert.equal(
    await saveAuthoredGame(savedId, {
      title: "Same-id saved project",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  const savedTarget = await bindSavedProgressTarget(savedId);
  assert.ok(savedTarget !== null);
  cleanup.later(() => removeProjectWithProgress(savedTarget, []));

  // An installed tape writes under its locator's own lifetime receipt — the
  // epoch a real boot captured beside the binding.
  const aEpoch = crypto.randomUUID();
  records.set(`lifetime/${targetA.locator}`, {
    projectId: targetA.locator,
    epoch: aEpoch,
    deleted: false,
  });
  assert.ok(writeAutosave(localStorage, targetA, autosaveFor(targetA, 7, autosaveImage)));
  assert.equal(writeGameSave(localStorage, targetA.locator, 2, slot), true);
  assert.equal(writeMapSidecar(localStorage, targetA.locator, mapWith("A map")), true);
  assert.equal(await importGameHistory(targetA, importedTape(targetA), aEpoch), true);

  assert.equal(writeGameSave(localStorage, targetB.locator, 5, slot), true);
  assert.equal(writeGameSave(localStorage, savedTarget.locator, 9, slot), true);
  assert.equal(writeGameSave(localStorage, savedId, 4, slot), true);
  assert.equal(writeMapSidecar(localStorage, savedId, mapWith("not A")), true);
  assert.ok(writeAutosave(localStorage, savedTarget, autosaveFor(savedTarget, 99, autosaveImage)));

  const { engine } = liveEngine({
    files,
    image: autosaveImage,
    target: targetA,
    installed: { folder: "games/live-a" },
    title: "Installed A",
    cycle: 12,
    room: 5,
  });
  const lib = library(engine);
  await lib.onExportAgiZip(true, true);
  assert.equal(lib.exportRefusal.value, "");
  assert.equal(downloads.length, 1);

  const opened = await readGameZip(await downloads[0]!.bytes());
  assert.equal(opened.progress?.saves["2"] === undefined, false, "A's own slot ships");
  assert.equal(opened.progress?.saves["5"], undefined);
  assert.equal(opened.progress?.saves["9"], undefined);
  assert.equal(opened.progress?.saves["4"], undefined);
  // The direct worker checkpoint survives — its identity is the target's
  // logical project, never a colon locator written where a project id goes.
  const checkpoint = opened.progress?.autosave;
  assert.ok(checkpoint !== null && checkpoint !== undefined);
  assert.equal(checkpoint.room, 5);
  assert.equal(checkpoint.game.installed, true);
  assert.equal(checkpoint.game.identity.project, savedId);
  assert.equal(checkpoint.game.identity.project.includes(":"), false);
  assert.equal(checkpoint.game.identity.revision, revision);
  assert.equal(opened.map?.notes["7"], "A map");
  assert.equal(opened.history?.recording.segments.map((s) => s.id).join(","), "imp.s1");
  assert.equal(
    computeResourceRevision(opened.files),
    revision,
    "the archive's full native revision is the offered bytes' own",
  );
});

test("a live download refuses when the runtime moves during ZIP entry collection", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { files } = gameContainer();
  const image = checkpointImage(files);
  const id = testProjectId("live-move");
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Live saved",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  const stored = await loadAuthoredGameWithHistoryLifetime(id);
  assert.ok(stored !== null && stored.lifetime !== null);
  const target = projectProgressTarget(id, computeResourceRevision(files), stored.lifetime);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));

  const { engine, game } = liveEngine({
    files,
    image,
    target,
    projectId: id,
    generation: stored.data.generation ?? 0,
  });
  const moved = game.booted;
  const lib = library(engine);
  const held = holdArchiveWriter();
  const running = lib.onExportAgiZip(true, true);
  await held.held();
  // The same binding fields on a fresh object is still a different runtime —
  // DTO equality never substitutes for the booted reference.
  game.booted = { ...(moved as object) };
  held.release();
  await running;
  assert.equal(downloads.length, 0);
  assert.notEqual(lib.exportRefusal.value, "");
});

test("a live download refuses when the worker answers for another binding", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { files } = gameContainer();
  const image = checkpointImage(files);
  const id = testProjectId("live-binding");
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Live saved",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  const stored = await loadAuthoredGameWithHistoryLifetime(id);
  assert.ok(stored !== null && stored.lifetime !== null);
  const target = projectProgressTarget(id, computeResourceRevision(files), stored.lifetime);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  const other = projectProgressTarget(
    id,
    computeResourceRevision(files),
    "22222222-3333-4444-8555-666666666666",
  );
  assert.ok(other !== null && other !== target);

  const { engine } = liveEngine({ files, image, target, projectId: id, exportTarget: other });
  const lib = library(engine);
  await lib.onExportAgiZip(true, true);
  assert.equal(downloads.length, 0, "a rebound export offer is not this runtime's");
  assert.notEqual(lib.exportRefusal.value, "");
});

test("a live download survives a storage wall with its worker checkpoint and a truthful report", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { files } = gameContainer();
  const image = checkpointImage(files);
  const id = testProjectId("live-quota");
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Live saved",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  const stored = await loadAuthoredGameWithHistoryLifetime(id);
  assert.ok(stored !== null && stored.lifetime !== null);
  const target = projectProgressTarget(id, computeResourceRevision(files), stored.lifetime);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));

  const { engine } = liveEngine({
    files,
    image,
    target,
    projectId: id,
    generation: stored.data.generation ?? 0,
    flush: () => Promise.resolve(false),
    room: 5,
  });
  const lib = library(engine);
  // localStorage reads throw mid-export — the quota wall the root review's
  // checkpoint contract exists for.
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem() {
        throw new DOMException("quota", "QuotaExceededError");
      },
      setItem() {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem() {},
      clear() {},
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
  });
  await lib.onExportAgiZip(true, true);
  assert.equal(downloads.length, 1, "the direct checkpoint carries the download anyway");
  const opened = await readGameZip(await downloads[0]!.bytes());
  assert.equal(opened.progress?.autosave?.room, 5, "the worker checkpoint is the autosave");
  assert.equal(opened.progress?.autosave?.game.identity.project, id);
  assert.equal(opened.backupWarning === undefined, false, "the report says it is incomplete");
  assert.match(
    lib.exportRefusal.value,
    /could not be read/,
    "the limitation names what storage could not hand over",
  );
});

test("an unbound live export ships the in-memory game and says what it could not carry", async (t) => {
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { files } = gameContainer();
  const image = checkpointImage(files);
  const id = testProjectId("live-unbound");
  // No stored body, no binding: the removed-body game still owns its bytes,
  // its running checkpoint and its recovery — and nothing persistent.
  const { engine } = liveEngine({
    files,
    image,
    target: undefined,
    projectId: id,
    title: "Unbound game",
    room: 8,
  });
  const lib = library(engine);
  await lib.onExportAgiZip(true, true);
  assert.equal(downloads.length, 1);
  const opened = await readGameZip(await downloads[0]!.bytes());
  assert.deepEqual(opened.files["VOL.0"], files["VOL.0"]);
  assert.equal(opened.progress?.autosave?.room, 8, "the running checkpoint still ships");
  assert.equal(opened.progress?.autosave?.game.installed, false);
  assert.equal(opened.progress?.autosave?.game.identity.project, id);
  assert.deepEqual(opened.progress?.saves, {}, "no stored slots exist to carry");
  assert.equal(opened.map, undefined);
  assert.equal(opened.history, undefined);
  assert.equal(opened.backupWarning === undefined, false, "the report says it is incomplete");
  assert.match(
    lib.exportRefusal.value,
    /stored body is gone/,
    "the limitation names the omitted persistent components",
  );
});

test("a live checkpoint matches the authored vocabulary, not the container's WORDS.TOK", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { files: containerFiles } = gameContainer();
  // The runtime booted the container's empty WORDS.TOK; the authored export
  // overlays the vocabulary the agent actually wrote — the same worker
  // split historySnapshot records.
  const authoredWordsTok = buildWordsTok([{ word: "look", id: 2 }]);
  const files = { ...containerFiles, "WORDS.TOK": authoredWordsTok };
  const image = checkpointImage(files);
  const id = testProjectId("live-words");
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Live saved",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [["look", 2]],
    }),
    true,
  );
  const stored = await loadAuthoredGameWithHistoryLifetime(id);
  assert.ok(stored !== null && stored.lifetime !== null);
  const target = projectProgressTarget(id, computeResourceRevision(files), stored.lifetime);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));

  const { engine } = liveEngine({
    files,
    image,
    target,
    projectId: id,
    words: [["look", 2]],
    generation: stored.data.generation ?? 0,
    bootFiles: containerFiles,
    bootDictionary: [["look", 2]],
    room: 6,
  });
  const lib = library(engine);
  await lib.onExportAgiZip(true, true);
  assert.equal(lib.exportRefusal.value, "");
  assert.equal(downloads.length, 1);
  const opened = await readGameZip(await downloads[0]!.bytes());
  assert.equal(
    opened.progress?.autosave?.room,
    6,
    "the checkpoint restores under the authored WORDS.TOK basis",
  );
});

test("a live checkpoint is omitted with a named cause when the runtime booted other bytes", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { files } = gameContainer(
    "load.pic(v0); draw.pic(v0); show.pic(); accept.input(); return;",
  );
  // The running engine booted different container bytes than the export
  // offers — the image is real, the basis is not.
  const image = checkpointImage(files);
  const other = gameContainer();
  const bootFiles = { ...other.files, "VOL.0": Uint8Array.of(0x01) };
  assert.notEqual(computeResourceRevision(bootFiles), computeResourceRevision(files));
  const id = testProjectId("live-mismatch");
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Live saved",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  const stored = await loadAuthoredGameWithHistoryLifetime(id);
  assert.ok(stored !== null && stored.lifetime !== null);
  const target = projectProgressTarget(id, computeResourceRevision(files), stored.lifetime);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));

  const { engine } = liveEngine({
    files,
    image,
    target,
    projectId: id,
    bootFiles,
    room: 3,
    generation: stored.data.generation ?? 0,
  });
  const lib = library(engine);
  await lib.onExportAgiZip(true, true);
  assert.equal(downloads.length, 1, "the game archive still ships");
  const opened = await readGameZip(await downloads[0]!.bytes());
  assert.equal(
    opened.progress?.autosave,
    undefined,
    "a checkpoint that cannot restore under the export is not relabelled into it",
  );
  assert.match(lib.exportRefusal.value, /checkpoint could not be verified/);
});

test("a bound live download carries the kept Creative snapshot its own body owns", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { files } = gameContainer();
  const id = testProjectId("live-creative");
  const request = {
    projectId: id,
    commitId: "initial",
    workspaceId: "workspace",
    buildId: "a".repeat(64),
    expected: null,
    documents: [{ key: "logic:0", version: 1 }],
    data: {
      title: "Creative live",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    },
  };
  const first = await commitProject(request);
  const encoded = encodePngRgb(1, 1, Uint8Array.of(255, 0, 0));
  const raster = Uint8Array.of(255, 0, 0, 255);
  const source: CreativeSource = {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: { id: "red-source", incarnation: "original", revision: 0 },
    encoded: { hash: sha256Hex(encoded), byteLength: encoded.length, mime: "image/png" },
    availability: "original",
    normalized: {
      blob: { hash: sha256Hex(raster), byteLength: raster.length, mime: "application/x-rgba8" },
      format: "rgba8-srgb-unpremultiplied-v1",
      width: 1,
      height: 1,
    },
    origin: { kind: "import", title: "Synthetic red pixel" },
  };
  const staged = await stageCreativeBlobs({
    projectId: id,
    expectedHead: 0,
    lease: { id: "art", owner: "editor", workspace: "workspace" },
    staged: { sources: [source] },
    blobs: [
      { hash: source.encoded.hash, mime: source.encoded.mime, bytes: encoded },
      { hash: source.normalized.blob.hash, mime: source.normalized.blob.mime, bytes: raster },
    ],
  });
  await commitProject({
    ...request,
    commitId: "keep-art",
    expected: first.receipt.saved,
    creative: {
      expectedHead: staged.head,
      asOf: Date.now(),
      lease: { id: "art", owner: "editor", workspace: "workspace" },
      keep: { sources: [source.identity], derivatives: [], recipes: [], board: [] },
    },
  });
  const stored = await loadAuthoredGameWithHistoryLifetime(id);
  assert.ok(stored !== null && stored.lifetime !== null);
  const target = projectProgressTarget(id, computeResourceRevision(files), stored.lifetime);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  const snapshot = await captureCreativeProject(id);
  assert.ok(snapshot !== null && stored.data.creative !== undefined);

  const { engine } = liveEngine({
    files,
    image: checkpointImage(files),
    target,
    projectId: id,
    generation: stored.data.generation ?? 0,
    creative: stored.data.creative,
    room: 4,
  });
  const lib = library(engine);
  await lib.onExportAgiZip(true, true);
  assert.equal(lib.exportRefusal.value, "");
  assert.equal(downloads.length, 1);
  const opened = await readGameZip(await downloads[0]!.bytes());
  assert.deepEqual(
    opened.project?.creative?.manifest,
    snapshot.manifest,
    "the archive carries the captured body's own kept manifest",
  );
  assert.equal(opened.progress?.autosave?.room, 4, "the checkpoint ships beside it");
});

test("a kept Creative marker without its catalog refuses the stored download", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const { downloads } = installDownloads(t);
  const { files } = gameContainer();
  const id = testProjectId("creative-orphan");
  // The body's marker claims kept assets whose catalog rows never existed —
  // stamping it that way is the only spelling a hostile or half-migrated
  // body leaves behind.
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Orphaned marker",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
      creative: { kept: 1 },
    }),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  const meta = getCachedGameMeta(id);
  assert.ok(meta !== null);

  const lib = library(fakeEngine());
  await lib.onExportLibraryGame(meta, true);
  assert.equal(
    downloads.length,
    0,
    "a kept marker without its snapshot is never shipped as a complete backup",
  );
  assert.notEqual(lib.exportRefusal.value, "");
});

for (const change of ["native revision", "interpreter profile"] as const) {
  test(`an in-place live ${change} during ZIP preparation refuses the captured download`, async (t) => {
    const cleanup = cleanupAfter(t);
    installLocalStorage(t);
    const { downloads } = installDownloads(t);
    const { files } = gameContainer();
    const id = testProjectId(`live-in-place-${change.replaceAll(" ", "-")}`);
    assert.equal(
      await saveAuthoredGame(id, { title: "Captured live game", files, words: [] }),
      true,
    );
    const stored = await loadAuthoredGameWithHistoryLifetime(id);
    assert.ok(stored !== null && stored.lifetime !== null);
    const target = projectProgressTarget(id, computeResourceRevision(files), stored.lifetime)!;
    cleanup.later(() => removeProjectWithProgress(target, []));
    const { engine, game } = liveEngine({
      files,
      image: checkpointImage(files),
      target,
      projectId: id,
      generation: stored.data.generation ?? 0,
    });
    const captured = game.booted;
    const lib = library(engine);
    const held = holdArchiveWriter();
    t.after(held.release);
    const running = lib.onExportAgiZip(true, true);
    await held.held();
    if (change === "native revision") {
      const next = gameContainer("load.pic(v0); draw.pic(v0); show.pic(); v1 = 7; return;");
      await updateBootedResources(captured as BootedGame, next.files);
    } else {
      engine.state.profile = "2.917";
    }
    assert.equal(game.booted, captured, "the same actual boot object remains installed");
    assert.equal(
      (captured as BootedGame).progressTarget,
      target,
      "the prior binding remains unchanged",
    );
    held.release();
    await running;
    assert.equal(downloads.length, 0, "an outdated live offer never reaches the anchor click");
    assert.notEqual(lib.exportRefusal.value, "");
  });
}

for (const project of [false, true]) {
  for (const field of ["profile", "parent"] as const) {
    test(`installed live ${field} survives ${project ? "Project" : "Game"} export and native ZIP read`, async (t) => {
      installLocalStorage(t);
      const { downloads } = installDownloads(t);
      const { files } = gameContainer("load.pic(v0); draw.pic(v0); show.pic(); v42 = 17; return;");
      const revision = computeResourceRevision(files);
      const target = installedProgressTarget({ folder: "installed-remix" }, revision)!;
      const parent = { project: testProjectId("declared-parent"), revision };
      const selected = new Engine(
        openContainer(new Map(Object.entries(files)), { profile: "2.917" }),
        HOST,
        undefined,
        { profile: "2.917" },
      );
      selected.tick();
      assert.equal(
        selected.vars[42],
        17,
        "the real selected-profile bytecode reached its checkpoint",
      );
      const selectedImage = selected.autosaveImage();
      assert.ok(selectedImage);
      const { engine } = liveEngine({
        files,
        image: bytesToB64(selectedImage),
        target,
        installed: { folder: "installed-remix" },
        parent,
        bootProfile: "2.917",
      });
      engine.state.profile = "2.917";
      const lib = library(engine);
      await lib.onExportAgiZip(true, project);
      assert.equal(downloads.length, 1);
      const opened = await readGameZip(await downloads[0]!.bytes());
      if (field === "profile") assert.equal(opened.profile, "2.917");
      else assert.deepEqual(opened.metadata?.parent, parent);
      assert.equal(computeResourceRevision(opened.files), revision);
      if (project) {
        assert.ok(
          opened.progress?.autosave,
          "the selected-profile checkpoint survives native import",
        );
        const restored = new Engine(
          openContainer(new Map(Object.entries(opened.files)), { profile: opened.profile! }),
          HOST,
          undefined,
          { profile: opened.profile! },
        );
        assert.equal(restored.vars[42], 0);
        restored.restoreImage(
          Uint8Array.from(atob(opened.progress.autosave.image), (character) =>
            character.charCodeAt(0),
          ),
        );
        assert.equal(
          restored.vars[42],
          17,
          "a real Engine restores the exported state under the archive's declared profile",
        );
      }
    });
  }
}

for (const scenario of ["removed stored owner", "unbound Creative marker"] as const) {
  test(`a live ${scenario} still exports playable resources and its direct checkpoint`, async (t) => {
    const cleanup = cleanupAfter(t);
    installLocalStorage(t);
    const { downloads } = installDownloads(t);
    const { files } = gameContainer();
    const id = testProjectId(scenario.replaceAll(" ", "-"));
    let target: ProjectProgressTarget | undefined;
    if (scenario === "removed stored owner") {
      assert.equal(await saveAuthoredGame(id, { title: scenario, files, words: [] }), true);
      target = (await bindSavedProgressTarget(id))!;
      assert.ok(target);
      cleanup.later(async () => {
        const remaining = await bindSavedProgressTarget(id);
        if (remaining !== null) await removeProjectWithProgress(remaining, []);
      });
    }
    const { engine, game } = liveEngine({
      files,
      image: checkpointImage(files),
      target,
      projectId: id,
      ...(scenario === "unbound Creative marker" ? { creative: { kept: 3 } } : {}),
    });
    if (scenario === "removed stored owner") {
      assert.equal(markRemoved(game.booted as BootedGame), true);
      assert.equal((game.booted as BootedGame).progressTarget, target);
      await removeProjectWithProgress(target!, []);
    }
    const lib = library(engine);
    await lib.onExportAgiZip(true, true);
    assert.equal(downloads.length, 1, `playable download; refusal=${lib.exportRefusal.value}`);
    const opened = await readGameZip(await downloads[0]!.bytes());
    assert.equal(computeResourceRevision(opened.files), computeResourceRevision(files));
    assert.ok(opened.progress?.autosave);
    assert.deepEqual(opened.progress.saves, {});
    assert.equal(opened.project?.creative, undefined);
    assert.equal(opened.map, undefined);
    assert.equal(opened.history, undefined);
    assert.ok(opened.backupWarning);
    if (scenario === "unbound Creative marker") {
      assert.match(lib.exportRefusal.value, /Creative assets/);
      // readGameZip exposes a concise warning; the stored ZIP retains the
      // complete BACKUP.JSON note for recovery and archive inspection.
      assert.match(
        new TextDecoder().decode(await downloads[0]!.bytes()),
        /Creative assets require the original stored project/,
      );
    }
  });
}
