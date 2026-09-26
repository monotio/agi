import { test } from "node:test";
import assert from "node:assert/strict";
import { useAuthoringController, type PowerUpUiState } from "../src/useAuthoringController.ts";
import { AgentSession } from "../src/agent/agentSession.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId, testRevision } from "./identity.ts";
import {
  saveAuthoredGame,
  clearCachedGame,
  loadAuthoredGame,
  readHistoryLifetime,
  updateAuthoredGameFiles,
} from "../src/gameStorage.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { createWorldDraft, draftAddRoom } from "../../src/agent/worldPlan.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { gameRevision } from "../src/gameMetadata.ts";
import type { DecodedImage } from "../src/referenceArt.ts";
import { base64ToBytes } from "../src/bytes.ts";
import type { BootedGame } from "../src/gameTypes.ts";
import type { AwaitPatchedFn } from "../src/workerQueries.ts";

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
const ackPatch: AwaitPatchedFn = async (kind, num, hint) => ({ kind, num, hint, patchGen: 1 });

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
    awaitPatched: ackPatch,
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
    awaitPatched: ackPatch,
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
  const patches: { type: string; kind?: string; num?: number }[] = [];
  const worker = {
    postMessage: (message: { type: string; kind?: string; num?: number }) => patches.push(message),
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
  assert.equal(patches[0]?.kind, "view");
  assert.equal(patches[0]?.num, 0);
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
