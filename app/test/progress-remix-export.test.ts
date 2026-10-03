/**
 * The B4 progress-binding fragments: installed editions' conversation
 * records addressed by the physical `installed:` locator, remix ancestry
 * naming the original instance's logical identity, a remix owner bound to
 * its real saved body+epoch before it is installed, superseded-boot
 * refusal, and the export's typed `progressTarget` beside the released
 * `{ data, progressKey }` shape.
 *
 * Real IndexedDB fixture, real saved-body APIs, fake worker and link seams
 * only — the same pattern worker-studio-commit.test.ts drives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import { useGameLifecycle, type GameLifecycleOptions } from "../src/engine/useGameLifecycle.ts";
import type { ResumeBootCarrier } from "../src/saves/useAutosaveController.ts";
import {
  useAuthoringController,
  type PowerUpUiState,
} from "../src/authoring/useAuthoringController.ts";
import { AgentSession } from "../src/agent/agentSession.ts";
import * as authoringStack from "../src/agent/authoringStack.ts";
import { bindProgressTarget } from "../src/project/progressBinding.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import {
  installedProgressLocator,
  parseProgressLocator,
  type ProgressTarget,
} from "../src/project/progressTarget.ts";
import {
  clearCachedGame,
  loadAuthoredGame,
  loadGameConversation,
  readHistoryLifetime,
  saveAuthoredGame,
  saveGameConversation,
  type CachedGameData,
} from "../src/project/gameStorage.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import type { AwaitPatchedFn } from "../src/engine/workerQueries.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";

const records = installIndexedDbFixture();

// Progress/autosave records live in localStorage; this file is one process.
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
/** Two installations' shared vocabulary spelling, as released storage knew it. */
const SHARED_HASH = "sharedhash-sharedhash";

// Room Studio's red picture and its same-bytes rename (the source-only edit).
const BLUE = ["vis 1", "fill 80,80", "end"].join("\n");
const NAMED_BLUE = ['# @item sky "Sky" art', "vis 1", "fill 80,80", "# @end", "end"].join("\n");
const RED = ["vis 4", "fill 80,80", "end"].join("\n");
const compile = (source: string) =>
  compilePictureSource(source, { profile: DEFAULT_V2_PROFILE }).bytes;

/** The worker's install ack, answered at once for the bytes sent. */
const ackPatch: AwaitPatchedFn = async (resources) => ({ resources, patchGen: 1 });

