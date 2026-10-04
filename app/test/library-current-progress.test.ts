/**
 * Home's pending-progress offer: the strict physical resume pointer, the
 * saved/installed target caches, and the record+target pair the Resume
 * handoff uses. Everything runs against real stored bodies, real lifetime
 * epochs and the real localStorage keys; the only seams are the deferred
 * saved-target bind and a gateable audio wait in the fake engine.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { reactive } from "vue";
import { createContainer } from "../../src/container/container.ts";
import { bindSavedProgressTarget } from "../src/project/progressBinding.ts";
import {
  installedProgressTarget,
  type ProgressTarget,
  type ProjectProgressTarget,
} from "../src/project/progressTarget.ts";
import {
  autosaveKey,
  readGameProgress,
  writeAutosave,
  type AutosaveRecord,
} from "../src/saves/gameProgress.ts";
import {
  LEGACY_LAST_GAME_KEY,
  RESUME_POINTER_KEY,
  clearResumePointer,
  readResumePointer,
  writeResumePointer,
} from "../src/saves/resumePointer.ts";
import { removeProjectWithProgress, saveAuthoredGame } from "../src/project/gameStorage.ts";
import type { InstalledGameDescriptor } from "../src/project/gameTypes.ts";
import type { EngineApi } from "../src/engine/engineContext.ts";
import type { AiSettingsApi } from "../src/settings/useAiSettings.ts";
import { createShellBridge } from "../src/shell/shellBridge.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId, testRevision } from "./identity.ts";

// gameTemplates.ts loads the bundled adventure briefs as `?raw` text — a
// Vite transform Node does not know. The controller paths under test never
// read them, so each resolves to an empty string module.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("?raw")) return { url: `test-raw:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("test-raw:"))
      return { format: "module", source: 'export default "";', shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { createGameLibrary } = await import("../src/library/useGameLibrary.ts");

const records = installIndexedDbFixture();

function installLocalStorage(t: { after(callback: () => void): void }): Map<string, string> {
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
  return values;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * This test's stored-body teardown. The callbacks run with an inert
 * localStorage so a removal that lands after the fixture's own restore
 * still finds the global.
 */
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

/**
 * The injected bind seam: `hold()` parks later resolutions until the test
 * resolves them by hand with the body's own real target.
 */
function binder() {
  let held = false;
  const pending: { project: string; resolve: (target: ProjectProgressTarget | null) => void }[] =
    [];
  return {
    pending,
    hold(): void {
      held = true;
    },
    async release(): Promise<void> {
      held = false;
      const waiting = pending.splice(0);
      for (const { project, resolve } of waiting) resolve(await bindSavedProgressTarget(project));
    },
    bind: (project: string) =>
      held
        ? new Promise<ProjectProgressTarget | null>((resolve) => pending.push({ project, resolve }))
        : bindSavedProgressTarget(project),
  };
}

function savedProjectBody(files: Record<string, Uint8Array>, title = "Progress game") {
  return {
    title,
    provider: "stub",
    model: "offline-stub",
    files,
    words: [] as [string, number][],
  };
}

/** A real autosave record that embeds its target's own identity. */
function autosaveFor(target: ProgressTarget, room: number): AutosaveRecord {
  return {
    format: "monotio.agi.autosave",
    version: 1,
    image: `image-${room}`,
    cycle: room * 10,
    room,
    savedAt: 1_700_000_000_000 + room,
    game: { installed: target.kind === "installed", identity: target.identity },
  };
}

interface EngineCalls {
  resumeLastGame: number;
  resumeFromRecord: { record: AutosaveRecord; locator: string | undefined }[];
  startOver: { target: string }[];
  bootGame: number;
  bootAuthoredGame: number;
}

/** The smallest EngineApi the pending-offer paths touch, with a gateable audio wait. */
function fakeEngine(installed: InstalledGameDescriptor[] = []): {
  api: EngineApi;
  calls: EngineCalls;
  gateAudio(): () => void;
  refuseResume(): void;
} {
  const calls: EngineCalls = {
    resumeLastGame: 0,
    resumeFromRecord: [],
    startOver: [],
    bootGame: 0,
    bootAuthoredGame: 0,
  };
  let audioHold: Promise<void> | null = null;
  let resumeAnswer = true;
  const state = reactive({ installedGames: installed, powerUp: { busy: false } });
  const api = {
    state,
    resumeAudio: () => audioHold ?? Promise.resolve(),
    bootGame: () => {
      calls.bootGame += 1;
      return Promise.resolve();
    },
    bootAuthoredGame: () => {
      calls.bootAuthoredGame += 1;
      return Promise.resolve();
    },
    resumeLastGame: () => {
      calls.resumeLastGame += 1;
      return Promise.resolve(true);
    },
    resumeFromRecord: (record: AutosaveRecord, _config: unknown, locator?: string) => {
      calls.resumeFromRecord.push({ record, locator });
      return Promise.resolve(resumeAnswer);
    },
    startOver: (target: string) => {
      calls.startOver.push({ target });
      return Promise.resolve();
    },
    currentGame: () => null,
    flushAutosave: () => Promise.resolve(true),
    exportCurrentGame: () => Promise.reject(new Error("unused")),
    roomMap: { storedSidecar: () => undefined },
  } as unknown as EngineApi;
  return {
    api,
    calls,
    gateAudio: () => {
      let release!: () => void;
      audioHold = new Promise<void>((resolve) => {
        release = () => {
          audioHold = null;
          resolve();
        };
      });
      return release;
    },
    refuseResume: () => {
      resumeAnswer = false;
    },
  };
}

