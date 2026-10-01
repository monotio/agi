import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autosaveMatches,
  readAutosave,
  clearAutosave,
  lastGameKey,
  resumableAutosave,
  useAutosaveController,
  type AutosaveControllerContext,
} from "../src/saves/useAutosaveController.ts";
import { writeAutosave, type AutosaveRecord } from "../src/saves/gameProgress.ts";
import { installedProgressLocator, projectProgressTarget } from "../src/project/progressTarget.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId, testRevision } from "./identity.ts";
import { requireResourceRevision, type ResourceRevision } from "../../src/gameIdentity.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { openContainer } from "../../src/container/container.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { bytesToBase64 } from "../src/project/bytes.ts";
import type { ProfileId } from "../../src/runtime/profile.ts";
import {
  saveAuthoredGame,
  clearCachedGame,
  loadAuthoredGameWithHistoryLifetime,
  readHistoryLifetime,
} from "../src/project/gameStorage.ts";

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

test("autosaveMatches matches the storage key the record was written under", () => {
  // Installed records match their project key — a folder or a content hash;
  // an alias is a query resolved before the record is ever read.
  const installedRecord = {
    installed: true,
    identity: {
      project: testProjectId("41d863172326c712c0aebadf12fc63b049ff5d892743f4ee990004c344eb3780"),
      revision: testRevision("rev1"),
    },
  };
  assert.equal(
    autosaveMatches(
      installedRecord,
      "41d863172326c712c0aebadf12fc63b049ff5d892743f4ee990004c344eb3780",
    ),
    true,
  );
  assert.equal(autosaveMatches(installedRecord, "kq1"), false);
  assert.equal(autosaveMatches(installedRecord, "sq1"), false);

  // Authored game matching by project id
  const authoredRecord = {
    installed: false,
    identity: { project: testProjectId("remix-123"), revision: testRevision("rev2") },
  };
  assert.equal(autosaveMatches(authoredRecord, "remix-123"), true);
  assert.equal(autosaveMatches(authoredRecord, "remix-456"), false);
});

test("installed autosaves are folder-scoped so same-hash editions keep separate progress", (t) => {
  installLocalStorageMock(t);
  const sharedHash = "a".repeat(64);
  const record: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    image: "img",
    cycle: 10,
    room: 1,
    savedAt: Date.now(),
    game: {
      installed: true,
      identity: {
        project: testProjectId("gr1"),
        revision: requireResourceRevision("b".repeat(64)),
      },
    },
  };

  writeAutosave(localStorage, record);
  // Stored under the folder key, reachable by it.
  assert.equal(readAutosave("gr1")?.cycle, 10);
  // A second edition sharing the WORDS.TOK hash sees nothing.
  assert.equal(readAutosave("gr1-second-edition"), null);
  // Nor does a hash lookup find the folder-keyed record.
  assert.equal(readAutosave(sharedHash), null);
  // Once folder-scoped, hash and alias no longer match the record.
  assert.equal(autosaveMatches(record.game, "gr1"), true);
  assert.equal(autosaveMatches(record.game, sharedHash), false);
  assert.equal(autosaveMatches(record.game, "gr1-second-edition"), false);

  // A folder-less record keys on the content hash: only that key matches.
  const legacy = {
    installed: true,
    identity: {
      project: testProjectId(sharedHash),
      revision: requireResourceRevision("b".repeat(64)),
    },
  };
  assert.equal(autosaveMatches(legacy, "gr1"), false);
  assert.equal(autosaveMatches(legacy, sharedHash), true);
  assert.equal(autosaveMatches(legacy, "gr1-second-edition"), false);
});

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

test("readAutosave, clearAutosave, and lastGameKey manage localStorage entries", (t) => {
  installLocalStorageMock(t);
  const targetKey = "test-game-project";
  const record: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    image: "test-image-data",
    cycle: 100,
    room: 5,
    savedAt: Date.now(),
    game: {
      installed: false,
      identity: {
        project: testProjectId(targetKey),
        revision: requireResourceRevision("0".repeat(64)),
      },
    },
  };

  try {
    writeAutosave(localStorage, record);
    localStorage.setItem("monotio_agi.lastGame", targetKey);

    const read = readAutosave(targetKey);
    assert.notEqual(read, null);
    assert.equal(read?.cycle, 100);
    assert.equal(read?.room, 5);
    assert.equal(read?.image, "test-image-data");
    assert.equal(lastGameKey(), targetKey);

    clearAutosave(targetKey);
    assert.equal(readAutosave(targetKey), null);
    assert.equal(lastGameKey(), null);
  } finally {
    clearAutosave(targetKey);
  }
});

