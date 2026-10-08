import { waitUntil } from "./async.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STALE_SAVE_MESSAGE,
  useAuthoringController,
  type PowerUpUiState,
  type RoomGenerationUiState,
} from "../src/authoring/useAuthoringController.ts";
import { ResourceCommitError } from "../src/project/projectTransaction.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { computeResourceRevision } from "../../src/authoring/resourceRevision.ts";
import { AgentSession } from "../src/agent/agentSession.ts";
import * as authoringStack from "../src/agent/authoringStack.ts";
import {
  AUTHORING_LOAD_FAILED,
  AuthoringLoadError,
  type AuthoringLoader,
} from "../src/agent/authoringLoader.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { installWebLocksFixture } from "./webLocksFixture.ts";

import { testProjectId, testRevision } from "./identity.ts";
import {
  saveAuthoredGame,
  clearCachedGame,
  loadAuthoredGame,
  readHistoryLifetime,
  updateAuthoredGameFiles,
  updateGameConversation,
  commitProject,
} from "../src/project/gameStorage.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { createWorldDraft, draftAddRoom } from "../../src/agent/worldPlan.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import type { DecodedImage } from "../src/references/referenceArt.ts";
import { base64ToBytes, bytesToBase64 } from "../src/project/bytes.ts";
import { resourceSetHint } from "../../src/agent/authoringState.ts";
import type { HistoryBoot } from "../../src/agent/history.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import type { AwaitPatchedFn } from "../src/engine/workerQueries.ts";

installWebLocksFixture();

const records = installIndexedDbFixture();

function createMockPowerUp(): PowerUpUiState {
  return {
    mode: "remix",
    messages: [],
    open: false,
    needsConfig: false,
    busy: false,
    feedStart: 0,
    reply: "",
    room: 1,
    error: "",
  };
}

/** The worker's install ack, answered at once for the bytes sent. */
const ackPatch: AwaitPatchedFn = async (resources) => ({ resources, patchGen: 1 });

const mockConfig: LlmConfig = {
  provider: "stub",
  apiKey: "test",
  model: "test-model",
};

test("closePowerUp closes the bubble and resumes the engine", () => {
  const powerUp = createMockPowerUp();
  powerUp.open = true;
  let resumed = false;

  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp,
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => null,
    query: async () => assert.fail("query should not be called"),
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {
      resumed = true;
    },
    getBootedGame: () => null,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
  });

  controller.closePowerUp();
  assert.equal(powerUp.open, false);
  assert.equal(resumed, true);
});

test("a request runtime refuses an engine replaced during its query", async () => {
  const pending = Promise.withResolvers<unknown>();
  let worker = {} as Worker;
  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp: createMockPowerUp(),
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => worker,
    query: async <T>() => (await pending.promise) as T,
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => null,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
  });
  const runtime = controller.getAgentRuntime();
  const result = runtime.engine!.state();
  worker = {} as Worker;
  pending.resolve({ room: 2 });
  await assert.rejects(Promise.resolve(result), /running game changed/);
  await assert.rejects(runtime.nativeFiles!(), /running game changed/);
});

test("an old Ask result cannot publish into a new session after reset", async () => {
  const pending = Promise.withResolvers<string>();
  const ui = {
    phase: "running" as const,
    powerUp: createMockPowerUp(),
    agentTask: null,
    agentLog: [],
    profile: "2.936",
    worldTick: 0,
    planDurableRev: "",
  };
  ui.powerUp.mode = "ask";
  const controller = useAuthoringController({
    state: ui,
    getWorker: () => null,
    query: async <T>() => null as T,
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => null,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
  });
  const author = AgentSession.fromAuthoredData(
    mockConfig,
    () => {},
    Object.fromEntries(createContainer().files),
    [],
  );
  author.runAsk = () => pending.promise;
  controller.setSession(author);
  const result = controller.submitPowerUp("Where next?");
  controller.resetSession();
  ui.powerUp.messages = [];
  ui.powerUp.busy = true;
  pending.resolve("An answer from the old game.");
  await result;
  assert.deepEqual(ui.powerUp.messages, []);
  assert.equal(ui.powerUp.busy, true);
  assert.equal(ui.powerUp.chatSaveError, "");
});

for (const outcome of ["saved", "rejected"] as const) {
  test(`a retired Play Ask save cannot overwrite the next game's UI when ${outcome}`, async (t) => {
    installLocalStorageMock(t);
    const projectId = testProjectId(`ask-retired-save-${outcome}`);
    const files = createTestFiles();
    await saveAuthoredGame(projectId, { title: "Old game", files, words: [] });
    const game: BootedGame = {
      installed: false,
      projectId,
      title: "Old game",
      files,
      words: [],
      revision: await gameRevision(files),
    };
    const ui = {
      phase: "running" as const,
      powerUp: createMockPowerUp(),
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    };
    ui.powerUp.mode = "ask";
    const controller = useAuthoringController({
      state: ui,
      getWorker: () => null,
      query: async <T>() => null as T,
      logAgent: () => {},
      readFrames: async () => [],
      pauseEngine: () => {},
      resumeEngine: () => {},
      getBootedGame: () => game,
      setBootedGame: () => {},
      flushAutosave: async () => {},
      getAutosaveWrite: async () => true,
      clearAutosave: () => {},
      awaitPatched: ackPatch,
    });
    const author = AgentSession.fromAuthoredData(mockConfig, () => {}, files, []);
    author.runAsk = async () => "Read the sign.";
    controller.setSession(author);
    let retired = false;
    const set = records.set.bind(records);
    const write = t.mock.method(records, "set", (key: IDBValidKey, value: unknown) => {
      assert.equal(ui.powerUp.reply, "Read the sign.");
      controller.resetSession();
      retired = true;
      ui.powerUp.chatSaveError = "The next conversation needs saving.";
      ui.powerUp.error = "The next game's notice.";
      ui.powerUp.busy = true;
      if (outcome === "rejected") throw new ResourceCommitError("stale", "Old game changed.");
      return set(key, value);
    });
    try {
      await controller.submitPowerUp("Where next?");
      assert.equal(retired, true);
      assert.equal(ui.powerUp.chatSaveError, "The next conversation needs saving.");
      assert.equal(ui.powerUp.error, "The next game's notice.");
      assert.equal(ui.powerUp.offerReload, false);
      assert.equal(ui.powerUp.busy, true);
    } finally {
      write.mock.restore();
      await clearCachedGame(projectId);
    }
  });
}

test("openPowerUp enters remix mode, pauses engine, and queries room", async () => {
  const powerUp = createMockPowerUp();
  let paused = false;

  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp,
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => null,
    query: async <T>(type: string): Promise<T> => {
      if (type === "state") {
        return { room: 42, profile: "2.936" } as T;
      }
      throw new Error(`Unexpected query: ${type}`);
    },
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {
      paused = true;
    },
    resumeEngine: () => {},
    getBootedGame: () => null,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
  });

  await controller.openPowerUp(mockConfig);
  assert.equal(paused, true);
  assert.equal(powerUp.open, true);
  assert.equal(powerUp.room, 42);
  assert.equal(powerUp.busy, false);
});

test("remixNeedsSave flag transitions cleanly and resetSession cancels active task", () => {
  const powerUp = createMockPowerUp();
  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp,
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => null,
    query: async () => assert.fail("query should not be called"),
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => null,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
  });

  assert.equal(controller.isRemixNeedsSave(), false);
  controller.setRemixNeedsSave(true);
  assert.equal(controller.isRemixNeedsSave(), true);
  controller.resetSession();
  assert.equal(controller.isRemixNeedsSave(), false);
  assert.equal(controller.getSession(), null);
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

