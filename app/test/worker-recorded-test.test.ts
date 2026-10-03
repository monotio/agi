/**
 * Saving a recorded game test, end to end over fake ports: the real
 * recorder and authoring controller drive the real worker link and dispatch
 * against the IndexedDB fixture. The recording's TESTS.JSON reaches the
 * session and the running game only after storage took it, so a stale
 * refusal leaves all three as they were.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import { gameContainer } from "./worker-ctx.ts";
import {
  useAuthoringController,
  type PowerUpUiState,
} from "../src/authoring/useAuthoringController.ts";
import { useTestRecorder, type TestRecorderState } from "../src/authoring/useTestRecorder.ts";
import { useWorkerLink } from "../src/engine/useWorkerLink.ts";
import { createWorkerContext, type WorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import {
  clearCachedGame,
  loadAuthoredGame,
  readHistoryLifetime,
  saveAuthoredGame,
  updateAuthoredGameFiles,
} from "../src/project/gameStorage.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import type { EngineState, TextHook } from "../src/engine/useEngineTypes.ts";
import type { AgiAudio } from "../src/audio/AgiAudio.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";
import type { WorkerInbound } from "../src/worker/workerProtocol.ts";
import { openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";

installIndexedDbFixture();

const localValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => void localValues.set(key, value),
    removeItem: (key: string) => void localValues.delete(key),
    clear: () => localValues.clear(),
  },
});

const STUB: LlmConfig = { provider: "stub", model: "offline-stub", apiKey: "" };
/** The refusal a stale remix turn ends with; the recorder says the same. */
const STALE =
  "The game was changed elsewhere while the assistant worked, so nothing was applied. Reload the game, then ask again.";

/** Logic 0 enters room 1; room 1 draws PIC 1, so a recording has a room to resume. */
function gameFiles(): Record<string, Uint8Array> {
  return Object.fromEntries(
    gameContainer(
      [
        "if (equaln(v0,0)) { new.room(1); } call.v(v0); return;",
        "if (isset(f5)) { assignn(v50,1); load.pic(v50); draw.pic(v50); show.pic(); } return;",
      ],
      (c) =>
        c.putResource(
          "picture",
          1,
          compilePictureSource(["vis 1", "fill 80,80", "end"].join("\n"), {
            profile: DEFAULT_V2_PROFILE,
          }).bytes,
        ),
    ).files,
  );
}

function powerUp(): PowerUpUiState {
  return {
    mode: "remix",
    messages: [],
    open: false,
    needsConfig: false,
    busy: false,
    feedStart: 0,
    reply: "",
    room: 0,
    error: "",
  };
}

async function rig(t: TestContext, name: string) {
  const files = gameFiles();
  const projectId = testProjectId(name);
  const revision = await gameRevision(files);
  await saveAuthoredGame(projectId, {
    title: "Recorded",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  t.after(() => clearCachedGame(projectId));
  let game: BootedGame = {
    installed: false,
    projectId,
    title: "Recorded",
    revision,
    files,
    words: [],
    historyLifetime: await readHistoryLifetime(projectId),
  };

  const posted: WorkerInbound[] = [];
  let now = 0;
  let heldStop: WorkerInbound | null = null;
  let holdStop = false;
  const worker = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: WorkerInbound) {
      posted.push(msg);
      if (holdStop && msg.type === "stopRecording") heldStop = msg;
      else onWorkerMessage(ctx, msg);
    },
    terminate() {},
  };
  const ctx: WorkerContext = createWorkerContext({
    control: (message) => queueMicrotask(() => worker.onmessage?.({ data: message })),
    presentation: () => {},
    now: () => now,
  });
  ctx.host = createEngineHost(ctx);
  const linkState = {
    controls: [],
    agentLog: [],
    rows: [],
    powerUp: { messages: [] },
    walkthrough: {},
    debugTrace: [],
    debugTraceDropped: 0,
    debugObjects: [],
    roomJournal: [],
    prompt: null,
    debugChannels: {},
  } as unknown as EngineState;
  const link = useWorkerLink({
    state: linkState,
    hook: { rows: [] } as unknown as TextHook,
    audio: { stop() {}, setMuted() {}, setPaused() {}, output() {} } as unknown as AgiAudio,
    onFrame: () => {},
    logAgent: () => {},
    getBootedGame: () => game,
    getActiveWalkthroughSession: () => 0,
    observationListeners: new Set(),
  });
  Object.assign(link.deps, {
    resetScreenState() {},
    cancelPrompt() {},
    handleAutosave() {},
    handleHistoryBatch: async () => true,
    handleHistoryView() {},
    handleFlushed() {},
    handleRestored() {},
    handleSaveSlotRequest: () => "",
    handlePromptRequest: async () => "",
    handleRoomAuthoring: async () => "",
    getAgentSession: () => null,
    getReplayDriver: () => ({ latest: null }),
    gameQuit() {},
  });
  link.wireWorker(worker as unknown as Worker);
  worker.postMessage({ type: "boot", files, words: [] });
  ctx.fns.stopTimers();
  t.after(() => ctx.fns.stopTimers());
  const tick = (n: number): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  tick(6);

  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp: powerUp(),
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: link.getWorker,
    query: link.query,
    awaitPatched: link.awaitPatched,
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => game,
    setBootedGame: (next) => {
      game = next!;
    },
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
  });
  const recorderState: TestRecorderState = {
    phase: "running",
    recording: { active: false, starting: false, error: "" },
    powerUp: { open: false, busy: false },
    modal: null,
    prompt: null,
    waitingForKey: false,
  };
  const recorder = useTestRecorder({
    state: recorderState,
    getWorker: link.getWorker,
    query: link.query,
    logAgent: () => {},
    getBootedGame: () => game,
    getOrCreateSession: controller.getOrCreateSession,
    commitTestsFile: controller.commitTestsFile,
    flushAutosave: async () => {},
  });

  link.deps.recordingReset = recorder.reset;

  /** Record a few idle cycles in room 1 and return the snapshot. */
  async function record() {
    await recorder.startTestRecording();
    assert.equal(recorderState.recording.error, "");
    tick(3);
    const snapshot = await recorder.stopTestRecording();
    assert.ok(snapshot && !("endedBy" in snapshot), "the worker returned a recording");
    return snapshot;
  }
  const workerTests = () => ctx.engine!.containerFiles.get("TESTS.JSON");
  return {
    projectId,
    files,
    ctx,
    posted,
    controller,
    recorder,
    recorderState,
    worker,
    tick,
    holdStopRecording() {
      holdStop = true;
    },
    releaseStopRecording() {
      assert.ok(heldStop, "a stop request is waiting");
      onWorkerMessage(ctx, heldStop);
      heldStop = null;
      holdStop = false;
    },
    record,
    workerTests,
    game: () => game,
  };
}

