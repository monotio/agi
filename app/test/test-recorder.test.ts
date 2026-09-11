import { test } from "node:test";
import assert from "node:assert/strict";
import { useTestRecorder, type TestRecorderState } from "../src/useTestRecorder.ts";
import type { BootedGame } from "../src/useEngine.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";
import type { RecordingSnapshot } from "../src/gameRecording.ts";

function createMockState(
  overrides: Partial<{
    phase: string;
    recording: { active: boolean; starting: boolean; error: string };
    powerUp: { open: boolean; busy: boolean };
    modal: unknown;
    prompt: unknown;
    waitingForKey: boolean;
  }> = {},
): TestRecorderState {
  return {
    phase: "running",
    recording: { active: false, starting: false, error: "" },
    powerUp: { open: false, busy: false },
    modal: null,
    prompt: null,
    waitingForKey: false,
    ...overrides,
  };
}

const mockConfig: LlmConfig = {
  provider: "stub",
  apiKey: "test",
  model: "test-model",
};

test("test recorder refuses to start when blocking modal is open", async () => {
  const state = createMockState({ modal: "print" });
  const posted: unknown[] = [];
  const recorder = useTestRecorder({
    state,
    getWorker: () => ({ postMessage: (msg: unknown) => posted.push(msg) }) as unknown as Worker,
    query: async () => assert.fail("query should not be called when modal is open"),
    logAgent: () => {},
    getBootedGame: () => null,
    getOrCreateSession: async () => assert.fail("session should not be created"),
    markRemixNeedsSave: () => {},
    persistRemix: async () => {},
    flushAutosave: async () => {},
  });

  await recorder.startTestRecording();
  assert.equal(state.recording.active, false);
  assert.match(state.recording.error, /Close the open window/);
});

test("test recorder starts and stops successfully through worker queries", async () => {
  const state = createMockState();
  const workerMessages: unknown[] = [];
  const worker = { postMessage: (msg: unknown) => workerMessages.push(msg) } as unknown as Worker;

  const recorder = useTestRecorder({
    state,
    getWorker: () => worker,
    query: async <T>(type: string): Promise<T> => {
      if (type === "startRecording") {
        return {
          ok: true,
          image: "img-base64",
          replayState: {
            cycle: 10,
            room: 1,
            score: 0,
            sound: 0,
            variables: [],
            flags: [],
            objects: [],
            strings: [],
            inventory: [],
            profile: "2.936",
          },
          cycle: 10,
          state: {
            room: 1,
            score: 0,
            sound: 0,
            variables: [0, 0],
            flags: [false, false],
            objects: [],
            strings: [],
            inventory: [],
          },
        } as T;
      }
      if (type === "stopRecording") {
        return {
          operations: [],
          events: [],
          printed: ["Welcome!"],
          tainted: null,
          usedGetnum: false,
          cycle: 15,
          state: {
            room: 1,
            score: 5,
            sound: 0,
            variables: [0, 1],
            flags: [true, false],
            objects: [],
            strings: [],
            inventory: [],
          },
        } as T;
      }
      throw new Error(`Unexpected query: ${type}`);
    },
    logAgent: () => {},
    getBootedGame: () => null,
    getOrCreateSession: async () => assert.fail("session should not be called"),
    markRemixNeedsSave: () => {},
    persistRemix: async () => {},
    flushAutosave: async () => {},
  });

  await recorder.startTestRecording();
  assert.equal(state.recording.active, true);
  assert.equal(state.recording.error, "");

  const snapshot = await recorder.stopTestRecording();
  assert.ok(snapshot);
  assert.equal(state.recording.active, false);
  assert.equal(snapshot.start.cycle, 10);
  assert.equal(snapshot.endCycle, 15);
  assert.deepEqual(snapshot.printed, ["Welcome!"]);
});

test("test recorder cancels active recording and notifies worker", async () => {
  const state = createMockState();
  const workerMessages: unknown[] = [];
  const worker = { postMessage: (msg: unknown) => workerMessages.push(msg) } as unknown as Worker;

  const recorder = useTestRecorder({
    state,
    getWorker: () => worker,
    query: async <T>(type: string): Promise<T> => {
      if (type === "startRecording") {
        return {
          ok: true,
          image: "img-base64",
          replayState: {
            cycle: 10,
            room: 1,
            score: 0,
            sound: 0,
            variables: [],
            flags: [],
            objects: [],
            strings: [],
            inventory: [],
            profile: "2.936",
          },
          cycle: 10,
          state: {
            room: 1,
            score: 0,
            sound: 0,
            variables: [],
            flags: [],
            objects: [],
            strings: [],
            inventory: [],
          },
        } as T;
      }
      throw new Error(`Unexpected query: ${type}`);
    },
    logAgent: () => {},
    getBootedGame: () => null,
    getOrCreateSession: async () => assert.fail("session should not be called"),
    markRemixNeedsSave: () => {},
    persistRemix: async () => {},
    flushAutosave: async () => {},
  });

  await recorder.startTestRecording();
  assert.equal(state.recording.active, true);

  recorder.cancelTestRecording();
  assert.equal(state.recording.active, false);
  assert.deepEqual(workerMessages, [{ type: "cancelRecording" }]);

  // Calling stop after cancel yields null
  const snapshot = await recorder.stopTestRecording();
  assert.equal(snapshot, null);
});

test("saveRecordedTest rejects tainted recordings", async () => {
  const state = createMockState();
  const booted: BootedGame = {
    installed: true,
    title: "Test Game",
    revision: "abc",
    files: {},
    words: [],
  };
  const recorder = useTestRecorder({
    state,
    getWorker: () => ({ postMessage: () => {} }) as unknown as Worker,
    query: async () => assert.fail("query should not be called"),
    logAgent: () => {},
    getBootedGame: () => booted,
    getOrCreateSession: async () => assert.fail("session should not be created"),
    markRemixNeedsSave: () => {},
    persistRemix: async () => {},
    flushAutosave: async () => {},
  });

  const taintedSnapshot: RecordingSnapshot = {
    start: {
      image: "img",
      cycle: 1,
      state: {
        room: 1,
        vars: [],
        flags: [],
        inventory: [],
      },
      replayState: {} as unknown as RecordingSnapshot["start"]["replayState"],
    },
    operations: [],
    events: [],
    printed: [],
    endState: {
      room: 1,
      vars: [],
      flags: [],
      inventory: [],
    },
    endCycle: 2,
    tainted: "Game state was modified externally",
    usedGetnum: false,
  };

  const result = await recorder.saveRecordedTest(taintedSnapshot, "test", [], mockConfig);
  assert.equal(result.ok, false);
  assert.equal(result.message, "Game state was modified externally");
});
