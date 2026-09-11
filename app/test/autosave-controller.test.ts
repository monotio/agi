import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autosaveMatches,
  readAutosave,
  clearAutosave,
  lastGameKey,
  useAutosaveController,
  type AutosaveControllerContext,
} from "../src/useAutosaveController.ts";
import { writeAutosave, type AutosaveRecord } from "../src/gameProgress.ts";
import { gameRevision } from "../src/gameMetadata.ts";
import type { BootedGame } from "../src/gameTypes.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { saveAuthoredGame, clearCachedGame } from "../src/gameStorage.ts";

installIndexedDbFixture();

test("autosaveMatches distinguishes installed and authored games correctly", () => {
  // Installed game matching by hash or alias
  const installedRecord = {
    installed: true,
    revision: "rev1",
    hash: "41d863172326c712c0aebadf12fc63b049ff5d892743f4ee990004c344eb3780",
    alias: "kq1",
  };
  assert.equal(autosaveMatches(installedRecord, "kq1"), true);
  assert.equal(
    autosaveMatches(
      installedRecord,
      "41d863172326c712c0aebadf12fc63b049ff5d892743f4ee990004c344eb3780",
    ),
    true,
  );
  assert.equal(autosaveMatches(installedRecord, "sq1"), false);

  // Authored game matching by projectId
  const authoredRecord = {
    installed: false,
    revision: "rev2",
    projectId: "remix-123",
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
      revision: "b".repeat(64),
      hash: sharedHash,
      alias: "gr1",
      folder: "gr1",
    },
  };

  writeAutosave(localStorage, record);
  // Stored under the folder key, reachable by it.
  assert.equal(readAutosave("gr1")?.cycle, 10);
  // A second edition sharing the WORDS.TOK hash sees nothing.
  assert.equal(readAutosave("agi-imported-gold-rush-polar-bear-project"), null);
  // Nor does a hash lookup find the folder-keyed record.
  assert.equal(readAutosave(sharedHash), null);
  // Once folder-scoped, hash and alias no longer match the record.
  assert.equal(autosaveMatches(record.game, "gr1"), true);
  assert.equal(autosaveMatches(record.game, sharedHash), false);
  assert.equal(autosaveMatches(record.game, "agi-imported-gold-rush-polar-bear-project"), false);

  // A record without a folder (older shape) still matches by hash and alias.
  const legacy = { installed: true, revision: "b".repeat(64), hash: sharedHash, alias: "gr1" };
  assert.equal(autosaveMatches(legacy, "gr1"), true);
  assert.equal(autosaveMatches(legacy, sharedHash), true);
  assert.equal(autosaveMatches(legacy, "agi-imported-gold-rush-polar-bear-project"), false);
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
      revision: "0".repeat(64),
      projectId: targetKey,
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

  const dummyFiles: Record<string, Uint8Array> = {
    LOGDIR: new Uint8Array([0, 1]),
  };

  const bootedGame: BootedGame = {
    installed: true,
    title: "Test Game",
    revision: "test-rev",
    files: dummyFiles,
    words: [],
    alias: "kq1",
    hash: "41d863172326c712c0aebadf12fc63b049ff5d892743f4ee990004c344eb3780",
  };

  const state = { resumed: false };

  const ctx: AutosaveControllerContext = {
    state,
    getBootedGame: () => bootedGame,
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
    bootGame: async () => {},
    bootAuthoredGame: async () => {},
    configForGame: (_p, config) => config,
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
    assert.equal(lastGameKey(), "41d863172326c712c0aebadf12fc63b049ff5d892743f4ee990004c344eb3780");

    // 2. Handle restored message (ok)
    controller.handleRestored({
      ok: true,
      room: 3,
      egoX: 80,
      egoY: 120,
    });
    assert.deepEqual(restoredState, { room: 3, egoX: 80, egoY: 120 });
    assert.equal(state.resumed, true);

    // 3. Reset clears in-memory state
    controller.reset();
    assert.equal(controller.lastAutosaveRecord(), null);
    assert.equal(state.resumed, false);

    // 4. Handle restored message (failure) clears autosave
    controller.handleRestored({
      ok: false,
      message: "corrupt save",
    });
    assert.ok(logs.some((l) => l.includes("Autosave discarded")));
  } finally {
    clearAutosave("kq1");
    clearAutosave("41d863172326c712c0aebadf12fc63b049ff5d892743f4ee990004c344eb3780");
  }
});