test("useAutosaveController stores autosave and notifies lifecycle callbacks", async (t) => {
  installLocalStorageMock(t);
  let storedCycle: number | null = null;
  let restoredState: { room: number; egoX: number; egoY: number } | null = null;
  const logs: string[] = [];

  const rig = await starterRig();
  const filesRevision = rig.revision;
  const checkpointImage = bytesToBase64(starterCheckpoint(rig).image);

  const bootedGame: BootedGame = {
    installed: true,
    title: "Test Game",
    revision: filesRevision,
    files: rig.files,
    words: [],
    folder: "kq1",
    alias: "kq1",
    hash: "41d863172326c712c0aebadf12fc63b049ff5d892743f4ee990004c344eb3780",
  };

  const state = {
    resumed: false,
    installedGames: [
      {
        folder: "kq1",
        alias: "kq1",
        hash: "h".repeat(64),
        title: "KQ1",
        revision: filesRevision,
        profile: rig.profileId,
      },
    ],
  };
  let slot: BootedGame | null = bootedGame;
  const retired: { game: BootedGame; message: string }[] = [];
  // A boot's resume admission resolved — the point a worker answer may land.
  const armedResolvers: (() => void)[] = [];

  const ctx: AutosaveControllerContext = {
    state,
    getBootedGame: () => slot,
    getWorker: () => null,
    onAutosaveStored: (cycle) => {
      storedCycle = cycle;
    },
    onAutosaveRestored: (room, egoX, egoY) => {
      restoredState = { room, egoX, egoY };
    },
    logAgent: (_kind, msg) => {
      logs.push(msg);
    },
    isInstalledGame: () => true,
    bootGame: async (_folder, carrier) => {
      // The production order: the resume gate answers first, then the boot
      // admits the armed intent against the candidate it just landed, and
      // only a boot the intent did not abort installs into the slot.
      if (!controller.beginResumeBoot(carrier)) return;
      const next: BootedGame = { ...bootedGame };
      const admission = await controller.takeResumeState(
        { game: next, files: rig.files, profile: rig.profileId },
        carrier,
      );
      if (admission.status !== "aborted") slot = next;
      armedResolvers.shift()?.();
    },
    bootAuthoredGame: async () => {},
    configForGame: (_p, config) => config,
    retireFailedRecovery: (game, message) => {
      retired.push({ game, message });
      if (slot === game) slot = null;
    },
  };

  const controller = useAutosaveController(ctx);

  try {
    // 1. Handle autosave message
    controller.handleAutosave({
      image: "image-1",
      cycle: 42,
      room: 3,
    });
    await controller.getAutosaveWrite();

    assert.equal(storedCycle, 42);
    const last = controller.lastAutosaveRecord();
    assert.notEqual(last, null);
    assert.equal(last?.cycle, 42);
    assert.equal(last?.room, 3);
    // The resume pointer names the physical locator, not the released spelling.
    assert.equal(lastGameKey(), installedProgressLocator("kq1", bootedGame.revision));

    // 2. A real resume: the armed intent waits for the worker's own
    // restored:true before reporting success.
    const locator = installedProgressLocator("kq1", filesRevision)!;
    const resumeRecord: AutosaveRecord = {
      format: "monotio.agi.autosave",
      version: 1,
      image: checkpointImage,
      cycle: 40,
      room: 3,
      savedAt: Date.now(),
      game: {
        installed: true,
        identity: { project: testProjectId("kq1"), revision: filesRevision },
      },
    };
    const resuming = controller.resumeFromRecord(
      resumeRecord,
      { provider: "stub", apiKey: "", model: "offline-stub" },
      locator,
    );
    await new Promise<void>((resolve) => armedResolvers.push(resolve));
    controller.handleRestored({
      ok: true,
      room: 3,
      egoX: 80,
      egoY: 120,
    });
    assert.equal(await resuming, true);
    assert.deepEqual(restoredState, { room: 3, egoX: 80, egoY: 120 });
    assert.equal(state.resumed, true);

    // 3. Reset clears in-memory state
    controller.reset();
    assert.equal(controller.lastAutosaveRecord(), null);
    assert.equal(state.resumed, false);

    // 4. A refused restore keeps the checkpoint and retires its worker.
    const failing = controller.resumeFromRecord(
      resumeRecord,
      { provider: "stub", apiKey: "", model: "offline-stub" },
      locator,
    );
    await new Promise<void>((resolve) => armedResolvers.push(resolve));
    controller.handleRestored({
      ok: false,
      message: "corrupt save",
    });
    assert.equal(await failing, false);
    assert.ok(logs.some((l) => l.includes("the checkpoint has been kept")));
    assert.deepEqual(
      retired.map(({ message }) => message),
      ["The saved checkpoint could not be restored: corrupt save"],
    );
  } finally {
    clearAutosave("kq1");
    clearAutosave(installedProgressLocator("kq1", bootedGame.revision)!);
    clearAutosave("41d863172326c712c0aebadf12fc63b049ff5d892743f4ee990004c344eb3780");
  }
});