const ai = {
  llmConfig: () => ({ provider: "stub", apiKey: "", model: "offline-stub" }),
  openAiSettings: () => {},
  aiConfigured: { value: true },
} as unknown as AiSettingsApi;

function library(engine: EngineApi): ReturnType<typeof createGameLibrary> {
  return createGameLibrary(engine, ai, createShellBridge());
}

test("a strict project pointer publishes the proven pair and Resume hands off record+locator", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("pending-resume-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  const record = autosaveFor(target, 4);
  writeAutosave(localStorage, target, record);
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const lib = library(engine.api);
  await flush();
  lib.refreshPendingAutosave();
  assert.deepEqual(lib.pendingAutosave.value, record);

  await lib.onResumeAutosave();
  assert.equal(engine.calls.resumeLastGame, 0);
  assert.equal(engine.calls.resumeFromRecord.length, 1);
  assert.deepEqual(engine.calls.resumeFromRecord[0]?.record, record);
  assert.equal(engine.calls.resumeFromRecord[0]?.locator, target.locator);
  assert.equal(lib.pendingProgressTarget.value?.kind, "project");
  assert.equal(lib.pendingProgressTarget.value?.locator, target.locator);
  assert.deepEqual(await lib.routedResumeOffer(id), { record, target });
});

test("a pointer naming a retired saved epoch offers nothing and leaves bytes and pointer", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("retired-epoch-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const retired = await bindSavedProgressTarget(id);
  assert.ok(retired !== null);
  writeAutosave(localStorage, retired, autosaveFor(retired, 7));
  assert.equal(writeResumePointer(localStorage, retired.locator), true);
  // Remove and recreate the same id: the recreated body carries a new
  // lifetime epoch, so the pointer names a retired incarnation.
  await removeProjectWithProgress(retired, []);
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([3]) })),
    true,
  );
  const live = await bindSavedProgressTarget(id);
  assert.ok(live !== null && live.locator !== retired.locator);
  cleanup.later(() => removeProjectWithProgress(live, []));

  const lib = library(engine.api);
  await flush();
  lib.refreshPendingAutosave();
  // The retired body's checkpoint and the pointer stay exactly as stored.
  assert.notEqual(localStorage.getItem(autosaveKey(retired.locator)), null);
  assert.equal(localStorage.getItem(RESUME_POINTER_KEY), retired.locator);
  assert.ok(lib.pendingAutosave.value === undefined);
  assert.ok(lib.pendingProgressTarget.value === undefined);
});

test("an unavailable installed pointer offers nothing and preserves raw bytes and pointer", async (t) => {
  installLocalStorage(t);
  const engine = fakeEngine();
  const gone = installedProgressTarget({ folder: "missing-game-folder" }, testRevision("gone"));
  assert.ok(gone !== null);
  writeAutosave(localStorage, gone, autosaveFor(gone, 2));
  assert.equal(writeResumePointer(localStorage, gone.locator), true);

  const lib = library(engine.api);
  await flush();
  lib.refreshPendingAutosave();
  assert.ok(lib.pendingAutosave.value === undefined);
  assert.ok(lib.pendingProgressTarget.value === undefined);
  assert.notEqual(localStorage.getItem(autosaveKey(gone.locator)), null);
  assert.equal(localStorage.getItem(RESUME_POINTER_KEY), gone.locator);
});

test("a served folder at another revision does not answer the pointer's revision", async (t) => {
  installLocalStorage(t);
  const engine = fakeEngine([
    {
      folder: "served-game",
      hash: "served-game-hash",
      alias: "served-alias",
      title: "Served game",
      revision: testRevision("served-b"),
    },
  ]);
  const stale = installedProgressTarget({ folder: "served-game" }, testRevision("served-a"));
  assert.ok(stale !== null);
  writeAutosave(localStorage, stale, autosaveFor(stale, 3));
  assert.equal(writeResumePointer(localStorage, stale.locator), true);

  const lib = library(engine.api);
  await flush();
  lib.refreshPendingAutosave();
  assert.ok(lib.pendingAutosave.value === undefined);
  assert.ok(lib.pendingProgressTarget.value === undefined);
  assert.notEqual(localStorage.getItem(autosaveKey(stale.locator)), null);
  assert.equal(localStorage.getItem(RESUME_POINTER_KEY), stale.locator);
});

test("a released lastGame checkpoint offers Resume against its matching saved body", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("legacy-key-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  records.delete(`lifetime/${id}`);
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  const record = autosaveFor(target, 5);
  // Released spelling: the record under the bare id, the pointer under
  // lastGame — history a released build left behind.
  writeAutosave(localStorage, record);
  localStorage.setItem(LEGACY_LAST_GAME_KEY, id);

  const lib = library(engine.api);
  await flush();
  lib.refreshPendingAutosave();
  assert.deepEqual(lib.pendingAutosave.value, record);
  assert.equal(lib.pendingProgressTarget.value?.locator, target.locator);
  assert.deepEqual(await lib.routedResumeOffer(id), { record, target });
  // The released bytes and key survive untouched, readable as Earlier context.
  assert.deepEqual(readGameProgress(localStorage, target).autosave, record);
  assert.equal(
    (JSON.parse(localStorage.getItem(`monotio_agi.autosave.${id}`)!) as AutosaveRecord).game
      .identity.project,
    id,
  );
  assert.equal(localStorage.getItem(LEGACY_LAST_GAME_KEY), id);
});

