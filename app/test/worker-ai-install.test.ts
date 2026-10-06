import { scheduler as testScheduler } from "node:timers/promises";
/**
 * An AI turn's install, end to end over fake ports: the real authoring
 * controller saves the turn, then installs it through the real worker link
 * into the real worker dispatch and Engine. A remix whose batch the worker
 * refuses, whose acknowledgement never comes, or whose worker is replaced
 * before it answers — and a room written mid-play that the worker declines —
 * is saved, never reported installed, and leaves the game behind storage:
 * no old-engine autosave or checkpoint lands under the saved revision.
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
import { useAutosaveController, autosaveKey } from "../src/saves/useAutosaveController.ts";
import { useWorkerLink } from "../src/engine/useWorkerLink.ts";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import {
  clearCachedGame,
  loadAuthoredGame,
  readHistoryLifetime,
  saveAuthoredGame,
} from "../src/project/gameStorage.ts";
import type { BootedGame, ProjectId } from "../src/project/gameTypes.ts";
import type { EngineState, TextHook } from "../src/engine/useEngineTypes.ts";
import type { AgiAudio } from "../src/audio/AgiAudio.ts";
import type { WorkerInbound, WorkerPresentation } from "../src/worker/workerProtocol.ts";
import type { AwaitPatchedFn } from "../src/engine/workerQueries.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";
import type { AgentHandler } from "../src/agent/hostRequests.ts";
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

const STUB: LlmConfig = { provider: "stub", apiKey: "", model: "offline-stub" };
const picture = (colour: number) =>
  compilePictureSource([`vis ${colour}`, "fill 80,80", "end"].join("\n"), {
    profile: DEFAULT_V2_PROFILE,
  }).bytes;
const logic = (source: string) => assembleLogic(source, { dictionary: new Map() }).payload;

/** Room 1 draws PIC 1 (blue); with `writesRoom2`, it walks on once into room 2, which does not exist yet. */
function gameFiles(writesRoom2 = false): Record<string, Uint8Array> {
  return Object.fromEntries(
    gameContainer(
      [
        "if (equaln(v0,0)) { new.room(1); } call.v(v0); return;",
        `if (isset(f5)) { load.pic(v0); draw.pic(v0); show.pic(); } ${writesRoom2 ? "if (!isset(f200)) { set(f200); new.room(2); }" : ""} return;`,
      ],
      (c) => c.putResource("picture", 1, picture(1)),
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
    room: 1,
    error: "",
  };
}

/**
 * Store `files` as a project and boot it in a real worker dispatch behind a
 * fake Worker: posts dispatch synchronously unless `drop` holds them back,
 * worker → host replies arrive on a later microtask. Room requests reach
 * the controller with `agent`, as the link hands them on.
 */
async function rig(
  t: TestContext,
  name: string,
  hooks: {
    files?: Record<string, Uint8Array>;
    drop?: (msg: WorkerInbound) => boolean;
    awaitPatched?: (link: AwaitPatchedFn) => AwaitPatchedFn;
    agent?: AgentHandler;
  } = {},
) {
  const files = hooks.files ?? gameFiles();
  const projectId: ProjectId = testProjectId(name);
  const revision = await gameRevision(files);
  await saveAuthoredGame(projectId, {
    title: "AI install",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
    roomGeneration: true,
  });
  t.after(() => clearCachedGame(projectId));
  let game: BootedGame = {
    installed: false,
    projectId,
    title: "AI install",
    revision,
    files,
    words: [],
    historyLifetime: await readHistoryLifetime(projectId),
  };
  const presentation: WorkerPresentation[] = [];
  let now = 0;
  const worker = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: WorkerInbound) {
      if (!hooks.drop?.(msg)) onWorkerMessage(ctx, msg);
    },
    terminate() {},
  };
  const ctx = createWorkerContext({
    control: (message) => queueMicrotask(() => worker.onmessage?.({ data: message })),
    presentation: (message) => void presentation.push(message),
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
  let behindNotices = 0;
  let noticeBehind!: () => void;
  const behindStorageNotice = new Promise<void>((resolve) => (noticeBehind = resolve));
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
  const ui = {
    phase: "running" as const,
    powerUp: powerUp(),
    agentTask: null,
    agentLog: [],
    profile: "2.936",
    worldTick: 0,
    planDurableRev: "",
  };
  const controller = useAuthoringController({
    state: ui,
    getWorker: link.getWorker,
    query: link.query,
    awaitPatched: hooks.awaitPatched?.(link.awaitPatched) ?? link.awaitPatched,
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => game,
    setBootedGame: (next) => {
      game = next!;
    },
    flushAutosave: async () => true,
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    configForGame: (_project, config) => config,
    getLlmConfig: () => STUB,
    onBehindStorage: () => {
      behindNotices++;
      noticeBehind();
    },
  });
  const autosave = useAutosaveController({
    state: { resumed: false },
    getBootedGame: () => game,
    getWorker: link.getWorker,
    logAgent: () => {},
    isInstalledGame: () => false,
    bootGame: async () => {},
    bootAuthoredGame: async () => {},
    configForGame: (_project, config) => config,
    // No resume intent is armed in these tests; retirement is unreachable.
    retireFailedRecovery: () => {},
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
    handleRoomAuthoring: (req: Parameters<typeof controller.handleRoomAuthoring>[0]) =>
      controller.handleRoomAuthoring(req, hooks.agent!, () => {}),
    // As useEngine wires it: the answer is posted, then the room's install is confirmed.
    hostAnswered: () => controller.roomAnswered(),
    getAgentSession: () => null,
    getReplayDriver: () => ({ latest: null }),
    ejectGame() {},
  });
  link.wireWorker(worker as unknown as Worker);
  worker.postMessage({
    type: "boot",
    files,
    words: [],
    autosaveFiles: true,
    authorRooms: hooks.agent !== undefined,
  });
  ctx.fns.stopTimers();
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  tick(6);
  t.after(() => ctx.fns.stopTimers());
  const settle = () => testScheduler.yield();

  /**
   * The old engine's next autosave: one more resource patched into it, so
   * the autosave carries its container, handed to the autosave controller.
   */
  async function oldEngineAutosave(): Promise<void> {
    onWorkerMessage(ctx, {
      type: "patch",
      resources: [{ kind: "logic", num: 3, payload: logic("return;") }],
    });
    onWorkerMessage(ctx, { type: "flush", id: 99 });
    const message = presentation.findLast((m) => m.type === "autosave");
    assert.ok(message?.type === "autosave" && message.files, "the old engine autosaved its files");
    autosave.handleAutosave(message);
    await autosave.getAutosaveWrite();
  }

  return {
    ctx,
    link,
    ui,
    controller,
    projectId,
    revision,
    game: () => game,
    tick,
    settle,
    behindNotices: () => behindNotices,
    behindStorageNotice,
    oldEngineAutosave,
  };
}

/** The model's remix: PIC 1 turns red and logic 2 appears — one batch. */
function remixTurn(t: TestContext, r: Awaited<ReturnType<typeof rig>>) {
  const session = r.controller.getSession()!;
  t.mock.method(
    session,
    "runPowerUp",
    async (_i: string, _room: number, _images: unknown, beforeAdopt?: () => Promise<void>) => {
      await beforeAdopt?.();
      return {
        text: "The sky is red now.",
        patched: [
          { kind: "picture" as const, num: 1, payload: picture(4) },
          { kind: "logic" as const, num: 2, payload: logic("return;") },
        ],
      };
    },
  );
}

/** The remix is in storage, the game never took it, and the old engine writes nothing over it. */
async function savedNotInstalled(r: Awaited<ReturnType<typeof rig>>, pattern: RegExp) {
  assert.match(r.ui.powerUp.error, pattern);
  assert.equal(r.ui.powerUp.offerReload, true, "the panel offers the reload");
  const saved = (await loadAuthoredGame(r.projectId))!;
  const savedRevision = await gameRevision(saved.files);
  assert.notEqual(savedRevision, r.revision, "the remix was saved");
  assert.equal(r.game().revision, r.revision, "the booted game stays on what it confirmed");
  assert.equal(r.game().behindStorage, true);

  await r.oldEngineAutosave();
  const after = (await loadAuthoredGame(r.projectId))!;
  assert.equal(after.generation, saved.generation, "no old-engine autosave was written");
  assert.deepEqual(after.files, saved.files);
  const checkpoint = JSON.parse(localValues.get(autosaveKey(r.projectId)) ?? "null") as {
    game: { identity: { revision: string } };
  } | null;
  assert.notEqual(
    checkpoint?.game.identity.revision,
    savedRevision,
    "no checkpoint names the remix",
  );
}

test("a remix batch the worker refuses is saved, never installed, and stays safe from the old engine", async (t) => {
  const r = await rig(t, "ai-install-refused");
  await r.controller.openPowerUp(STUB);
  remixTurn(t, r);
  // The container refuses to pack the batch's logic: the worker installs none of it.
  const container = (r.ctx.engine as unknown as { container: { pack(arg: unknown): void } })
    .container;
  const pack = container.pack.bind(container);
  t.mock.method(container, "pack", (arg: unknown) => {
    if ([arg].flat().some((each) => (each as { kind?: string } | undefined)?.kind === "logic"))
      throw new Error("VOL.0 is full");
    pack(arg);
  });
  await r.controller.submitPowerUp("make the sky red");
  t.mock.restoreAll();
  await savedNotInstalled(r, /remix was saved.*VOL\.0 is full.*Reload/);
});

test("a remix whose acknowledgement never arrives is saved, never installed, and stays safe from the old engine", async (t) => {
  const r = await rig(t, "ai-install-silent", {
    drop: (msg) => msg.type === "patch",
    awaitPatched: (link) => (resources) => link(resources, 1),
  });
  await r.controller.openPowerUp(STUB);
  remixTurn(t, r);
  await r.controller.submitPowerUp("make the sky red");
  await savedNotInstalled(r, /remix was saved.*did not acknowledge.*Reload/);
});

test("a remix whose worker is replaced before it answers is saved, never installed, and stays safe from the old engine", async (t) => {
  let replace: () => void = () => {};
  const r = await rig(t, "ai-install-replaced", {
    // The patch is posted; before the worker answers, the link replaces it.
    drop: (msg) => {
      if (msg.type === "patch") queueMicrotask(replace);
      return msg.type === "patch";
    },
  });
  replace = () => r.link.drainPendingQueries(new Error("engine worker replaced"));
  await r.controller.openPowerUp(STUB);
  remixTurn(t, r);
  await r.controller.submitPowerUp("make the sky red");
  await savedNotInstalled(r, /remix was saved.*engine worker replaced.*Reload/);
});

test("a room written mid-play that the worker declines is saved, never installed, and stays safe from the old engine", async (t) => {
  const room2 = { logic: logic("return;"), picture: picture(2) };
  const r = await rig(t, "ai-install-room", {
    files: gameFiles(true),
    // The session stages a valid room, but the answer the worker receives
    // does not compile there: it declines the room.
    agent: {
      handle: async (_req, beforeAdopt) => {
        await beforeAdopt?.();
        const { container } = r.controller.getSession()!.state;
        container.putResource("logic", 2, room2.logic);
        container.putResource("picture", 2, room2.picture);
        return "not a room the worker can compile";
      },
    },
  });
  await r.controller.openPowerUp(STUB);
  r.controller.closePowerUp();
  // Room 1 walks on into room 2: the worker asks for it, and waits.
  for (let i = 0; i < 20 && r.ctx.hostRequests.hostRequestOutstanding === null; i++) r.tick();
  assert.equal(r.ctx.hostRequests.hostRequestOutstanding?.op, "room");
  await r.behindStorageNotice;

  const saved = (await loadAuthoredGame(r.projectId))!;
  const savedRevision = await gameRevision(saved.files);
  assert.notEqual(savedRevision, r.revision, "the room was saved");
  assert.equal(r.ctx.hostRequests.hostRequestOutstanding, null, "the worker got its answer");
  assert.equal(r.game().revision, r.revision, "the booted game stays on what it confirmed");
  assert.equal(r.game().behindStorage, true);
  assert.equal(r.behindNotices(), 1, "the player hears it, with no panel open");
  // The declined room left the player in room 1 behind its message; play on.
  onWorkerMessage(r.ctx, { type: "dismissPrint" });
  r.tick(2);

  await r.oldEngineAutosave();
  const after = (await loadAuthoredGame(r.projectId))!;
  assert.equal(after.generation, saved.generation, "no old-engine autosave was written");
  assert.deepEqual(after.files, saved.files);
});
