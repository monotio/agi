import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createStartOver } from "../src/engine/startOver.ts";
import { createPauseHolds } from "../src/engine/pauseHolds.ts";
import { useAutosaveController } from "../src/saves/useAutosaveController.ts";
import { readGameProgress, writeAutosave } from "../src/saves/gameProgress.ts";
import {
  installedProgressTarget,
  projectProgressTarget,
  type ProgressTarget,
} from "../src/project/progressTarget.ts";
import { bindProgressTarget } from "../src/project/progressBinding.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import {
  clearCachedGame,
  loadAuthoredGameWithHistoryLifetime,
  readHistoryLifetime,
  saveAuthoredGame,
} from "../src/project/gameStorage.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import { requireResourceRevision } from "../../src/gameIdentity.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";
import type { BootedGame, ProjectId } from "../src/project/gameTypes.ts";
import type { EngineState } from "../src/engine/useEngineTypes.ts";

/**
 * Start over's operation ownership: the selected physical target, the
 * running game, its worker and the session incarnation are captured before
 * the first awaited admission. A call parked on the seal, the body binding
 * or the tape read whose world was replaced underneath it clears no
 * checkpoint, moves no timeline intent, boots nothing and shows no note.
 */

installIndexedDbFixture();

const REVISION = requireResourceRevision("c".repeat(64));
const CONFIG: LlmConfig = { provider: "stub", apiKey: "", model: "offline-stub" };

const storageValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storageValues.get(key) ?? null,
    setItem: (key: string, value: string) => void storageValues.set(key, value),
    removeItem: (key: string) => void storageValues.delete(key),
  },
});