test("the pending offer follows the pointed-at domain when both spell the same id", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const spelling = "shared-spelling";
  const id = testProjectId(spelling);
  const revision = testRevision("installed-rev");
  const engine = fakeEngine([
    { folder: spelling, hash: spelling, alias: "shared-alias", title: "Shared", revision },
  ]);
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([7]) })),
    true,
  );
  const savedTarget = await bindSavedProgressTarget(id);
  assert.ok(savedTarget !== null);
  cleanup.later(() => removeProjectWithProgress(savedTarget, []));
  const installedTarget = installedProgressTarget({ folder: spelling, hash: spelling }, revision);
  assert.ok(installedTarget !== null);
  const savedRecord = autosaveFor(savedTarget, 6);
  const installedRecord = autosaveFor(installedTarget, 8);
  writeAutosave(localStorage, savedTarget, savedRecord);
  writeAutosave(localStorage, installedTarget, installedRecord);

  const lib = library(engine.api);
  await flush();
  writeResumePointer(localStorage, installedTarget.locator);
  lib.refreshPendingAutosave();
  assert.deepEqual(lib.pendingAutosave.value, installedRecord);
  const pointedInstalled = lib.pendingProgressTarget.value;
  assert.equal(pointedInstalled?.kind, "installed");
  assert.equal(pointedInstalled?.locator, installedTarget.locator);

  writeResumePointer(localStorage, savedTarget.locator);
  lib.refreshPendingAutosave();
  assert.deepEqual(lib.pendingAutosave.value, savedRecord);
  const pointedSaved = lib.pendingProgressTarget.value;
  assert.equal(pointedSaved?.kind, "project");
  assert.equal(pointedSaved?.locator, savedTarget.locator);
});

test("a record stored under a locator but owned by another identity never offers", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("identity-mismatch-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  // Bytes at the pointer's own key, but the record claims another game.
  const intruder: AutosaveRecord = {
    ...autosaveFor(target, 3),
    game: {
      installed: false,
      identity: { project: testProjectId("other-project"), revision: target.identity.revision },
    },
  };
  localStorage.setItem(autosaveKey(target.locator), JSON.stringify(intruder));
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const lib = library(engine.api);
  await flush();
  lib.refreshPendingAutosave();
  assert.ok(lib.pendingAutosave.value === undefined);
  assert.ok(lib.pendingProgressTarget.value === undefined);
  assert.notEqual(localStorage.getItem(autosaveKey(target.locator)), null);
});

test("a saved bind still in flight holds the offer until the cache lands", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("held-bind-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  writeAutosave(localStorage, target, autosaveFor(target, 1));
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const seam = binder();
  seam.hold();
  const lib = createGameLibrary(engine.api, ai, createShellBridge(), {
    bindSavedProgressTarget: seam.bind,
  });
  const pendingOffer = () => lib.pendingAutosave.value;
  const pendingTarget = () => lib.pendingProgressTarget.value;
  await flush();
  lib.refreshPendingAutosave();
  assert.equal(pendingOffer(), undefined);
  assert.equal(pendingTarget(), undefined);
  await seam.release();
  await flush();
  lib.refreshPendingAutosave();
  assert.equal(pendingOffer()?.room, 1);
  assert.equal(pendingTarget()?.locator, target.locator);
});

test("Resume refuses when the proven pair changed during the audio wait", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("moving-offer-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  writeAutosave(localStorage, target, autosaveFor(target, 9));
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const lib = library(engine.api);
  await flush();
  lib.refreshPendingAutosave();
  assert.ok(lib.pendingAutosave.value !== undefined);

  const releaseAudio = engine.gateAudio();
  const resumed = lib.onResumeAutosave();
  await flush();
  // The pointer moved while audio was still coming up; the re-check drops it.
  clearResumePointer(localStorage);
  lib.refreshPendingAutosave();
  releaseAudio();
  await resumed;
  assert.equal(engine.calls.resumeFromRecord.length, 0);
});

test("a saved-generation refresh withdraws the pending offer until the bind lands", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("rebind-offer-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  writeAutosave(localStorage, target, autosaveFor(target, 9));
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const seam = binder();
  const lib = createGameLibrary(engine.api, ai, createShellBridge(), {
    bindSavedProgressTarget: seam.bind,
  });
  const pendingOffer = () => lib.pendingAutosave.value;
  const pendingTarget = () => lib.pendingProgressTarget.value;
  await flush();
  lib.refreshPendingAutosave();
  assert.equal(pendingOffer()?.room, 9);

  seam.hold();
  lib.syncMenuPhase();
  // The entry reads pending while the rebind is out, and the offer proven
  // under the retired generation is already withdrawn with it — the hero
  // cannot offer what its binding no longer vouches for.
  assert.equal(lib.savedProgress(id).status, "pending");
  assert.equal(pendingOffer(), undefined);
  assert.equal(pendingTarget(), undefined);
  // Nothing cleared or adopted: bytes and pointer are exactly as stored.
  assert.notEqual(localStorage.getItem(autosaveKey(target.locator)), null);
  assert.equal(localStorage.getItem(RESUME_POINTER_KEY), target.locator);

  await seam.release();
  await flush();
  // The landed bind re-proves the pointer and republishes the same pair.
  assert.equal(pendingOffer()?.room, 9);
  assert.equal(pendingTarget()?.locator, target.locator);
});