function createTestFiles(): Record<string, Uint8Array> {
  const c = createContainer();
  c.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  return { ...Object.fromEntries(c.files), "WORDS.TOK": buildWordsTok([]) };
}

test("handleRoomAuthoring establishes on-demand session for imported authorable project and creates room", async (t) => {
  installLocalStorageMock(t);
  const projectId = testProjectId("imported-authorable-proj");
  const files = createTestFiles();
  await saveAuthoredGame(projectId, {
    title: "Imported Authorable Game",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
    roomGeneration: true,
    imported: true,
  });

  const bootedGame: BootedGame = {
    installed: false,
    projectId,
    title: "Imported Authorable Game",
    revision: await gameRevision(files),
    files,
    words: [],
  };

  const powerUp = createMockPowerUp();
  let agentHandled = false;
  const mockAgent = {
    handle: async () => {
      agentHandled = true;
      return "Room created successfully";
    },
  };

  const activeConfig: LlmConfig = {
    provider: "stub",
    apiKey: "",
    model: "offline-stub",
  };

  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp,
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => null,
    query: async <T>() => null as T,
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => bootedGame,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
    configForGame: (_p, config) => config,
    getLlmConfig: () => activeConfig,
  });

  assert.equal(controller.getSession(), null);

  const result = await controller.handleRoomAuthoring(
    { op: "room", context: { room: 2 } },
    mockAgent,
    () => {},
  );

  assert.equal(result, "Room created successfully");
  assert.equal(agentHandled, true);
  assert.notEqual(controller.getSession(), null);
  assert.equal(powerUp.needsConfig, false);

  await clearCachedGame(projectId);
});

test("handleRoomAuthoring moves the booted game to the revision it saved once the game confirms it", async (t) => {
  // A later remix or Keep compares the booted revision with storage; a room
  // written mid-play that left it behind made every later turn look stale.
  // The worker installs the room as its answer, after this turn returns, so
  // the booted game follows when the running game confirms the saved files.
  installLocalStorageMock(t);
  const projectId = testProjectId("jit-room-revision");
  const files = createTestFiles();
  await saveAuthoredGame(projectId, {
    title: "JIT Room Game",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
    roomGeneration: true,
  });
  const bootedGame: BootedGame = {
    installed: false,
    projectId,
    title: "JIT Room Game",
    revision: await gameRevision(files),
    files,
    words: [],
  };
  const room = assembleLogic("return;", { dictionary: new Map() }).payload;
  // The running game answers with what it holds: the room once the answer landed.
  let running = files;
  const worker = { postMessage() {} } as unknown as Worker;
  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp: createMockPowerUp(),
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => worker,
    query: async <T>(type: string) => (type === "exportFiles" ? (running as T) : (null as T)),
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => bootedGame,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
    configForGame: (_p, config) => config,
    getLlmConfig: () => ({ provider: "stub", apiKey: "", model: "offline-stub" }),
  });
  await controller.handleRoomAuthoring(
    { op: "room", context: { room: 2 } },
    {
      handle: async () => {
        controller.getSession()!.state.container.putResource("logic", 2, room);
        return "Room created";
      },
    },
    () => {},
  );

  const stored = await loadAuthoredGame(projectId);
  assert.ok(stored);
  assert.equal(bootedGame.revision, await gameRevision(files), "not before the game holds it");
  running = stored!.files;
  controller.roomAnswered();
  // The next write waits the confirmation out instead of reading it as stale.
  assert.equal(await controller.persistSessionState(), true);
  assert.equal(bootedGame.revision, await gameRevision(stored!.files));
  assert.notEqual(bootedGame.revision, await gameRevision(files));
  assert.equal(bootedGame.behindStorage, undefined);

  await clearCachedGame(projectId);
});

test("an answered room checkpoints after its owned project publishes the installed revision", async (t) => {
  installLocalStorageMock(t);
  const projectId = testProjectId("owned-room-checkpoint");
  const files = createTestFiles();
  await saveAuthoredGame(projectId, {
    title: "JIT Room Game",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
    roomGeneration: true,
  });
  const bootedGame: BootedGame = {
    installed: false,
    projectId,
    title: "JIT Room Game",
    revision: await gameRevision(files),
    files,
    words: [],
  };
  const data = (await loadAuthoredGame(projectId))!;
  const project = openProjectSession({
    data,
    lifetime: (await readHistoryLifetime(projectId))!,
    admission: {
      runToken: "room-run",
      admit: async () => assert.fail("the worker already installed the room answer"),
      admitPreparedRoom: async () => ({
        status: "committed",
        expected: null,
        current: null,
        patchGeneration: 1,
      }),
    },
    publish(snapshot, saved) {
      bootedGame.files = saved.files;
      bootedGame.revision = snapshot.lastAdmissibleBuild!.identity.revision;
    },
  });
  t.after(() => project.dispose());
  let checkpoints = 0;
  const room = assembleLogic("return;", { dictionary: new Map() }).payload;
  // The running game answers with what it holds: the room once the answer landed.
  let running = files;
  const worker = { postMessage() {} } as unknown as Worker;
  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp: createMockPowerUp(),
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => worker,
    query: async <T>(type: string) => (type === "exportFiles" ? (running as T) : (null as T)),
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => bootedGame,
    setBootedGame: () => {},
    flushAutosave: async () => {
      assert.equal(bootedGame.revision, computeResourceRevision(running));
      assert.equal(project.saveStatus().state, "saved");
      checkpoints++;
    },
    getProjectSession: () => project,
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
    configForGame: (_p, config) => config,
    getLlmConfig: () => ({ provider: "stub", apiKey: "", model: "offline-stub" }),
  });
  await controller.handleRoomAuthoring(
    { op: "room", context: { room: 2 } },
    {
      handle: async () => {
        controller.getSession()!.state.container.putResource("logic", 2, room);
        return "Room created";
      },
    },
    () => {},
  );

  assert.equal(checkpoints, 0, "the host answer has not been delivered");
  running = Object.fromEntries(controller.getSession()!.state.getFiles());
  controller.roomAnswered();
  // Drain the answer's publish and durable write, without advancing the engine.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await project.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(checkpoints, 1, "a parked room gets a checkpoint at its installed revision");

  await clearCachedGame(projectId);
});

test("handleRoomAuthoring shows recovery and sets needsConfig when credentials are missing", async (t) => {
  installLocalStorageMock(t);
  const projectId = testProjectId("imported-no-creds-proj");
  const files = createTestFiles();
  await saveAuthoredGame(projectId, {
    title: "Imported Game No Creds",
    provider: "openai",
    model: "gpt-4o",
    files,
    words: [],
    roomGeneration: true,
    imported: true,
  });

  const bootedGame: BootedGame = {
    installed: false,
    projectId,
    title: "Imported Game No Creds",
    revision: testRevision("rev-1"),
    files,
    words: [],
  };

  const powerUp = createMockPowerUp();
  let agentCalled = false;
  const mockAgent = {
    handle: async () => {
      agentCalled = true;
      return "Room created";
    },
  };

  const activeConfig: LlmConfig = {
    provider: "openai",
    apiKey: "", // empty API key
    model: "gpt-4o",
  };

  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp,
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => null,
    query: async <T>() => null as T,
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => bootedGame,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
    configForGame: (_p, config) => config,
    getLlmConfig: () => activeConfig,
  });

  const pendingRoom = controller.handleRoomAuthoring(
    { op: "room", context: { room: 2 } },
    mockAgent,
    () => {},
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.stopRoomGeneration();
  assert.equal(await pendingRoom, "");

  assert.equal(agentCalled, false);
  assert.equal(powerUp.needsConfig, true);
  assert.equal(controller.getSession(), null);

  await clearCachedGame(projectId);
});

