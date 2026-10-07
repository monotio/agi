/**
 * Progress binding: how a live or stored game resolves to its physical
 * progress target, and how progress storage separates the locator a record
 * is written under from the released identity the record embeds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId, testRevision } from "./identity.ts";
import {
  bindProgressTarget,
  bindSavedProgressTarget,
  resolveProgressTarget,
} from "../src/project/progressBinding.ts";
import {
  installedProgressLocator,
  installedProgressTarget,
  parseProgressLocator,
  projectProgressTarget,
  type ProgressTarget,
} from "../src/project/progressTarget.ts";
import {
  autosaveKey,
  readGameProgress,
  storeImportedProgress,
  writeAutosave,
  type AutosaveRecord,
} from "../src/saves/gameProgress.ts";
import { readGameSaves } from "../src/saves/gameSaves.ts";
import { useSaveSlotController } from "../src/saves/useSaveSlotController.ts";
import {
  lastGameKey,
  readAutosave,
  useAutosaveController,
  type AutosaveController,
  type AutosaveControllerContext,
} from "../src/saves/useAutosaveController.ts";
import {
  clearCachedGame,
  readHistoryLifetime,
  saveAuthoredGame,
} from "../src/project/gameStorage.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import type { ResourceRevision } from "../../src/gameIdentity.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { openContainer } from "../../src/container/container.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { bytesToBase64 } from "../src/project/bytes.ts";
import type { ProfileId } from "../../src/runtime/profile.ts";

installIndexedDbFixture();

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

/** A real Engine checkpoint image: the starter's first resumable room. */
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

function installLocalStorageMock(t: { after: (fn: () => void) => void }): Map<string, string> {
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
      },
      removeItem(key: string): void {
        values.delete(key);
      },
      clear(): void {
        values.clear();
      },
    },
  });
  return values;
}

function autosaveRecord(over: {
  installed: boolean;
  project: string;
  revision: string;
  image?: string;
}): AutosaveRecord {
  return {
    format: "monotio.agi.autosave",
    version: 1,
    image: over.image ?? "img",
    cycle: 7,
    room: 1,
    savedAt: Date.now(),
    game: {
      installed: over.installed,
      identity: {
        project: testProjectId(over.project),
        revision: testRevision(over.revision),
      },
    },
  };
}

test("released bare-id progress remains readable under its matching bound target", (t) => {
  const values = installLocalStorageMock(t);
  const revision = testRevision("released-body");
  const target = projectProgressTarget("released-game", revision, "initial")!;
  const record = autosaveRecord({
    installed: false,
    project: "released-game",
    revision: "released-body",
  });
  values.set(autosaveKey("released-game"), JSON.stringify(record));
  values.set(
    "monotio_agi.saves.released-game",
    JSON.stringify({ format: "monotio.agi.saves", version: 1, slots: { "1": "AQI=" } }),
  );
  assert.deepEqual(readGameProgress(localStorage, target).autosave, record);
  assert.deepEqual(readGameProgress(localStorage, target).saves, { "1": Uint8Array.of(1, 2) });
  values.delete(autosaveKey("released-game"));
  assert.deepEqual(readGameProgress(localStorage, target).saves, { "1": Uint8Array.of(1, 2) });
  values.set(autosaveKey("released-game"), JSON.stringify(record));
  assert.equal(values.has(autosaveKey(target.locator)), false, "reading preserves released bytes");
  const changed = projectProgressTarget("released-game", testRevision("changed-body"), "initial")!;
  assert.equal(readGameProgress(localStorage, changed).autosave, null);
  values.set(autosaveKey(target.locator), JSON.stringify({ ...record, version: 2 }));
  assert.equal(
    readGameProgress(localStorage, target).autosave,
    null,
    "a future current record blocks fallback",
  );
});

test("rebinding unchanged progress preserves an in-flight download owner", () => {
  const game = {
    installed: false,
    projectId: testProjectId("download-owner"),
    revision: testRevision("first"),
    historyLifetime: "initial",
    progressTarget: undefined as ProgressTarget | undefined,
  };
  const captured = bindProgressTarget(game);
  assert.equal(bindProgressTarget(game), captured);
  game.revision = testRevision("changed");
  assert.notEqual(bindProgressTarget(game), captured);
  const revised = game.progressTarget;
  game.historyLifetime = "new-lifetime";
  assert.notEqual(bindProgressTarget(game), revised);
});