test("a refresh to an empty shelf withdraws the saved offer outright", async (t) => {
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("gone-shelf-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  writeAutosave(localStorage, target, autosaveFor(target, 5));
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const lib = library(engine.api);
  await flush();
  lib.refreshPendingAutosave();
  assert.equal(lib.pendingAutosave.value?.room, 5);

  // The body is gone: the shelf refresh lists nothing and no bind ever
  // lands, yet the offer it was proven under must not linger.
  await removeProjectWithProgress(target, []);
  lib.refreshLibrary();
  await flush();
  assert.equal(lib.pendingAutosave.value, undefined);
  assert.equal(lib.pendingProgressTarget.value, undefined);
  assert.equal(localStorage.getItem(RESUME_POINTER_KEY), target.locator);
  assert.notEqual(localStorage.getItem(autosaveKey(target.locator)), null);
});

test("a saved-generation refresh leaves a proven installed offer standing", async (t) => {
  installLocalStorage(t);
  const revision = testRevision("staying-rev");
  const engine = fakeEngine([
    {
      folder: "staying-game",
      hash: "staying-hash",
      alias: "staying-alias",
      title: "Staying",
      revision,
    },
  ]);
  const target = installedProgressTarget(
    { folder: "staying-game", hash: "staying-hash", alias: "staying-alias" },
    revision,
  );
  assert.ok(target !== null);
  writeAutosave(localStorage, target, autosaveFor(target, 4));
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const lib = library(engine.api);
  await flush();
  lib.refreshPendingAutosave();
  assert.equal(lib.pendingAutosave.value?.room, 4);

  // The installed offer is proven without the saved cache; a saved
  // generation bump is not its invalidation.
  lib.syncMenuPhase();
  assert.equal(lib.pendingAutosave.value?.room, 4);
  assert.equal(lib.pendingProgressTarget.value?.locator, target.locator);
});

test("Resume refuses when the saved generation moved during the audio wait", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("generations-moved-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  writeAutosave(localStorage, target, autosaveFor(target, 9));
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const lib = library(engine.api);
  await flush();
  lib.refreshPendingAutosave();
  assert.ok(lib.pendingAutosave.value !== undefined);

  const releaseAudio = engine.gateAudio();
  const resumed = lib.onResumeAutosave();
  await flush();
  // A shelf refresh retires the generation the pair was proven under; the
  // post-wait re-proof ends this resume instead of handing off a pair the
  // cache no longer vouches for.
  lib.refreshLibrary();
  releaseAudio();
  await resumed;
  assert.equal(engine.calls.resumeFromRecord.length, 0);
  assert.equal(localStorage.getItem(RESUME_POINTER_KEY), target.locator);
  assert.notEqual(localStorage.getItem(autosaveKey(target.locator)), null);
});

test("Resume refuses when the checkpoint vanished during the audio wait", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("vanished-record-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  writeAutosave(localStorage, target, autosaveFor(target, 9));
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const lib = library(engine.api);
  await flush();
  lib.refreshPendingAutosave();
  assert.ok(lib.pendingAutosave.value !== undefined);

  const releaseAudio = engine.gateAudio();
  const resumed = lib.onResumeAutosave();
  await flush();
  // No refresh ran: the refs still hold the published pair, and only a
  // re-read under the target sees the record is gone.
  localStorage.removeItem(autosaveKey(target.locator));
  releaseAudio();
  await resumed;
  assert.equal(engine.calls.resumeFromRecord.length, 0);
});

test("the routed resume offer proves pointer, live target and record for the routed key", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("routed-resume-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  const record = autosaveFor(target, 6);
  writeAutosave(localStorage, target, record);
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const lib = library(engine.api);
  const offer = await lib.routedResumeOffer(id);
  assert.equal(offer?.target.kind, "project");
  assert.equal(offer?.target.locator, target.locator);
  assert.deepEqual(offer?.record, record);
  // Another routed key gets nothing: the pointer names this id alone, and
  // a bare project spelling is never evidence.
  assert.equal(await lib.routedResumeOffer("other-project"), null);
});

test("the routed resume offer awaits the live bind instead of reading a pending cache", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("routed-pending-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  writeAutosave(localStorage, target, autosaveFor(target, 3));
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const seam = binder();
  seam.hold();
  const lib = createGameLibrary(engine.api, ai, createShellBridge(), {
    bindSavedProgressTarget: seam.bind,
  });
  // The shelf cache has not bound; the offer still proves against the live
  // body rather than dropping a checkpoint for a pending first render.
  const offered = lib.routedResumeOffer(id);
  await seam.release();
  const offer = await offered;
  assert.equal(offer?.target.locator, target.locator);
  assert.equal(offer?.record.room, 3);
});

test("the routed resume offer answers null for a retired epoch and keeps bytes and pointer", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("routed-retired-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const retired = await bindSavedProgressTarget(id);
  assert.ok(retired !== null);
  writeAutosave(localStorage, retired, autosaveFor(retired, 7));
  assert.equal(writeResumePointer(localStorage, retired.locator), true);
  await removeProjectWithProgress(retired, []);
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([3]) })),
    true,
  );
  const live = await bindSavedProgressTarget(id);
  assert.ok(live !== null && live.locator !== retired.locator);
  cleanup.later(() => removeProjectWithProgress(live, []));

  const lib = library(engine.api);
  assert.equal(await lib.routedResumeOffer(id), null);
  assert.notEqual(localStorage.getItem(autosaveKey(retired.locator)), null);
  assert.equal(localStorage.getItem(RESUME_POINTER_KEY), retired.locator);
});

test("the routed resume offer answers null when no checkpoint stands under the pointer", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("routed-empty-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  // A current, strictly parseable pointer — with nothing stored under it.
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const lib = library(engine.api);
  assert.equal(await lib.routedResumeOffer(id), null);
  assert.equal(localStorage.getItem(RESUME_POINTER_KEY), target.locator);
});

