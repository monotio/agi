import { scheduler as testScheduler } from "node:timers/promises";
/**
 * Room Studio's and Sprite Studio's Keep, end to end over fake ports: the real authoring
 * controller commits through the real worker link into the real worker
 * dispatch and Engine, against the IndexedDB fixture. Each case checks one
 * leg of the transaction — the install ack, the refusals that must leave
 * storage and the worker untouched, the no-op, the remix fork, the re-render
 * and history record, and a failed install after the durable save.
 */
import { test, type TestContext } from "node:test";
import { ref } from "vue";
import assert from "node:assert/strict";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId, testRevision } from "./identity.ts";
import { gameContainer, replayHistorySegment } from "./worker-ctx.ts";
import { AgentSession } from "../src/agent/agentSession.ts";
import {
  useAuthoringController,
  type PowerUpUiState,
} from "../src/authoring/useAuthoringController.ts";
import { PROJECT_REMOVED_MESSAGE, ResourceCommitError } from "../src/project/projectTransaction.ts";
import { useWorkerLink } from "../src/engine/useWorkerLink.ts";
import { createWorkerContext, type WorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import { bindProgressTarget } from "../src/project/progressBinding.ts";
import {
  clearCachedGame,
  loadAuthoredGame,
  readHistoryLifetime,
  saveAuthoredGame,
  updateAuthoredGameFiles,
} from "../src/project/gameStorage.ts";
import type { BootedGame, ProjectId, ResourceRevision } from "../src/project/gameTypes.ts";
import type { EngineState, TextHook } from "../src/engine/useEngineTypes.ts";
import type { AgiAudio } from "../src/audio/AgiAudio.ts";
import type {
  WorkerControl,
  WorkerInbound,
  WorkerOutbound,
  WorkerPresentation,
} from "../src/worker/workerProtocol.ts";
import { studioCommitFailure, useStudioCommit } from "../src/studio/useStudioCommit.ts";
import { useStudioKeep } from "../src/studio/useStudioKeep.ts";
import { useAutosaveController } from "../src/saves/useAutosaveController.ts";
import { draftPictureEdit, type StudioDraft } from "../src/studio/useStudioDraft.ts";
import type { AwaitPatchedFn } from "../src/engine/workerQueries.ts";
import { resourceCacheHint } from "../../src/agent/authoringState.ts";
import { authoredPictureSource, createAgentSessionState } from "../../src/agent/agentState.ts";
import { historySyncDigest, type HistorySegment } from "../../src/agent/history.ts";
import { openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { openSprite } from "../../src/view/spriteDocument.ts";
import { applyEdit } from "../../src/studio/editOperations.ts";
import {
  parsePictureDocument,
  serializePictureDocument,
} from "../../src/studio/pictureDocument.ts";
import { placeEgo } from "../../src/runtime/playHere.ts";
import { parseLogicDocument } from "../../src/studio/rules/logicDocument.ts";
import { followPictureEdit } from "../../src/studio/rules/ruleBinding.ts";
import { applyRuleEdit } from "../../src/studio/rules/ruleEdit.ts";
import { applySpriteEdit } from "../../src/studio/sprite/spriteOperations.ts";
import { viewSpec } from "../../src/view/celEdit.ts";
import { buildView, type BuildViewInput } from "../../src/view/view.ts";
import { bytesToBase64 } from "../src/project/bytes.ts";

installIndexedDbFixture();

// Room 1 draws PIC 1: a whole-screen fill, blue before the edit, red after.
const BLUE = ["vis 1", "fill 80,80", "end"].join("\n");
const RED = ['# @item sky "Sky" art', "vis 4", "fill 80,80", "# @end", "end"].join("\n");
/** RED's bytes under different annotations: a source-only edit. */
const RED_RENAMED = ['# @item sky "Evening sky" art', "vis 4", "fill 80,80", "# @end", "end"].join(
  "\n",
);
const compile = (source: string) =>
  compilePictureSource(source, { profile: DEFAULT_V2_PROFILE }).bytes;
const PROBE = { x: 80, y: 80 };

/**
 * Room 1's logic draws PIC `drawn`; PIC 1 and PIC `drawn` start blue. Logic 0
 * runs the room's logic through call.v(v0), as AGI games do: a logic called
 * by number is shared, and the static scan credits it with no room's picture.
 */
function gameFiles(drawn = 1): Record<string, Uint8Array> {
  return Object.fromEntries(
    gameContainer(
      [
        "if (equaln(v0,0)) { new.room(1); } call.v(v0); return;",
        `if (isset(f5)) { assignn(v50,${drawn}); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
      ],
      (c) => {
        c.putResource("picture", 1, compile(BLUE));
        c.putResource("picture", drawn, compile(BLUE));
      },
    ).files,
  );
}

// Library metadata and the last-game pointer live in localStorage; each test
// file runs in its own process, so one store serves the whole file.
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

interface Rig {
  ctx: WorkerContext;
  controller: ReturnType<typeof useAuthoringController>;
  link: ReturnType<typeof useWorkerLink>;
  linkState: EngineState;
  /** Every host → worker message, in post order. */
  posted: WorkerInbound[];
  control: WorkerControl[];
  presentation: WorkerPresentation[];
  remixes: ProjectId[];
  game(): BootedGame;
  tick(n?: number): void;
  /** Let queued worker → host deliveries and storage callbacks land. */
  settle(): Promise<void>;
  /** The latest frame's picture-plane colour at PROBE. */
  picturePixel(): number;
}

/**
 * Boot `files` in a real worker dispatch behind a fake Worker: host → worker
 * posts dispatch synchronously, worker → host control replies arrive on a
 * later microtask, as they would across the thread boundary.
 */
function rig(
  t: TestContext,
  files: Record<string, Uint8Array>,
  booted: BootedGame,
  hooks: {
    /** A message the worker never receives (an interrupted install). */
    drop?: (msg: WorkerInbound) => boolean;
    /** Wraps the link's patch waiter the commit uses. */
    awaitPatched?: (link: AwaitPatchedFn) => AwaitPatchedFn;
    /** Boot as the app boots authored games: a patched container rides each autosave. */
    autosaveFiles?: boolean;
  } = {},
): Rig {
  const posted: WorkerInbound[] = [];
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  let now = 0;
  const worker = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: WorkerInbound) {
      posted.push(msg);
      if (!hooks.drop?.(msg)) onWorkerMessage(ctx, msg);
    },
    terminate() {},
  };
  const ctx = createWorkerContext({
    control: (message) => {
      control.push(message);
      queueMicrotask(() => worker.onmessage?.({ data: message }));
    },
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
    // The picture plane rides every frame once the channel is armed.
    debugChannels: { picture: true },
  } as unknown as EngineState;
  const hook = { rows: [] } as unknown as TextHook;
  const audio = { stop() {}, setMuted() {}, setPaused() {}, output() {} } as unknown as AgiAudio;
  let game = booted;
  const link = useWorkerLink({
    state: linkState,
    hook,
    audio,
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
  worker.postMessage({
    type: "boot",
    files,
    words: [],
    ...(hooks.autosaveFiles ? { autosaveFiles: true } : {}),
  });
  // The test drives cycles on a controlled clock.
  ctx.fns.stopTimers();
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  tick(6);

  const owners = new Set<string>();
  const remixes: ProjectId[] = [];
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
    awaitPatched: hooks.awaitPatched?.(link.awaitPatched) ?? link.awaitPatched,
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: (owner) => {
      if (owners.size === 0) worker.postMessage({ type: "pause", paused: true });
      owners.add(owner);
    },
    resumeEngine: (owner) => {
      owners.delete(owner);
      if (owners.size === 0) worker.postMessage({ type: "pause", paused: false });
    },
    getBootedGame: () => game,
    setBootedGame: (next) => {
      game = next!;
    },
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    onRemixCreated: (id) => void remixes.push(id),
  });
  t.after(() => ctx.fns.stopTimers());
  return {
    ctx,
    controller,
    link,
    linkState,
    posted,
    control,
    presentation,
    remixes,
    game: () => game,
    tick,
    settle: () => testScheduler.yield(),
    picturePixel() {
      const frame = presentation.findLast((m) => m.type === "frame");
      assert.ok(frame?.type === "frame" && frame.picVisual, "a frame carries the picture plane");
      return frame.picVisual![PROBE.y * 160 + PROBE.x]!;
    },
  };
}

/** Store an authored project and boot it; `library` makes it a catalog entry. */
async function authoredRig(
  t: TestContext,
  name: string,
  catalog = false,
  drawn = 1,
  files = gameFiles(drawn),
) {
  const projectId = testProjectId(name);
  const revision = await gameRevision(files);
  await saveAuthoredGame(projectId, {
    title: "Studio room",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
    ...(catalog
      ? {
          library: {
            version: 1 as const,
            revision,
            source: "catalog" as const,
            catalog: { id: "studio-room", version: "1" },
            validation: { status: "ready" as const, message: "" },
          },
        }
      : {}),
  });
  t.after(() => clearCachedGame(projectId));
  const booted: BootedGame = {
    installed: false,
    projectId,
    title: "Studio room",
    revision,
    files,
    words: [],
    historyLifetime: await readHistoryLifetime(projectId),
  };
  return { projectId, revision, files, r: rig(t, files, booted) };
}

const patches = (r: Rig) =>
  r.posted.filter((m): m is Extract<WorkerInbound, { type: "patch" }> => m.type === "patch");
/** The commit's own traffic since `from`; the link's history acks are not the transaction's. */
const hostPosts = (r: Rig, from: number) =>
  r.posted
    .slice(from)
    .map((m) => m.type)
    .filter((type) => type !== "historyAck");
const storedPicture = (files: Record<string, Uint8Array>) =>
  openContainer(new Map(Object.entries(files))).getResource("picture", 1);

test("a patch is acked with the hint of the bytes the engine now holds", async (t) => {
  const { r } = await authoredRig(t, "studio-ack");
  const bytes = compile(RED);
  const before = r.ctx.engine!.patchGeneration;
  const expected = [{ kind: "picture" as const, num: 1, hint: resourceCacheHint(bytes) }];
  const acked = r.link.awaitPatched(expected, 500);
  r.link.getWorker()!.postMessage({
    type: "patch",
    resources: [{ kind: "picture", num: 1, payload: bytes }],
  } satisfies WorkerInbound);
  assert.deepEqual(await acked, { resources: expected, patchGen: before + 1 });
  // An ack naming other bytes never confirms a waiter's install.
  const wrong = r.link.awaitPatched(
    [{ kind: "picture", num: 1, hint: resourceCacheHint(compile(BLUE)) }],
    500,
  );
  r.link.getWorker()!.postMessage({
    type: "patch",
    resources: [{ kind: "picture", num: 1, payload: compile(RED) }],
  } satisfies WorkerInbound);
  await assert.rejects(wrong, /different picture 1 bytes/);
});

test("a patch whose second resource is refused leaves every resource on its old bytes", async (t) => {
  const { files, r } = await authoredRig(t, "studio-batch-refused");
  const engine = r.ctx.engine!;
  const before = engine.patchGeneration;
  const live = () => openContainer(new Map(engine.containerFiles));
  const oldLogic = live().getResource("logic", 1);
  const expected = [
    { kind: "picture" as const, num: 1, hint: resourceCacheHint(compile(RED)) },
    { kind: "logic" as const, num: 1, hint: "" },
  ];
  const acked = r.link.awaitPatched(expected, 500);
  // The logic is over the u16 record length: the container refuses it.
  const oversized = new Uint8Array(0x10000);
  r.link.getWorker()!.postMessage({
    type: "patch",
    resources: [
      { kind: "picture", num: 1, payload: compile(RED) },
      { kind: "logic", num: 1, payload: oversized },
    ],
  } satisfies WorkerInbound);
  await assert.rejects(acked, /exceeds the u16le record length limit/);
  assert.deepEqual(live().getResource("picture", 1), storedPicture(files));
  assert.deepEqual(live().getResource("logic", 1), oldLogic);
  assert.equal(engine.patchGeneration, before, "a refused patch is not a patch");
});

test("a stale base or an unusable source is refused before storage or the worker", async (t) => {
  const { projectId, revision, files, r } = await authoredRig(t, "studio-stale");
  const generation = (await loadAuthoredGame(projectId))!.generation;
  const posts = r.posted.length;
  const edit = { pictureNumber: 1, bytes: compile(RED), source: RED, baseRevision: revision };

  // Studio opened on another revision of the game.
  await assert.rejects(
    r.controller.commitPictureEdit({ ...edit, baseRevision: testRevision("before") }),
    (e) => e instanceof ResourceCommitError && e.code === "stale",
  );
  // The stored project moved since boot (another tab kept an edit).
  const moved = openContainer(new Map(Object.entries(files)));
  moved.putResource("picture", 2, compile(BLUE));
  assert.equal(await updateAuthoredGameFiles(projectId, Object.fromEntries(moved.files)), true);
  await assert.rejects(
    r.controller.commitPictureEdit(edit),
    (e) => e instanceof ResourceCommitError && e.code === "stale",
  );
  assert.equal(await updateAuthoredGameFiles(projectId, files), true);
  const restored = (await loadAuthoredGame(projectId))!.generation;
  // Text that does not compile to the bytes is not a picture edit.
  await assert.rejects(
    r.controller.commitPictureEdit({ ...edit, source: BLUE }),
    (e) => e instanceof ResourceCommitError && e.code === "invalid",
  );
  await r.settle();

  assert.equal(generation! + 2, restored, "only the test's own writes moved the record");
  assert.equal((await loadAuthoredGame(projectId))!.generation, restored);
  assert.deepEqual(
    hostPosts(r, posts),
    ["pause", "pause", "pause", "pause", "pause", "exportFiles", "state", "pause"],
    "the refusals held and released the pause; only the last one read the game",
  );
  assert.equal(patches(r).length, 0);
  assert.deepEqual(storedPicture((await loadAuthoredGame(projectId))!.files), compile(BLUE));
  assert.equal(r.game().revision, revision);

  // The composable words a stale refusal for the Studio.
  const failure = studioCommitFailure(new ResourceCommitError("stale", "moved"));
  assert.equal(failure.message, "The game changed since you opened Studio. Reopen to continue.");
});

test("a Studio Keep refused as removed shows the transaction's words, not the generic stale text", () => {
  const removed = "This game was removed in another tab. Reload to continue.";
  const worded = studioCommitFailure(
    new ResourceCommitError("stale", removed, { behindStorage: true, removed: true }),
  );
  assert.deepEqual([worded.code, worded.message, worded.behindStorage], ["stale", removed, true]);
  // Any other stale refusal keeps the Studio's own words, whatever its text says.
  assert.equal(
    studioCommitFailure(new ResourceCommitError("stale", removed, { behindStorage: true })).message,
    "The game changed since you opened Studio. Reopen to continue.",
  );
});

test("an edit whose bytes and source already match commits nothing", async (t) => {
  const { projectId, revision, r } = await authoredRig(t, "studio-unchanged");
  const author = AgentSession.fromAuthoredData(
    { provider: "stub", model: "offline-stub", apiKey: "" },
    () => {},
    r.game().files,
    [],
  );
  author.state.sources.pictures.set(1, BLUE);
  r.controller.setSession(author);
  const generation = (await loadAuthoredGame(projectId))!.generation;
  const posts = r.posted.length;
  const result = await r.controller.commitPictureEdit({
    pictureNumber: 1,
    bytes: compile(BLUE),
    source: BLUE,
    baseRevision: revision,
  });
  assert.equal(result.status, "unchanged");
  assert.equal((await loadAuthoredGame(projectId))!.generation, generation);
  assert.deepEqual(hostPosts(r, posts), ["pause", "exportFiles", "state", "pause"]);

  // Same bytes, new annotations: the source commits without a patch.
  const { commit, busy, lastError } = useStudioCommit(r.controller.commitPictureEdit);
  const kept = await r.controller.commitPictureEdit({
    pictureNumber: 1,
    bytes: compile(RED),
    source: RED,
    baseRevision: revision,
  });
  assert.equal(kept.status, "committed");
  const renamed = commit({
    pictureNumber: 1,
    bytes: compile(RED_RENAMED),
    source: RED_RENAMED,
    baseRevision: kept.revision,
  });
  assert.equal(busy.value, true);
  assert.equal((await renamed)?.status, "committed");
  assert.equal(busy.value, false);
  assert.equal(lastError.value, null);
  assert.deepEqual(
    patches(r).flatMap((m) => m.resources.map(({ kind }) => kind)),
    ["picture"],
    "the rename posted no second patch",
  );
  const stored = (await loadAuthoredGame(projectId))!;
  const reopened = AgentSession.fromAuthoredData(
    { provider: "stub", model: "offline-stub", apiKey: "" },
    () => {},
    stored.files,
    stored.words,
    stored.transcript,
    stored.sessionId,
    stored.authoringState,
  );
  assert.equal(authoredPictureSource(reopened.state, 1), RED_RENAMED);
});

for (const origin of ["catalog", "installed"] as const) {
  test(`the first Keep on a ${origin} game forks a remix and keeps the source intact`, async (t) => {
    let projectId: ProjectId | null = null;
    let installedBoot: BootedGame | null = null;
    let r: Rig;
    let revision: ResourceRevision;
    if (origin === "catalog") {
      ({ projectId, revision, r } = await authoredRig(t, "studio-catalog", true));
    } else {
      const files = gameFiles();
      revision = await gameRevision(files);
      installedBoot = {
        installed: true,
        // A folder spelling outside the project-id alphabet: its logical
        // identity is minted from the folder digest, not the shared hash.
        folder: "Studio Edition",
        hash: "studio-installed",
        alias: "studio",
        title: "Studio edition",
        revision,
        files,
        words: [],
      };
      bindProgressTarget(installedBoot);
      r = rig(t, files, installedBoot);
    }
    const result = await r.controller.commitPictureEdit({
      pictureNumber: 1,
      bytes: compile(RED),
      source: RED,
      baseRevision: revision,
    });
    assert.equal(result.status, "committed");
    const remix = result.projectId!;
    t.after(() => clearCachedGame(remix));
    assert.notEqual(remix, projectId);
    assert.deepEqual(r.remixes, [remix], "Create follows the new remix");
    assert.equal(r.game().projectId, remix);
    assert.equal(r.game().installed, false);
    assert.equal(r.game().revision, result.revision);
    assert.equal(r.game().historyLifetime, await readHistoryLifetime(remix));
    assert.equal(
      r.game().progressTarget?.locator,
      `project:${remix}:${await readHistoryLifetime(remix)}`,
      "the adopted owner is bound to its own saved body's epoch",
    );
    assert.equal(r.game().progressTarget?.identity.revision, result.revision);

    const fork = (await loadAuthoredGame(remix))!;
    assert.equal(fork.library?.source, "remix");
    assert.equal(fork.library?.revision, result.revision);
    assert.deepEqual(fork.library?.parent, {
      project: projectId ?? installedBoot!.progressTarget!.identity.project,
      revision,
    });
    assert.deepEqual(storedPicture(fork.files), compile(RED));
    const pictures = (fork.authoringState?.["sources"] as { pictures: [number, string][] })
      .pictures;
    assert.deepEqual(pictures, [[1, RED]]);
    if (projectId) {
      const original = (await loadAuthoredGame(projectId))!;
      assert.equal(original.library?.source, "catalog");
      assert.deepEqual(storedPicture(original.files), compile(BLUE));
    }
  });
}

test("a notes-only first Keep on a catalog game forks a remix and leaves the catalog entry as shipped", async (t) => {
  const { projectId, revision, r } = await authoredRig(t, "studio-catalog-notes", true);
  const shipped = (await loadAuthoredGame(projectId))!;
  // The same bytes as BLUE, now with an item annotation.
  const NAMED_BLUE = ['# @item sky "Sky" art', "vis 1", "fill 80,80", "# @end", "end"].join("\n");
  assert.deepEqual(compile(NAMED_BLUE), compile(BLUE));
  const result = await r.controller.commitPictureEdit({
    pictureNumber: 1,
    bytes: compile(NAMED_BLUE),
    source: NAMED_BLUE,
    baseRevision: revision,
  });
  assert.equal(result.status, "committed");
  const remix = result.projectId!;
  t.after(() => clearCachedGame(remix));
  assert.notEqual(remix, projectId);
  assert.equal(patches(r).length, 0, "no bytes changed, so nothing installs");
  assert.equal(r.game().projectId, remix);
  const fork = (await loadAuthoredGame(remix))!;
  assert.equal(fork.library?.source, "remix");
  assert.deepEqual(
    (fork.authoringState?.["sources"] as { pictures: [number, string][] }).pictures,
    [[1, NAMED_BLUE]],
  );
  const original = (await loadAuthoredGame(projectId))!;
  assert.equal(original.generation, shipped.generation, "the catalog entry was not written");
  assert.equal(original.library?.source, "catalog");
  assert.equal(original.authoringState, undefined);
});

test("a kept picture re-renders the room and lands on the tape as patch then authoring", async (t) => {
  const { projectId, revision, r } = await authoredRig(t, "studio-render");
  const author = AgentSession.fromAuthoredData(
    { provider: "stub", model: "offline-stub", apiKey: "" },
    () => {},
    r.game().files,
    [],
  );
  r.controller.setSession(author);
  assert.equal(r.ctx.engine!.vars[0], 1);
  assert.equal(r.picturePixel(), 1, "room 1 shows the blue picture");

  const result = await r.controller.commitPictureEdit({
    pictureNumber: 1,
    bytes: compile(RED),
    source: RED,
    baseRevision: revision,
    reason: "Paint the sky red",
  });
  assert.equal(result.status, "committed");
  assert.equal(result.projectId, projectId);
  // The worker holds the edit, and the session and booted game describe it.
  assert.deepEqual(
    openContainer(new Map(r.ctx.engine!.containerFiles)).getResource("picture", 1),
    compile(RED),
  );
  assert.equal(authoredPictureSource(author.state, 1), RED);
  assert.equal(r.game().revision, result.revision);
  assert.equal(result.revision, await gameRevision((await loadAuthoredGame(projectId))!.files));

  r.tick(4);
  assert.equal(r.ctx.engine!.vars[0], 1);
  assert.equal(r.picturePixel(), 4, "the re-entered room draws the red picture");

  // The tape: the patch, the room re-entry and the checkpoint naming the
  // source, in that order — and the segment replays to the live state.
  r.link.getWorker()!.postMessage({ type: "flush", id: 1 } satisfies WorkerInbound);
  const segment = collectSegment(r.control);
  const causes = segment.events.map((e) => e.cause);
  const at = (kind: string) => causes.findIndex((c) => c.kind === kind);
  assert.ok(at("patch") >= 0 && at("patch") < at("reenter") && at("reenter") < at("authoring"));
  const checkpoint = causes[at("authoring")];
  assert.ok(checkpoint?.kind === "authoring");
  assert.deepEqual((checkpoint.snapshot["sources"] as { pictures: unknown }).pictures, [[1, RED]]);
  const replayed = replayHistorySegment(segment);
  assert.equal(replayed.error, null);
  assert.equal(replayed.diverged, null);
  assert.equal(historySyncDigest(replayed.ctx.engine!), historySyncDigest(r.ctx.engine!));
});

test("Keep re-enters the room whose logic draws the picture, not the room of that number", async (t) => {
  const { revision, r } = await authoredRig(t, "studio-pic7", false, 7);
  assert.equal(r.ctx.engine!.vars[0], 1);
  assert.equal(r.picturePixel(), 1, "room 1 shows PIC 7, blue");
  const reentries = () => r.posted.filter((m) => m.type === "reenter");

  // Room 1 never draws PIC 1: keeping it leaves the room as it stands.
  const unshown = await r.controller.commitPictureEdit({
    pictureNumber: 1,
    bytes: compile(RED),
    source: RED,
    baseRevision: revision,
  });
  assert.equal(unshown.status, "committed");
  assert.deepEqual(reentries(), []);
  r.tick(4);
  assert.equal(r.picturePixel(), 1);

  const shown = await r.controller.commitPictureEdit({
    pictureNumber: 7,
    bytes: compile(RED),
    source: RED,
    baseRevision: unshown.revision,
  });
  assert.equal(shown.status, "committed");
  assert.deepEqual(reentries(), [{ type: "reenter", room: 1 }]);
  r.tick(4);
  assert.equal(r.ctx.engine!.vars[0], 1);
  assert.equal(r.picturePixel(), 4, "the re-entered room draws the edited PIC 7");
});

test("a failed install after the save keeps storage as the source of truth", async (t) => {
  const { projectId, revision, r } = await authoredRig(t, "studio-install-fails");
  t.mock.method(r.ctx.engine!, "patchResources", () => {
    throw new Error("VOL.0 is full");
  });
  const { commit, lastError } = useStudioCommit(r.controller.commitPictureEdit);
  const result = await commit({
    pictureNumber: 1,
    bytes: compile(RED),
    source: RED,
    baseRevision: revision,
  });
  assert.equal(result, null);
  assert.equal(lastError.value?.code, "install");
  assert.equal(lastError.value?.projectId, projectId);
  assert.match(lastError.value!.message, /saved.*VOL\.0 is full.*Reload/);
  t.mock.restoreAll();

  // Storage holds the whole edit: bytes and the source that compiles to them.
  const stored = (await loadAuthoredGame(projectId))!;
  assert.deepEqual(storedPicture(stored.files), compile(RED));
  const reopened = AgentSession.fromAuthoredData(
    { provider: "stub", model: "offline-stub", apiKey: "" },
    () => {},
    stored.files,
    stored.words,
    stored.transcript,
    stored.sessionId,
    stored.authoringState,
  );
  assert.equal(authoredPictureSource(reopened.state, 1), RED);
  // The live side stayed on the old revision, so nothing builds on it.
  assert.equal(r.game().revision, revision);
  assert.equal(r.linkState.phase, "error", "the session error surfaced");
  await assert.rejects(
    r.controller.commitPictureEdit({
      pictureNumber: 1,
      bytes: compile(BLUE),
      source: BLUE,
      baseRevision: revision,
    }),
    (e) => e instanceof ResourceCommitError && e.code === "stale",
  );

  // Reloading boots the stored project, which already shows the edit.
  const reloaded = rig(t, stored.files, {
    installed: false,
    projectId,
    title: stored.title,
    revision: await gameRevision(stored.files),
    files: stored.files,
    words: stored.words,
  });
  assert.equal(reloaded.picturePixel(), 4);
});

/** Studio's Keep over the real commit: a draft of `source` made on `revision`. */
function keeper(r: Rig, source: string, revision: ResourceRevision) {
  const draft = {
    dirty: ref(true),
    gesturing: ref(false),
    kept: ref({ revision }),
    changes: ref(1),
    notesOnly: ref(false),
    compiled: ref({ bytes: compile(source) }),
    source: ref(source),
    markKept: () => {},
  } as unknown as StudioDraft;
  return useStudioKeep({
    draft,
    keep: (baseRevision) =>
      r.controller.commitPictureEdit(draftPictureEdit(draft, 1, baseRevision)),
  });
}

test("a Keep behind a project kept elsewhere reopens by reloading from storage", async (t) => {
  const { projectId, revision, files, r } = await authoredRig(t, "studio-kept-elsewhere");
  // Studio opened on another revision of the running game: reopening on the
  // running game is enough, and nothing needs a reload.
  const behindGame = keeper(r, RED, testRevision("before"));
  assert.equal(await behindGame.keep(), false);
  assert.equal(behindGame.banner.value?.recovery, "reopen");
  assert.equal(behindGame.banner.value?.fromStorage, false);

  // Another tab kept an edit: the stored project moved past the running game.
  const elsewhere = openContainer(new Map(Object.entries(files)));
  elsewhere.putResource("picture", 1, compile(RED));
  assert.equal(await updateAuthoredGameFiles(projectId, Object.fromEntries(elsewhere.files)), true);
  const behindStorage = keeper(r, RED_RENAMED, revision);
  assert.equal(await behindStorage.keep(), false);
  assert.deepEqual(behindStorage.banner.value, {
    message: "The game changed since you opened Studio. Reopen to continue.",
    recovery: "reopen",
    fromStorage: true,
  });
  // Nothing was written and nothing reached the worker: the other tab's edit stands.
  assert.equal(patches(r).length, 0);
  assert.deepEqual(storedPicture((await loadAuthoredGame(projectId))!.files), compile(RED));

  // A project removed and stored again (a new lifetime) is behind storage too.
  await clearCachedGame(projectId);
  await saveAuthoredGame(projectId, {
    title: "Studio room",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  await assert.rejects(
    r.controller.commitPictureEdit({
      pictureNumber: 1,
      bytes: compile(RED),
      source: RED,
      baseRevision: revision,
    }),
    (e) => e instanceof ResourceCommitError && e.code === "stale" && e.behindStorage,
  );
});

test("a Keep that loses the race to another tab's Keep says reopen from storage, not retry", async (t) => {
  const files = gameFiles();
  const projectId = testProjectId("studio-keep-race");
  const revision = await gameRevision(files);
  await saveAuthoredGame(projectId, {
    title: "Studio room",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  t.after(() => clearCachedGame(projectId));
  // The other tab's Keep lands after this Keep read the record and before
  // its conditional save: queued on the same project, it commits first.
  const green = compile(["vis 2", "fill 80,80", "end"].join("\n"));
  const elsewhere = openContainer(new Map(Object.entries(files)));
  elsewhere.putResource("picture", 1, green);
  let raced: Promise<boolean> | undefined;
  const r = rig(
    t,
    files,
    {
      installed: false,
      projectId,
      title: "Studio room",
      revision,
      files,
      words: [],
      historyLifetime: await readHistoryLifetime(projectId),
    },
    {
      drop: (msg) => {
        if (msg.type === "exportFiles" && raced === undefined)
          raced = updateAuthoredGameFiles(projectId, Object.fromEntries(elsewhere.files));
        return false;
      },
    },
  );
  const loser = keeper(r, RED, revision);
  assert.equal(await loser.keep(), false);
  assert.equal(await raced, true);
  // Retry would only refuse again: the one way on is the reload from storage.
  assert.deepEqual(loser.banner.value, {
    message: "The game changed since you opened Studio. Reopen to continue.",
    recovery: "reopen",
    fromStorage: true,
  });
  assert.equal(r.game().behindStorage, true);
  assert.equal(patches(r).length, 0);
  assert.deepEqual(storedPicture((await loadAuthoredGame(projectId))!.files), green);
});

test("a Keep on a project removed in another tab refuses as removed, with nothing written", async (t) => {
  const { projectId, revision, r } = await authoredRig(t, "studio-removed-elsewhere");
  await clearCachedGame(projectId);
  const removed = (e: unknown) =>
    e instanceof ResourceCommitError &&
    e.code === "stale" &&
    e.behindStorage &&
    e.removed &&
    e.message === PROJECT_REMOVED_MESSAGE;
  const edit = { pictureNumber: 1, bytes: compile(RED), source: RED, baseRevision: revision };
  // Found by the Keep itself (nothing heard): the game is behind for good.
  await assert.rejects(r.controller.commitPictureEdit(edit), removed);
  assert.equal(r.game().behindStorage, true);
  // Heard from the removing tab: refused before storage is read.
  r.game().removed = true;
  await assert.rejects(r.controller.commitPictureEdit(edit), removed);
  assert.equal(patches(r).length, 0);
  assert.equal(await loadAuthoredGame(projectId), null, "the Keep never recreates the project");
  // A stale refusal of a project that still exists is not a removal.
  assert.equal(new ResourceCommitError("stale", "x", { behindStorage: true }).removed, false);
});

test("a worker that never acks the patch fails the Keep as an install, after a bounded wait", async (t) => {
  const timeouts: (number | undefined)[] = [];
  const projectId = testProjectId("studio-never-acks");
  const files = gameFiles();
  const revision = await gameRevision(files);
  await saveAuthoredGame(projectId, {
    title: "Studio room",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  t.after(() => clearCachedGame(projectId));
  const r = rig(
    t,
    files,
    {
      installed: false,
      projectId,
      title: "Studio room",
      revision,
      files,
      words: [],
      historyLifetime: await readHistoryLifetime(projectId),
    },
    {
      drop: (msg) => msg.type === "patch",
      // Record the wait the commit asks for, and let it lapse at once.
      awaitPatched: (link) => (resources, timeoutMs) => {
        timeouts.push(timeoutMs);
        return link(resources, 1);
      },
    },
  );
  const keep = keeper(r, RED, revision);
  const kept = keep.keep();
  assert.equal(keep.status.value, "keeping");
  assert.equal(await kept, false);
  assert.equal(timeouts.length, 1);
  assert.ok(
    timeouts[0] !== undefined && timeouts[0] >= 1000 && timeouts[0] <= 15_000,
    `a sensible ack timeout, got ${timeouts[0]}`,
  );
  // The edit is saved; the live game never took it, so Studio stops editing
  // and offers the reload from storage.
  assert.equal(keep.status.value, "reload");
  assert.equal(keep.needsReload.value, true);
  assert.equal(keep.banner.value?.recovery, "reload");
  assert.equal(keep.banner.value?.fromStorage, true);
  assert.match(keep.banner.value!.message, /saved.*did not acknowledge picture 1.*Reload/);
  assert.deepEqual(storedPicture((await loadAuthoredGame(projectId))!.files), compile(RED));
  assert.equal(r.game().revision, revision, "the live side stays on the old revision");
  assert.equal(patches(r).length, 1);
  assert.deepEqual(
    openContainer(new Map(r.ctx.engine!.containerFiles)).getResource("picture", 1),
    compile(BLUE),
  );
});

/** The one live segment's events, deduped by batch as the host commits them. */
function collectSegment(control: WorkerControl[]): HistorySegment {
  let segment: HistorySegment | null = null;
  const seen = new Set<number>();
  for (const message of control as WorkerOutbound[]) {
    if (message.type !== "historyBatch" || seen.has(message.batch.batch)) continue;
    seen.add(message.batch.batch);
    const batch = message.batch;
    segment ??= {
      id: batch.segment,
      boot: batch.boot!,
      anchors: [],
      events: [],
      marks: [],
      sync: [],
    };
    segment.events.push(...batch.events);
    segment.marks.push(...batch.marks);
    segment.sync.push(...batch.sync);
    if (batch.clock !== undefined) (segment.clock ??= []).push(...batch.clock);
    if (batch.anchor !== undefined) segment.anchors.push(batch.anchor);
  }
  assert.ok(segment, "the session recorded a segment");
  return segment;
}

// ---- Sprite Studio: the VIEW edit ----------------------------------------

/** A 2x2 VIEW: loop 0 one cel, loop 1 its mirror. */
function spriteView(pixels: readonly number[]): Uint8Array {
  const cel = { width: 2, height: 2, transparentColor: 13, pixels };
  return buildView({ loops: [{ cels: [cel] }, { mirrorLoop: 0 }] }, DEFAULT_V2_PROFILE);
}
const VIEW_BEFORE = spriteView([1, 2, 13, 3]);

/** Room 1 animates object 1 in VIEW 3; with `bake`, it also adds VIEW 3 to the picture. */
function spriteFiles(bake: boolean): Record<string, Uint8Array> {
  return Object.fromEntries(
    gameContainer(
      [
        "if (equaln(v0,0)) { new.room(1); } call.v(v0); return;",
        [
          "if (isset(f5)) {",
          "load.pic(v0); draw.pic(v0); load.view(3);",
          bake ? "add.to.pic(3, 0, 0, 20, 100, 4, 4);" : "",
          "animate.obj(o1); set.view(o1, 3); position(o1, 60, 100); draw(o1); show.pic();",
          "} return;",
        ].join(" "),
      ],
      (c) => {
        c.putResource("picture", 1, compile(BLUE));
        c.putResource("view", 3, VIEW_BEFORE);
      },
    ).files,
  );
}
const storedView = (files: Record<string, Uint8Array>) =>
  openContainer(new Map(Object.entries(files))).getResource("view", 3);

test("a kept view installs live and keeps its spec; only a room that bakes it re-enters", async (t) => {
  for (const bake of [false, true]) {
    const { projectId, revision, r } = await authoredRig(
      t,
      `sprite-keep-${bake}`,
      false,
      1,
      spriteFiles(bake),
    );
    const after = applySpriteEdit(openSprite(VIEW_BEFORE, DEFAULT_V2_PROFILE), {
      type: "setPixels",
      loop: 1,
      cel: 0,
      changes: [{ x: 0, y: 0, color: 4 }],
    });
    assert.ok("document" in after);
    const bytes = after.document.payload;
    const result = await r.controller.commitViewEdit({
      viewNumber: 3,
      bytes,
      baseRevision: revision,
    });
    assert.equal(result.status, "committed");
    assert.deepEqual(storedView((await loadAuthoredGame(projectId))!.files), bytes);
    // The running engine re-parsed the loaded view in place (a baking room
    // loads it again on re-entry): loop 1 is its own copy now.
    r.tick(4);
    const live = r.ctx.engine!.getView(3)!;
    // Loop 1 shows [2, 1 / 3, ∅] mirrored; its top-left pixel is now colour 4.
    assert.deepEqual([...live.loops[1]!.cels[0]!.pixels], [4, 1, 3, 13]);
    assert.deepEqual([...live.loops[0]!.cels[0]!.pixels], [1, 2, 13, 3]);
    assert.deepEqual(
      r.posted.filter((m) => m.type === "reenter"),
      bake ? [{ type: "reenter", room: 1 }] : [],
    );
    const views = (
      (await loadAuthoredGame(projectId))!.authoringState?.["sources"] as {
        views: [number, BuildViewInput][];
      }
    ).views;
    assert.deepEqual(views, [[3, viewSpec(bytes, DEFAULT_V2_PROFILE)]]);
  }
});

test("a view edit is refused as stale or invalid before storage or the worker", async (t) => {
  const { projectId, revision, r } = await authoredRig(
    t,
    "sprite-refusals",
    false,
    1,
    spriteFiles(false),
  );
  const generation = (await loadAuthoredGame(projectId))!.generation;
  await assert.rejects(
    r.controller.commitViewEdit({
      viewNumber: 3,
      bytes: spriteView([4, 4, 4, 4]),
      baseRevision: testRevision("before"),
    }),
    (e) => e instanceof ResourceCommitError && e.code === "stale",
  );
  await assert.rejects(
    r.controller.commitViewEdit({
      viewNumber: 3,
      bytes: Uint8Array.of(0, 0, 9),
      baseRevision: revision,
    }),
    (e) => e instanceof ResourceCommitError && e.code === "invalid",
  );
  assert.equal((await loadAuthoredGame(projectId))!.generation, generation);
  assert.equal(patches(r).length, 0);
});

test("a staged candidate repaired in Sprite Studio keeps the repaired bytes and spends the offer", async (t) => {
  const { projectId, revision, r } = await authoredRig(
    t,
    "sprite-staged",
    false,
    1,
    spriteFiles(false),
  );
  const candidate = spriteView([5, 5, 13, 5]);
  const stored = (await loadAuthoredGame(projectId))!;
  await saveAuthoredGame(projectId, {
    ...stored,
    references: [
      {
        id: "ref-staged",
        kind: "character",
        target: 3,
        brief: "",
        images: [{ facing: "right", png: "AA==", mime: "image/png", width: 1, height: 1 }],
        attachedAt: { project: projectId, revision },
        staged: {
          num: 3,
          payload: bytesToBase64(candidate),
          input: viewSpec(candidate, DEFAULT_V2_PROFILE),
          loops: [],
          warnings: [],
          substitutions: [],
        },
      },
    ],
  });
  r.game().historyLifetime = await readHistoryLifetime(projectId);
  const repaired = spriteView([5, 6, 13, 5]);
  const result = await r.controller.keepStagedView("ref-staged", {
    bytes: repaired,
    baseRevision: revision,
  });
  assert.equal(result.status, "committed");
  const kept = (await loadAuthoredGame(projectId))!;
  assert.deepEqual(storedView(kept.files), repaired);
  assert.equal(kept.references?.[0]?.staged, undefined);
  const views = (kept.authoringState?.["sources"] as { views: [number, BuildViewInput][] }).views;
  assert.deepEqual(views, [[3, viewSpec(repaired, DEFAULT_V2_PROFILE)]]);
});

// ---- Room Studio: the combined picture + logic Keep ---------------------

/** PIC 1: a grey floor and a red doorway item Room Studio can move. */
const ROOM_PICTURE = [
  '# @item floor "Floor" art',
  "vis 8",
  "fill 80,80",
  "# @end",
  '# @item doorway "East doorway" art',
  "vis 4",
  "rect 120,100 135,130",
  "# @end",
  "end",
].join("\n");
/** Room 1: ego 1x1 enters at 40,140; the door box follows the doorway item to room 2. */
const ROOM_LOGIC = [
  "if (isset(f5)) {",
  "  load.pic(v0); draw.pic(v0); show.pic(); load.view(0);",
  "  animate.obj(o0); set.view(o0, 0); position(o0, 40, 140); draw(o0); accept.input();",
  "}",
  '// @rule door-east "East door" exit item=doorway',
  "if (posn(o0, 120, 125, 135, 130)) {",
  "  new.room(2);",
  "}",
  "// @end",
  "return;",
  "",
].join("\n");
const roomSession = (files: Record<string, Uint8Array>) =>
  createAgentSessionState(openContainer(new Map(Object.entries(files))), DEFAULT_V2_PROFILE);

function roomFiles(): Record<string, Uint8Array> {
  return Object.fromEntries(
    gameContainer(
      [
        "if (equaln(v0,0)) { new.room(1); } call.v(v0); return;",
        ROOM_LOGIC,
        "if (isset(f5)) { load.pic(v0); draw.pic(v0); show.pic(); } return;",
      ],
      (c) => {
        c.putResource("picture", 1, compile(ROOM_PICTURE));
        c.putResource("picture", 2, compile(BLUE));
        c.putResource(
          "view",
          0,
          buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [15] }] }] }),
        );
      },
    ).files,
  );
}

async function roomRig(t: TestContext, name: string, hooks: Parameters<typeof rig>[3] = {}) {
  const files = roomFiles();
  const projectId = testProjectId(name);
  const revision = await gameRevision(files);
  await saveAuthoredGame(projectId, {
    title: "Door room",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
    authoringState: {
      authoring: { version: 1, bindings: {}, world: { rooms: {}, facts: {}, quests: {} } },
      sources: { logics: [[1, ROOM_LOGIC]], pictures: [[1, ROOM_PICTURE]] },
    },
  });
  t.after(() => clearCachedGame(projectId));
  const booted: BootedGame = {
    installed: false,
    projectId,
    title: "Door room",
    revision,
    files,
    words: [],
    historyLifetime: await readHistoryLifetime(projectId),
  };
  return { projectId, revision, files, r: rig(t, files, booted, hooks) };
}

/** The doorway moved 20 px west, and the door rule followed it. */
function movedDoorway(files: Record<string, Uint8Array>) {
  const before = parsePictureDocument(ROOM_PICTURE).document;
  const moved = applyEdit(before, { type: "moveItem", itemId: "doorway", dx: -20, dy: 0 });
  assert.ok(!("error" in moved), "the doorway moves");
  const pictureSource = serializePictureDocument(moved.document);
  const follow = followPictureEdit(
    parseLogicDocument(ROOM_LOGIC).document,
    before,
    moved.document,
    roomSession(files),
  );
  assert.ok(follow.ok, follow.ok ? "" : follow.error);
  return { pictureSource, logic: follow };
}

const storedLogic = (files: Record<string, Uint8Array>) =>
  openContainer(new Map(Object.entries(files))).getResource("logic", 1);
const storedSources = async (projectId: ProjectId) =>
  (await loadAuthoredGame(projectId))!.authoringState as {
    authoring: { bindings: Record<string, { kind: string; num: number }> };
    sources: { logics: [number, string][]; pictures: [number, string][] };
  };

test("a combined Keep installs the picture and the logic, each acked, and the door follows the art", async (t) => {
  const { projectId, revision, files, r } = await roomRig(t, "room-combined");
  const { pictureSource, logic } = movedDoorway(files);
  assert.ok(logic.ok);
  assert.match(logic.source, /posn\(o0, 100, 125, 115, 130\)/);
  const before = r.posted.length;
  const acks: string[] = [];
  const result = await r.controller.commitRoomEdit({
    room: 1,
    picture: { pictureNumber: 1, bytes: compile(pictureSource), source: pictureSource },
    logic: { bytes: logic.bytes, source: logic.source, newBindings: {} },
    baseRevision: revision,
    reason: "Move the doorway",
  });
  assert.equal(result.status, "committed");
  assert.equal(result.projectId, projectId);
  const posted = r.posted.slice(before).filter((m) => m.type === "patch" || m.type === "reenter");
  assert.deepEqual(
    posted.map((m) =>
      m.type === "patch" ? `patch:${m.resources.map(({ kind }) => kind).join("+")}` : m.type,
    ),
    ["patch:picture+logic", "reenter"],
    "both resources install in one patch, then the room re-enters",
  );
  for (const m of r.control)
    if (m.type === "patched") acks.push(...m.resources.map(({ kind, hint }) => `${kind}:${hint}`));
  assert.deepEqual(
    acks,
    [
      `picture:${resourceCacheHint(compile(pictureSource))}`,
      `logic:${resourceCacheHint(logic.bytes)}`,
    ],
    "one ack names each resource's bytes",
  );

  // Storage holds both resources and both sources.
  const stored = (await loadAuthoredGame(projectId))!;
  assert.deepEqual(storedPicture(stored.files), compile(pictureSource));
  assert.deepEqual(storedLogic(stored.files), logic.bytes);
  const sources = await storedSources(projectId);
  assert.deepEqual(sources.sources.logics, [[1, logic.source]]);
  assert.deepEqual(sources.sources.pictures, [[1, pictureSource]]);
  assert.equal(r.game().revision, result.revision);

  // The live game runs the new door: its old box does nothing, the new one leaves.
  r.tick(4);
  const engine = r.ctx.engine!;
  assert.equal(engine.vars[0], 1);
  assert.equal(placeEgo(engine, 125, 128), "ok");
  r.tick(3);
  assert.equal(engine.vars[0], 1, "the old doorway is only floor now");
  assert.equal(placeEgo(engine, 105, 128), "ok");
  r.tick(3);
  assert.equal(engine.vars[0], 2, "walking into the moved door box changes room");
});

test("a logic-only Keep stores the bindings its rules reserved and installs one patch", async (t) => {
  const { projectId, revision, files, r } = await roomRig(t, "room-logic-only");
  const session = roomSession(files);
  const edit = applyRuleEdit(
    parseLogicDocument(ROOM_LOGIC).document,
    {
      op: "updateRule",
      id: "door-east",
      model: {
        kind: "exit",
        edge: null,
        box: { x1: 120, y1: 125, x2: 135, y2: 130 },
        destination: 2,
        requiresFlag: "door_open",
      },
    },
    session,
  );
  assert.ok(edit.ok, edit.ok ? "" : edit.error);
  assert.deepEqual(edit.newBindings, { door_open: { kind: "flag", num: 32 } });
  const before = r.posted.length;
  const result = await r.controller.commitRoomEdit({
    room: 1,
    logic: { bytes: edit.bytes, source: edit.source, newBindings: edit.newBindings },
    baseRevision: revision,
  });
  assert.equal(result.status, "committed");
  assert.deepEqual(
    r.posted
      .slice(before)
      .filter((m) => m.type === "patch" || m.type === "reenter")
      .flatMap((m) => (m.type === "patch" ? m.resources.map(({ kind }) => kind) : [m.type])),
    ["logic"],
    "only the logic installs, and a rule change needs no re-entry",
  );
  const sources = await storedSources(projectId);
  assert.deepEqual(sources.authoring.bindings["door_open"], { kind: "flag", num: 32 });
  assert.deepEqual(sources.sources.logics, [[1, edit.source]]);

  // The door is shut until f32 is set.
  r.tick(2);
  const engine = r.ctx.engine!;
  assert.equal(placeEgo(engine, 125, 128), "ok");
  r.tick(3);
  assert.equal(engine.vars[0], 1);
  engine.flags[32] = 1;
  r.tick(3);
  assert.equal(engine.vars[0], 2);
});

test("a combined Keep is refused whole when stale or invalid, before storage or the worker", async (t) => {
  const { projectId, revision, files, r } = await roomRig(t, "room-refused");
  const { pictureSource, logic } = movedDoorway(files);
  assert.ok(logic.ok);
  const generation = (await loadAuthoredGame(projectId))!.generation;
  const edit = {
    room: 1,
    picture: { pictureNumber: 1, bytes: compile(pictureSource), source: pictureSource },
    logic: { bytes: logic.bytes, source: logic.source, newBindings: {} },
    baseRevision: revision,
  };
  await assert.rejects(
    r.controller.commitRoomEdit({ ...edit, baseRevision: testRevision("before") }),
    (e) => e instanceof ResourceCommitError && e.code === "stale",
  );
  // Logic text that assembles to other bytes (the unmoved door) is not this edit.
  await assert.rejects(
    r.controller.commitRoomEdit({ ...edit, logic: { ...edit.logic, source: ROOM_LOGIC } }),
    (e) => e instanceof ResourceCommitError && e.code === "invalid" && /logic/.test(e.message),
  );
  // A reserved name that now means something else refuses too.
  const author = AgentSession.fromAuthoredData(
    { provider: "stub", model: "offline-stub", apiKey: "" },
    () => {},
    r.game().files,
    [],
  );
  author.state.authoring.bindings["door_open"] = { kind: "flag", num: 40 };
  r.controller.setSession(author);
  await assert.rejects(
    r.controller.commitRoomEdit({
      ...edit,
      logic: { ...edit.logic, newBindings: { door_open: { kind: "flag", num: 32 } } },
    }),
    (e) => e instanceof ResourceCommitError && e.code === "invalid" && /door_open/.test(e.message),
  );
  // A picture text that does not compile to its bytes refuses the logic with it.
  await assert.rejects(
    r.controller.commitRoomEdit({ ...edit, picture: { ...edit.picture, source: ROOM_PICTURE } }),
    (e) => e instanceof ResourceCommitError && e.code === "invalid",
  );
  assert.equal((await loadAuthoredGame(projectId))!.generation, generation);
  assert.equal(patches(r).length, 0);
  assert.deepEqual(storedLogic((await loadAuthoredGame(projectId))!.files), storedLogic(files));
});

/** A real autosave controller over the rig's booted game. */
function autosaves(r: Rig, onBehindStorage?: () => void) {
  return useAutosaveController({
    ...(onBehindStorage ? { onBehindStorage } : {}),
    state: { resumed: false },
    getBootedGame: () => r.game(),
    getWorker: r.link.getWorker,
    logAgent: () => {},
    isInstalledGame: () => false,
    bootGame: async () => {},
    bootAuthoredGame: async () => {},
    configForGame: (_project, config) => config,
    // No resume intent is armed in these tests; retirement is unreachable.
    retireFailedRecovery: () => {},
  });
}

/** Take a worker autosave now and hand it to `controller`, as the link does; the message it stored. */
async function autosaveNow(r: Rig, controller: ReturnType<typeof autosaves>) {
  r.link.getWorker()!.postMessage({ type: "flush", id: 99 } satisfies WorkerInbound);
  const message = r.presentation.findLast((m) => m.type === "autosave");
  assert.ok(message?.type === "autosave", "the worker took an autosave");
  controller.handleAutosave(message);
  await controller.getAutosaveWrite();
  return message;
}

/** The container resolves `pack` for anything but a logic, as a full volume would refuse it. */
function refuseLogicPacks(t: TestContext, r: Rig): void {
  const container = (r.ctx.engine as unknown as { container: { pack(arg: unknown): void } })
    .container;
  const pack = container.pack.bind(container);
  t.mock.method(container, "pack", (arg: unknown) => {
    const replacing = [arg].flat() as ({ kind?: string } | undefined)[];
    if (replacing.some((replacement) => replacement?.kind === "logic"))
      throw new Error("VOL.0 is full");
    pack(arg);
  });
}

test("a combined Keep whose logic fails to install leaves the running game on the old picture and logic", async (t) => {
  const { projectId, revision, files, r } = await roomRig(t, "room-install-fails", {
    autosaveFiles: true,
  });
  const { pictureSource, logic } = movedDoorway(files);
  assert.ok(logic.ok);
  refuseLogicPacks(t, r);
  const { commit, lastError } = useStudioCommit(r.controller.commitRoomEdit);
  const result = await commit({
    room: 1,
    picture: { pictureNumber: 1, bytes: compile(pictureSource), source: pictureSource },
    logic: { bytes: logic.bytes, source: logic.source, newBindings: {} },
    baseRevision: revision,
  });
  assert.equal(result, null);
  assert.equal(lastError.value?.code, "install");
  assert.match(lastError.value!.message, /room edit was saved.*VOL\.0 is full.*Reload/);
  t.mock.restoreAll();
  const stored = (await loadAuthoredGame(projectId))!;
  assert.deepEqual(storedPicture(stored.files), compile(pictureSource));
  assert.deepEqual(storedLogic(stored.files), logic.bytes);
  assert.equal(r.game().revision, revision, "the live side stays on the old revision");
  // Neither resource reached the running game: the picture waits with the logic.
  const live = openContainer(new Map(r.ctx.engine!.containerFiles));
  assert.deepEqual(live.getResource("picture", 1), storedPicture(files));
  assert.deepEqual(live.getResource("logic", 1), storedLogic(files));
  assert.equal(await gameRevision(Object.fromEntries(live.files)), revision);

  // The next autosave keeps the saved Keep: no half-new files reach storage.
  const generation = stored.generation;
  await autosaveNow(r, autosaves(r));
  const after = (await loadAuthoredGame(projectId))!;
  assert.equal(after.generation, generation);
  assert.deepEqual(storedPicture(after.files), compile(pictureSource));
  assert.deepEqual(storedLogic(after.files), logic.bytes);
  assert.equal(r.game().revision, revision);
});

test("after an install failure no autosave writes the running game's files, even when the install lands late", async (t) => {
  // The patch is held back past its ack timeout, then reaches the worker.
  const held: WorkerInbound[] = [];
  const {
    projectId,
    revision,
    files,
    r: late,
  } = await roomRig(t, "room-install-late", {
    drop: (msg) => msg.type === "patch" && held.push(msg) > 0,
    awaitPatched: (link) => (resources) => link(resources, 1),
    autosaveFiles: true,
  });
  const { pictureSource, logic } = movedDoorway(files);
  assert.ok(logic.ok);
  const { commit, lastError } = useStudioCommit(late.controller.commitRoomEdit);
  const result = await commit({
    room: 1,
    picture: { pictureNumber: 1, bytes: compile(pictureSource), source: pictureSource },
    logic: { bytes: logic.bytes, source: logic.source, newBindings: {} },
    baseRevision: revision,
  });
  assert.equal(result, null);
  assert.equal(lastError.value?.code, "install");
  const saved = (await loadAuthoredGame(projectId))!;
  assert.equal(held.length, 1);
  onWorkerMessage(late.ctx, held[0]!);
  await late.settle();

  const message = await autosaveNow(late, autosaves(late));
  assert.ok(message.files, "the late install rides the autosave as files");
  const after = (await loadAuthoredGame(projectId))!;
  assert.equal(after.generation, saved.generation, "storage was not written");
  assert.deepEqual(after.files, saved.files);
  assert.equal(late.game().revision, revision, "the booted revision did not move");
});

test("an autosave carrying files never writes over another tab's newer Keep, and says so once", async (t) => {
  const { projectId, files, r } = await roomRig(t, "room-autosave-behind", { autosaveFiles: true });
  // Another tab keeps an edit: storage moves past this tab's booted revision.
  const elsewhere = openContainer(new Map(Object.entries(files)));
  elsewhere.putResource("picture", 1, compile(RED));
  assert.equal(await updateAuthoredGameFiles(projectId, Object.fromEntries(elsewhere.files)), true);
  const newer = (await loadAuthoredGame(projectId))!;
  let notices = 0;
  const controller = autosaves(r, () => notices++);
  // A patch lands in this tab's worker, so its autosaves carry the container.
  for (const logic of ["return;", "assignn(v60,1); return;"]) {
    r.link.getWorker()!.postMessage({
      type: "patch",
      resources: [
        { kind: "logic", num: 3, payload: assembleLogic(logic, { dictionary: new Map() }).payload },
      ],
    } satisfies WorkerInbound);
    const message = await autosaveNow(r, controller);
    assert.ok(message.files, "the autosave carries this tab's files");
    const stored = (await loadAuthoredGame(projectId))!;
    assert.equal(stored.generation, newer.generation, "nothing was written");
    assert.deepEqual(stored.files, newer.files, "the other tab's Keep stays");
  }
  assert.equal(notices, 1, "the reload is offered once, not on every autosave");
  assert.equal(r.game().behindStorage, true);
});