test("remixed project with Sierra alias uses projectId for autosave identity and resume, refusing alias collision", async (t) => {
  installLocalStorageMock(t);
  const rig = await starterRig();
  const checkpointImage = bytesToBase64(starterCheckpoint(rig).image);

  await saveAuthoredGame(testProjectId("remix-project-789"), {
    title: "King's Quest Remix",
    provider: "stub",
    model: "offline-stub",
    files: rig.files,
    words: [],
    roomGeneration: true,
  });

  // A booted game runs the revision storage holds: its files' own.
  const revision = rig.revision;
  const remixEpoch = await readHistoryLifetime(testProjectId("remix-project-789"));
  const remixLocator = `project:remix-project-789:${remixEpoch}`;
  const remixGame: BootedGame = {
    installed: false,
    projectId: testProjectId("remix-project-789"),
    alias: "kq1", // presentation alias preserved from Sierra KQ1
    title: "King's Quest Remix",
    revision,
    files: rig.files,
    words: [],
    historyLifetime: remixEpoch,
  };

  let bootedProjectId: string | null = null;
  let bootedGameTarget: string | null = null;
  // The slot holds the game its current boot landed; a resume's boot swaps
  // it for the candidate it admits.
  let slot: BootedGame | null = remixGame;
  let armed!: () => void;
  const armedGate = new Promise<void>((resolve) => (armed = resolve));

  const ctx: AutosaveControllerContext = {
    state: { resumed: false },
    getBootedGame: () => slot,
    getWorker: () => null,
    logAgent: () => {},
    isInstalledGame: (target) => target === "kq1",
    bootGame: async (target) => {
      bootedGameTarget = target;
    },
    bootAuthoredGame: async (_m, _c, opts) => {
      bootedProjectId = opts?.projectId ?? null;
      if (!controller.beginResumeBoot(opts?.resumeCarrier)) return;
      // A real boot lands the body storage answers with — its live
      // lifetime included — and the resume admits exactly that candidate.
      const loaded = await loadAuthoredGameWithHistoryLifetime(opts!.projectId!);
      assert.ok(loaded !== null, "the saved body the boot named exists");
      const next: BootedGame = {
        installed: false,
        projectId: opts?.projectId,
        title: "King's Quest Remix",
        revision: await gameRevision(loaded.data.files),
        files: loaded.data.files,
        words: [],
        historyLifetime: loaded.lifetime,
      };
      const admission = await controller.takeResumeState(
        { game: next, files: next.files, profile: rig.profileId },
        opts?.resumeCarrier,
      );
      if (admission.status !== "aborted") slot = next;
      armed();
    },
    configForGame: (_p, config) => config,
    retireFailedRecovery: () => {},
  };

  const controller = useAutosaveController(ctx);
  try {
    controller.handleAutosave({
      image: checkpointImage,
      cycle: 100,
      room: 5,
    });
    await controller.getAutosaveWrite();

    // 1. Stored under the project's epoch locator; the record carries the
    // released identity, never an alias
    assert.equal(lastGameKey(), remixLocator);
    const record = readAutosave(remixLocator);
    assert.notEqual(record, null);
    assert.equal(record?.game.identity.project, "remix-project-789");
    assert.equal(record?.game.installed, false);
    assert.deepEqual(Object.keys(record!.game).sort(), ["identity", "installed"]);

    // 2. autosaveMatches refuses presentation alias for local project
    assert.equal(autosaveMatches(record!.game, "remix-project-789"), true);
    assert.equal(autosaveMatches(record!.game, "kq1"), false);

    // 3. readAutosave by presentation alias returns null, preventing cross-project collision
    assert.equal(readAutosave("kq1"), null);

    // 4. resumeFromRecord boots the project ID via bootAuthoredGame, not the
    // alias via bootGame; success waits for the armed worker's restored:true.
    const resuming = controller.resumeFromRecord(record!, {
      provider: "stub",
      apiKey: "",
      model: "offline-stub",
    });
    await armedGate;
    controller.handleRestored({ ok: true, room: 5, egoX: 0, egoY: 0 });
    const resumed = await resuming;
    assert.equal(resumed, true);
    assert.equal(bootedProjectId, "remix-project-789");
    assert.equal(bootedGameTarget, null);
  } finally {
    clearAutosave(remixLocator);
    clearAutosave("remix-project-789");
    clearAutosave("kq1");
    await clearCachedGame(testProjectId("remix-project-789"));
  }
});