test("the routed installed offer binds the served folder and exact revision", async (t) => {
  installLocalStorage(t);
  const revision = testRevision("routed-installed");
  const engine = fakeEngine([
    {
      folder: "routed-saga",
      hash: "routed-hash",
      alias: "routed-alias",
      title: "Routed Saga",
      revision,
    },
  ]);
  const target = installedProgressTarget(
    { folder: "routed-saga", hash: "routed-hash", alias: "routed-alias" },
    revision,
  );
  assert.ok(target !== null);
  const record = autosaveFor(target, 4);
  writeAutosave(localStorage, target, record);
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const lib = library(engine.api);
  const offer = await lib.routedResumeOffer("routed-saga");
  assert.equal(offer?.target.kind, "installed");
  assert.equal(offer?.target.locator, target.locator);
  assert.deepEqual(offer?.record, record);
  // A spelling that names no served folder is no route to the pointer.
  assert.equal(await lib.routedResumeOffer("nowhere-saga"), null);
});

test("a routed pointer at another revision or a legacy key answers null", async (t) => {
  installLocalStorage(t);
  const revision = testRevision("routed-installed");
  const engine = fakeEngine([
    {
      folder: "routed-saga",
      hash: "routed-hash",
      alias: "routed-alias",
      title: "Routed Saga",
      revision,
    },
  ]);
  const lib = library(engine.api);
  // The served revision is not the pointer's.
  const stale = installedProgressTarget(
    { folder: "routed-saga", hash: "routed-hash", alias: "routed-alias" },
    testRevision("other-revision"),
  );
  assert.ok(stale !== null);
  writeAutosave(localStorage, stale, autosaveFor(stale, 2));
  assert.equal(writeResumePointer(localStorage, stale.locator), true);
  assert.equal(await lib.routedResumeOffer("routed-saga"), null);
  assert.notEqual(localStorage.getItem(autosaveKey(stale.locator)), null);
  assert.equal(localStorage.getItem(RESUME_POINTER_KEY), stale.locator);
  // The released lastGame key selects nothing, however it is spelled.
  localStorage.setItem(LEGACY_LAST_GAME_KEY, "routed-saga");
  assert.equal(await lib.routedResumeOffer("routed-saga"), null);
});

test("a routed offer refuses a strict pointer cleared during its held saved bind", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("routed-cleared-pointer");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  const record = autosaveFor(target, 9);
  writeAutosave(localStorage, target, record);
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const seam = binder();
  seam.hold();
  const lib = createGameLibrary(engine.api, ai, createShellBridge(), {
    bindSavedProgressTarget: seam.bind,
  });
  const offered = lib.routedResumeOffer(id);
  // The pointer cleared while the bind was still out: the offer the old
  // pointer once proved cannot be handed out under it afterwards.
  clearResumePointer(localStorage);
  await seam.release();
  assert.equal(await offered, null);
  // Nothing is adopted or rewritten: the checkpoint bytes stay and the
  // cleared pointer stays cleared.
  assert.equal(localStorage.getItem(autosaveKey(target.locator)), JSON.stringify(record));
  assert.equal(readResumePointer(localStorage), null);
});

test("a routed offer refuses a strict pointer moved during its held saved bind", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("routed-moved-pointer");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  writeAutosave(localStorage, target, autosaveFor(target, 9));
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const seam = binder();
  seam.hold();
  const lib = createGameLibrary(engine.api, ai, createShellBridge(), {
    bindSavedProgressTarget: seam.bind,
  });
  const offered = lib.routedResumeOffer(id);
  // Another game took the pointer while the bind was still out.
  const other = installedProgressTarget({ folder: "elsewhere" }, testRevision("elsewhere"));
  assert.ok(other !== null);
  assert.equal(writeResumePointer(localStorage, other.locator), true);
  await seam.release();
  assert.equal(await offered, null);
  assert.equal(localStorage.getItem(RESUME_POINTER_KEY), other.locator);
  assert.notEqual(localStorage.getItem(autosaveKey(target.locator)), null);
});

test("routedResume reports absent without reaching the resume seam", async (t) => {
  installLocalStorage(t);
  const engine = fakeEngine();
  const lib = library(engine.api);
  assert.equal(await lib.routedResume("not-a-game"), "absent");
  assert.equal(engine.calls.resumeFromRecord.length, 0);
});

test("routedResume resumes a proven offer through the strict seam", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("routed-resumed-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  const record = autosaveFor(target, 6);
  writeAutosave(localStorage, target, record);
  assert.equal(writeResumePointer(localStorage, target.locator), true);

  const lib = library(engine.api);
  assert.equal(await lib.routedResume(id), "resumed");
  assert.equal(engine.calls.resumeFromRecord.length, 1);
  assert.deepEqual(engine.calls.resumeFromRecord[0]?.record, record);
  assert.equal(engine.calls.resumeFromRecord[0]?.locator, target.locator);
});

test("routedResume reports an attempted restore the runtime refused", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("routed-refused-game");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  writeAutosave(localStorage, target, autosaveFor(target, 6));
  assert.equal(writeResumePointer(localStorage, target.locator), true);
  engine.refuseResume();

  const lib = library(engine.api);
  // The offer stood and the attempt was made; refusal is its own outcome,
  // not another absent offer to open around.
  assert.equal(await lib.routedResume(id), "refused");
  assert.equal(engine.calls.resumeFromRecord.length, 1);
});