test("remixed project with Sierra alias uses projectId for autosave identity and resume, refusing alias collision", async (t) => {
  installLocalStorageMock(t);
  const dummyFiles: Record<string, Uint8Array> = {
    LOGDIR: new Uint8Array([0, 1]),
  };

  await saveAuthoredGame("remix-project-789", {
    title: "King's Quest Remix",
    provider: "stub",
    model: "offline-stub",
    files: dummyFiles,
    words: [],
    roomGeneration: true,
  });

  const revision = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const remixGame: BootedGame = {
    installed: false,
    projectId: "remix-project-789",
    alias: "kq1", // presentation alias preserved from Sierra KQ1
    title: "King's Quest Remix",
    revision,
    files: dummyFiles,
    words: [],
  };

  let bootedProjectId: string | null = null;
  let bootedGameTarget: string | null = null;

  const ctx: AutosaveControllerContext = {
    state: { resumed: false },
    getBootedGame: () => remixGame,
    getWorker: () => null,
    logAgent: () => {},
    isInstalledGame: (target) => target === "kq1",
    bootGame: async (target) => {
      bootedGameTarget = target;
    },
    bootAuthoredGame: async (_m, _c, opts) => {
      bootedProjectId = opts?.projectId ?? null;
    },
    configForGame: (_p, config) => config,
  };

  const controller = useAutosaveController(ctx);
  try {
    controller.handleAutosave({
      image: "remix-image-1",
      cycle: 100,
      room: 5,
    });
    await controller.getAutosaveWrite();

    // 1. Stored under projectId, not alias
    assert.equal(lastGameKey(), "remix-project-789");
    const record = readAutosave("remix-project-789");
    assert.notEqual(record, null);
    assert.equal(record?.game.projectId, "remix-project-789");
    assert.equal(record?.game.installed, false);
    // Presentation alias is intentionally omitted from local project autosave
    assert.equal(record?.game.alias, undefined);

    // 2. autosaveMatches refuses presentation alias for local project
    assert.equal(autosaveMatches(record!.game, "remix-project-789"), true);
    assert.equal(autosaveMatches(record!.game, "kq1"), false);

    // 3. readAutosave by presentation alias returns null, preventing cross-project collision
    assert.equal(readAutosave("kq1"), null);

    // 4. resumeFromRecord boots the project ID via bootAuthoredGame, not the alias via bootGame
    const resumed = await controller.resumeFromRecord(record!, {
      provider: "stub",
      apiKey: "",
      model: "offline-stub",
    });
    assert.equal(resumed, true);
    assert.equal(bootedProjectId, "remix-project-789");
    assert.equal(bootedGameTarget, null);
  } finally {
    clearAutosave("remix-project-789");
    clearAutosave("kq1");
    await clearCachedGame("remix-project-789");
  }
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
  let restoreImageDuringBoot = "";
  const ctx: AutosaveControllerContext = {
    state: { resumed: false },
    getBootedGame: () => null,
    getWorker: () => null,
    logAgent: () => {},
    isInstalledGame: () => true,
    bootGame: async () => {
      // Simulate spawnWorker() inside bootGame:
      controller.resetScreen();
      // And takeResumeState during boot:
      const state = await controller.takeResumeState({});
      restoreImageDuringBoot = state.restoreImage;
    },
    bootAuthoredGame: async () => {},
    configForGame: (_p, config) => config,
  };
  const controller = useAutosaveController(ctx);
  const revision = await gameRevision({});
  const record: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    savedAt: Date.now(),
    cycle: 10,
    room: 2,
    game: {
      installed: true,
      alias: "kq1",
      revision,
    },
    image: "base64image",
  };

  const resumed = await controller.resumeFromRecord(record, {
    provider: "stub",
    apiKey: "",
    model: "offline-stub",
  });
  assert.equal(resumed, true);
  assert.equal(restoreImageDuringBoot, "base64image");

  // Full reset clears pendingResumeRecord
  controller.reset();
  const emptyState = await controller.takeResumeState({});
  assert.equal(emptyState.restoreImage, "");
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
    installed: false,
    title: "Test Game",
    revision: "test-rev",
    files: { LOGDIR: new Uint8Array([0, 1]) },
    words: [],
    projectId: "detailed-test",
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
  };

  const controller = useAutosaveController(ctx);

  // 1. When a modal window is open, reports not_checkpointable
  const flush1 = controller.flushAutosaveDetailed(2000);
  const flushMsg1 = postedMessages[postedMessages.length - 1] as { type: string; id: number };
  controller.handleFlushed({
    id: flushMsg1.id,
    taken: false,
    cycle: 10,
    hasEngine: true,
    modal: true,
    textMode: false,
    pictureShown: true,
  });
  const res1 = await flush1;
  assert.equal(res1.status, "not_checkpointable");
  assert.equal(res1.reason, "A dialog or menu is open.");

  // 2. When text mode is active, reports not_checkpointable
  const flush2 = controller.flushAutosaveDetailed(2000);
  const flushMsg2 = postedMessages[postedMessages.length - 1] as { type: string; id: number };
  controller.handleFlushed({
    id: flushMsg2.id,
    taken: false,
    cycle: 11,
    hasEngine: true,
    modal: false,
    textMode: true,
    pictureShown: true,
  });
  const res2 = await flush2;
  assert.equal(res2.status, "not_checkpointable");
  assert.equal(res2.reason, "Game is in text mode.");

  // 3. Clean opening at cycle 0 is already durable (does not trap player at start)
  const flush3 = controller.flushAutosaveDetailed(2000);
  const flushMsg3 = postedMessages[postedMessages.length - 1] as { type: string; id: number };
  controller.handleFlushed({
    id: flushMsg3.id,
    taken: false,
    cycle: 0,
    hasEngine: true,
    modal: false,
    textMode: false,
    pictureShown: false,
  });
  const res3 = await flush3;
  assert.equal(res3.status, "already_durable");

  // 3b. Mid-game transition (cycle > lastCycle with unrendered picture) is not_checkpointable
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
    hasEngine: true,
    modal: false,
    textMode: false,
    pictureShown: false,
  });
  const res3b = await flush3b;
  assert.equal(res3b.status, "not_checkpointable");
  assert.equal(res3b.reason, "Interpreter is between transitions.");

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
    hasEngine: true,
    modal: false,
    textMode: false,
    pictureShown: true,
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
    hasEngine: true,
    modal: false,
    textMode: false,
    pictureShown: true,
  });
  const res5 = await flush5;
  assert.equal(res5.status, "saved");

  // 6. When worker flush times out with unsaved progress
  controller.handleFlushed({
    id: -1,
    taken: false,
    cycle: 99,
    hasEngine: true,
    modal: false,
    textMode: false,
    pictureShown: true,
  });
  const flush6 = controller.flushAutosaveDetailed(10);
  const res6 = await flush6;
  assert.equal(res6.status, "timeout");
});