/** A clean storage slate per test; the mock itself lives for the file. */
function installLocalStorage(_t: TestContext): void {
  storageValues.clear();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeWorker() {
  const posted: { type: string; paused?: boolean }[] = [];
  return {
    posted,
    postMessage: (msg: { type: string; paused?: boolean }) => void posted.push(msg),
    terminate: () => {},
  };
}
type FakeWorker = ReturnType<typeof fakeWorker>;

/** A bound installed booted game, as bootGame leaves one. */
function installedGame(folder: string): BootedGame {
  const target = installedProgressTarget({ folder }, REVISION);
  assert.ok(target !== null);
  return {
    installed: true,
    folder,
    title: folder.toUpperCase(),
    revision: REVISION,
    files: {},
    words: [],
    progressTarget: target,
    historyLifetime: "initial",
  };
}

function targetOf(game: BootedGame): ProgressTarget {
  assert.ok(game.progressTarget !== undefined);
  return game.progressTarget;
}

/** A checkpoint stored under the target's physical locator, identity-checked. */
function checkpoint(target: ProgressTarget, image: string): void {
  const written = writeAutosave(localStorage, target, {
    format: "monotio.agi.autosave",
    version: 1,
    image,
    cycle: 9,
    room: 2,
    savedAt: 1,
    game: { installed: target.kind === "installed", identity: target.identity },
  });
  assert.ok(written !== null, "the checkpoint wrote under the physical locator");
}

const checkpointAt = (target: ProgressTarget) => readGameProgress(localStorage, target).autosave;

function rig(
  t: TestContext,
  booted: BootedGame | null,
  opts: {
    installed?: readonly string[];
    seal?: () => Promise<void>;
    earlier?: (key: string) => Promise<boolean>;
  } = {},
) {
  const calls: string[] = [];
  const boots: string[] = [];
  const state = {
    phase: "running",
    paused: false,
    resumed: false,
    // Revision-carrying descriptors, as the served listing leaves them: a
    // released spelling can only select a target when the served descriptor
    // proves which build the folder boots.
    installedGames: (opts.installed ?? []).map((folder) => ({
      folder,
      alias: folder,
      hash: folder,
      title: folder.toUpperCase(),
      revision: REVISION,
    })),
  } as unknown as EngineState;
  let game = booted;
  let worker = fakeWorker();
  let session = 11;
  const holds = createPauseHolds({
    post: (paused) => worker.postMessage({ type: "pause", paused }),
    audio: { setPaused: () => {} },
    state,
  });
  /**
   * Another flow takes the slot, the way a real boot or eject does: the
   * pause holds die with the replaced worker, and the session incarnation
   * moves. The fresh worker is returned so the test can watch what is
   * posted to it.
   */
  const takeSlot = (next: BootedGame | null): FakeWorker => {
    holds.resetPauseOwners();
    game = next;
    worker = fakeWorker();
    session++;
    return worker;
  };
  const autosave = useAutosaveController({
    state,
    getBootedGame: () => game,
    getWorker: () => worker as unknown as Worker,
    logAgent: () => {},
    isInstalledGame: (key) => (opts.installed ?? []).includes(key),
    bootGame: async (folder) => {
      boots.push(`installed:${folder}`);
      takeSlot(installedGame(folder));
    },
    // The lifecycle's fresh-boot seam: the candidate the folder serves is
    // proven against the selected locator, the operation is re-admitted, and
    // only then does the checkpoint commit and the slot move.
    bootInstalledFresh: async (selected, admission) => {
      const next = installedGame(selected.folder);
      const landed = next.progressTarget;
      if (landed?.kind !== "installed" || landed.locator !== selected.locator)
        return { status: "refused" as const };
      if (!admission.admitted(landed)) return { status: "superseded" as const };
      admission.commit();
      boots.push(`installed:${selected.folder}`);
      takeSlot(next);
      return { status: "completed" as const };
    },
    bootAuthoredGame: async (_prompt, _config, options) => {
      const id = options?.projectId;
      assert.ok(id !== undefined);
      boots.push(`project:${id}`);
      const loaded = await loadAuthoredGameWithHistoryLifetime(id);
      assert.ok(loaded !== null, "the saved body the boot named exists");
      const next: BootedGame = {
        installed: false,
        projectId: id,
        title: id,
        revision: await gameRevision(loaded.data.files),
        files: loaded.data.files,
        words: loaded.data.words,
        historyLifetime: loaded.lifetime,
      };
      bindProgressTarget(next);
      takeSlot(next);
    },
    configForGame: (_project, config) => config,
    // No resume intent is armed by a start-over; retirement is unreachable.
    retireFailedRecovery: () => {},
  });
  const startOver = createStartOver({
    state,
    getBootedGame: () => game,
    getWorker: () => worker as unknown as Worker,
    getSessionId: () => session,
    sealHistory: opts.seal ?? (async () => {}),
    drainHistoryCommits: async () => {},
    pauseEngine: holds.pauseEngine,
    resumeEngine: holds.resumeEngine,
    selectTarget: (key, held) => autosave.selectProgressTarget(key, held),
    hasEarlierSession: (key) => {
      calls.push(`read:${key}`);
      return opts.earlier?.(key) ?? Promise.resolve(false);
    },
    expectStartOver: (expected = true) => void calls.push(`expect:${expected}`),
    bootFresh: (key, config, operation) => autosave.startOver(key, config, operation),
    showNote: () => calls.push("note"),
  });
  return {
    state,
    calls,
    boots,
    holds,
    autosave,
    startOver,
    takeSlot,
    game: () => game,
    worker: () => worker,
  };
}

/** Poll a recorded effect until it lands, so the parked await is genuinely held. */
async function until(took: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !took(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(took(), "the awaited step ran");
}

test("a start-over parked on the seal cannot act once another game owns the slot", async (t) => {
  installLocalStorage(t);
  const a = installedGame("alpha-saga");
  const b = installedGame("omega-saga");
  const r = rig(t, a, { installed: ["alpha-saga", "omega-saga"] });
  checkpoint(targetOf(a), "alpha-checkpoint");
  const gate = deferred<void>();
  const startOver = createStartOver({
    state: r.state,
    getBootedGame: r.game,
    getWorker: () => r.worker() as unknown as Worker,
    getSessionId: () => 11,
    sealHistory: () => gate.promise,
    drainHistoryCommits: async () => {},
    pauseEngine: r.holds.pauseEngine,
    resumeEngine: r.holds.resumeEngine,
    selectTarget: (key, held) => r.autosave.selectProgressTarget(key, held),
    hasEarlierSession: (key) => {
      r.calls.push(`read:${key}`);
      return Promise.resolve(true);
    },
    expectStartOver: (expected = true) => void r.calls.push(`expect:${expected}`),
    bootFresh: (key, config, operation) => r.autosave.startOver(key, config, operation),
    showNote: () => r.calls.push("note"),
  });
  const pending = startOver(targetOf(a).locator, CONFIG);
  await until(() => r.holds.pauseOwners().includes("startOver"));
  assert.deepEqual(r.holds.pauseOwners(), ["startOver"], "the seal holds the pause");
  const workerB = r.takeSlot(b);
  gate.resolve();
  await pending;
  assert.deepEqual(r.calls, [], "a superseded action reads, marks, boots and notes nothing");
  assert.equal(r.game(), b);
  assert.equal(checkpointAt(targetOf(a))?.image, "alpha-checkpoint");
  assert.deepEqual(
    workerB.posted.filter((m) => m.type === "pause"),
    [],
    "the replacing worker is never touched",
  );
});

test("a session that moved without a worker swap still supersedes the parked call", async (t) => {
  installLocalStorage(t);
  const a = installedGame("alpha-saga");
  const r = rig(t, a, { installed: ["alpha-saga"] });
  const gate = deferred<void>();
  const sessions = { current: 11 };
  const startOver = createStartOver({
    state: r.state,
    getBootedGame: r.game,
    getWorker: () => r.worker() as unknown as Worker,
    getSessionId: () => sessions.current,
    sealHistory: () => gate.promise,
    drainHistoryCommits: async () => {},
    pauseEngine: r.holds.pauseEngine,
    resumeEngine: r.holds.resumeEngine,
    selectTarget: (key, held) => r.autosave.selectProgressTarget(key, held),
    hasEarlierSession: (key) => {
      r.calls.push(`read:${key}`);
      return Promise.resolve(false);
    },
    expectStartOver: (expected = true) => void r.calls.push(`expect:${expected}`),
    bootFresh: (key, config, operation) => r.autosave.startOver(key, config, operation),
    showNote: () => r.calls.push("note"),
  });
  const pending = startOver(targetOf(a).locator, CONFIG);
  await Promise.resolve();
  sessions.current++;
  gate.resolve();
  await pending;
  assert.deepEqual(r.calls, [], "a stale session admits nothing");
  assert.deepEqual(r.holds.pauseOwners(), [], "its own hold is released");
});

test("a start-over parked on the tape read cannot mark or boot a replaced game", async (t) => {
  installLocalStorage(t);
  const a = installedGame("alpha-saga");
  const b = installedGame("omega-saga");
  const read = deferred<boolean>();
  const r = rig(t, a, {
    installed: ["alpha-saga", "omega-saga"],
    earlier: () => read.promise,
  });
  checkpoint(targetOf(a), "alpha-checkpoint");
  const pending = r.startOver(targetOf(a).locator, CONFIG);
  await until(() => r.calls.some((c) => c.startsWith("read:")));
  const workerB = r.takeSlot(b);
  read.resolve(true);
  await pending;
  assert.deepEqual(r.calls, [`read:${targetOf(a).locator}`], "the read ran; the action did not");
  assert.deepEqual(r.boots, []);
  assert.equal(checkpointAt(targetOf(a))?.image, "alpha-checkpoint");
  assert.deepEqual(
    workerB.posted.filter((m) => m.type === "pause"),
    [],
    "the replacing worker is never touched",
  );
});

test("a start-over superseded during the body bind clears and boots nothing", async (t) => {
  installLocalStorage(t);
  const id = testProjectId("bound-body-game");
  const files = { "WORDS.TOK": Uint8Array.of(0, 0) };
  await saveAuthoredGame(id, {
    title: "Bound body",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  t.after(() => clearCachedGame(id));
  const epoch = await readHistoryLifetime(id);
  const revision = await gameRevision(files);
  const target = projectProgressTarget(id, revision, epoch)!;
  checkpoint(target, "kept-checkpoint");
  const gameA: BootedGame = {
    installed: false,
    projectId: id,
    title: "Bound body",
    revision,
    files,
    words: [],
    historyLifetime: epoch,
    progressTarget: target,
  };
  let booted: BootedGame | null = gameA;
  let bootedProject: string | null = null;
  const autosave = useAutosaveController({
    state: { resumed: false, installedGames: [] },
    getBootedGame: () => booted,
    getWorker: () => null,
    logAgent: () => {},
    isInstalledGame: () => false,
    bootGame: async () => assert.fail("a project never boots as an edition"),
    bootAuthoredGame: async (_p, _c, options) => {
      bootedProject = options?.projectId ?? null;
    },
    configForGame: (_project, config) => config,
    // No resume intent is armed by a start-over; retirement is unreachable.
    retireFailedRecovery: () => {},
  });
  const pending = autosave.startOver(target.locator, CONFIG, {
    admitted: () => booted === gameA,
  });
  // The replacement lands while the body's live epoch is still being read:
  // the synchronous swap is always earlier than any bind continuation.
  booted = installedGame("omega-saga");
  const outcome = await pending;
  assert.deepEqual(outcome, { status: "superseded" });
  assert.equal(bootedProject, null);
  assert.equal(checkpointAt(target)?.image, "kept-checkpoint");
});

test("a start-over still owner through the body bind clears its own checkpoint and boots", async (t) => {
  installLocalStorage(t);
  const id = testProjectId("kept-body-game");
  const files = { "WORDS.TOK": Uint8Array.of(0, 0) };
  await saveAuthoredGame(id, {
    title: "Kept body",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  t.after(() => clearCachedGame(id));
  const epoch = await readHistoryLifetime(id);
  const revision = await gameRevision(files);
  const target = projectProgressTarget(id, revision, epoch)!;
  checkpoint(target, "kept-checkpoint");
  const game: BootedGame = {
    installed: false,
    projectId: id,
    title: "Kept body",
    revision,
    files,
    words: [],
    historyLifetime: epoch,
    progressTarget: target,
  };
  let bootedProject: ProjectId | null = null;
  const autosave = useAutosaveController({
    state: { resumed: false, installedGames: [] },
    getBootedGame: () => game,
    getWorker: () => null,
    logAgent: () => {},
    isInstalledGame: () => false,
    bootGame: async () => assert.fail("a project never boots as an edition"),
    bootAuthoredGame: async (_p, _c, options) => {
      bootedProject = options?.projectId ?? null;
    },
    configForGame: (_project, config) => config,
    // No resume intent is armed by a start-over; retirement is unreachable.
    retireFailedRecovery: () => {},
  });
  const outcome = await autosave.startOver(target.locator, CONFIG, {
    admitted: () => true,
  });
  assert.deepEqual(outcome, { status: "completed" });
  assert.equal(bootedProject, id);
  assert.equal(checkpointAt(target), null, "its own checkpoint is gone");
});

test("a start-over refused on a recreated body retracts its intent and shows no note", async (t) => {
  installLocalStorage(t);
  const id = testProjectId("recreated-body-game");
  const files = { "WORDS.TOK": Uint8Array.of(0, 0) };
  await saveAuthoredGame(id, {
    title: "Recreated body",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  t.after(() => clearCachedGame(id));
  const epoch = await readHistoryLifetime(id);
  const revision = await gameRevision(files);
  const target = projectProgressTarget(id, revision, epoch)!;
  checkpoint(target, "old-body-checkpoint");
  const running: BootedGame = {
    installed: false,
    projectId: id,
    title: "Recreated body",
    revision,
    files,
    words: [],
    historyLifetime: epoch,
    progressTarget: target,
  };
  const read = deferred<boolean>();
  const r = rig(t, running, { earlier: () => read.promise });
  const workerA = r.worker();
  const pending = r.startOver(id, CONFIG);
  await until(() => r.calls.some((c) => c.startsWith("read:")));
  // The body is deleted and recreated while the tape read is parked: the
  // captured epoch names the removed incarnation and must not boot it.
  await clearCachedGame(id);
  await saveAuthoredGame(id, {
    title: "Recreated body",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
  read.resolve(true);
  await pending;
  assert.equal(r.game(), running, "the running incarnation keeps its slot");
  assert.deepEqual(r.boots, []);
  assert.deepEqual(r.calls, [`read:${target.locator}`, "expect:true", "expect:false"]);
  assert.equal(
    checkpointAt(target)?.image,
    "old-body-checkpoint",
    "the removed body's record stays",
  );
  assert.deepEqual(
    workerA.posted.map((m) => m.paused),
    [true, false],
    "its own pause hold is released on the same worker",
  );
});

test("a start-over on a bound installed game clears its physical checkpoint and keeps its sibling's progress", async (t) => {
  installLocalStorage(t);
  const a = installedGame("alpha-saga");
  const b = installedGame("omega-saga");
  const r = rig(t, a, { installed: ["alpha-saga", "omega-saga"], earlier: async () => true });
  checkpoint(targetOf(a), "alpha-checkpoint");
  checkpoint(targetOf(b), "omega-checkpoint");
  // A record under the released spelling is Earlier progress read context —
  // the installed selection clears only its own physical locator, even when
  // the legacy record's embedded identity matches the running build.
  writeAutosave(localStorage, {
    format: "monotio.agi.autosave",
    version: 1,
    image: "alpha-legacy",
    cycle: 4,
    room: 1,
    savedAt: 1,
    game: {
      installed: true,
      identity: { project: testProjectId("alpha-saga"), revision: REVISION },
    },
  });
  await r.startOver("alpha-saga", CONFIG);
  assert.deepEqual(r.calls, [`read:${targetOf(a).locator}`, "expect:true", "note"]);
  assert.deepEqual(r.boots, ["installed:alpha-saga"]);
  assert.equal(checkpointAt(targetOf(a)), null, "its own physical checkpoint is gone");
  assert.equal(
    r.autosave.readAutosave("alpha-saga")?.image,
    "alpha-legacy",
    "the spelled record stays as Earlier progress",
  );
  assert.equal(
    checkpointAt(targetOf(b))?.image,
    "omega-checkpoint",
    "the sibling keeps its progress",
  );
  assert.notEqual(r.game(), a, "a fresh game booted");
});

test("a start-over on a bound saved body reads its physical tape and keeps the sibling's checkpoint", async (t) => {
  installLocalStorage(t);
  const idA = testProjectId("saved-alpha");
  const idB = testProjectId("saved-omega");
  const files = { "WORDS.TOK": Uint8Array.of(0, 0) };
  for (const [id, title] of [
    [idA, "Saved alpha"],
    [idB, "Saved omega"],
  ] as const) {
    await saveAuthoredGame(id, {
      title,
      provider: "stub",
      model: "offline-stub",
      files,
      words: [],
    });
    t.after(() => clearCachedGame(id));
  }
  const revision = await gameRevision(files);
  const targetA = projectProgressTarget(idA, revision, await readHistoryLifetime(idA))!;
  const targetB = projectProgressTarget(idB, revision, await readHistoryLifetime(idB))!;
  checkpoint(targetA, "alpha-checkpoint");
  checkpoint(targetB, "omega-checkpoint");
  const running: BootedGame = {
    installed: false,
    projectId: idA,
    title: "Saved alpha",
    revision,
    files,
    words: [],
    historyLifetime: targetA.bodyEpoch,
    progressTarget: targetA,
  };
  const r = rig(t, running, { earlier: async () => true });
  await r.startOver(idA, CONFIG);
  assert.deepEqual(r.calls, [`read:${targetA.locator}`, "expect:true", "note"]);
  assert.deepEqual(r.boots, [`project:${idA}`]);
  assert.equal(checkpointAt(targetA), null);
  assert.equal(checkpointAt(targetB)?.image, "omega-checkpoint");
});