test("handleRoomAuthoring stops without authoring when roomGeneration is false", async (t) => {
  installLocalStorageMock(t);
  const projectId = testProjectId("imported-public-proj");
  const files = createTestFiles();
  await saveAuthoredGame(projectId, {
    title: "Public Imported Game",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
    roomGeneration: false,
    imported: true,
  });

  const bootedGame: BootedGame = {
    installed: false,
    projectId,
    title: "Public Imported Game",
    revision: testRevision("rev-1"),
    files,
    words: [],
  };

  const powerUp = createMockPowerUp();
  const mockAgent = {
    handle: async () => "Room created",
  };

  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp,
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => null,
    query: async <T>() => null as T,
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => bootedGame,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
    configForGame: (_p, config) => config,
    getLlmConfig: () => ({ provider: "stub", apiKey: "", model: "offline-stub" }),
  });

  const pendingRoom = controller.handleRoomAuthoring(
    { op: "room", context: { room: 2 } },
    mockAgent,
    () => {},
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.stopRoomGeneration();
  assert.equal(await pendingRoom, "");

  assert.equal(powerUp.needsConfig, true);
  assert.equal(controller.getSession(), null);

  await clearCachedGame(projectId);
});

test("reference capacity refuses room and character attachments without discarding art", async (t) => {
  installLocalStorageMock(t);
  const projectId = testProjectId("reference-capacity");
  const files = createTestFiles();
  await saveAuthoredGame(projectId, {
    title: "Art",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  const game: BootedGame = {
    installed: false,
    projectId,
    title: "Art",
    revision: testRevision("rev-1"),
    files,
    words: [],
  };
  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp: createMockPowerUp(),
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => null,
    query: async <T>() => null as T,
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => game,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
  });
  const decoded = {
    width: 1,
    height: 1,
    rgba: Uint8Array.of(1, 2, 3, 255),
    bytes: Uint8Array.of(1),
    mime: "image/png" as const,
  };
  for (let i = 0; i < 16; i++) await controller.attachRoomReference(decoded, 1, `image ${i}`);
  await assert.rejects(
    controller.attachRoomReference(decoded, 1, "seventeenth"),
    /16 references.*remove/i,
  );
  // Capacity is checked before attempting an invalid conversion.
  await assert.rejects(
    controller.attachCharacterReference([], { poses: 3 }, 0, "seventeenth"),
    /16 references.*remove/i,
  );
  assert.equal((await controller.listReferences()).length, 16);
  assert.equal((await controller.listReferences())[15]?.brief, "image 15");
  controller.resetSession();
  await clearCachedGame(projectId);
});

/** A decoded upload without DOM: 64x12, magenta key, one figure per cell. */
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

test("keepStagedView refuses a busy turn and a moved durable base, then commits once", async (t) => {
  installLocalStorageMock(t);
  const projectId = testProjectId("keep-staged-view");
  const files = createTestFiles();
  await saveAuthoredGame(projectId, {
    title: "Keep staged",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  const revision = await gameRevision(files);
  const game: BootedGame = {
    installed: false,
    projectId,
    title: "Keep staged",
    revision,
    files,
    words: [],
  };
  const powerUp = createMockPowerUp();
  const patches: { type: string; resources?: { kind: string; num: number }[] }[] = [];
  const worker = {
    postMessage: (message: { type: string; resources?: { kind: string; num: number }[] }) =>
      patches.push(message),
  } as unknown as Worker;
  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp,
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => worker,
    query: async <T>(type: string): Promise<T> => {
      if (type === "exportFiles") return files as T;
      return null as T;
    },
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => game,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
  });

  const reference = await controller.attachCharacterReference(
    [{ decoded: decodedSheet(), facing: "right" }],
    { poses: 4 },
    0,
    "hero",
  );
  const stagedPayload = base64ToBytes(reference.staged!.payload);

  // A running turn owns the session — Keep refuses and the offer survives.
  powerUp.busy = true;
  await assert.rejects(controller.keepStagedView(reference.id), /current agent turn/);
  assert.equal(patches.length, 0);
  powerUp.busy = false;

  // A second writer moved the durable project since boot — Keep refuses and
  // the offer survives for a reloaded game to take.
  const moved = createTestFiles();
  const movedContainer = openContainer(new Map(Object.entries(moved)));
  movedContainer.putResource(
    "logic",
    2,
    assembleLogic("return;", { dictionary: new Map() }).payload,
  );
  const movedFiles = Object.fromEntries(movedContainer.files);
  assert.equal(await updateAuthoredGameFiles(projectId, movedFiles), true);
  await assert.rejects(controller.keepStagedView(reference.id), /changed elsewhere/);
  assert.equal(patches.length, 0);
  assert.ok((await controller.listReferences())[0]?.staged, "staged offer must survive");

  // Restore the booted base and keep: the staged view lands in the project,
  // the worker gets the patch, and the stored offer is spent.
  assert.equal(await updateAuthoredGameFiles(projectId, files), true);
  await controller.keepStagedView(reference.id);
  const stored = await loadAuthoredGame(projectId);
  const storedContainer = openContainer(new Map(Object.entries(stored!.files)));
  assert.deepEqual(storedContainer.getResource("view", 0), stagedPayload);
  assert.equal(stored!.references?.[0]?.staged, undefined);
  // The patch, then the tape's authoring checkpoint naming the kept source.
  assert.deepEqual(
    patches.map((p) => p.type),
    ["patch", "authoring"],
  );
  assert.deepEqual(
    patches[0]?.resources?.map(({ kind, num }) => [kind, num]),
    [["view", 0]],
  );
  await clearCachedGame(projectId);
});