test("a recorded test refused as stale leaves the session, the worker and storage unchanged", async (t) => {
  const r = await rig(t, "recorded-stale");
  const snapshot = await r.record();
  const author = await r.controller.getOrCreateSession(r.game(), STUB);
  // Another tab kept an edit: the stored project moved past the running game.
  const moved = openContainer(new Map(Object.entries(r.files)));
  moved.putResource("logic", 2, assembleLogic("return;", { dictionary: new Map() }).payload);
  const elsewhere = Object.fromEntries(moved.files);
  assert.equal(await updateAuthoredGameFiles(r.projectId, elsewhere), true);
  const posts = r.posted.length;

  const result = await r.recorder.saveRecordedTest(
    snapshot,
    "idle in room 1",
    [{ id: "room", kind: "room", label: "room 1", room: 1, selected: true }],
    STUB,
  );

  assert.deepEqual(result, { ok: false, message: STALE });
  assert.equal(author.state.testsPayload, undefined, "the session holds no recorded test");
  assert.equal(r.workerTests(), undefined, "the running game holds no recorded test");
  assert.deepEqual(
    r.posted.slice(posts).filter((m) => m.type === "patchMetadata"),
    [],
    "nothing was installed",
  );
  const stored = (await loadAuthoredGame(r.projectId))!;
  assert.equal(stored.files["TESTS.JSON"], undefined);
  assert.deepEqual(stored.files, elsewhere, "the other tab's save stands");
});

test("a recorded test is stored, then held by the session and installed in the running game", async (t) => {
  const r = await rig(t, "recorded-saved");
  const snapshot = await r.record();
  const result = await r.recorder.saveRecordedTest(
    snapshot,
    "idle in room 1",
    [{ id: "room", kind: "room", label: "room 1", room: 1, selected: true }],
    STUB,
  );
  assert.equal(result.ok, true, result.message);

  const stored = (await loadAuthoredGame(r.projectId))!.files["TESTS.JSON"];
  assert.ok(stored, "storage holds the recorded test");
  const tests = JSON.parse(new TextDecoder().decode(stored)) as { tests: { name: string }[] };
  assert.deepEqual(
    tests.tests.map((entry) => entry.name),
    ["idle in room 1"],
  );
  const author = r.controller.getSession()!;
  assert.deepEqual(author.state.testsPayload, stored, "the session holds the stored file");
  assert.deepEqual(r.workerTests(), stored, "the running game holds the stored file");
  assert.equal(r.game().revision, await gameRevision((await loadAuthoredGame(r.projectId))!.files));
});

test("a stop handled after a run replacement ends the recording without a snapshot", async (t) => {
  const r = await rig(t, "recorded-restarted");
  await r.recorder.startTestRecording();
  assert.equal(r.recorderState.recording.active, true);
  r.holdStopRecording();
  const pending = r.recorder.stopTestRecording();
  const oldEngine = r.ctx.engine;
  r.worker.postMessage({ type: "boot", files: r.files, words: [] });
  r.ctx.fns.stopTimers();
  r.tick(6);
  await Promise.resolve();
  assert.notEqual(r.ctx.engine, oldEngine, "the worker replaced the engine");
  assert.equal(r.recorderState.recording.active, false, "the reset reached the recorder");
  r.releaseStopRecording();
  assert.deepEqual(await pending, { endedBy: "restart" });
  assert.equal(r.recorderState.recording.active, false);
  assert.equal(r.recorderState.recording.error, "");
});