test("an ended note's saved play refuses the body rebound under the same id", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("qualified-saved-play");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const retired = await bindSavedProgressTarget(id);
  assert.ok(retired !== null);
  writeAutosave(localStorage, retired, autosaveFor(retired, 4));

  const seam = binder();
  seam.hold();
  const lib = createGameLibrary(engine.api, ai, createShellBridge(), {
    bindSavedProgressTarget: seam.bind,
  });
  const game = lib.savedGames.value.find((entry) => entry.projectId === id);
  assert.ok(game !== undefined);
  // The ended note's captured binding travels with the call.
  const played = lib.onPlayLibraryGame(game, retired);
  // While its bind is still out the same id is removed and recreated: the
  // live body now carries another epoch and the note's intent is dead.
  await removeProjectWithProgress(retired, []);
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([3]) })),
    true,
  );
  const live = await bindSavedProgressTarget(id);
  assert.ok(live !== null && live.locator !== retired.locator);
  cleanup.later(() => removeProjectWithProgress(live, []));
  await seam.release();
  await played;
  assert.equal(engine.calls.resumeFromRecord.length, 0);
  assert.equal(engine.calls.bootAuthoredGame, 0);
});

test("an ended note's saved play proceeds while its bound body still answers", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("qualified-saved-ok");
  assert.equal(
    await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
    true,
  );
  const target = await bindSavedProgressTarget(id);
  assert.ok(target !== null);
  cleanup.later(() => removeProjectWithProgress(target, []));
  const record = autosaveFor(target, 4);
  writeAutosave(localStorage, target, record);

  const seam = binder();
  seam.hold();
  const lib = createGameLibrary(engine.api, ai, createShellBridge(), {
    bindSavedProgressTarget: seam.bind,
  });
  const game = lib.savedGames.value.find((entry) => entry.projectId === id);
  assert.ok(game !== undefined);
  const played = lib.onPlayLibraryGame(game, target);
  await seam.release();
  await played;
  assert.equal(engine.calls.resumeFromRecord.length, 1);
  assert.deepEqual(engine.calls.resumeFromRecord[0]?.record, record);
  assert.equal(engine.calls.resumeFromRecord[0]?.locator, target.locator);
});

test("an ended note's installed play refuses a descriptor replaced during audio", async (t) => {
  installLocalStorage(t);
  const old: InstalledGameDescriptor = {
    folder: "qualified-install",
    alias: "qualified-install",
    hash: "qualified-hash",
    title: "Old",
    revision: testRevision("old"),
  };
  const replacement: InstalledGameDescriptor = {
    ...old,
    title: "Replacement",
    revision: testRevision("new"),
  };
  const oldTarget = installedProgressTarget(old, old.revision!);
  assert.ok(oldTarget !== null);
  const freshTarget = installedProgressTarget(replacement, replacement.revision!);
  assert.ok(freshTarget !== null);
  writeAutosave(localStorage, oldTarget, autosaveFor(oldTarget, 2));
  writeAutosave(localStorage, freshTarget, autosaveFor(freshTarget, 8));
  const engine = fakeEngine([old]);
  const lib = library(engine.api);

  const releaseAudio = engine.gateAudio();
  const played = lib.onPlayLocalGame("qualified-install", oldTarget);
  // The folder is swapped for a newer build while audio is still coming up.
  engine.api.state.installedGames = [replacement];
  releaseAudio();
  await played;
  // The same folder resolving to another revision never answers the note's
  // binding: neither the replacement's checkpoint nor a fresh boot runs.
  assert.equal(engine.calls.resumeFromRecord.length, 0);
  assert.equal(engine.calls.bootGame, 0);
});

test("an ended note's installed play proceeds while its descriptor still answers", async (t) => {
  installLocalStorage(t);
  const served: InstalledGameDescriptor = {
    folder: "qualified-install-ok",
    alias: "qualified-install-ok",
    hash: "qualified-ok-hash",
    title: "Served",
    revision: testRevision("served"),
  };
  const target = installedProgressTarget(served, served.revision!);
  assert.ok(target !== null);
  const record = autosaveFor(target, 2);
  writeAutosave(localStorage, target, record);
  const engine = fakeEngine([served]);
  const lib = library(engine.api);

  await lib.onPlayLocalGame("qualified-install-ok", target);
  assert.equal(engine.calls.resumeFromRecord.length, 1);
  assert.deepEqual(engine.calls.resumeFromRecord[0]?.record, record);
  assert.equal(engine.calls.resumeFromRecord[0]?.locator, target.locator);
});

test("an ended note's saved opening refuses a same-id body recreated during audio", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("qualified-opening-recreated");
  const body = savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) });
  assert.equal(await saveAuthoredGame(id, body), true);
  const expected = await bindSavedProgressTarget(id);
  assert.ok(expected !== null);
  // No checkpoint stands under the binding: the qualified call takes the
  // fresh-opening path. The audio wait inside it is a boundary — the same
  // id coming back with new bytes owns a different physical instance.
  let enterAudio!: () => void;
  const entered = new Promise<void>((resolve) => {
    enterAudio = resolve;
  });
  const audio = engine.api.resumeAudio;
  engine.api.resumeAudio = () => {
    enterAudio();
    return audio();
  };
  const lib = library(engine.api);
  const game = lib.savedGames.value.find((entry) => entry.projectId === id);
  assert.ok(game !== undefined);
  const releaseAudio = engine.gateAudio();
  const played = lib.onPlayLibraryGame(game, expected);
  await entered;
  await removeProjectWithProgress(expected, []);
  assert.equal(await saveAuthoredGame(id, body), true);
  const live = await bindSavedProgressTarget(id);
  assert.ok(live !== null && live.locator !== expected.locator);
  cleanup.later(() => removeProjectWithProgress(live, []));
  releaseAudio();
  await played;
  assert.equal(engine.calls.resumeFromRecord.length, 0);
  assert.equal(engine.calls.bootAuthoredGame, 0);
});