for (const withSession of [false, true]) {
  test(`Keep owns its base through export and persistence (session: ${withSession})`, async (t) => {
    installLocalStorageMock(t);
    const projectId = testProjectId(`keep-race-${withSession}`);
    const files = createTestFiles();
    await saveAuthoredGame(projectId, {
      title: "Keep race",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    });
    let game: BootedGame = {
      installed: false,
      projectId,
      title: "Keep race",
      revision: await gameRevision(files),
      files,
      words: [],
    };
    const author = AgentSession.fromAuthoredData(mockConfig, () => {}, files, []);
    const before = author.resourceSet();
    const powerUp = createMockPowerUp();
    const posts: { type: string }[] = [];
    const worker = {
      postMessage: (message: { type: string }) => posts.push(message),
    } as unknown as Worker;
    let duringExport: () => Promise<void> = async () => {};
    const controller = useAuthoringController({
      state: {
        phase: "running",
        powerUp,
        agentTask: null,
        agentLog: [],
        profile: "2.936",
        worldTick: 0,
        planDurableRev: "",
      },
      getWorker: () => worker,
      query: async <T>(type: string): Promise<T> => {
        assert.equal(type, "exportFiles");
        await duringExport();
        return game.files as T;
      },
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
      awaitPatched: ackPatch,
    });
    if (withSession) controller.setSession(author);
    const reference = await controller.attachCharacterReference(
      [{ decoded: decodedSheet(), facing: "right" }],
      { poses: 4 },
      0,
      "hero",
    );
    const moved = openContainer(new Map(Object.entries(files)));
    moved.putResource("logic", 2, assembleLogic("return;", { dictionary: new Map() }).payload);
    duringExport = async () => {
      assert.equal(await updateAuthoredGameFiles(projectId, Object.fromEntries(moved.files)), true);
    };
    await assert.rejects(controller.keepStagedView(reference.id), /changed|save/i);
    assert.equal(author.resourceSet(), before);
    assert.equal(game.files, files);
    assert.equal(posts.length, 0);
    const stored = (await loadAuthoredGame(projectId))!;
    assert.ok(openContainer(new Map(Object.entries(stored.files))).getResource("logic", 2));
    assert.ok(stored.references?.[0]?.staged);
    assert.equal(powerUp.busy, false);

    await updateAuthoredGameFiles(projectId, files);
    const beforeRecreation = (await loadAuthoredGame(projectId))!;
    game.historyLifetime = await readHistoryLifetime(projectId);
    duringExport = async () => {
      await clearCachedGame(projectId);
      const replacement = {
        ...beforeRecreation,
        title: "Replacement project",
        files: Object.fromEntries(moved.files),
      };
      for (let generation = 0; generation < beforeRecreation.generation!; generation++)
        assert.equal(await saveAuthoredGame(projectId, replacement), true);
      assert.equal((await loadAuthoredGame(projectId))!.generation, beforeRecreation.generation);
      assert.notEqual(await readHistoryLifetime(projectId), game.historyLifetime);
    };
    await assert.rejects(controller.keepStagedView(reference.id), /changed|save/i);
    const replacement = (await loadAuthoredGame(projectId))!;
    assert.equal(replacement.title, "Replacement project");
    assert.ok(openContainer(new Map(Object.entries(replacement.files))).getResource("logic", 2));
    assert.ok(replacement.references?.[0]?.staged);
    assert.equal(author.resourceSet(), before);
    assert.equal(posts.length, 0);

    // Even identical bytes in the replacement cannot revive the old boot's ownership.
    await updateAuthoredGameFiles(projectId, files);
    duringExport = async () => assert.fail("an obsolete boot must refuse before export");
    await assert.rejects(controller.keepStagedView(reference.id), /changed|removed/i);
    game.historyLifetime = await readHistoryLifetime(projectId);
    duringExport = async () => {
      assert.equal(powerUp.busy, true, "Keep reserves the controller before exporting");
      await assert.rejects(controller.keepStagedView(reference.id), /current agent turn/);
      if (withSession) {
        await assert.rejects(author.runPowerUp("change it", 1), /keeping a staged view/i);
        assert.throws(() => author.holdAdoption("rewind"), /keeping a staged view/i);
        const draft = createWorldDraft(author.state.authoring.world);
        assert.equal(draftAddRoom(draft, 99, "Concurrent room", ""), null);
        assert.equal(author.commitPlanDraft(draft).status, "invalid");
        assert.equal(author.state.authoring.world.rooms["99"], undefined);
      }
    };
    const originalSet = records.set.bind(records);
    t.mock.method(records, "set", (key: string, value: unknown) => {
      if (key === projectId) throw new DOMException("Quota injected", "QuotaExceededError");
      return originalSet(key, value);
    });
    await assert.rejects(controller.keepStagedView(reference.id), /save/i);
    assert.equal(author.resourceSet(), before, "failed persistence cannot mutate the live session");
    assert.equal(posts.length, 0);
    assert.ok((await loadAuthoredGame(projectId))!.references?.[0]?.staged);
    assert.equal(powerUp.busy, false);
    assert.equal(author.adoptionHeld, null);
    t.mock.restoreAll();

    await controller.keepStagedView(reference.id);
    const kept = (await loadAuthoredGame(projectId))!;
    assert.equal(kept.references?.[0]?.staged, undefined);
    const reopened = AgentSession.fromAuthoredData(
      mockConfig,
      () => {},
      kept.files,
      kept.words,
      kept.transcript,
      kept.sessionId,
      kept.authoringState,
    );
    assert.deepEqual(reopened.state.sources.views.get(0), reference.staged!.input);
    assert.deepEqual(
      posts.map((post) => post.type),
      ["patch", "authoring"],
    );
    if (withSession) {
      assert.deepEqual(
        author.state.container.getResource("view", 0),
        base64ToBytes(reference.staged!.payload),
      );
      assert.deepEqual(author.state.sources.views.get(0), reference.staged!.input);
      assert.deepEqual(kept.authoringState, author.getAuthoringState());
    }
    assert.equal(powerUp.busy, false);

    // A catalog edit creates a separate remix, preserving its source and offer.
    await saveAuthoredGame(projectId, {
      ...kept,
      library: { ...kept.library!, source: "catalog" },
    });
    const nextReference = await controller.attachCharacterReference(
      [{ decoded: decodedSheet(), facing: "right" }],
      { poses: 4 },
      1,
      "second hero",
    );
    const sourceBefore = (await loadAuthoredGame(projectId))!;
    duringExport = async () => {};
    await controller.keepStagedView(nextReference.id);
    assert.notEqual(game.projectId, projectId);
    assert.equal(game.historyLifetime, await readHistoryLifetime(game.projectId!));
    const original = (await loadAuthoredGame(projectId))!;
    assert.deepEqual(original.files, sourceBefore.files);
    assert.ok(original.references?.find((r) => r.id === nextReference.id)?.staged);
    const fork = (await loadAuthoredGame(game.projectId!))!;
    assert.equal(fork.library?.source, "remix");
    assert.equal(fork.library?.parent?.project, projectId);
    assert.equal(fork.references?.find((r) => r.id === nextReference.id)?.staged, undefined);
    assert.ok(openContainer(new Map(Object.entries(fork.files))).getResource("view", 1));
    await clearCachedGame(game.projectId!);
    await clearCachedGame(projectId);
  });
}

const STALE_TURN_MESSAGE =
  "The game was changed elsewhere while the assistant worked, so nothing was applied. Reload the game, then ask again.";

type WorkerPost = {
  type: string;
  resources?: { kind: "logic" | "picture" | "view" | "sound"; num: number; payload: Uint8Array }[];
  files?: Record<string, Uint8Array>;
};

/** A fake worker that applies patch traffic to a live container, as dispatch does. */
function remixHarness(files: Record<string, Uint8Array>) {
  const posts: WorkerPost[] = [];
  const liveContainer = openContainer(new Map(Object.entries(files)));
  const liveFiles = { ...files };
  const worker = {
    postMessage(message: WorkerPost) {
      posts.push(message);
      if (message.type === "patch")
        for (const { kind, num, payload } of message.resources ?? [])
          liveContainer.putResource(kind, num, payload);
      if (message.type === "patchMetadata" && message.files)
        Object.assign(liveFiles, message.files);
    },
  } as unknown as Worker;
  const query = async <T>(type: string): Promise<T> => {
    if (type === "exportFiles")
      return { ...liveFiles, ...Object.fromEntries(liveContainer.files) } as T;
    if (type === "state") return { room: 1, profile: "2.936" } as T;
    return null as T;
  };
  return { posts, liveContainer, worker, query };
}