function powerUpUi(): PowerUpUiState {
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

/** A minimal real container a session and a commit can open. */
function testFiles(picture?: Uint8Array): Record<string, Uint8Array> {
  const c = createContainer();
  c.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  c.putResource("logic", 1, assembleLogic("return;", { dictionary: new Map() }).payload);
  if (picture) c.putResource("picture", 1, picture);
  return { ...Object.fromEntries(c.files), "WORDS.TOK": buildWordsTok([]) };
}

/** A booted installed edition with its physical target bound, the way B1's boot binds it. */
async function installedGame(
  folder: string,
  files: Record<string, Uint8Array>,
  hash = SHARED_HASH,
): Promise<BootedGame> {
  const game: BootedGame = {
    installed: true,
    folder,
    hash,
    alias: "shared-edition",
    title: folder,
    revision: await gameRevision(files),
    files,
    words: [],
  };
  assert.ok(bindProgressTarget(game), "the installed boot binds");
  return game;
}

interface ControllerRig {
  controller: ReturnType<typeof useAuthoringController>;
  current(): BootedGame | null;
  installed: (BootedGame | null)[];
  remixes: string[];
  clearedAutosaves: string[];
}

/** An authoring controller over the real storage stack with the boot slot wired by hand. */
function controllerRig(
  game: BootedGame,
  hooks: { getBootedGame?: () => BootedGame | null } = {},
): ControllerRig {
  let current: BootedGame | null = game;
  const installed: (BootedGame | null)[] = [];
  const remixes: string[] = [];
  const clearedAutosaves: string[] = [];
  const worker = { postMessage() {} } as unknown as Worker;
  const controller = useAuthoringController({
    state: {
      phase: "running",
      powerUp: powerUpUi(),
      agentTask: null,
      agentLog: [],
      profile: "2.936",
      worldTick: 0,
      planDurableRev: "",
    },
    getWorker: () => worker,
    query: async <T>(type: string): Promise<T> => {
      if (type === "exportFiles") return current!.files as T;
      if (type === "state") return { room: 1, profile: "2.936" } as T;
      return null as T;
    },
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: hooks.getBootedGame ?? (() => current),
    setBootedGame: (next) => {
      installed.push(next);
      current = next;
    },
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: (key: string) => clearedAutosaves.push(key),
    awaitPatched: ackPatch,
    onRemixCreated: (id) => void remixes.push(id),
    loadAuthoring: async () => authoringStack,
  });
  return { controller, current: () => current, installed, remixes, clearedAutosaves };
}

/** Files one resource revision ahead of `files` — what a completed remix writes. */
function remixedFiles(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const c = openContainer(new Map(Object.entries(files)));
  c.putResource("logic", 7, assembleLogic("return;", { dictionary: new Map() }).payload);
  return Object.fromEntries(c.files);
}

test("a Unicode-folder installation's remix names the minted parent and binds the saved body's epoch", async (t) => {
  const files = testFiles();
  const source = await installedGame("quest ünï dûx", files);
  const target = source.progressTarget!;
  assert.equal(target.locator, installedProgressLocator("quest ünï dûx", source.revision));
  assert.ok(target.identity.project.startsWith("installed-"), "the folder mints a logical id");
  const rig = controllerRig(source);
  const author = AgentSession.fromAuthoredData(STUB, () => {}, files, []);
  rig.controller.setSession(author);

  const next = remixedFiles(files);
  const committedRevision = await gameRevision(next);
  await rig.controller.persistRemix(source, author, next);

  // The remix runs on as the bound owner of its own durable body.
  const owner = rig.current()!;
  assert.equal(owner.installed, false);
  const remixId = owner.projectId!;
  t.after(() => clearCachedGame(remixId));
  assert.deepEqual(rig.remixes, [remixId]);
  const epoch = await readHistoryLifetime(remixId);
  assert.ok(epoch, "the durable write minted a real lifetime");
  assert.equal(owner.progressTarget?.locator, `project:${remixId}:${epoch}`);
  assert.equal(owner.progressTarget?.identity.project, remixId);
  assert.equal(
    owner.progressTarget?.identity.revision,
    committedRevision,
    "the committed revision participates in the bound identity",
  );

  // The fork's record is readable and names the installation's minted
  // logical identity — never its folder text, shared hash or locator.
  const fork = (await loadAuthoredGame(remixId))!;
  assert.equal(fork.library?.source, "remix");
  assert.deepEqual(fork.library?.parent, {
    project: target.identity.project,
    revision: target.identity.revision,
  });
});

test("a remix of an installed edition keeps the original's physical checkpoint untouched", async (t) => {
  const files = testFiles();
  const source = await installedGame("ember-tale", files);
  const target = source.progressTarget!;
  // The checkpoint the instance owns under its locator, and the released
  // hash spelling a pre-binding build could have written under.
  localValues.set(`monotio_agi.autosave.${target.locator}`, "locator-checkpoint");
  localValues.set(`monotio_agi.autosave.${SHARED_HASH}`, "legacy-checkpoint");
  const rig = controllerRig(source);
  const author = AgentSession.fromAuthoredData(STUB, () => {}, files, []);
  rig.controller.setSession(author);

  const next = remixedFiles(files);
  await rig.controller.persistRemix(source, author, next);
  const remixId = rig.current()!.projectId!;
  t.after(() => clearCachedGame(remixId));

  // Forking never clears or rewrites the original's progress records; the
  // remix writes under its own `project:` address from here on.
  assert.equal(localValues.get(`monotio_agi.autosave.${target.locator}`), "locator-checkpoint");
  assert.equal(localValues.get(`monotio_agi.autosave.${SHARED_HASH}`), "legacy-checkpoint");
  assert.deepEqual(rig.clearedAutosaves, []);
});

test("installed editions sharing a vocabulary hash read and write conversations under their own locators", async () => {
  const files = testFiles();
  const gameA = await installedGame("Ember ünï Tale", files);
  const gameB = await installedGame("ember-tale", files);
  const locatorA = gameA.progressTarget!.locator;
  const locatorB = gameB.progressTarget!.locator;
  assert.notEqual(locatorA, locatorB, "same hash, different folders: different physical addresses");

  // A's own record and a released-spelling decoy under the shared hash.
  await saveGameConversation(locatorA, {
    provider: "stub",
    model: "earlier-model",
    transcript: [{ turn: "alpha-talk" }],
    authoringState: { chat: [{ role: "user", text: "alpha chat" }] },
  });
  await saveGameConversation(SHARED_HASH, {
    provider: "stub",
    model: "earlier-model",
    transcript: [{ turn: "hash-decoy" }],
    authoringState: { chat: [{ role: "user", text: "decoy chat" }] },
  });

  // A's session continues A's record — never the decoy the shared hash holds.
  const rigA = controllerRig(gameA);
  const sessionA = await rigA.controller.createGameSession(gameA, STUB);
  assert.equal(
    JSON.stringify(sessionA.getTranscript()).includes("alpha-talk"),
    true,
    "the locator's conversation continues",
  );
  assert.equal(JSON.stringify(sessionA.getTranscript()).includes("hash-decoy"), false);
  assert.deepEqual(sessionA.getMessages(), [{ role: "user", text: "alpha chat" }]);

  // B's session starts clean: neither the decoy nor A's record leaks across.
  const rigB = controllerRig(gameB);
  const sessionB = await rigB.controller.createGameSession(gameB, STUB);
  assert.equal(sessionB.getTranscript().length, 0);
  assert.deepEqual(sessionB.getMessages(), []);

  // B's settings write lands under B's locator alone.
  rigB.controller.setSession(sessionB);
  await rigB.controller.updateAiConfig({ ...STUB, model: "another-model" });
  const written = records.get(`conversation/${locatorB}`) as
    { format?: string; version?: number; model?: string } | undefined;
  assert.equal(written?.format, "monotio.agi.conversation");
  assert.equal(written?.version, 1, "the released conversation record layout is unchanged");
  assert.equal(written?.model, "another-model");
  assert.equal(records.has(`conversation/${SHARED_HASH}`), true, "the decoy was only ever seeded");
  assert.deepEqual(await loadGameConversation(SHARED_HASH), {
    provider: "stub",
    model: "earlier-model",
    transcript: [{ turn: "hash-decoy" }],
    authoringState: { chat: [{ role: "user", text: "decoy chat" }] },
  });
});

test("a native Keep on an installed edition reads and writes under the locator, and forks to a bound owner", async (t) => {
  const files = testFiles(compile(BLUE));
  const gameA = await installedGame("Ember ünï Tale", files);
  const locatorA = gameA.progressTarget!.locator;
  const baseRevision = gameA.revision;
  await saveGameConversation(locatorA, {
    provider: "stub",
    model: "earlier-model",
    transcript: [{ turn: "alpha-talk" }],
    authoringState: {},
  });
  await saveGameConversation(SHARED_HASH, {
    provider: "stub",
    model: "earlier-model",
    transcript: [{ turn: "hash-decoy" }],
    authoringState: {},
  });

  const rig = controllerRig(gameA);
  // Byte-changing Keep: the fork carries the locator's discussion, not the
  // shared-hash decoy's, and the adopted owner binds the saved body's epoch.
  const kept = await rig.controller.commitPictureEdit({
    pictureNumber: 1,
    bytes: compile(RED),
    source: RED,
    baseRevision,
  });
  assert.equal(kept.status, "committed");
  const remixId = kept.projectId!;
  t.after(() => clearCachedGame(remixId));
  const fork = (await loadAuthoredGame(remixId))!;
  assert.deepEqual(fork.transcript, [{ turn: "alpha-talk" }]);
  assert.deepEqual(fork.library?.parent, {
    project: gameA.progressTarget!.identity.project,
    revision: baseRevision,
  });
  const owner = rig.current()!;
  const epoch = await readHistoryLifetime(remixId);
  assert.equal(owner.progressTarget?.locator, `project:${remixId}:${epoch}`);
  assert.equal(owner.progressTarget?.identity.revision, kept.revision);
  assert.deepEqual(rig.clearedAutosaves, []);

  // Source-only Keep on another installation: the record under its locator
  // takes the new authoring content; the shared-hash record is untouched.
  const gameB = await installedGame("ember-tale", files);
  const locatorB = gameB.progressTarget!.locator;
  const rigB = controllerRig(gameB);
  const renamed = await rigB.controller.commitPictureEdit({
    pictureNumber: 1,
    bytes: compile(NAMED_BLUE),
    source: NAMED_BLUE,
    baseRevision,
  });
  assert.equal(renamed.status, "committed");
  assert.equal(renamed.projectId, null, "a source-only edit on an edition forks nothing");
  const record = (await loadGameConversation(locatorB))!;
  assert.deepEqual(
    (record.authoringState["sources"] as { pictures: [number, string][] }).pictures,
    [[1, NAMED_BLUE]],
    "the new source landed under the physical locator",
  );
  assert.deepEqual(
    (await loadGameConversation(SHARED_HASH))?.transcript,
    [{ turn: "hash-decoy" }],
    "the released spelling's record is untouched",
  );
});

test("a Keep on an installation with no physical binding refuses rather than fall back", async () => {
  const files = testFiles(compile(BLUE));
  const unbound: BootedGame = {
    installed: true,
    folder: "unbound-folder",
    hash: "unbound-hash",
    alias: "unbound-edition",
    title: "Unbound",
    revision: await gameRevision(files),
    files,
    words: [],
    // No progressTarget: the boot never bound this instance.
  };
  const rig = controllerRig(unbound);
  await assert.rejects(
    rig.controller.commitPictureEdit({
      pictureNumber: 1,
      bytes: compile(RED),
      source: RED,
      baseRevision: unbound.revision,
    }),
    /binding/i,
  );
  for (const spelling of ["unbound-folder", "unbound-hash", "unbound-edition", "installed"])
    assert.equal(records.has(`conversation/${spelling}`), false, `no ${spelling} write`);
});

test("a remix saved after a newer boot took the slot installs no owner", async () => {
  const files = testFiles();
  const source = await installedGame("ember-tale", files);
  const replacement: BootedGame = {
    installed: false,
    projectId: testProjectId("superseding-boot"),
    title: "Replacement",
    revision: await gameRevision(files),
    files,
    words: [],
  };
  // The first read admits the save; every later read sees the new owner.
  let reads = 0;
  const rig = controllerRig(source, {
    getBootedGame: () => (reads++ === 0 ? source : replacement),
  });
  const author = AgentSession.fromAuthoredData(STUB, () => {}, files, []);
  rig.controller.setSession(author);
  await assert.rejects(
    rig.controller.persistRemix(source, author, remixedFiles(files)),
    /game changed/i,
  );
  assert.deepEqual(rig.installed, [], "the retired save never installed an owner");
  assert.deepEqual(rig.remixes, []);
});

/** A lifecycle over the running game; the link answers its one export query. */
function exportLifecycle(game: BootedGame) {
  const lifecycle = useGameLifecycle({
    state: { phase: "running", powerUp: { busy: false } },
    authoring: {
      getSession: () => null,
      assembleExportData: (
        data: CachedGameData,
        g: BootedGame,
        _session: null,
        out: Record<string, Uint8Array>,
      ) => ({ ...data, files: out, words: g.words }),
    },
    link: { query: async () => game.files },
    logAgent: () => {},
  } as unknown as GameLifecycleOptions);
  lifecycle.setBootedGame(game);
  return lifecycle;
}

test("a live export names the installation's logical id and returns its physical binding", async () => {
  const files = testFiles();
  const game = await installedGame("quest ünï dûx", files);
  const target = game.progressTarget!;
  const exported = await exportLifecycle(game).exportCurrentGame();
  assert.equal(exported.progressKey, target.locator, "progressKey is the bound locator");
  assert.equal(exported.progressTarget?.locator, exported.progressKey, "locator equality");
  assert.equal(exported.data.projectId, target.identity.project);
  assert.ok(String(exported.data.projectId).startsWith("installed-"), "a valid logical id");
  assert.equal(parseProgressLocator(exported.data.projectId), null, "never a colon locator");
  assert.notEqual(exported.data.projectId, SHARED_HASH);
});

test("a saved project's export returns its body-epoch binding; a removed body exports without one", async (t) => {
  const files = testFiles();
  const projectId = testProjectId("export-saved");
  await saveAuthoredGame(projectId, {
    title: "Saved game",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  t.after(() => clearCachedGame(projectId));
  const epoch = (await readHistoryLifetime(projectId))!;
  const game: BootedGame = {
    installed: false,
    projectId,
    title: "Saved game",
    revision: await gameRevision(files),
    files,
    words: [],
    historyLifetime: epoch,
  };
  bindProgressTarget(game);
  const exported = await exportLifecycle(game).exportCurrentGame();
  assert.equal(exported.progressKey, `project:${projectId}:${epoch}`);
  assert.equal(exported.progressTarget?.locator, exported.progressKey);
  assert.equal(exported.data.projectId, projectId);

  // The body deleted in another tab: the in-memory game still downloads,
  // but no physical binding grants progress writes or adoption.
  const removed: BootedGame = {
    installed: false,
    projectId,
    title: "Saved game",
    revision: await gameRevision(files),
    files,
    words: [],
    historyLifetime: null,
    removed: true,
    authoredGame: {
      projectId,
      title: "Saved game",
      authoredAt: "",
      files,
      words: [],
    },
  };
  bindProgressTarget(removed);
  assert.equal(removed.progressTarget, undefined, "a deleted lifetime binds nothing");
  const abandoned = await exportLifecycle(removed).exportCurrentGame();
  assert.equal(abandoned.progressTarget, undefined);
  assert.equal(abandoned.progressKey, projectId, "the historical spelling, not a bound locator");
  assert.equal(abandoned.data.projectId, projectId);
});

test("an export racing an in-place Keep refuses rather than pair new files with a stale binding", async (t) => {
  const files = testFiles(compile(BLUE));
  const projectId = testProjectId("export-keep-race");
  assert.equal(
    await saveAuthoredGame(projectId, {
      title: "Kept",
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    }),
    true,
  );
  t.after(() => clearCachedGame(projectId));
  const game: BootedGame = {
    installed: false,
    projectId,
    title: "Kept",
    revision: await gameRevision(files),
    files,
    words: [],
    historyLifetime: await readHistoryLifetime(projectId),
  };
  assert.ok(bindProgressTarget(game));
  const captured = game.progressTarget!;
  const rig = controllerRig(game);
  // The export's worker query is the controlled await: it resolves only
  // after the real in-place Keep below has rebound the same owner.
  let release!: () => void;
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lifecycle = useGameLifecycle({
    state: { phase: "running", powerUp: { busy: false } },
    authoring: rig.controller,
    link: {
      query: async () => {
        reached();
        await hold;
        return rig.current()!.files;
      },
    },
    logAgent: () => {},
  } as unknown as GameLifecycleOptions);
  lifecycle.setBootedGame(game);
  const exporting = lifecycle.exportCurrentGame();
  await waiting;

  // A real native Keep on the same saved owner: the same BootedGame object
  // and the same body-epoch locator, under a new bound revision.
  const committed = await rig.controller.commitPictureEdit({
    pictureNumber: 1,
    bytes: compile(RED),
    source: RED,
    baseRevision: game.revision,
  });
  assert.equal(committed.status, "committed");
  assert.equal(rig.current(), game, "the Keep updates the same saved owner object");
  assert.equal(game.progressTarget!.locator, captured.locator, "the body epoch keeps its locator");
  assert.notEqual(game.progressTarget!.identity.revision, captured.identity.revision);
  release();

  // Pairing the committed bytes with the captured stale binding is refused.
  await assert.rejects(exporting, /changed during export/i);

  // A settled export still works and returns the rebound identity, coherent
  // with the bytes it carries.
  const exported = await exportLifecycle(game).exportCurrentGame();
  assert.equal(exported.progressTarget, game.progressTarget);
  assert.equal(exported.progressKey, game.progressTarget!.locator);
  assert.equal(
    exported.progressTarget!.identity.revision,
    await gameRevision(exported.data.files),
    "the returned binding identifies the exported resources",
  );
});

/** The quit path: the ended note keeps the game's identity, nothing else saves. */
function quitHarness() {
  const calls: string[] = [];
  const state = {
    leaving: false,
    phase: "running",
    gameEnded: null as {
      projectId: string;
      title: string;
      progressTarget?: ProgressTarget;
    } | null,
    powerUp: { busy: false },
    walkthrough: { active: false, status: "stopped" },
  };
  const noop = () => {};
  const lifecycle = useGameLifecycle({
    state,
    audio: { stop: noop, setPaused: noop },
    hook: {},
    logAgent: noop,
    authoring: { getSession: () => null, isRemixNeedsSave: () => false, resetSession: noop },
    autosave: {
      // The quit path invalidates any armed resume before it departs; no
      // intent exists here, so an ordinary departure proceeds and a foreign
      // carrier would refuse.
      beginResumeBoot: (carrier?: ResumeBootCarrier) => carrier === undefined,
      flushAutosaveDetailed: async () => ({ status: "saved" }),
      clearAutosave: noop,
      reset: noop,
      resetScreen: noop,
    },
    link: {
      query: async (kind: string) => {
        calls.push(kind);
        return true;
      },
      terminateWorker: () => calls.push("terminate"),
      drainPendingQueries: noop,
      clearShake: noop,
    },
    testRecorder: { reset: noop },
    pauseEngine: noop,
    resumeEngine: noop,
    abortWalkthrough: noop,
    promptCancel: noop,
    drainHistoryCommits: async () => {},
    nextSessionId: noop,
    setActiveReplaySeed: noop,
    stopHistoryWriter: noop,
    resetPauseOwners: noop,
    resetHistoryView: noop,
    releaseAgentAudioPreviews: noop,
  } as unknown as GameLifecycleOptions);
  return { calls, state, lifecycle };
}

test("a quit installation names its minted logical id and keeps its physical target separate", async () => {
  const files = testFiles();
  const gameA = await installedGame("quest ünï dûx", files);
  const gameB = await installedGame("quest-duplicate", files);
  assert.notEqual(gameA.progressTarget!.locator, gameB.progressTarget!.locator);

  const { state, lifecycle } = quitHarness();
  lifecycle.setBootedGame(gameA);
  await lifecycle.gameQuit();
  const ended = state.gameEnded!;
  assert.equal(ended.projectId, gameA.progressTarget!.identity.project);
  assert.ok(String(ended.projectId).startsWith("installed-"));
  assert.equal(parseProgressLocator(ended.projectId), null, "no colon locator as project id");
  assert.notEqual(ended.projectId, SHARED_HASH, "never the shared alias spelling");
  assert.equal(ended.progressTarget?.locator, gameA.progressTarget!.locator);
  assert.equal(ended.progressTarget?.kind, "installed");
});

test("a quit saved project keeps its logical id and physical target", async (t) => {
  const files = testFiles();
  const projectId = testProjectId("quit-saved");
  await saveAuthoredGame(projectId, {
    title: "Quiz Game",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  t.after(() => clearCachedGame(projectId));
  const game: BootedGame = {
    installed: false,
    projectId,
    title: "Quiz Game",
    revision: await gameRevision(files),
    files,
    words: [],
    historyLifetime: await readHistoryLifetime(projectId),
  };
  bindProgressTarget(game);
  const { state, lifecycle } = quitHarness();
  lifecycle.setBootedGame(game);
  await lifecycle.gameQuit();
  assert.equal(state.gameEnded!.projectId, projectId);
  assert.equal(
    state.gameEnded!.progressTarget?.locator,
    `project:${projectId}:${await readHistoryLifetime(projectId)}`,
  );
});
