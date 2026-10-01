/**
 * Cross-editor coherence, end to end over fake ports: a stored project keeps
 * both its native files and its workspace envelope; an ordinary Room/Sprite
 * Studio Keep through the real authoring controller, worker link and Engine
 * must leave the envelope agreeing with the files it describes — the next
 * editable open re-verifies every claim, so a stale claim would refuse the
 * whole build. Each case keeps a resource, reopens through
 * openEditableProject, and proves the untouched documents are preserved
 * exactly while a small LOGIC edit still builds and keeps.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import {
  useAuthoringController,
  type PowerUpUiState,
} from "../src/authoring/useAuthoringController.ts";
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
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject, type EditableProject } from "../src/project/editableProject.ts";
import { ResourceCommitError } from "../src/project/projectTransaction.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import type { EngineState, TextHook } from "../src/engine/useEngineTypes.ts";
import type { AgiAudio } from "../src/audio/AgiAudio.ts";
import type {
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
} from "../src/worker/workerProtocol.ts";
import type { StarterKind } from "../../src/authoring/starterProject.ts";
import {
  readProjectWorkspace,
  writeProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { openContainer } from "../../src/container/container.ts";
import { buildView, type BuildViewInput } from "../../src/view/view.ts";
import { viewSpec } from "../../src/view/celEdit.ts";
import { openSprite } from "../../src/view/spriteDocument.ts";
import { applySpriteEdit } from "../../src/studio/sprite/spriteOperations.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";

installIndexedDbFixture();

// Library metadata and the last-game pointer live in localStorage; each test
// file runs in its own process, so one store serves the whole file.
const localValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => void localValues.set(key, value),
    removeItem: (key: string) => localValues.delete(key),
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
  posted: WorkerInbound[];
  control: WorkerControl[];
  game(): BootedGame;
  tick(n?: number): void;
  settle(): Promise<void>;
}

/**
 * Boot `files` in a real worker dispatch behind a fake Worker: host → worker
 * posts dispatch synchronously, worker → host control replies arrive on a
 * later microtask, as they would across the thread boundary.
 */