test("a remix turn is refused when the stored project moved mid-turn", async (t) => {
  installLocalStorageMock(t);
  const projectId = testProjectId("remix-stale");
  const files = createTestFiles();
  await saveAuthoredGame(projectId, {
    title: "Remix stale",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  const baseRevision = await gameRevision(files);
  const game: BootedGame = {
    installed: false,
    projectId,
    title: "Remix stale",
    revision: baseRevision,
    files,
    words: [],
  };
  const powerUp = createMockPowerUp();
  const { posts, worker, query } = remixHarness(files);
  // A Keep's bytes land while the remix turn is in flight — the running game
  // still holds the pre-Keep revision, so the turn's result is stale.
  const moved = openContainer(new Map(Object.entries(files)));
  moved.putResource("logic", 2, assembleLogic("return;", { dictionary: new Map() }).payload);
  const movedFiles = Object.fromEntries(moved.files);
  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp,
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => worker,
    query,
    logAgent: () => {},
    readFrames: async () => {
      assert.equal(await updateAuthoredGameFiles(projectId, movedFiles), true);
      return [];
    },
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => game,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
  });
  await controller.openPowerUp(mockConfig);
  const session = controller.getSession()!;
  const postsBefore = posts.length;
  await controller.submitPowerUp("add a sign");

  assert.equal(powerUp.error, STALE_TURN_MESSAGE);
  assert.equal(powerUp.offerReload, true);
  assert.equal(powerUp.busy, false);
  assert.equal(posts.length, postsBefore, "a refused remix posts nothing to the worker");
  assert.equal(controller.isRemixNeedsSave(), false);
  assert.equal(
    session.state.container.getResource("logic", 1),
    null,
    "the refused turn's patch never reaches the session's resources",
  );
  assert.equal(game.revision, baseRevision);
  assert.equal(game.files, files);
  const stored = (await loadAuthoredGame(projectId))!;
  assert.equal(await gameRevision(stored.files), await gameRevision(movedFiles));
  assert.ok(openContainer(new Map(Object.entries(stored.files))).getResource("logic", 2));
  await clearCachedGame(projectId);
});

test("an ordinary remix installs and persists when storage holds its base", async (t) => {
  installLocalStorageMock(t);
  const projectId = testProjectId("remix-ordinary");
  const files = createTestFiles();
  await saveAuthoredGame(projectId, {
    title: "Remix ok",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  const game: BootedGame = {
    installed: false,
    projectId,
    title: "Remix ok",
    revision: await gameRevision(files),
    files,
    words: [],
  };
  const powerUp = createMockPowerUp();
  const { posts, liveContainer, worker, query } = remixHarness(files);
  let resumed = false;
  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp,
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => worker,
    query,
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {
      resumed = true;
    },
    getBootedGame: () => game,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
  });
  await controller.openPowerUp(mockConfig);
  const session = controller.getSession()!;
  const postsBefore = posts.length;
  await controller.submitPowerUp("add a sign");

  assert.equal(powerUp.error, "");
  assert.equal(powerUp.open, false);
  assert.equal(powerUp.busy, false);
  assert.equal(resumed, true);
  assert.equal(powerUp.messages.at(-1)?.text, "A weathered sign now stands in room 1.");
  // The stored bytes are exactly what the worker and the session installed.
  const stored = (await loadAuthoredGame(projectId))!;
  const remixed = openContainer(new Map(Object.entries(stored.files))).getResource("logic", 1);
  assert.ok(remixed);
  assert.deepEqual(liveContainer.getResource("logic", 1), remixed);
  assert.deepEqual(session.state.container.getResource("logic", 1), remixed);
  assert.equal(game.revision, await gameRevision(stored.files));
  assert.equal(controller.isRemixNeedsSave(), false);
  assert.deepEqual(
    posts.slice(postsBefore).map((post) => post.type),
    ["patch", "authoring", "reenter"],
  );
  await clearCachedGame(projectId);
});

test("buildRoomFromMap refuses when the stored project moved mid-build", async (t) => {
  installLocalStorageMock(t);
  const projectId = testProjectId("map-build-stale");
  const files = createTestFiles();
  await saveAuthoredGame(projectId, {
    title: "Map build",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
    roomGeneration: true,
  });
  const game: BootedGame = {
    installed: false,
    projectId,
    title: "Map build",
    revision: await gameRevision(files),
    files,
    words: [],
  };
  const moved = openContainer(new Map(Object.entries(files)));
  moved.putResource("logic", 3, assembleLogic("return;", { dictionary: new Map() }).payload);
  const movedFiles = Object.fromEntries(moved.files);
  let wrote = false;
  const posts: WorkerPost[] = [];
  const worker = {
    postMessage: (message: WorkerPost) => posts.push(message),
  } as unknown as Worker;
  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp: createMockPowerUp(),
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => worker,
    // The stored project moves while the build turn is being set up.
    query: async <T>(type: string): Promise<T> => {
      if (type === "state") {
        if (!wrote) {
          wrote = true;
          assert.equal(await updateAuthoredGameFiles(projectId, movedFiles), true);
        }
        return { room: 1 } as T;
      }
      if (type === "objects") return [] as T;
      if (type === "exportFiles") return files as T;
      return null as T;
    },
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => game,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
    configForGame: (_p, config) => config,
    getLlmConfig: () => mockConfig,
  });
  await assert.rejects(controller.buildRoomFromMap(2, 1, []), (error) => {
    assert.equal((error as { code?: string }).code, "stale");
    assert.equal((error as Error).message, STALE_TURN_MESSAGE);
    return true;
  });
  const session = controller.getSession()!;
  assert.equal(
    session.state.container.getResource("logic", 2),
    null,
    "the refused build never reaches the session's resources",
  );
  assert.equal(
    posts.filter((post) => post.type === "patch" || post.type === "patchMetadata").length,
    0,
    "a refused build installs nothing",
  );
  const stored = (await loadAuthoredGame(projectId))!;
  assert.equal(await gameRevision(stored.files), await gameRevision(movedFiles));
  assert.ok(openContainer(new Map(Object.entries(stored.files))).getResource("logic", 3));
  assert.equal(game.files, files);
  await clearCachedGame(projectId);
});