test("installed games bind the exact folder digest and the full revision", () => {
  const revision = testRevision("installed-rev");
  const target = resolveProgressTarget({
    installed: true,
    folder: "kq1",
    hash: "aa".repeat(32),
    alias: "KQ1",
    revision,
  });
  assert.equal(target?.kind, "installed");
  assert.equal(target?.locator, installedProgressLocator("kq1", revision));
  assert.equal(target?.identity.project, "kq1");
  assert.equal(target?.identity.revision, revision);
  assert.deepEqual(target?.legacyKeys, ["kq1", "aa".repeat(32), "KQ1"]);

  // Case and Unicode are part of the physical address.
  const folded = resolveProgressTarget({ installed: true, folder: "KQ1", revision });
  assert.equal(folded?.kind, "installed");
  assert.notEqual(folded?.locator, target?.locator);
  const spaced = resolveProgressTarget({
    installed: true,
    folder: "King's Quest I",
    revision,
  });
  assert.equal(spaced?.kind, "installed");
  const spacedParsed = parseProgressLocator(spaced!.locator);
  if (spacedParsed?.kind !== "installed") assert.fail("expected an installed locator");
  assert.equal(
    spaced?.identity.project,
    `installed-${spacedParsed.folderDigest}`,
    "an invalid-folder spelling mints a stable logical id",
  );

  // A descriptor without a folder names no current instance.
  assert.equal(
    resolveProgressTarget({ installed: true, hash: "aa".repeat(32), alias: "KQ1", revision }),
    null,
  );
  // An ambiguous folder encoding is refused rather than hashed.
  assert.equal(resolveProgressTarget({ installed: true, folder: "bad\uD800", revision }), null);
  // No full revision, no target.
  assert.equal(
    resolveProgressTarget({ installed: true, folder: "kq1", revision: "not-a-revision" }),
    null,
  );
});

test("saved games bind the captured live body epoch, never a fabricated one", () => {
  const revision = testRevision("saved-rev");
  const epoch = "3f6b0a1e-9c2d-4e5f-8a7b-0c1d2e3f4a5b";
  const target = resolveProgressTarget({
    installed: false,
    projectId: "my-game",
    revision,
    historyLifetime: epoch,
  });
  assert.equal(target?.kind, "project");
  assert.equal(target?.locator, `project:my-game:${epoch}`);
  assert.equal(target?.identity.project, "my-game");

  // A pre-receipt body's live epoch is the string "initial".
  assert.equal(
    resolveProgressTarget({
      installed: false,
      projectId: "my-game",
      revision,
      historyLifetime: "initial",
    })?.locator,
    "project:my-game:initial",
  );
  // A removed body's captured lifetime is null: refuse, never rebind.
  assert.equal(
    resolveProgressTarget({
      installed: false,
      projectId: "my-game",
      revision,
      historyLifetime: null,
    }),
    null,
  );
  // An epoch that was never captured is not minted here.
  assert.equal(resolveProgressTarget({ installed: false, projectId: "my-game", revision }), null);
  // A shape carrying only the bound target still resolves its epoch.
  assert.equal(
    resolveProgressTarget({
      installed: false,
      projectId: "my-game",
      revision,
      progressTarget: projectProgressTarget("my-game", revision, epoch)!,
    })?.locator,
    `project:my-game:${epoch}`,
  );
});

test("bindProgressTarget stamps the ephemeral field and clears refusals", () => {
  const revision = testRevision("bind-rev");
  const game: {
    installed: boolean;
    folder?: string | undefined;
    revision: string;
    progressTarget?: ProgressTarget | undefined;
  } = { installed: true, folder: "kq1", revision };
  const target = bindProgressTarget(game);
  assert.equal(target?.kind, "installed");
  assert.equal(game.progressTarget, target);
  game.folder = undefined;
  assert.equal(bindProgressTarget(game), null);
  assert.equal(game.progressTarget, undefined);
});