function rig(
  t: TestContext,
  files: Record<string, Uint8Array>,
  words: [string, number][],
  booted: BootedGame,
): Rig {
  const posted: WorkerInbound[] = [];
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  let now = 0;
  const worker = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: WorkerInbound) {
      posted.push(msg);
      onWorkerMessage(ctx, msg);
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
  worker.postMessage({ type: "boot", files, words });
  ctx.fns.stopTimers();
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  tick(6);

  const owners = new Set<string>();
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
    onRemixCreated: () => {},
  });
  t.after(() => ctx.fns.stopTimers());
  return {
    ctx,
    controller,
    link,
    posted,
    control,
    game: () => game,
    tick,
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

/** Prepare, save and boot a local project — the body carries a real workspace. */
async function projectRig(t: TestContext, name: string, kind: StarterKind = "boilerplate") {
  const prepared = prepareLocalProject({ title: name, kind });
  await prepared.save();
  const stored = (await loadAuthoredGame(prepared.projectId))!;
  const revision = await gameRevision(stored.files);
  const booted: BootedGame = {
    installed: false,
    projectId: prepared.projectId,
    title: stored.title,
    revision,
    files: stored.files,
    words: stored.words,
    historyLifetime: await readHistoryLifetime(prepared.projectId),
  };
  const r = rig(t, stored.files, stored.words, booted);
  return { projectId: prepared.projectId, revision, files: stored.files, r };
}

const compile = (source: string) =>
  compilePictureSource(source, { profile: DEFAULT_V2_PROFILE }).bytes;
const storedResource = (files: Record<string, Uint8Array>, kind: "picture" | "view", num: number) =>
  openContainer(new Map(Object.entries(files))).getResource(kind, num);

/** A deliberately formatted LOGIC with a comment: must survive unrelated Keeps exactly. */
const COMMENTED_LOGIC = [
  "// Room 1 — formatted and commented on purpose.",
  '#message 1 "Your game starts here."',
  "if (isset(f5)) {",
  "    assignn(v50, first_pic);   // the first picture",
  "    load.pic(v50);",
  "    draw.pic(v50);",
  "    show.pic();",
  "    accept.input();",
  "    print(m1);",
  "}",
  "return;",
  "",
].join("\n");
const SECOND_LOGIC = "// A later note\nreturn;\n";

function keepLogic(ws: EditableProject, key: string, source: string) {
  const snapshot = ws.draft.capture();
  ws.draft.edit(key, source, snapshot.version(key));
  return ws.keepCandidate(ws.buildSelected([key]));
}

const PIC_EDIT = ['# @item sky "Sky" art', "vis 4", "fill 80,80", "# @end", "end"].join("\n");
/** The same bytes as PIC_EDIT under different annotations: a source-only edit. */
const PIC_EDIT_RENAMED = [
  '# @item sky "Evening sky" art',
  "vis 4",
  "fill 80,80",
  "# @end",
  "end",
].join("\n");
assert.deepEqual(compile(PIC_EDIT), compile(PIC_EDIT_RENAMED));

test("a picture Keep updates its own workspace claim, preserves the rest and lets Logic build", async (t) => {
  const { projectId, revision, r } = await projectRig(t, "ws-picture-keep");

  // First the reverse order: a Logic Studio Keep wins before the resource Keep.
  const editable = await openEditableProject(projectId);
  assert.equal(editable.inspection.requiresSourceReview, false);
  await keepLogic(editable, "logic:1", COMMENTED_LOGIC);
  const before = await loadAuthoredGame(projectId);
  assert.equal(readProjectWorkspace(before!.workspace)["logic:1"], COMMENTED_LOGIC);

  // Room Studio keeps a byte-changing picture over the running game.
  const kept = await r.controller.commitPictureEdit({
    pictureNumber: 1,
    bytes: compile(PIC_EDIT),
    source: PIC_EDIT,
    baseRevision: revision,
  });
  assert.equal(kept.status, "committed");

  const stored = (await loadAuthoredGame(projectId))!;
  assert.deepEqual(storedResource(stored.files, "picture", 1), compile(PIC_EDIT));
  const documents = readProjectWorkspace(stored.workspace);
  assert.equal(documents["picture:1"], PIC_EDIT, "the kept picture's claim is the new source");
  assert.equal(documents["logic:1"], COMMENTED_LOGIC, "the unrelated LOGIC text is preserved");
  assert.equal(
    documents["bindings"],
    readProjectWorkspace(before!.workspace)["bindings"],
    "the bindings document keeps its exact text",
  );

  // The editable open re-verifies: no refused claims, so builds are allowed.
  const reopened = await openEditableProject(projectId);
  assert.equal(reopened.inspection.requiresSourceReview, false);
  assert.equal(reopened.inspection.documents["picture:1"], PIC_EDIT);
  assert.equal(reopened.draft.capture().read("logic:1")!.content, COMMENTED_LOGIC);
  const follow = await keepLogic(reopened, "logic:1", SECOND_LOGIC);
  assert.equal(follow.kind, "savedOnly");
  const reopened2 = await openEditableProject(projectId);
  assert.equal(reopened2.draft.capture().read("logic:1")!.content, SECOND_LOGIC);
});

test("a source-only picture Keep projects the new text without inventing a native edit", async (t) => {
  const { projectId, revision, r } = await projectRig(t, "ws-picture-source-only");

  const bytes = await r.controller.commitPictureEdit({
    pictureNumber: 1,
    bytes: compile(PIC_EDIT),
    source: PIC_EDIT,
    baseRevision: revision,
  });
  assert.equal(bytes.status, "committed");

  const patches = () => r.posted.filter((m) => m.type === "patch").length;
  const rename = await r.controller.commitPictureEdit({
    pictureNumber: 1,
    bytes: compile(PIC_EDIT_RENAMED),
    source: PIC_EDIT_RENAMED,
    baseRevision: bytes.revision,
  });
  assert.equal(rename.status, "committed");
  assert.equal(patches(), 1, "the rename posted no second patch");
  const stored = (await loadAuthoredGame(projectId))!;
  assert.deepEqual(storedResource(stored.files, "picture", 1), compile(PIC_EDIT));
  assert.equal(
    readProjectWorkspace(stored.workspace)["picture:1"],
    PIC_EDIT_RENAMED,
    "the claim text followed the source-only Keep",
  );

  const reopened = await openEditableProject(projectId);
  assert.equal(reopened.inspection.requiresSourceReview, false);
  const follow = await keepLogic(reopened, "logic:1", SECOND_LOGIC);
  assert.equal(follow.kind, "savedOnly");
});

test("a view Keep updates its own workspace claim, preserves metadata and lets Logic build", async (t) => {
  const { projectId, revision, files, r } = await projectRig(t, "ws-view-keep", "starter");

  // Owner metadata a Sprite Keep must carry through untouched.
  const seeded = (await loadAuthoredGame(projectId))!;
  seeded.workspace = writeProjectWorkspace({
    ...readProjectWorkspace(seeded.workspace),
    tests: '[{"name":"smoke"}]',
    references: '[{"kind":"note"}]',
  });
  assert.equal(await saveAuthoredGame(projectId, seeded), true);

  const original = storedResource(files, "view", 0)!;
  const after = applySpriteEdit(openSprite(original, DEFAULT_V2_PROFILE), {
    type: "setPixels",
    loop: 0,
    cel: 0,
    changes: [{ x: 0, y: 0, color: 4 }],
  });
  assert.ok("document" in after);
  const kept = await r.controller.commitViewEdit({
    viewNumber: 0,
    bytes: after.document.payload,
    baseRevision: revision,
  });
  assert.equal(kept.status, "committed");

  const stored = (await loadAuthoredGame(projectId))!;
  assert.deepEqual(storedResource(stored.files, "view", 0), after.document.payload);
  const documents = readProjectWorkspace(stored.workspace);
  const claim = documents["view:0"];
  if (typeof claim === "string") {
    // A verified spec claim: it rebuilds exactly the kept bytes.
    assert.deepEqual(
      buildView(JSON.parse(claim) as BuildViewInput, DEFAULT_V2_PROFILE),
      after.document.payload,
    );
  } else {
    assert.deepEqual(claim, after.document.payload);
  }
  assert.equal(documents["tests"], '[{"name":"smoke"}]', "unrelated metadata is preserved");
  assert.equal(documents["references"], '[{"kind":"note"}]');
  assert.equal(documents["logic:1"], readProjectWorkspace(seeded.workspace)["logic:1"]);

  const reopened = await openEditableProject(projectId);
  assert.equal(reopened.inspection.requiresSourceReview, false);
  const spec = viewSpec(after.document.payload, DEFAULT_V2_PROFILE);
  const views = (stored.authoringState!["sources"] as { views: [number, unknown][] }).views;
  assert.deepEqual(views.find(([num]) => num === 0)![1], spec);
  const follow = await keepLogic(reopened, "logic:1", SECOND_LOGIC);
  assert.equal(follow.kind, "savedOnly");
});

test("a stale generation or a recreated lifetime still refuses and loses nothing", async (t) => {
  const { projectId, revision, files, r } = await projectRig(t, "ws-stale-keeps");

  // Another writer moves storage past the running game (a new picture 2).
  const elsewhere = openContainer(new Map(Object.entries(files)));
  elsewhere.putResource("picture", 2, compile(PIC_EDIT));
  assert.equal(await updateAuthoredGameFiles(projectId, Object.fromEntries(elsewhere.files)), true);
  const moved = (await loadAuthoredGame(projectId))!;
  await assert.rejects(
    r.controller.commitPictureEdit({
      pictureNumber: 1,
      bytes: compile(PIC_EDIT),
      source: PIC_EDIT,
      baseRevision: revision,
    }),
    (e) => e instanceof ResourceCommitError && e.code === "stale",
  );
  const after = (await loadAuthoredGame(projectId))!;
  assert.equal(after.generation, moved.generation, "the refused Keep wrote nothing");
  assert.deepEqual(after.workspace, moved.workspace, "the moved project's envelope stands");

  // A removed-and-recreated project is another lifetime; the Keep refuses too.
  await clearCachedGame(projectId);
  assert.equal(await saveAuthoredGame(projectId, moved), true);
  await assert.rejects(
    r.controller.commitPictureEdit({
      pictureNumber: 1,
      bytes: compile(PIC_EDIT),
      source: PIC_EDIT,
      baseRevision: revision,
    }),
    (e) => e instanceof ResourceCommitError && e.code === "stale",
  );
  const recreated = (await loadAuthoredGame(projectId))!;
  assert.deepEqual(recreated.files, moved.files, "the recreated record lost nothing");
  assert.deepEqual(recreated.workspace, moved.workspace);
});