for (const when of ["before the turn", "mid-turn"] as const) {
  test(`a room written mid-play is refused when the stored project moved ${when}`, async (t) => {
    installLocalStorageMock(t);
    const projectId = testProjectId(`jit-room-stale-${when === "mid-turn" ? "mid" : "before"}`);
    const files = createTestFiles();
    await saveAuthoredGame(projectId, {
      title: "JIT stale",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
      roomGeneration: true,
    });
    const baseRevision = await gameRevision(files);
    const game: BootedGame = {
      installed: false,
      projectId,
      title: "JIT stale",
      revision: baseRevision,
      files,
      words: [],
    };
    // A Studio Keep from another tab: the stored project moves past the
    // revision the running game was built on.
    const moved = openContainer(new Map(Object.entries(files)));
    moved.putResource("logic", 3, assembleLogic("return;", { dictionary: new Map() }).payload);
    const movedFiles = Object.fromEntries(moved.files);
    const keepElsewhere = async () =>
      assert.equal(await updateAuthoredGameFiles(projectId, movedFiles), true);
    if (when === "before the turn") await keepElsewhere();
    const room = assembleLogic("return;", { dictionary: new Map() }).payload;
    let spent = false;
    const ui = {
      roomGeneration: null as RoomGenerationUiState | null,
      phase: "running" as const,
      powerUp: createMockPowerUp(),
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    };
    const controller = useAuthoringController({
      state: ui,
      getWorker: () => null,
      query: async <T>() => null as T,
      logAgent: () => {},
      readFrames: async () => [],
      pauseEngine: () => {},
      resumeEngine: () => {},
      getBootedGame: () => game,
      setBootedGame: () => {},
      flushAutosave: async () => {},
      getAutosaveWrite: async () => true,
      clearAutosave: () => {},
      awaitPatched: ackPatch,
      configForGame: (_p, config) => config,
      getLlmConfig: () => ({ provider: "stub", apiKey: "", model: "offline-stub" }),
    });
    // The session's contract: the host's gate runs before the staged room
    // lands in the session's container.
    const agent = {
      handle: async (_req: unknown, beforeAdopt?: () => Promise<void>) => {
        spent = true;
        if (when === "mid-turn") await keepElsewhere();
        await beforeAdopt?.();
        controller.getSession()!.state.container.putResource("logic", 2, room);
        return "Room created";
      },
    };
    const failedRoom = controller.handleRoomAuthoring(
      { op: "room", context: { room: 2 } },
      agent,
      () => {},
    );
    await waitUntil(() => !!ui.roomGeneration?.error, "the stale room error did not arrive");
    assert.equal(ui.roomGeneration?.error, STALE_TURN_MESSAGE);
    controller.stopRoomGeneration();
    assert.equal(await failedRoom, "");
    assert.equal(spent, when === "mid-turn", "a turn already behind storage never spends");
    // The room panel the request opened shows the refusal and its recovery.
    assert.equal(ui.powerUp.mode, "remix");
    assert.equal(ui.roomGeneration, null);
    assert.equal(ui.powerUp.offerReload, true);
    assert.equal(ui.powerUp.busy, false);
    assert.equal(controller.getSession()!.state.container.getResource("logic", 2), null);
    assert.equal(game.revision, baseRevision);
    const stored = (await loadAuthoredGame(projectId))!;
    assert.equal(await gameRevision(stored.files), await gameRevision(movedFiles));
    await clearCachedGame(projectId);
  });
}

for (const stopped of [false, true]) {
  test(
    stopped
      ? "Stop before the authoring stack arrives prevents the room request"
      : "the authoring stack loads on the first AI action, under the room's progress",
    async (t) => {
      // Play boots without the authoring stack: constructing the controller
      // loads nothing, and the first room a created game writes waits for the
      // load while the room panel already shows the room being written.
      installLocalStorageMock(t);
      const projectId = testProjectId("lazy-authoring-stack");
      const files = createTestFiles();
      await saveAuthoredGame(projectId, {
        title: "Lazy Stack Game",
        provider: "stub",
        model: "offline-stub",
        files,
        words: [],
        roomGeneration: true,
      });
      const bootedGame: BootedGame = {
        installed: false,
        projectId,
        title: "Lazy Stack Game",
        revision: await gameRevision(files),
        files,
        words: [],
      };
      let loads = 0;
      let release!: () => void;
      const arrived = new Promise<void>((resolve) => (release = resolve));
      const loadAuthoring: AuthoringLoader = async () => {
        loads++;
        await arrived;
        return authoringStack;
      };
      const ui = {
        roomGeneration: null as RoomGenerationUiState | null,
        phase: "running" as const,
        powerUp: createMockPowerUp(),
        agentTask: null,
        agentLog: [],
        profile: "2.936",
        worldTick: 0,
        planDurableRev: "",
      };
      const controller = useAuthoringController({
        state: ui,
        getWorker: () => null,
        query: async <T>() => null as T,
        logAgent: () => {},
        readFrames: async () => [],
        pauseEngine: () => {},
        resumeEngine: () => {},
        getBootedGame: () => bootedGame,
        setBootedGame: () => {},
        flushAutosave: async () => {},
        getAutosaveWrite: async () => true,
        clearAutosave: () => {},
        awaitPatched: ackPatch,
        configForGame: (_p, config) => config,
        getLlmConfig: () => mockConfig,
        loadAuthoring,
      });
      assert.equal(loads, 0, "constructing the controller loads nothing");

      let handled = false;
      const answer = controller.handleRoomAuthoring(
        { op: "room", context: { room: 2 } },
        {
          handle: async () => {
            handled = true;
            return "Room created";
          },
        },
        () => {},
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(loads, 1, "the first AI action starts the load");
      assert.equal(controller.getSession(), null, "no session before the stack arrives");
      assert.equal(handled, false);
      assert.deepEqual(
        { room: ui.roomGeneration?.room, busy: ui.roomGeneration?.busy, open: ui.powerUp.open },
        { room: 2, busy: true, open: false },
        "the room progress shows while the stack loads",
      );

      if (stopped) controller.stopRoomGeneration();
      release();
      assert.equal(await answer, stopped ? "" : "Room created");
      assert.equal(handled, !stopped);
      assert.equal(controller.getSession() instanceof AgentSession, !stopped);
      await clearCachedGame(projectId);
    },
  );
}

test("a failed authoring load reads plainly in Ask and leaves Play running", async () => {
  let loads = 0;
  const powerUp = createMockPowerUp();
  powerUp.mode = "ask";
  let resumed = false;
  const files = createTestFiles();
  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp,
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => null,
    query: async <T>(type: string) => (type === "state" ? ({ room: 3 } as T) : (null as T)),
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {
      resumed = true;
    },
    getBootedGame: () => ({
      installed: true,
      alias: "demo",
      title: "Demo",
      revision: testRevision("lazy-load-failure"),
      files,
      words: [],
    }),
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
    loadAuthoring: async () => {
      loads++;
      throw new AuthoringLoadError({ cause: new TypeError("Failed to fetch") });
    },
  });

  await controller.openPowerUp(mockConfig);
  assert.equal(loads, 1);
  assert.equal(powerUp.error, AUTHORING_LOAD_FAILED);
  assert.equal(powerUp.busy, false);
  assert.equal(controller.getSession(), null);
  // The drawer closes like any other; the next Ask tries the load again.
  controller.closePowerUp();
  assert.equal(resumed, true);
  await controller.openPowerUp(mockConfig);
  assert.equal(loads, 2);
});

test("Ask opens on Connect AI at once when no model is connected, before the engine answers", async () => {
  // The drawer never shows its prompt line first and then swaps it for the
  // connect prompt once the engine's state query returns.
  const ui = {
    phase: "running" as const,
    powerUp: createMockPowerUp(),
    agentTask: null,
    agentLog: [],
    profile: "2.936",
    worldTick: 0,
    planDurableRev: "",
  };
  ui.powerUp.mode = "ask";
  let answer!: (state: unknown) => void;
  const files = createTestFiles();
  const controller = useAuthoringController({
    state: ui,
    getWorker: () => null,
    query: <T>() => new Promise<T>((resolve) => (answer = resolve as (state: unknown) => void)),
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => ({
      installed: true,
      alias: "demo",
      title: "Demo",
      revision: testRevision("ask-connect-ai"),
      files,
      words: [],
    }),
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
    loadAuthoring: async () => assert.fail("an unconnected Ask loads no session"),
  });

  const opening = controller.openPowerUp({ provider: "openai", apiKey: "", model: "gpt-6-astra" });
  assert.equal(ui.powerUp.open, true);
  assert.equal(ui.powerUp.needsConfig, true, "Connect AI shows while the engine is asked");
  answer({ room: 1 });
  await opening;
  assert.equal(ui.powerUp.needsConfig, true);
  assert.equal(ui.powerUp.room, 1);
  assert.equal(ui.powerUp.error, "");
  assert.equal(controller.getSession(), null);
});