test("an ended note's saved opening proceeds while its body is unchanged", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("qualified-opening-current");
  const body = savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) });
  assert.equal(await saveAuthoredGame(id, body), true);
  const expected = await bindSavedProgressTarget(id);
  assert.ok(expected !== null);
  cleanup.later(() => removeProjectWithProgress(expected, []));
  const lib = library(engine.api);
  const game = lib.savedGames.value.find((entry) => entry.projectId === id);
  assert.ok(game !== undefined);

  const releaseAudio = engine.gateAudio();
  const played = lib.onPlayLibraryGame(game, expected);
  await flush();
  releaseAudio();
  await played;
  assert.equal(engine.calls.resumeFromRecord.length, 0);
  assert.equal(engine.calls.bootAuthoredGame, 1);
});

test("an ended note's saved opening refuses once its note departs, body unchanged", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("departed-note-opening");
  const body = savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) });
  assert.equal(await saveAuthoredGame(id, body), true);
  const expected = await bindSavedProgressTarget(id);
  assert.ok(expected !== null);
  cleanup.later(() => removeProjectWithProgress(expected, []));
  const lib = library(engine.api);
  const game = lib.savedGames.value.find((entry) => entry.projectId === id);
  assert.ok(game !== undefined);

  // The action's owner is the note it was clicked under: the body staying
  // current cannot rescue a dispatch whose note already left.
  let owns = true;
  const releaseAudio = engine.gateAudio();
  const played = lib.onPlayLibraryGame(game, expected, () => owns);
  await flush();
  owns = false;
  releaseAudio();
  await played;
  assert.equal(engine.calls.resumeFromRecord.length, 0);
  assert.equal(engine.calls.bootAuthoredGame, 0);
});

test("an ended note's installed play refuses once its note departs, descriptor unchanged", async (t) => {
  installLocalStorage(t);
  const served: InstalledGameDescriptor = {
    folder: "departed-install",
    alias: "departed-install",
    hash: "departed-hash",
    title: "Departed",
    revision: testRevision("departed"),
  };
  const target = installedProgressTarget(served, served.revision!);
  assert.ok(target !== null);
  writeAutosave(localStorage, target, autosaveFor(target, 2));
  const engine = fakeEngine([served]);
  const lib = library(engine.api);

  let owns = true;
  const releaseAudio = engine.gateAudio();
  const played = lib.onPlayLocalGame("departed-install", target, () => owns);
  owns = false;
  releaseAudio();
  await played;
  assert.equal(engine.calls.resumeFromRecord.length, 0);
  assert.equal(engine.calls.bootGame, 0);
});

for (const checkpoint of [false, true]) {
  for (const change of ["none", "note", "selection"] as const) {
    test(`qualified ${checkpoint ? "resume" : "opening"} checks ${change} after its final saved bind`, async (t) => {
      const cleanup = cleanupAfter(t);
      installLocalStorage(t);
      const engine = fakeEngine();
      const id = testProjectId(`final-bind-${checkpoint}-${change}`);
      assert.equal(
        await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) })),
        true,
      );
      const target = await bindSavedProgressTarget(id);
      assert.ok(target);
      cleanup.later(() => removeProjectWithProgress(target, []));
      if (checkpoint) writeAutosave(localStorage, target, autosaveFor(target, 6));
      let armed = false;
      let calls = 0;
      let entered!: () => void;
      let release!: () => void;
      const bound = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lib = createGameLibrary(engine.api, ai, createShellBridge(), {
        bindSavedProgressTarget: async (project) => {
          const live = await bindSavedProgressTarget(project);
          if (armed && project === id && ++calls === 2) {
            entered();
            await gate;
          }
          return live;
        },
      });
      await flush();
      const game = lib.savedGames.value.find((entry) => entry.projectId === id);
      assert.ok(game);
      let current = true;
      armed = true;
      const playing = lib.onPlayLibraryGame(game, target, () => current);
      await bound;
      if (change === "note") current = false;
      if (change === "selection") lib.selectedProjectId.value = testProjectId("other-selection");
      release();
      await playing;
      const allowed = change === "none" ? 1 : 0;
      assert.equal(engine.calls.bootAuthoredGame, checkpoint ? 0 : allowed);
      assert.equal(engine.calls.resumeFromRecord.length, checkpoint ? allowed : 0);
    });
  }
}

test("a same-epoch checkpoint from an earlier revision refuses opening and keeps its bytes", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("changed-checkpoint-body");
  await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) }));
  const target = (await bindSavedProgressTarget(id))!;
  cleanup.later(() => removeProjectWithProgress(target, []));
  const record = autosaveFor(target, 4);
  record.game = {
    ...record.game,
    identity: { ...record.game.identity, revision: testRevision("earlier-native-build") },
  };
  const raw = JSON.stringify(record);
  localStorage.setItem(autosaveKey(target.locator), raw);
  const lib = library(engine.api);
  await flush();
  const progress = lib.savedProgress(id);
  assert.ok(progress.status === "ready");
  assert.equal(progress.autosave?.room, 4);
  await lib.onPlayLibraryGame(lib.savedGames.value.find((game) => game.projectId === id)!);
  assert.equal(engine.calls.bootAuthoredGame, 0);
  assert.equal(engine.calls.resumeFromRecord.length, 0);
  assert.match(engine.api.state.error, /earlier version/);
  assert.equal(lib.latestVersion.value?.locator, target.locator);
  await lib.startLatestVersion();
  assert.equal(engine.calls.bootAuthoredGame, 1);
  assert.equal(localStorage.getItem(autosaveKey(target.locator)), raw);
});

