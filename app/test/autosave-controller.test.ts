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
import type { BootedGame } from "../src/gameTypes.ts";

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
    getInstalledFolder: () => "/games/kq1",
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
    getInstalledFolder: () => "",
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