test("reloading from storage resumes only a checkpoint of the stored bytes, else starts from the top", async (t) => {
  const id = testProjectId("reload-from-storage");
  // Hooks run in order: the record goes while the store is still installed.
  t.after(() => clearCachedGame(id));
  installLocalStorageMock(t);
  const before = { "WORDS.TOK": Uint8Array.of(0, 0) };
  const rig = await starterRig();
  const after = rig.files;
  const checkpointImage = bytesToBase64(starterCheckpoint(rig).image);
  // Another tab kept an edit: storage holds `after` while this tab runs `before`.
  await saveAuthoredGame(id, {
    title: "Kept elsewhere",
    provider: "stub",
    model: "offline-stub",
    files: after,
    words: [],
  });
  let running: BootedGame = {
    installed: false,
    projectId: id,
    title: "Kept elsewhere",
    revision: await gameRevision(before),
    files: before,
    words: [],
  };
  const boots: string[] = [];
  const armedResolvers: (() => void)[] = [];
  const controller: ReturnType<typeof useAutosaveController> = useAutosaveController({
    state: { resumed: false },
    getBootedGame: () => running,
    getWorker: () => null,
    logAgent: () => {},
    isInstalledGame: () => false,
    bootGame: async () => assert.fail("an authored project never boots as an edition"),
    bootAuthoredGame: async (_prompt, _config, options) => {
      const { resumeCarrier, ...rest } = options ?? {};
      assert.deepEqual(rest, { projectId: id, useCached: true });
      if (!controller.beginResumeBoot(resumeCarrier)) return;
      // A real boot rebinds the slot to the body storage answered with, its
      // live lifetime included — the resume the boot took is checked against
      // that exact candidate.
      const loaded = await loadAuthoredGameWithHistoryLifetime(id);
      assert.ok(loaded !== null, "the saved body the boot named exists");
      const next: BootedGame = {
        ...running,
        revision: await gameRevision(loaded.data.files),
        files: loaded.data.files,
        historyLifetime: loaded.lifetime,
      };
      const admission = await controller.takeResumeState(
        { game: next, files: loaded.data.files, profile: rig.profileId },
        resumeCarrier,
      );
      boots.push(admission.status === "restore" ? admission.restoreImage : "");
      if (admission.status !== "aborted") running = next;
      armedResolvers.shift()?.();
    },
    configForGame: (_project, config) => config,
    retireFailedRecovery: () => {},
  });
  const config = { provider: "stub" as const, apiKey: "", model: "offline-stub" };
  // This body's live epoch addresses the physical locator the stored
  // incarnation's own checkpoint sits under.
  const epoch = await readHistoryLifetime(id);
  const storedTarget = projectProgressTarget(id, await gameRevision(after), epoch)!;
  const checkpoint = async (files: Record<string, Uint8Array>, image: string) =>
    writeAutosave(localStorage, {
      format: "monotio.agi.autosave",
      version: 1,
      image,
      cycle: 7,
      room: 1,
      savedAt: Date.now(),
      game: { installed: false, identity: { project: id, revision: await gameRevision(files) } },
    });

  // This tab's own checkpoint names the bytes it runs, not the stored ones:
  // the stored game starts from the top instead of refusing the mismatch.
  await checkpoint(before, "this-tab");
  assert.equal(await controller.reloadFromStorage(config), true);
  // The other tab's Keep took a checkpoint of the stored bytes under the
  // live epoch's locator: that owned physical record resumes.
  assert.notEqual(
    writeAutosave(localStorage, storedTarget, {
      format: "monotio.agi.autosave",
      version: 1,
      image: checkpointImage,
      cycle: 7,
      room: 1,
      savedAt: Date.now(),
      game: {
        installed: false,
        identity: { project: id, revision: await gameRevision(after) },
      },
    }),
    null,
    "an owned checkpoint under the live epoch's locator",
  );
  const secondReload = controller.reloadFromStorage(config);
  // The armed resume reports only the worker's own restored:true.
  await new Promise<void>((resolve) => armedResolvers.push(resolve));
  controller.handleRestored({ ok: true, room: 1, egoX: 0, egoY: 0 });
  assert.equal(await secondReload, true);
  assert.deepEqual(boots, ["", checkpointImage]);
  // An installed edition is no stored project to reload.
  running = { ...running, installed: true, projectId: undefined, hash: "edition" };
  assert.equal(await controller.reloadFromStorage(config), false);
  assert.equal(boots.length, 2);
});