test("bindSavedProgressTarget binds the body's live epoch, refuses missing and deleted", async (t) => {
  installLocalStorageMock(t);
  const id = testProjectId("bind-target-project");
  const files = { "WORDS.TOK": Uint8Array.of(1, 2), LOGDIR: Uint8Array.of(3) };
  t.after(() => clearCachedGame(id).catch(() => {}));

  assert.equal(await bindSavedProgressTarget(id), null, "no body, no target");

  await saveAuthoredGame(id, {
    title: "Bound",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  const epoch = await readHistoryLifetime(id);
  assert.notEqual(epoch, null);
  const target = await bindSavedProgressTarget(id);
  assert.equal(target?.kind, "project");
  assert.equal(target?.locator, `project:${id}:${epoch}`);
  assert.equal(target?.identity.project, id);
  assert.equal(target?.identity.revision, await gameRevision(files));
  assert.deepEqual(target?.legacyKeys, [id]);

  // Deletion ends the epoch: the same id refuses rather than rebinding.
  await clearCachedGame(id);
  assert.equal(await bindSavedProgressTarget(id), null);

  // Recreation under the same id mints a new epoch — a new physical address.
  await saveAuthoredGame(id, {
    title: "Bound again",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  const rebound = await bindSavedProgressTarget(id);
  assert.notEqual(rebound, null);
  assert.notEqual(rebound?.bodyEpoch, target?.bodyEpoch);
  assert.notEqual(rebound?.locator, target?.locator);
});

test("writeAutosave stores under the physical locator with the released identity embedded", (t) => {
  const storage = installLocalStorageMock(t);
  const revision = testRevision("autosave-rev");
  const target = installedProgressTarget({ folder: "kq1" }, revision)!;
  const record = autosaveRecord({
    installed: true,
    project: target.identity.project,
    revision: "autosave-rev",
  });
  assert.deepEqual(writeAutosave(localStorage, target, record), record);

  const key = autosaveKey(target.locator);
  assert.ok(storage.has(key), "stored under installed:<folder digest>:<revision>");
  assert.equal(storage.has(autosaveKey("kq1")), false, "nothing at the legacy key");
  const stored = JSON.parse(storage.get(key)!) as AutosaveRecord;
  assert.equal(stored.game.installed, true);
  assert.equal(stored.game.identity.project, "kq1");
  assert.equal(stored.game.identity.revision, revision);
});

test("writeAutosave refuses a record whose embedded identity is not the target's", (t) => {
  installLocalStorageMock(t);
  const revision = testRevision("autosave-rev");
  const target = projectProgressTarget("saved-one", revision, "initial")!;
  const matching = autosaveRecord({
    installed: false,
    project: "saved-one",
    revision: "autosave-rev",
  });
  assert.notEqual(writeAutosave(localStorage, target, matching), null);

  // Wrong embedded project, wrong revision, wrong domain: nothing is written.
  for (const game of [
    { installed: false, project: "other-game", revision: "autosave-rev" },
    { installed: false, project: "saved-one", revision: "other-rev" },
    { installed: true, project: "saved-one", revision: "autosave-rev" },
  ]) {
    const foreign = autosaveRecord({ ...game, image: "foreign" });
    const before = localStorage.getItem(autosaveKey(target.locator));
    assert.equal(writeAutosave(localStorage, target, foreign), null);
    assert.equal(localStorage.getItem(autosaveKey(target.locator)), before);
  }
});

test("writeAutosave keeps a future-version checkpoint instead of overwriting it", (t) => {
  installLocalStorageMock(t);
  const revision = testRevision("autosave-rev");
  const target = projectProgressTarget("saved-one", revision, "initial")!;
  const future = JSON.stringify({ format: "monotio.agi.autosave", version: 2 });
  localStorage.setItem(autosaveKey(target.locator), future);
  const record = autosaveRecord({
    installed: false,
    project: "saved-one",
    revision: "autosave-rev",
  });
  assert.equal(writeAutosave(localStorage, target, record), null);
  assert.equal(localStorage.getItem(autosaveKey(target.locator)), future);
});

test("installed and saved progress with the same logical id stay on separate addresses", (t) => {
  installLocalStorageMock(t);
  const revision = testRevision("shared-rev");
  // The collision the namespacing exists for: a folder and a saved project
  // that share one released storage spelling.
  const installed = installedProgressTarget({ folder: "shared-id" }, revision)!;
  const saved = projectProgressTarget("shared-id", revision, "initial")!;
  assert.equal(installed.identity.project, saved.identity.project);
  assert.notEqual(installed.locator, saved.locator);

  writeAutosave(
    localStorage,
    installed,
    autosaveRecord({
      installed: true,
      project: installed.identity.project,
      revision: "shared-rev",
      image: "installed-checkpoint",
    }),
  );
  writeAutosave(
    localStorage,
    saved,
    autosaveRecord({
      installed: false,
      project: saved.identity.project,
      revision: "shared-rev",
      image: "saved-checkpoint",
    }),
  );

  const installedProgress = readGameProgress(localStorage, installed);
  const savedProgress = readGameProgress(localStorage, saved);
  assert.equal(installedProgress.autosave?.image, "installed-checkpoint");
  assert.equal(savedProgress.autosave?.image, "saved-checkpoint");
  assert.equal(installedProgress.autosave?.game.installed, true);
  assert.equal(savedProgress.autosave?.game.installed, false);

  // A foreign record squatting on the physical address is not read.
  localStorage.setItem(
    autosaveKey(saved.locator),
    JSON.stringify(
      autosaveRecord({ installed: false, project: "other-game", revision: "shared-rev" }),
    ),
  );
  assert.equal(readGameProgress(localStorage, saved).autosave, null);
  // A recreated body's new epoch owns an empty address, not the old one's data.
  const recreated = projectProgressTarget(
    "shared-id",
    revision,
    "3f6b0a1e-9c2d-4e5f-8a7b-0c1d2e3f4a5b",
  )!;
  assert.equal(readGameProgress(localStorage, recreated).autosave, null);
});

test("storeImportedProgress writes under the destination target locator", (t) => {
  installLocalStorageMock(t);
  const revision = testRevision("imported-rev");
  const target = projectProgressTarget("imported-game", revision, "initial")!;
  const report = storeImportedProgress(localStorage, target, {
    saves: { "3": Uint8Array.of(9, 9, 9) },
    autosave: autosaveRecord({
      installed: false,
      project: "export-source-id",
      revision: "export-rev",
    }),
  });
  assert.deepEqual(report.slots, [3]);
  assert.deepEqual(readGameSaves(localStorage, target.locator), {
    "3": btoa("\t\t\t"),
  });
  // The autosave embeds the destination identity, never the source's.
  const stored = readGameProgress(localStorage, target).autosave;
  assert.equal(stored?.game.installed, false);
  assert.deepEqual(stored?.game.identity, target.identity);

  // The released spelling still lands under the bare project id.
  const legacyTarget = testProjectId("legacy-import");
  const legacy = storeImportedProgress(localStorage, legacyTarget, revision, {
    saves: {},
    autosave: autosaveRecord({
      installed: false,
      project: "export-source-id",
      revision: "export-rev",
    }),
  });
  assert.equal(localStorage.getItem(autosaveKey(legacyTarget)), JSON.stringify(legacy.autosave));
});

test("save slots read and write under the resolved target locator", async (t) => {
  installLocalStorageMock(t);
  const revision = testRevision("slot-rev");
  let booted: BootedGame | null = null;
  const controller = useSaveSlotController({ getBootedGame: () => booted });

  booted = {
    installed: true,
    folder: "kq1",
    hash: "aa".repeat(32),
    title: "KQ1",
    revision,
    files: {},
    words: [],
  };
  const image = btoa("slot-image");
  assert.equal(controller.handleSaveSlotRequest("saveWrite", { slot: 1, image }), "true");
  const locator = installedProgressLocator("kq1", revision)!;
  assert.deepEqual(readGameSaves(localStorage, locator), { "1": image });
  assert.equal(await controller.handleSaveSlotRequest("restore", { slot: 1 }), image);
  // The legacy folder spelling holds nothing: slots moved to the locator.
  assert.deepEqual(readGameSaves(localStorage, "kq1"), {});

  // A second instance sharing the hash writes its own address.
  booted = { ...booted, folder: "kq1 copy" };
  const otherLocator = installedProgressLocator("kq1 copy", revision)!;
  assert.notEqual(otherLocator, locator);
  assert.equal(controller.handleSaveSlotRequest("saveList", {}), "[]");
  assert.equal(
    controller.handleSaveSlotRequest("saveWrite", { slot: 1, image: btoa("copy") }),
    "true",
  );
  assert.deepEqual(readGameSaves(localStorage, otherLocator), { "1": btoa("copy") });
  assert.deepEqual(readGameSaves(localStorage, locator), { "1": image });

  // A saved project binds its captured body epoch.
  booted = {
    installed: false,
    projectId: testProjectId("saved-slots"),
    title: "Saved",
    revision,
    historyLifetime: "initial",
    files: {},
    words: [],
  };
  assert.equal(
    controller.handleSaveSlotRequest("saveWrite", { slot: 2, image: btoa("saved") }),
    "true",
  );
  assert.deepEqual(readGameSaves(localStorage, "project:saved-slots:initial"), {
    "2": btoa("saved"),
  });

  // No captured epoch, no write authority — the game reports failure.
  booted = {
    installed: false,
    projectId: testProjectId("unbound-slots"),
    title: "Unbound",
    revision,
    files: {},
    words: [],
  };
  assert.equal(controller.handleSaveSlotRequest("saveList", {}), "[]");
  assert.equal(controller.handleSaveSlotRequest("saveWrite", { slot: 3, image }), "false");
});

function autosaveTestContext(game: BootedGame | null): {
  ctx: AutosaveControllerContext;
  bootedFolders: string[];
  bootedProjects: string[];
  logs: string[];
  armedResolvers: (() => void)[];
  bind: (controller: AutosaveController) => void;
} {
  let slot = game;
  const bootedFolders: string[] = [];
  const bootedProjects: string[] = [];
  const logs: string[] = [];
  // A boot's resume admission resolved — the point a worker answer may land.
  const armedResolvers: (() => void)[] = [];
  let controller: AutosaveController | undefined;
  const ctx: AutosaveControllerContext = {
    state: {
      resumed: false,
      installedGames: [
        { hash: "aa".repeat(32), alias: "KQ1", title: "KQ1", folder: "kq1" },
        { hash: "aa".repeat(32), alias: "KQ1", title: "KQ1 copy", folder: "kq1 copy" },
      ],
    },
    getBootedGame: () => slot,
    getWorker: () => null,
    logAgent: (_kind, msg) => {
      logs.push(msg);
    },
    isInstalledGame: (target) => target === "kq1" || target === "kq1 copy",
    bootGame: async (folder, carrier) => {
      bootedFolders.push(folder);
      if (controller === undefined || slot === null) return;
      // The production order: the resume gate answers first, then the boot
      // admits the armed intent against the candidate it just landed, and
      // only a boot the intent did not abort installs into the slot.
      if (!controller.beginResumeBoot(carrier)) return;
      const next: BootedGame = { ...slot, folder };
      const admission = await controller.takeResumeState(
        { game: next, files: next.files },
        carrier,
      );
      if (admission.status !== "aborted") slot = next;
      armedResolvers.shift()?.();
    },
    bootAuthoredGame: async (_m, _c, opts) => {
      bootedProjects.push(opts?.projectId ?? "");
    },
    configForGame: (_p, config) => config,
    retireFailedRecovery: (retired) => {
      if (slot === retired) slot = null;
    },
  };
  return {
    ctx,
    bootedFolders,
    bootedProjects,
    logs,
    armedResolvers,
    bind: (bound: AutosaveController) => {
      controller = bound;
    },
  };
}

test("the autosave controller writes under the locator and points resume at it", async (t) => {
  installLocalStorageMock(t);
  const rig = await starterRig();
  const revision = rig.revision;
  const checkpointImage = bytesToBase64(starterCheckpoint(rig).image);
  const booted: BootedGame = {
    installed: true,
    folder: "kq1",
    hash: "aa".repeat(32),
    alias: "KQ1",
    title: "KQ1",
    revision,
    files: rig.files,
    words: [],
  };
  const { ctx, bootedFolders, armedResolvers, bind } = autosaveTestContext(booted);
  const controller = useAutosaveController(ctx);
  bind(controller);

  controller.handleAutosave({ image: checkpointImage, cycle: 11, room: 4 });
  assert.equal(await controller.getAutosaveWrite(), true);

  const locator = installedProgressLocator("kq1", revision)!;
  const record = readAutosave(locator);
  assert.equal(record?.image, checkpointImage);
  assert.equal(record?.game.installed, true);
  assert.equal(record?.game.identity.project, "kq1");
  assert.equal(record?.game.identity.revision, revision);
  // The resume pointer names the physical address, not a shared spelling.
  assert.equal(lastGameKey(), locator);
  // The released folder spelling is a read context, not the record's key.
  assert.equal(readAutosave("kq1"), null);

  // Resume resolves the folder back by locator equality and boots it; the
  // worker's own restored:true settles it.
  const resuming = controller.resumeLastGame({ provider: "stub", apiKey: "", model: "m" });
  await new Promise<void>((resolve) => armedResolvers.push(resolve));
  controller.handleRestored({ ok: true, room: 4, egoX: 0, egoY: 0 });
  assert.equal(await resuming, true);
  assert.deepEqual(bootedFolders, ["kq1"]);
});

test("installed instances sharing a content hash write separate progress", async (t) => {
  installLocalStorageMock(t);
  const revision = testRevision("autosave-rev");
  const first: BootedGame = {
    installed: true,
    folder: "kq1",
    hash: "aa".repeat(32),
    title: "KQ1",
    revision,
    files: {},
    words: [],
  };
  const second: BootedGame = { ...first, folder: "kq1 copy" };
  const firstController = useAutosaveController(autosaveTestContext(first).ctx);
  const secondController = useAutosaveController(autosaveTestContext(second).ctx);
  firstController.handleAutosave({ image: "first", cycle: 1, room: 1 });
  secondController.handleAutosave({ image: "second", cycle: 2, room: 2 });
  assert.equal(await firstController.getAutosaveWrite(), true);
  assert.equal(await secondController.getAutosaveWrite(), true);
  assert.equal(readAutosave(installedProgressLocator("kq1", revision)!)?.image, "first");
  assert.equal(readAutosave(installedProgressLocator("kq1 copy", revision)!)?.image, "second");
  // The minted logical id of an invalid folder participates in the record.
  const minted = readAutosave(installedProgressLocator("kq1 copy", revision)!);
  assert.equal(minted?.game.identity.project, `installed-${otherDigest("kq1 copy", revision)}`);
});

function otherDigest(folder: string, revision: string): string {
  const parsed = parseProgressLocator(installedProgressLocator(folder, revision)!);
  if (parsed?.kind !== "installed") assert.fail("expected an installed locator");
  return parsed.folderDigest;
}

test("a saved game without a captured epoch writes no checkpoint", async (t) => {
  installLocalStorageMock(t);
  const revision = testRevision("autosave-rev");
  const booted: BootedGame = {
    installed: false,
    projectId: testProjectId("uncaptured"),
    title: "Uncaptured",
    revision,
    files: {},
    words: [],
  };
  const { ctx, logs } = autosaveTestContext(booted);
  const controller = useAutosaveController(ctx);
  controller.handleAutosave({ image: "checkpoint", cycle: 1, room: 1 });
  assert.equal(await controller.getAutosaveWrite(), false);
  assert.ok(logs.some((m) => m.includes("no resolvable progress target")));
});

test("a saved game whose epoch was replaced writes nothing for either incarnation", async (t) => {
  const id = testProjectId("recreated-progress");
  t.after(() => clearCachedGame(id).catch(() => {}));
  installLocalStorageMock(t);
  const files = { "WORDS.TOK": Uint8Array.of(5) };
  await saveAuthoredGame(id, {
    title: "First",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  const firstEpoch = await readHistoryLifetime(id);
  const revision = await gameRevision(files);
  const booted: BootedGame = {
    installed: false,
    projectId: id,
    title: "First",
    revision,
    historyLifetime: firstEpoch,
    files,
    words: [],
  };
  let removed = 0;
  const { ctx } = autosaveTestContext(booted);
  const controller = useAutosaveController({
    ...ctx,
    onRemoved: () => removed++,
  });
  controller.handleAutosave({ image: "first", cycle: 1, room: 1 });
  assert.equal(await controller.getAutosaveWrite(), true);
  const firstLocator = `project:${id}:${firstEpoch}`;
  assert.equal(readAutosave(firstLocator)?.image, "first");

  // Deleted and recreated under the same id: a new epoch, a new address.
  await clearCachedGame(id);
  await saveAuthoredGame(id, {
    title: "Second",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  const secondEpoch = await readHistoryLifetime(id);
  assert.notEqual(secondEpoch, firstEpoch);
  const running = { ...booted };
  const stale = useAutosaveController({
    ...autosaveTestContext(running).ctx,
    onRemoved: () => removed++,
  });
  stale.handleAutosave({ image: "stale", cycle: 9, room: 9 });
  assert.equal(await stale.getAutosaveWrite(), false);
  assert.equal(removed, 1);
  assert.equal(readAutosave(firstLocator)?.image, "first", "old epoch untouched");
  assert.equal(
    readAutosave(`project:${id}:${secondEpoch}`),
    null,
    "nothing lands on the new incarnation's address",
  );
});