/**
 * Two tabs on one project: this tab booted `files`, then the other tab kept
 * an edit — new bytes, the source that describes them and its conversation.
 * Whatever this tab saves next must not replace that record.
 */
async function staleTab(t: { after: (fn: () => void) => void }, name: string) {
  installLocalStorageMock(t);
  const projectId = testProjectId(name);
  const files = createTestFiles();
  await saveAuthoredGame(projectId, {
    title: "Two tabs",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  t.after(() => void clearCachedGame(projectId));
  const game: BootedGame = {
    installed: false,
    projectId,
    title: "Two tabs",
    revision: await gameRevision(files),
    files,
    words: [],
    historyLifetime: await readHistoryLifetime(projectId),
  };
  const kept = openContainer(new Map(Object.entries(files)));
  kept.putResource("logic", 2, assembleLogic("return;", { dictionary: new Map() }).payload);
  const otherTab = AgentSession.fromAuthoredData(
    mockConfig,
    () => {},
    Object.fromEntries(kept.files),
    [],
  );
  otherTab.state.sources.logics.set(2, "return;");
  assert.equal(
    await updateGameConversation(
      projectId,
      [{ role: "user", content: "the other tab's conversation" }],
      "other-tab",
      otherTab.getAuthoringState(),
      "stub",
      "offline-stub",
      { ...Object.fromEntries(kept.files), "WORDS.TOK": files["WORDS.TOK"]! },
    ),
    true,
  );
  const newer = (await loadAuthoredGame(projectId))!;
  const ui = {
    phase: "running" as const,
    powerUp: createMockPowerUp(),
    agentTask: null,
    agentLog: [],
    profile: "2.936",
    worldTick: 0,
    planDurableRev: "",
  };
  const controller = useAuthoringController({
    state: ui,
    getWorker: () => null,
    query: async <T>(type: string) => (type === "state" ? ({ room: 1 } as T) : (null as T)),
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => game,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
  });
  const session = AgentSession.fromAuthoredData(mockConfig, () => {}, files, []);
  controller.setSession(session);
  /** The other tab's record, byte for byte: its files, sources, bindings and conversation. */
  async function untouched(): Promise<void> {
    const stored = (await loadAuthoredGame(projectId))!;
    assert.equal(stored.generation, newer.generation, "nothing was written over the newer save");
    assert.deepEqual(stored.files, newer.files);
    assert.deepEqual(stored.authoringState, newer.authoringState);
    assert.deepEqual(stored.transcript, newer.transcript);
  }
  return { ui, controller, game, files, session, untouched };
}

const staleSave = (error: unknown) =>
  error instanceof ResourceCommitError &&
  error.code === "stale" &&
  error.behindStorage &&
  error.message === STALE_SAVE_MESSAGE;

test("a stale tab's Ask says the game changed elsewhere and never saves over the newer project", async (t) => {
  const { ui, controller, untouched } = await staleTab(t, "two-tab-ask");
  ui.powerUp.mode = "ask";
  await controller.submitPowerUp("Where am I?");
  assert.equal(ui.powerUp.messages.at(-1)?.role, "assistant", "the answer is shown");
  assert.equal(ui.powerUp.error, STALE_SAVE_MESSAGE);
  assert.equal(ui.powerUp.offerReload, true);
  await untouched();
});

test("a stale tab's world-plan save refuses as stale and never saves over the newer project", async (t) => {
  const { controller, untouched } = await staleTab(t, "two-tab-plan");
  await assert.rejects(controller.persistSessionState(), staleSave);
  await untouched();
});

test("the plan's boolean save contract reports a refused project flush and Retry saves it", async (t) => {
  installLocalStorageMock(t);
  const projectId = testProjectId("plan-project-refusal");
  const files = createTestFiles();
  await saveAuthoredGame(projectId, { title: "Plan", files, words: [] });
  t.after(() => void clearCachedGame(projectId));
  const data = (await loadAuthoredGame(projectId))!;
  const game: BootedGame = {
    installed: false,
    projectId,
    title: data.title,
    revision: computeResourceRevision(files),
    files,
    words: [],
    authoredGame: data,
    historyLifetime: await readHistoryLifetime(projectId),
  };
  let fail = true;
  const project = openProjectSession({
    data,
    lifetime: game.historyLifetime!,
    admission: {
      runToken: "plan-refusal",
      admit: async () => ({
        status: "committed",
        expected: null,
        current: null,
        patchGeneration: 1,
      }),
    },
    write: async (request) => {
      if (fail) throw new Error("quota");
      return (await commitProject(request)).receipt;
    },
  });
  t.after(() => project.dispose());
  const ui = {
    phase: "running" as const,
    powerUp: createMockPowerUp(),
    agentTask: null,
    agentLog: [],
    profile: "2.936",
    worldTick: 0,
    planDurableRev: "",
  };
  const controller = useAuthoringController({
    state: ui,
    getProjectSession: () => project,
    getWorker: () => null,
    query: async <T>() => null as T,
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => game,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
  });
  const author = AgentSession.fromAuthoredData(mockConfig, () => {}, files, []);
  author.state.authoring.world.rooms["2"] = {
    title: "Gallery",
    description: "Portraits",
    exits: {},
  };
  controller.setSession(author);
  assert.equal(await controller.persistSessionState(), false);
  assert.equal(project.saveStatus().state, "failed");
  assert.equal(ui.planDurableRev, "");
  fail = false;
  assert.equal(await controller.persistSessionState(), true);
  assert.notEqual(ui.planDurableRev, "");
  const saved = (await loadAuthoredGame(projectId))!;
  assert.equal(
    (saved.authoringState?.["authoring"] as typeof author.state.authoring).world.rooms["2"]?.title,
    "Gallery",
  );
});

test("AI settings wait for the Assistant chat's catalog fork before loading its session", async (t) => {
  installLocalStorageMock(t);
  const projectId = testProjectId("settings-catalog-fork");
  const files = createTestFiles();
  const revision = computeResourceRevision(files);
  await saveAuthoredGame(projectId, {
    title: "Catalog",
    files,
    words: [],
    library: {
      version: 1,
      source: "catalog",
      revision,
      catalog: { id: "settings", version: "1" },
      validation: { status: "ready", message: "Ready" },
    },
  });
  const data = (await loadAuthoredGame(projectId))!;
  let game: BootedGame = {
    installed: false,
    projectId,
    title: data.title,
    revision,
    files,
    words: [],
    authoredGame: data,
    historyLifetime: await readHistoryLifetime(projectId),
  };
  const project = openProjectSession({
    data,
    lifetime: game.historyLifetime!,
    admission: {
      runToken: "settings-catalog-run",
      admit: async () => assert.fail("a chat never admits resource changes"),
    },
    forked(saved, lifetime) {
      game = {
        ...game,
        projectId: saved.projectId,
        authoredGame: saved,
        historyLifetime: lifetime,
      };
    },
  });
  t.after(() => project.dispose());
  let release!: () => void;
  const loading = new Promise<void>((resolve) => (release = resolve));
  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp: createMockPowerUp(),
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getProjectSession: () => project,
    getWorker: () => null,
    query: async <T>() => null as T,
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
    awaitPatched: ackPatch,
    loadAuthoring: async () => {
      await loading;
      return authoringStack;
    },
  });
  await project.saveChats(project.chats());
  const applying = controller.updateAiConfig(mockConfig);
  await project.flush();
  assert.notEqual(game.projectId, projectId);
  release();
  await applying;
  assert.equal(controller.getSession()!.getProviderContext().model, mockConfig.model);
  assert.equal(project.saveStatus().state, "saved");
  await clearCachedGame(projectId);
  await clearCachedGame(game.projectId!);
});