test("a tab behind storage never writes its checkpoint over the newer save's", async (t) => {
  const id = testProjectId("checkpoint-behind-storage");
  t.after(() => clearCachedGame(id));
  installLocalStorageMock(t);
  const before = { "WORDS.TOK": Uint8Array.of(0, 0) };
  const after = { "WORDS.TOK": Uint8Array.of(0, 0), OBJECT: Uint8Array.of(1) };
  // Another tab kept an edit and took a checkpoint of the kept bytes; this
  // tab still runs `before` and has not heard of it yet.
  await saveAuthoredGame(id, {
    title: "Kept elsewhere",
    provider: "stub",
    model: "offline-stub",
    files: after,
    words: [],
  });
  writeAutosave(localStorage, {
    format: "monotio.agi.autosave",
    version: 1,
    image: "other-tab",
    cycle: 7,
    room: 2,
    savedAt: Date.now(),
    game: { installed: false, identity: { project: id, revision: await gameRevision(after) } },
  });
  const epoch = await readHistoryLifetime(id);
  const running: BootedGame = {
    installed: false,
    projectId: id,
    title: "Kept elsewhere",
    revision: await gameRevision(before),
    files: before,
    words: [],
    historyLifetime: epoch,
  };
  let stored = 0;
  const context = (game: BootedGame): AutosaveControllerContext => ({
    state: { resumed: false },
    getBootedGame: () => game,
    getWorker: () => null,
    onAutosaveStored: () => stored++,
    logAgent: () => {},
    isInstalledGame: () => false,
    bootGame: async () => {},
    bootAuthoredGame: async () => {},
    configForGame: (_project, config) => config,
    retireFailedRecovery: () => {},
  });
  const controller = useAutosaveController(context(running));

  // A checkpoint names this tab's revision, which storage no longer holds:
  // it could never resume, and it would bury the other tab's.
  controller.handleAutosave({ image: "this-tab", cycle: 90, room: 1 });
  assert.equal(await controller.getAutosaveWrite(), false);
  assert.equal(readAutosave(id)?.image, "other-tab");
  assert.equal(stored, 0);

  // A game on the stored revision checkpoints as before.
  const current: BootedGame = { ...running, revision: await gameRevision(after), files: after };
  const onStored = useAutosaveController(context(current));
  // Unless it is marked behind (a removed-and-recreated project, a Keep
  // that never installed): then nothing writes until it reloads.
  current.behindStorage = true;
  onStored.handleAutosave({ image: "marked", cycle: 91, room: 3 });
  assert.equal(await onStored.getAutosaveWrite(), false);
  delete current.behindStorage;
  onStored.handleAutosave({ image: "current", cycle: 92, room: 3 });
  assert.equal(await onStored.getAutosaveWrite(), true);
  assert.equal(readAutosave(`project:${id}:${epoch}`)?.image, "current");
  assert.equal(stored, 1);
});

