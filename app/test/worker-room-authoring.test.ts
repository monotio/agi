/** Host request retirement releases hand edits through the real worker link and controller. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { useWorkerLink } from "../src/engine/useWorkerLink.ts";
import {
  useAuthoringController,
  type PowerUpUiState,
} from "../src/authoring/useAuthoringController.ts";
import { testsWriteBlockReason } from "../src/authoring/testWriteStatus.ts";
import { saveTests } from "../src/authoring/saveTests.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { advanceAuthoring } from "../src/project/projectTransaction.ts";
import {
  saveAuthoredGame,
  loadAuthoredGame,
  readHistoryLifetime,
  clearCachedGame,
} from "../src/project/gameStorage.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { computeResourceRevision } from "../../src/authoring/resourceRevision.ts";
import { testProjectId } from "./identity.ts";
import { installWebLocksFixture } from "./webLocksFixture.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { waitUntil } from "./async.ts";
import * as authoringStack from "../src/agent/authoringStack.ts";
import type { WorkerInbound, WorkerOutbound } from "../src/worker/workerProtocol.ts";
import type { EngineState, TextHook } from "../src/engine/useEngineTypes.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import type { AgentHandler } from "../src/agent/hostRequests.ts";

installWebLocksFixture();
installIndexedDbFixture();
const storedValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storedValues.set(key, value);
    },
    removeItem: (key: string) => {
      storedValues.delete(key);
    },
  },
});

function port() {
  return {
    onmessage: null as ((event: { data: WorkerOutbound }) => void) | null,
    posted: [] as WorkerInbound[],
    postMessage(message: WorkerInbound) {
      this.posted.push(message);
    },
    terminate() {},
  };
}
function powerUp(): PowerUpUiState {
  return {
    mode: "room",
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
async function rig(
  t: TestContext,
  name: string,
  options: { setup?: boolean; next?: boolean } = {},
) {
  const projectId = testProjectId(name);
  const container = createContainer();
  for (const room of [0, 1])
    container.putResource(
      "logic",
      room,
      assembleLogic("return;", { dictionary: new Map() }).payload,
    );
  const files = Object.fromEntries(container.files);
  await saveAuthoredGame(projectId, {
    title: "Room requests",
    files,
    words: [],
    roomGeneration: true,
  });
  const project = openProjectSession({
    data: (await loadAuthoredGame(projectId))!,
    lifetime: (await readHistoryLifetime(projectId))!,
    admission: {
      runToken: name,
      admit: async () => assert.fail("only an answered room can admit"),
      admitPreparedRoom: async () => ({
        status: "committed",
        expected: null,
        current: null,
        patchGeneration: 1,
      }),
    },
    publish(_snapshot, data) {
      advanceAuthoring(game, data.authoringState, data.workspace);
      game.files = data.files;
      game.revision = computeResourceRevision(data.files);
    },
  });
  const state = {
    phase: "running",
    controls: [],
    agentLog: [],
    rows: [],
    powerUp: powerUp(),
    walkthrough: {},
    debugTrace: [],
    debugTraceDropped: 0,
    debugObjects: [],
    roomJournal: [],
    prompt: null,
    agentTask: null,
    profile: "2.936",
    worldTick: 0,
    planDurableRev: "",
    roomGeneration: null,
  } as unknown as EngineState;
  const game: BootedGame = {
    installed: false,
    projectId,
    title: "Room requests",
    files,
    words: [],
    revision: computeResourceRevision(files),
  };
  let worker = port();
  const first = worker;
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const setupEntered = Promise.withResolvers<void>();
  const setupFinish = Promise.withResolvers<void>();
  const nextEntered = Promise.withResolvers<void>();
  const nextFinish = Promise.withResolvers<void>();
  let handled = 0;
  const calls: Promise<string>[] = [];
  const agent: AgentHandler = {
    async handle(req, beforeAdopt) {
      handled++;
      if (Number(req.context["room"]) === 2) {
        entered.resolve();
        await finish.promise;
      } else if (options.next) {
        nextEntered.resolve();
        await nextFinish.promise;
      }
      await beforeAdopt?.();
      controller
        .getSession()!
        .state.container.putResource(
          "logic",
          Number(req.context["room"]),
          assembleLogic("return;", { dictionary: new Map() }).payload,
        );
      return `Room ${String(req.context["room"])} created`;
    },
  };
  const link = useWorkerLink({
    state,
    hook: { rows: [] } as unknown as TextHook,
    audio: null,
    onFrame: () => {},
    logAgent: () => {},
    getBootedGame: () => game,
    getActiveWalkthroughSession: () => 0,
    observationListeners: new Set(),
  });
  const controller = useAuthoringController({
    state,
    getWorker: () => worker as unknown as Worker,
    query: async <T>() => null as T,
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => game,
    setBootedGame: () => {},
    getProjectSession: () => project,
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: async () => ({ resources: [], patchGen: 1 }),
    configForGame: (_p, config) => config,
    getLlmConfig: () => ({ provider: "stub", model: "offline-stub", apiKey: "" }),
    loadAuthoring: async () => {
      if (options.setup) {
        setupEntered.resolve();
        await setupFinish.promise;
      }
      return authoringStack;
    },
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
    handlePromptRequest: async () => "9",
    getAgentSession: () => agent,
    getReplayDriver: () => ({ latest: null }),
    gameQuit() {},
    handleRoomAuthoring(
      req: Parameters<typeof controller.handleRoomAuthoring>[0],
      author: AgentHandler,
    ) {
      const pending = controller.handleRoomAuthoring(req, author, () => {});
      calls.push(pending);
      return pending;
    },
    hostAnswered(req: { op: string }) {
      if (req.op === "room") controller.roomAnswered();
    },
  });
  link.wireWorker(worker as unknown as Worker);
  t.after(async () => {
    controller.resetSession();
    finish.resolve();
    setupFinish.resolve();
    nextFinish.resolve();
    await Promise.allSettled(calls);
    link.terminateWorker();
    project.dispose();
    await clearCachedGame(projectId);
  });
  return {
    link,
    controller,
    project,
    first,
    entered,
    finish,
    setupEntered,
    setupFinish,
    nextEntered,
    nextFinish,
    calls,
    state,
    get worker() {
      return worker;
    },
    get handled() {
      return handled;
    },
    replace() {
      worker = port();
      link.wireWorker(worker as unknown as Worker);
    },
    deliver(message: WorkerOutbound) {
      worker.onmessage!({ data: message });
    },
  };
}
const edit = {
  kind: "merge",
  tests: [{ name: "after abandoned room", room: 1, steps: [], expect: null }],
} as const;
for (const retirement of ["cancel", "replace", "supersede"] as const) {
  test(`a ${retirement} through the worker link retires the room hold after a late successful completion`, async (t) => {
    const f = await rig(t, `room-request-${retirement}`);
    f.deliver({ type: "hostRequest", generation: 1, id: 1, op: "room", context: { room: 2 } });
    await f.entered.promise;
    assert.match(testsWriteBlockReason(f.project)!, /Wait for the Agent/);
    if (retirement === "cancel") {
      f.deliver({ type: "interactionCancelled", generation: 0, id: 1, op: "room" });
      assert.match(
        testsWriteBlockReason(f.project)!,
        /Wait for the Agent/,
        "an older cancellation cannot retire this request",
      );
      f.deliver({ type: "interactionCancelled", generation: 1, id: 1, op: "room" });
    } else if (retirement === "replace") f.replace();
    else f.deliver({ type: "hostRequest", generation: 2, id: 1, op: "getnum", context: {} });
    f.finish.resolve();
    await f.calls[0];
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      testsWriteBlockReason(f.project),
      null,
      "an abandoned completion releases the Tests panel's hand-write hold",
    );
    assert.equal(f.controller.testsWriteBlockReason(), null);
    assert.equal(f.project.model.capture().read("logic:2"), undefined);
    assert.equal(
      f.first.posted.some((message) => message.type === "hostAnswer" && message.generation === 1),
      false,
    );
    await saveTests(f.project, edit);
    f.deliver({ type: "hostRequest", generation: 3, id: 1, op: "room", context: { room: 3 } });
    await waitUntil(
      () => f.state.roomGeneration?.busy === false,
      "the next room did not finish or report an error",
    );
    assert.equal(f.state.roomGeneration?.error, "");
    await f.calls[1];
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.project.flush();
    assert.equal(f.handled, 2, "the next room request reaches authoring");
    assert.ok(
      f.worker.posted.some(
        (message) =>
          message.type === "hostAnswer" &&
          message.generation === 3 &&
          message.response === "Room 3 created",
      ),
    );
    assert.ok(f.project.model.capture().read("logic:3"));
    await waitUntil(
      () => testsWriteBlockReason(f.project) === null,
      "the next room publication did not release its hold",
    );
    assert.equal(testsWriteBlockReason(f.project), null);
  });
}

test("a cancelled room setup cannot acquire a new hold when its loader finally answers", async (t) => {
  const f = await rig(t, "room-request-late-setup", { setup: true });
  f.deliver({ type: "hostRequest", generation: 1, id: 1, op: "room", context: { room: 2 } });
  await f.setupEntered.promise;
  f.deliver({ type: "interactionCancelled", generation: 1, id: 1, op: "room" });
  assert.equal(testsWriteBlockReason(f.project), null);
  await saveTests(f.project, edit);
  f.setupFinish.resolve();
  await f.calls[0];
  assert.equal(f.handled, 0, "the cancelled setup never reaches the author");
  assert.equal(testsWriteBlockReason(f.project), null, "late setup cannot reacquire the hold");
  assert.equal(f.controller.testsWriteBlockReason(), null);
  assert.equal(
    f.first.posted.some((message) => message.type === "hostAnswer"),
    false,
  );
});

test("a superseded room completion cannot release the next room's hold or publish its old state", async (t) => {
  const f = await rig(t, "room-request-overlap", { next: true });
  f.deliver({ type: "hostRequest", generation: 1, id: 1, op: "room", context: { room: 2 } });
  await f.entered.promise;
  f.deliver({ type: "hostRequest", generation: 2, id: 1, op: "room", context: { room: 3 } });
  await Promise.race([
    f.nextEntered.promise,
    f.calls[1]!.then(() => assert.fail("the next room must enter authoring")),
  ]);
  f.finish.resolve();
  await f.calls[0];
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(testsWriteBlockReason(f.project)!, /Wait for the Agent/);
  assert.match(f.controller.testsWriteBlockReason()!, /Wait for the Agent/);
  assert.equal(f.project.model.capture().read("logic:2"), undefined);
  assert.equal(
    f.first.posted.some((message) => message.type === "hostAnswer" && message.generation === 1),
    false,
  );
  f.nextFinish.resolve();
  await f.calls[1];
  await new Promise<void>((resolve) => setImmediate(resolve));
  await f.project.flush();
  assert.ok(f.project.model.capture().read("logic:3"));
  await waitUntil(
    () => testsWriteBlockReason(f.project) === null,
    "the next room publication did not release its hold",
  );
  assert.equal(testsWriteBlockReason(f.project), null);
  await saveTests(f.project, edit);
});