test("a stale tab's AI settings change says the game changed elsewhere and never saves over the newer project", async (t) => {
  const { ui, controller, untouched } = await staleTab(t, "two-tab-ai-config");
  await controller.updateAiConfig({ ...mockConfig, model: "another-model" });
  assert.equal(controller.getSession()?.getProviderContext().model, "another-model");
  assert.equal(ui.powerUp.error, STALE_SAVE_MESSAGE);
  assert.equal(ui.powerUp.offerReload, true);
  await untouched();
});

test("a stale tab's history adoption refuses as stale and never rolls the newer project back", async (t) => {
  const { controller, game, files, session, untouched } = await staleTab(t, "two-tab-adopt");
  const boot = {
    files: Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [name, bytesToBase64(bytes)]),
    ),
    dictionary: [],
    resourceSet: resourceSetHint({ getFiles: () => new Map(Object.entries(files)) }),
  } as unknown as HistoryBoot;
  await assert.rejects(
    controller.adoptSessionState(game, boot, session.snapshotAuthoring()),
    staleSave,
  );
  await untouched();
  // Without a session the adopted files alone would follow: refused the same way.
  controller.setSession(null);
  await assert.rejects(controller.adoptSessionState(game, boot, undefined), staleSave);
  await untouched();
});

test("a history adoption with no session stores the adopted files over the record it booted on", async (t) => {
  installLocalStorageMock(t);
  const projectId = testProjectId("adopt-no-session");
  const files = createTestFiles();
  const later = openContainer(new Map(Object.entries(files)));
  later.putResource("logic", 2, assembleLogic("return;", { dictionary: new Map() }).payload);
  const laterFiles = { ...Object.fromEntries(later.files), "WORDS.TOK": files["WORDS.TOK"]! };
  await saveAuthoredGame(projectId, {
    title: "Rewound",
    provider: "stub",
    model: "offline-stub",
    files: laterFiles,
    words: [],
  });
  t.after(() => void clearCachedGame(projectId));
  const game: BootedGame = {
    installed: false,
    projectId,
    title: "Rewound",
    revision: await gameRevision(laterFiles),
    files: laterFiles,
    words: [],
    historyLifetime: await readHistoryLifetime(projectId),
  };
  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp: createMockPowerUp(),
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => null,
    query: async <T>() => null as T,
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => game,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
  });
  // Resume from a moment before logic 2 was added.
  const boot = {
    files: Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [name, bytesToBase64(bytes)]),
    ),
    dictionary: [],
    resourceSet: resourceSetHint({ getFiles: () => new Map(Object.entries(files)) }),
  } as unknown as HistoryBoot;
  await controller.adoptSessionState(game, boot, undefined);
  const stored = (await loadAuthoredGame(projectId))!;
  assert.equal(await gameRevision(stored.files), await gameRevision(files));
  assert.equal(game.revision, await gameRevision(files));
});

for (const action of ["retry", "stop"] as const) {
  test(`room generation keeps its error visible with the drawer closed until ${action}`, async (t) => {
    installLocalStorageMock(t);
    const files = createTestFiles();
    const projectId = testProjectId(`room-recovery-${action}`);
    await saveAuthoredGame(projectId, {
      title: "Room recovery",
      provider: "stub",
      model: "stub",
      files,
      words: [],
      roomGeneration: true,
    });
    const game: BootedGame = {
      installed: false,
      projectId,
      title: "Room recovery",
      files,
      words: [],
      revision: await gameRevision(files),
    };
    const state = {
      phase: "running" as const,
      powerUp: createMockPowerUp(),
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
      roomGeneration: null as { busy: boolean; error: string; room: number } | null,
    };
    const controller = useAuthoringController({
      state,
      getWorker: () => null,
      query: async <T>() => null as T,
      logAgent: () => {},
      readFrames: async () => [],
      pauseEngine: () => {},
      resumeEngine: () => {},
      getBootedGame: () => game,
      setBootedGame: () => {},
      flushAutosave: async () => {},
      getAutosaveWrite: async () => true,
      clearAutosave: () => {},
      awaitPatched: ackPatch,
      configForGame: (_p, config) => config,
      getLlmConfig: () => mockConfig,
    });
    let attempts = 0;
    const pending = controller.handleRoomAuthoring(
      { op: "room", context: { room: 2, from: 1 } },
      {
        handle: async () => {
          attempts++;
          if (attempts === 1) throw new Error("The provider connection failed.");
          return controller.getSession()!.handle({ op: "room", context: { room: 2, from: 1 } });
        },
      },
      () => {},
    );
    void pending.catch(() => {});
    await waitUntil(() => !!state.roomGeneration?.error, "the room error did not arrive");
    assert.equal(state.powerUp.open, false);
    assert.equal(state.roomGeneration?.room, 2);
    assert.equal(state.roomGeneration?.busy, false);
    assert.equal(state.roomGeneration?.error, "The provider connection failed.");
    if (action === "retry") controller.retryRoomGeneration();
    else controller.stopRoomGeneration();
    const result = await pending;
    assert.equal(Boolean(result), action === "retry");
    assert.equal(attempts, action === "retry" ? 2 : 1);
    if (action === "stop") assert.equal(state.roomGeneration, null);
    controller.resetSession();
    await clearCachedGame(projectId);
  });
}

test("installed Play transfer waits for the active read-only turn and carries its exact conversation into Create", async () => {
  const files = Object.fromEntries(createContainer().files);
  const booted: BootedGame = {
    installed: true,
    title: "Installed",
    files,
    words: [],
    revision: computeResourceRevision(files),
  };
  const waiting = Promise.withResolvers<Record<string, Uint8Array>>();
  const inspected = Promise.withResolvers<void>();
  const worker = {} as Worker;
  const ui = {
    phase: "running" as const,
    powerUp: createMockPowerUp(),
    agentTask: null,
    agentLog: [],
    profile: "2.936",
    worldTick: 0,
    planDurableRev: "",
  };
  const controller = useAuthoringController({
    state: ui,
    getWorker: () => worker,
    query: async <T>() => {
      inspected.resolve();
      return (await waiting.promise) as T;
    },
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => booted,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: ackPatch,
    getLlmConfig: () => mockConfig,
    getConversationMode: () => "play",
  });
  const agent = (await controller.getConversationAgent())!;
  const running = agent.submit({ instruction: "Explain the game", mode: "play" });
  await inspected.promise;
  let transferred = false;
  const transfer = controller.prepareConversationTransfer().then((chats) => {
    transferred = true;
    return chats;
  });
  await Promise.resolve();
  assert.equal(transferred, false);
  waiting.resolve(files);
  await running;
  const chats = (await transfer)!;
  assert.equal(chats.active, agent.current().id);
  assert.deepEqual(chats.chats[0]!.messages, agent.current().messages);
  assert.equal(chats.chats[0]!.messages[0]!.request!.capability, "inspect");
  assert.deepEqual(ui.powerUp.messages, []);
  controller.resetSession();
});
