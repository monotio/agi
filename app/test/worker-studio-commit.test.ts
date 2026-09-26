/**
 * Room Studio's Keep, end to end over fake ports: the real authoring
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
import { gameContainer } from "./worker-ctx.ts";
import { AgentSession } from "../src/agent/agentSession.ts";
import { useAuthoringController, type PowerUpUiState } from "../src/useAuthoringController.ts";
import { ResourceCommitError } from "../src/resourceCommit.ts";
import { useWorkerLink } from "../src/useWorkerLink.ts";
import { createWorkerContext, type WorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { replayHistorySegment } from "../src/worker/replay.ts";
import { gameRevision } from "../src/gameMetadata.ts";
import {
  clearCachedGame,
  loadAuthoredGame,
  readHistoryLifetime,
  saveAuthoredGame,
  updateAuthoredGameFiles,
} from "../src/gameStorage.ts";
import type { BootedGame, ProjectId, ResourceRevision } from "../src/gameTypes.ts";
import type { EngineState, TextHook } from "../src/useEngineTypes.ts";
import type { AgiAudio } from "../src/audio/AgiAudio.ts";
import type {
  WorkerControl,
  WorkerInbound,
  WorkerOutbound,
  WorkerPresentation,
} from "../src/workerProtocol.ts";
import { studioCommitFailure, useStudioCommit } from "../src/studio/useStudioCommit.ts";
import { useStudioKeep } from "../src/studio/useStudioKeep.ts";
import type { StudioDraft } from "../src/studio/useStudioDraft.ts";
import type { AwaitPatchedFn } from "../src/workerQueries.ts";
import { resourceCacheHint } from "../../src/agent/authoringState.ts";
import { authoredPictureSource } from "../../src/agent/tools.ts";
import { historySyncDigest, type HistorySegment } from "../../src/agent/history.ts";
import { openContainer } from "../../src/container/container.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";

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
    ejectGame() {},
  });
  link.wireWorker(worker as unknown as Worker);
  worker.postMessage({ type: "boot", files, words: [] });
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
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
    picturePixel() {
      const frame = presentation.findLast((m) => m.type === "frame");
      assert.ok(frame?.type === "frame" && frame.picVisual, "a frame carries the picture plane");
      return frame.picVisual![PROBE.y * 160 + PROBE.x]!;
    },
  };
}

/** Store an authored project and boot it; `library` makes it a catalog entry. */
async function authoredRig(t: TestContext, name: string, catalog = false, drawn = 1) {
  const projectId = testProjectId(name);
  const files = gameFiles(drawn);
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
  const acked = r.link.awaitPatched("picture", 1, resourceCacheHint(bytes), 500);
  r.link.getWorker()!.postMessage({
    type: "patch",
    kind: "picture",
    num: 1,
    payload: bytes,
  } satisfies WorkerInbound);
  assert.deepEqual(await acked, {
    kind: "picture",
    num: 1,
    patchGen: before + 1,
    hint: resourceCacheHint(bytes),
  });
  // An ack naming other bytes never confirms a waiter's install.
  const wrong = r.link.awaitPatched("picture", 1, resourceCacheHint(compile(BLUE)), 500);
  r.link.getWorker()!.postMessage({
    type: "patch",
    kind: "picture",
    num: 1,
    payload: compile(RED),
  } satisfies WorkerInbound);
  await assert.rejects(wrong, /different picture 1 bytes/);
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
    patches(r).map((m) => m.kind),
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
    let r: Rig;
    let revision: ResourceRevision;
    if (origin === "catalog") {
      ({ projectId, revision, r } = await authoredRig(t, "studio-catalog", true));
    } else {
      const files = gameFiles();
      revision = await gameRevision(files);
      r = rig(t, files, {
        installed: true,
        hash: "studio-installed",
        alias: "studio",
        title: "Studio edition",
        revision,
        files,
        words: [],
      });
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

    const fork = (await loadAuthoredGame(remix))!;
    assert.equal(fork.library?.source, "remix");
    assert.equal(fork.library?.revision, result.revision);
    assert.deepEqual(fork.library?.parent?.revision, revision);
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
  t.mock.method(r.ctx.engine!, "patchResource", () => {
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
  return useStudioKeep({ draft, pictureNumber: () => 1, keep: r.controller.commitPictureEdit });
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
      awaitPatched: (link) => (kind, num, hint, timeoutMs) => {
        timeouts.push(timeoutMs);
        return link(kind, num, hint, 1);
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