for (const change of ["save", "remove", "refuse", "read failure"] as const) {
  test(`starting the latest version after ${change} keeps a usable library`, async (t) => {
    const cleanup = cleanupAfter(t);
    installLocalStorage(t);
    const engine = fakeEngine();
    const id = testProjectId(`latest-click-${change.replaceAll(" ", "-")}`);
    const files = createContainer();
    files.putResource("logic", 0, Uint8Array.of(0));
    await saveAuthoredGame(id, savedProjectBody(Object.fromEntries(files.files)));
    const target = (await bindSavedProgressTarget(id))!;
    if (change !== "remove") cleanup.later(() => removeProjectWithProgress(target, []));
    const record = autosaveFor(target, 4);
    record.game = {
      ...record.game,
      identity: { ...record.game.identity, revision: testRevision("old-build") },
    };
    const raw = JSON.stringify(record);
    localStorage.setItem(autosaveKey(target.locator), raw);
    let bootTarget: ProgressTarget | undefined;
    engine.api.bootAuthoredGame = async (_template, _config, options) => {
      engine.calls.bootAuthoredGame++;
      bootTarget = options?.opening?.target;
      if (change === "refuse") throw new Error("Boot refused");
      engine.api.state.phase = "running";
    };
    let failRead = false;
    const lib = createGameLibrary(engine.api, ai, createShellBridge(), {
      bindSavedProgressTarget: (project) =>
        failRead
          ? Promise.reject(new Error("Storage unavailable"))
          : bindSavedProgressTarget(project),
    });
    await lib.onPlayLibraryGame(lib.savedGames.value.find((game) => game.projectId === id)!);
    assert.ok(lib.latestVersion.value);
    if (change === "save") {
      files.putResource("logic", 0, Uint8Array.of(1, 0));
      await saveAuthoredGame(id, savedProjectBody(Object.fromEntries(files.files)));
    }
    if (change === "remove") await removeProjectWithProgress(target, []);
    const current = await bindSavedProgressTarget(id);
    failRead = change === "read failure";
    await lib.startLatestVersion();
    if (change === "remove") {
      assert.equal(engine.calls.bootAuthoredGame, 0);
      assert.equal(engine.api.state.phase, "idle");
      assert.equal(engine.api.state.error, "");
      assert.ok(!lib.savedGames.value.some((game) => game.projectId === id));
      assert.equal(lib.latestVersion.value, undefined);
    } else if (change === "read failure") {
      assert.equal(engine.calls.bootAuthoredGame, 0);
      assert.ok(lib.latestVersion.value, "a failed read leaves the offer available");
      assert.equal(engine.api.state.phase, "error");
      assert.match(lib.libraryActionError.value, /Storage unavailable/);
    } else if (change === "refuse") {
      assert.ok(lib.latestVersion.value, "the offer remains available after a refused boot");
      assert.match(lib.libraryActionError.value, /Boot refused/);
    } else {
      assert.equal(engine.calls.bootAuthoredGame, 1);
      assert.deepEqual(bootTarget, current);
      assert.equal(lib.latestVersion.value, undefined);
      assert.equal(localStorage.getItem(autosaveKey(target.locator)), raw);
    }
  });
}

test("an incompatible checkpoint refused during opening offers the latest version with its bytes preserved", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("incompatible-checkpoint-profile");
  await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) }));
  const target = (await bindSavedProgressTarget(id))!;
  cleanup.later(() => removeProjectWithProgress(target, []));
  const raw = JSON.stringify(autosaveFor(target, 4));
  localStorage.setItem(autosaveKey(target.locator), raw);
  engine.api.resumeFromRecord = async () => {
    engine.api.state.phase = "error";
    engine.api.state.error = "The checkpoint uses another interpreter profile.";
    return false;
  };
  const lib = library(engine.api);
  await flush();
  await lib.onPlayLibraryGame(lib.savedGames.value.find((game) => game.projectId === id)!);
  assert.equal(lib.latestVersion.value?.locator, target.locator);
  assert.match(engine.api.state.error, /interpreter profile/);
  assert.equal(localStorage.getItem(autosaveKey(target.locator)), raw);
});

test("a revision refusal during opening offers the latest version once with its bytes preserved", async (t) => {
  const cleanup = cleanupAfter(t);
  installLocalStorage(t);
  const engine = fakeEngine();
  const id = testProjectId("checkpoint-opening-revision");
  await saveAuthoredGame(id, savedProjectBody({ "dir.vol": new Uint8Array([1, 2]) }));
  const target = (await bindSavedProgressTarget(id))!;
  cleanup.later(() => removeProjectWithProgress(target, []));
  const raw = JSON.stringify(autosaveFor(target, 4));
  localStorage.setItem(autosaveKey(target.locator), raw);
  engine.api.resumeFromRecord = async () => {
    engine.api.state.phase = "error";
    engine.api.state.error =
      "This play position belongs to an earlier version of the game. Your project is safe. Start the latest version? The old position is replaced when the new run saves.";
    return false;
  };
  const lib = library(engine.api);
  await flush();
  await lib.onPlayLibraryGame(lib.savedGames.value.find((game) => game.projectId === id)!);
  assert.equal(lib.latestVersion.value?.locator, target.locator);
  assert.equal(engine.api.state.error.match(/Start the latest version\?/g)?.length, 1);
  assert.equal(
    engine.api.state.error.match(/The old position is replaced when the new run saves\./g)?.length,
    1,
  );
  assert.equal(localStorage.getItem(autosaveKey(target.locator)), raw);
});
