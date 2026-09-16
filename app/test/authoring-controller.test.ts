import { test } from "node:test";
import assert from "node:assert/strict";
import { useAuthoringController, type PowerUpUiState } from "../src/useAuthoringController.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId, testRevision } from "./identity.ts";
import { saveAuthoredGame, clearCachedGame } from "../src/gameStorage.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import type { BootedGame } from "../src/gameTypes.ts";

installIndexedDbFixture();

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
  });

  controller.closePowerUp();
  assert.equal(powerUp.open, false);
  assert.equal(resumed, true);
});

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
    revision: testRevision("rev-1"),
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

test("handleRoomAuthoring rejects and sets needsConfig when credentials are missing", async (t) => {
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
    configForGame: (_p, config) => config,
    getLlmConfig: () => activeConfig,
  });

  await assert.rejects(
    async () => {
      await controller.handleRoomAuthoring(
        { op: "room", context: { room: 2 } },
        mockAgent,
        () => {},
      );
    },
    { message: "The next room could not be created. Connect your model and try again." },
  );

  assert.equal(agentCalled, false);
  assert.equal(powerUp.needsConfig, true);
  assert.equal(controller.getSession(), null);

  await clearCachedGame(projectId);
});

test("handleRoomAuthoring rejects when roomGeneration is false", async (t) => {
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
    configForGame: (_p, config) => config,
    getLlmConfig: () => ({ provider: "stub", apiKey: "", model: "offline-stub" }),
  });

  await assert.rejects(
    async () => {
      await controller.handleRoomAuthoring(
        { op: "room", context: { room: 2 } },
        mockAgent,
        () => {},
      );
    },
    { message: "The next room could not be created. Connect your model and try again." },
  );

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