test("a tab running a removed project never brings its checkpoint back, and a reload says why", async (t) => {
  const id = testProjectId("checkpoint-removed-elsewhere");
  t.after(() => clearCachedGame(id));
  installLocalStorageMock(t);
  const files = { "WORDS.TOK": Uint8Array.of(0, 0) };
  await saveAuthoredGame(id, {
    title: "Removed elsewhere",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  const epoch = await readHistoryLifetime(id);
  const locator = `project:${id}:${epoch}`;
  const game: BootedGame = {
    installed: false,
    projectId: id,
    title: "Removed elsewhere",
    revision: await gameRevision(files),
    files,
    words: [],
    historyLifetime: epoch,
  };
  let removed = 0;
  const controller = useAutosaveController({
    state: { resumed: false },
    getBootedGame: () => game,
    getWorker: () => null,
    onRemoved: () => removed++,
    logAgent: () => {},
    isInstalledGame: () => false,
    bootGame: async () => assert.fail("an authored project never boots as an edition"),
    bootAuthoredGame: async () => assert.fail("a removed project never boots"),
    configForGame: (_project, config) => config,
    retireFailedRecovery: () => {},
  });
  controller.handleAutosave({ image: "before", cycle: 10, room: 1 });
  assert.equal(await controller.getAutosaveWrite(), true);

  // Another tab removes the game; this tab heard nothing (no BroadcastChannel).
  // The removal clears the incarnation's namespaced progress.
  await clearCachedGame(id);
  clearAutosave(locator);
  controller.handleAutosave({ image: "after", cycle: 20, room: 1 });
  assert.equal(await controller.getAutosaveWrite(), false);
  assert.equal(readAutosave(locator), null, "the removed project's checkpoint stays gone");
  assert.equal(lastGameKey(), null, "Home is pointed at nothing");
  assert.equal(game.removed, true);
  assert.equal(removed, 1);
  controller.handleAutosave({ image: "later", cycle: 30, room: 1 });
  assert.equal(await controller.getAutosaveWrite(), false);
  assert.equal(readAutosave(locator), null);
  assert.equal(removed, 1, "said once");

  // Reload game (or Studio's Reopen) finds nothing to reload: it says so again.
  const config = { provider: "stub" as const, apiKey: "", model: "offline-stub" };
  assert.equal(await controller.reloadFromStorage(config), false);
  assert.equal(removed, 2);
});

test("Home offers Continue only for a game that can still boot, and clears a removed one's leftover", async (t) => {
  const id = testProjectId("continue-removed");
  t.after(() => clearCachedGame(id));
  const values = installLocalStorageMock(t);
  const files = { "WORDS.TOK": Uint8Array.of(0, 0) };
  const checkpoint = async (project: string, installed = false) => {
    writeAutosave(localStorage, {
      format: "monotio.agi.autosave",
      version: 1,
      image: "img",
      cycle: 7,
      room: 1,
      savedAt: Date.now(),
      game: {
        installed,
        identity: { project: testProjectId(project), revision: await gameRevision(files) },
      },
    });
    localStorage.setItem("monotio_agi.lastGame", project);
  };
  assert.equal(resumableAutosave(), null, "nothing played yet");

  await saveAuthoredGame(id, {
    title: "Continue me",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  await checkpoint(id);
  assert.equal(resumableAutosave()?.game.identity.project, id);

  // Removed in another tab after its checkpoint was taken: never offered,
  // and the leftover under the removed project's own key goes.
  await clearCachedGame(id);
  assert.equal(resumableAutosave(), null);
  assert.equal(readAutosave(id), null);
  assert.equal(lastGameKey(), null);

  // An installed edition's checkpoint stays offered (its card resolves it).
  await checkpoint("gr1", true);
  assert.equal(resumableAutosave()?.game.identity.project, "gr1");

  // A project index this release cannot read is kept, but not offered.
  const newer = testProjectId("continue-newer-format");
  values.set(`monotio_agi.authored.${newer}`, JSON.stringify({ version: 2 }));
  await checkpoint(newer);
  assert.equal(resumableAutosave(), null);
  assert.notEqual(readAutosave(newer), null);
  assert.equal(lastGameKey(), newer);
});

test("useAutosaveController flushAutosave and drainFlushWaiters interact properly", async () => {
  const postedMessages: unknown[] = [];
  const fakeWorker = {
    postMessage: (msg: unknown) => {
      postedMessages.push(msg);
    },
  } as unknown as Worker;

  const ctx: AutosaveControllerContext = {
    state: { resumed: false },
    getBootedGame: () => null,
    getWorker: () => fakeWorker,
    logAgent: () => {},
    isInstalledGame: () => false,
    bootGame: async () => {},
    bootAuthoredGame: async () => {},
    configForGame: (_p, config) => config,
    retireFailedRecovery: () => {},
  };

  const controller = useAutosaveController(ctx);

  // 1. flushAutosave triggers worker postMessage and resolves upon handleFlushed
  const flushPromise = controller.flushAutosave(2000);
  assert.equal(postedMessages.length, 1);
  const flushMsg = postedMessages[0] as { type: string; id: number };
  assert.equal(flushMsg.type, "flush");

  controller.handleFlushed({ id: flushMsg.id, taken: true });
  const result = await flushPromise;
  assert.equal(result, true);

  // 2. drainFlushWaiters aborts pending flush waiters
  const secondFlush = controller.flushAutosave(2000);
  controller.drainFlushWaiters();
  const drainedResult = await secondFlush;
  assert.equal(drainedResult, false);
});

test("resetScreen preserves pending resume record while full reset clears it", async () => {
  const rig = await starterRig();
  const checkpointImage = bytesToBase64(starterCheckpoint(rig).image);
  let restoreImageDuringBoot = "";
  // The intent lands only on the game its own boot put in the slot.
  let running: BootedGame | null = null;
  let armed!: () => void;
  const armedGate = new Promise<void>((resolve) => (armed = resolve));
  const ctx: AutosaveControllerContext = {
    state: { resumed: false },
    getBootedGame: () => running,
    getWorker: () => null,
    logAgent: () => {},
    isInstalledGame: () => true,
    bootGame: async (folder, carrier) => {
      if (!controller.beginResumeBoot(carrier)) return;
      const next: BootedGame = {
        installed: true,
        title: folder,
        revision: rig.revision,
        files: rig.files,
        words: [],
        folder,
      };
      // Simulate spawnWorker() inside bootGame:
      controller.resetScreen();
      // And takeResumeState during boot, against the landed candidate:
      const admission = await controller.takeResumeState(
        { game: next, files: rig.files, profile: rig.profileId },
        carrier,
      );
      restoreImageDuringBoot = admission.status === "restore" ? admission.restoreImage : "";
      if (admission.status !== "aborted") running = next;
      armed();
    },
    bootAuthoredGame: async () => {},
    configForGame: (_p, config) => config,
    retireFailedRecovery: () => {},
  };
  const controller = useAutosaveController(ctx);
  const revision = rig.revision;
  const record: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    savedAt: Date.now(),
    cycle: 10,
    room: 2,
    game: {
      installed: true,
      identity: { project: testProjectId("kq1"), revision },
    },
    image: checkpointImage,
  };

  const pending = controller.resumeFromRecord(record, {
    provider: "stub",
    apiKey: "",
    model: "offline-stub",
  });
  // The boot admitted the intent; the worker's own acknowledgement settles it.
  await armedGate;
  controller.handleRestored({ ok: true, room: 2, egoX: 0, egoY: 0 });
  const resumed = await pending;
  assert.equal(resumed, true);
  assert.equal(restoreImageDuringBoot, checkpointImage);

  // Full reset clears pendingResumeRecord
  controller.reset();
  const emptyState = await controller.takeResumeState({ game: running!, files: {} });
  assert.equal(emptyState.status, "none");
});

test("flushAutosaveDetailed reports not_checkpointable, timeout, already_durable, and saved accurately", async (t) => {
  installLocalStorageMock(t);
  const postedMessages: unknown[] = [];
  const fakeWorker = {
    postMessage: (msg: unknown) => {
      postedMessages.push(msg);
    },
  } as unknown as Worker;

  const bootedGame: BootedGame = {
    installed: true,
    title: "Test Game",
    revision: testRevision("test-rev"),
    files: { LOGDIR: new Uint8Array([0, 1]) },
    words: [],
    folder: "flush-test",
    hash: "d".repeat(64),
  };

  const ctx: AutosaveControllerContext = {
    state: { resumed: false },
    getBootedGame: () => bootedGame,
    getWorker: () => fakeWorker,
    logAgent: () => {},
    isInstalledGame: () => false,
    bootGame: async () => {},
    bootAuthoredGame: async () => {},
    configForGame: (_p, config) => config,
    retireFailedRecovery: () => {},
  };

  const controller = useAutosaveController(ctx);

  // 1. A snapshot the worker refused past the last autosave reports not_checkpointable
  const flush1 = controller.flushAutosaveDetailed(2000);
  const flushMsg1 = postedMessages[postedMessages.length - 1] as { type: string; id: number };
  controller.handleFlushed({
    id: flushMsg1.id,
    taken: false,
    cycle: 10,
  });
  const res1 = await flush1;
  assert.equal(res1.status, "not_checkpointable");

  // 3. Clean opening at cycle 0 is already durable (does not trap player at start)
  const flush3 = controller.flushAutosaveDetailed(2000);
  const flushMsg3 = postedMessages[postedMessages.length - 1] as { type: string; id: number };
  controller.handleFlushed({
    id: flushMsg3.id,
    taken: false,
    cycle: 0,
  });
  const res3 = await flush3;
  assert.equal(res3.status, "already_durable");

  // 3b. A refusal after progress moved past the last autosave is not_checkpointable
  controller.handleAutosave({
    image: "image-1",
    cycle: 10,
    room: 1,
  });
  await controller.getAutosaveWrite();

  const flush3b = controller.flushAutosaveDetailed(2000);
  const flushMsg3b = postedMessages[postedMessages.length - 1] as { type: string; id: number };
  controller.handleFlushed({
    id: flushMsg3b.id,
    taken: false,
    cycle: 20,
  });
  const res3b = await flush3b;
  assert.equal(res3b.status, "not_checkpointable");

  // 4. When already durable (last seen cycle <= last autosave cycle), reports already_durable
  controller.handleAutosave({
    image: "image-durable",
    cycle: 50,
    room: 1,
  });
  await controller.getAutosaveWrite();

  const flush4 = controller.flushAutosaveDetailed(2000);
  const flushMsg4 = postedMessages[postedMessages.length - 1] as { type: string; id: number };
  controller.handleFlushed({
    id: flushMsg4.id,
    taken: false,
    cycle: 50,
  });
  const res4 = await flush4;
  assert.equal(res4.status, "already_durable");

  // 5. When flush succeeds and writes new autosave, reports saved
  const flush5 = controller.flushAutosaveDetailed(2000);
  const flushMsg5 = postedMessages[postedMessages.length - 1] as { type: string; id: number };
  controller.handleAutosave({
    image: "image-new",
    cycle: 55,
    room: 2,
  });
  controller.handleFlushed({
    id: flushMsg5.id,
    taken: true,
    cycle: 55,
  });
  const res5 = await flush5;
  assert.equal(res5.status, "saved");

  // 6. When worker flush times out with unsaved progress
  controller.handleFlushed({
    id: -1,
    taken: false,
    cycle: 99,
  });
  const flush6 = controller.flushAutosaveDetailed(10);
  const res6 = await flush6;
  assert.equal(res6.status, "timeout");
});

test("an autosave without a preview keeps the card's previous picture", async (t) => {
  installLocalStorageMock(t);
  const { createProgressPreview } = await import("../src/saves/progressPreview.ts");
  const visual = new Uint8Array(160 * 168).fill(2);
  const preview = createProgressPreview({ visual, text: new Uint8Array(2000), picRow: 1 });
  const bootedGame: BootedGame = {
    installed: true,
    title: "Test Game",
    revision: testRevision("preview-rev"),
    files: { LOGDIR: new Uint8Array([0, 1]) },
    words: [],
    folder: "kq4",
    alias: "kq4",
    hash: "c".repeat(64),
  };
  const controller = useAutosaveController({
    state: { resumed: false },
    getBootedGame: () => bootedGame,
    getWorker: () => null,
    logAgent: () => {},
    isInstalledGame: () => true,
    bootGame: async () => {},
    bootAuthoredGame: async () => {},
    configForGame: (_p, config) => config,
    retireFailedRecovery: () => {},
  });
  try {
    controller.handleAutosave({ image: "image-1", preview, cycle: 10, room: 3 });
    await controller.getAutosaveWrite();
    // The next frame was black, so the worker sent no preview with it.
    controller.handleAutosave({ image: "image-2", cycle: 20, room: 142 });
    await controller.getAutosaveWrite();
    const stored = readAutosave(installedProgressLocator("kq4", bootedGame.revision)!);
    assert.equal(stored?.image, "image-2", "the position still moves on");
    assert.equal(stored?.preview, preview, "the card keeps the last real picture");
  } finally {
    clearAutosave(installedProgressLocator("kq4", bootedGame.revision)!);
  }
});

test("an owned project checkpoint waits for session saving and never republishes resource files", async (t) => {
  const id = testProjectId("session-checkpoint");
  t.after(() => clearCachedGame(id));
  installLocalStorageMock(t);
  const rig = await starterRig();
  await saveAuthoredGame(id, { title: "Owned", files: rig.files, words: [] });
  const held = await loadAuthoredGameWithHistoryLifetime(id);
  assert.ok(held);
  const game: BootedGame = {
    installed: false,
    projectId: id,
    title: "Owned",
    revision: rig.revision,
    files: rig.files,
    words: [],
    historyLifetime: held.lifetime!,
  };
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let prepared = false;
  const controller = useAutosaveController({
    state: { resumed: false },
    getBootedGame: () => game,
    getWorker: () => null,
    logAgent() {},
    isInstalledGame: () => false,
    bootGame: async () => {},
    bootAuthoredGame: async () => {},
    configForGame: (_p, c) => c,
    retireFailedRecovery() {},
    async prepareCheckpoint() {
      prepared = true;
      await gate;
      return "owned" as const;
    },
  });
  controller.handleAutosave({ image: "owned-state", cycle: 10, room: 1, files: rig.files });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(prepared, true);
  assert.equal(readAutosave(id), null);
  release!();
  assert.equal(await controller.getAutosaveWrite(), true);
  assert.equal(
    (await loadAuthoredGameWithHistoryLifetime(id))!.data.generation,
    held.data.generation,
  );
  assert.equal(
    readAutosave(projectProgressTarget(id, rig.revision, held.lifetime!)!.locator)?.image,
    "owned-state",
  );
});
