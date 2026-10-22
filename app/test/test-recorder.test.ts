import { test } from "node:test";
import { testRevision } from "./identity.ts";
import assert from "node:assert/strict";
import { useTestRecorder, type TestRecorderState } from "../src/authoring/useTestRecorder.ts";
import type { BootedGame } from "../src/engine/useEngine.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import type { RecordingSnapshot } from "../src/authoring/gameRecording.ts";

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

test("test recorder refuses to start on a live host request but not a parked window", async () => {
  // A parked print window serializes into the recording's setup image; the
  // guard only refuses states whose answer belongs to the player.
  const parked = createMockState({ modal: "print" });
  let queried = false;
  const allowRecorder = useTestRecorder({
    state: parked,
    getWorker: () => ({ postMessage: () => {} }) as unknown as Worker,
    query: async <T>() => {
      queried = true;
      return { ok: false, error: "stop here" } as T;
    },
    logAgent: () => {},
    getBootedGame: () => null,
    getProjectSession: () => null,
    flushAutosave: async () => {},
  });
  await allowRecorder.startTestRecording();
  assert.equal(queried, true, "a parked window reaches the worker");

  for (const modal of ["save", "restore"]) {
    const state = createMockState({ modal });
    const recorder = useTestRecorder({
      state,
      getWorker: () => ({ postMessage: () => {} }) as unknown as Worker,
      query: async () => assert.fail("query should not be called during a live request"),
      logAgent: () => {},
      getBootedGame: () => null,
      getProjectSession: () => null,
      flushAutosave: async () => {},
    });
    await recorder.startTestRecording();
    assert.equal(state.recording.active, false);
    assert.match(state.recording.error, /Close the open prompt or agent/);
  }
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
    getProjectSession: () => null,
    flushAutosave: async () => {},
  });

  await recorder.startTestRecording();
  assert.equal(state.recording.active, true);
  assert.equal(state.recording.error, "");

  const snapshot = await recorder.stopTestRecording();
  assert.ok(snapshot && !("endedBy" in snapshot));
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
    getProjectSession: () => null,
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
    revision: testRevision("abc"),
    files: {},
    words: [],
  };
  const recorder = useTestRecorder({
    state,
    getWorker: () => ({ postMessage: () => {} }) as unknown as Worker,
    query: async () => assert.fail("query should not be called"),
    logAgent: () => {},
    getBootedGame: () => booted,
    getProjectSession: () => null,
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
  };

  const result = await recorder.saveRecordedTest(taintedSnapshot, "test", []);
  assert.equal(result.ok, false);
  assert.equal(result.message, "Game state was modified externally");
});

test("Tests are documents: a recorded test saves during an Agent turn without AI tools", async () => {
  const snapshot: RecordingSnapshot = {
    start: {
      image: "image",
      cycle: 1,
      state: { room: 1, vars: [], flags: [], inventory: [] },
      replayState: {} as RecordingSnapshot["start"]["replayState"],
    },
    operations: [],
    events: [],
    printed: [],
    endState: { room: 1, vars: [], flags: [], inventory: [] },
    endCycle: 2,
    tainted: null,
  };
  const project = {} as ProjectSession;
  let saved = false;
  const recorder = useTestRecorder({
    state: createMockState({ powerUp: { open: true, busy: true } }),
    getWorker: () => ({}) as Worker,
    query: async () => assert.fail("saving a test never queries the live engine"),
    logAgent: () => {},
    getBootedGame: () => ({
      installed: true,
      title: "Test",
      revision: testRevision("test"),
      files: {},
      words: [],
    }),
    getProjectSession: () => project,
    saveTests: async (owner, op) => {
      assert.equal(owner, project);
      assert.equal(op.kind, "merge");
      saved = true;
      return {
        tests: [
          {
            name: "recorded",
            room: 1,
            spawnX: null,
            spawnY: null,
            steps: [],
            expect: null,
            cycleBudget: null,
          },
        ],
        written: [],
        payload: new Uint8Array(),
      };
    },
    flushAutosave: async () => {},
  });
  assert.deepEqual(await recorder.saveRecordedTest(snapshot, "recorded", []), {
    ok: true,
    message: "1 game test saved",
  });
  assert.equal(saved, true);
});
