import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { useGameLifecycle, type GameLifecycleOptions } from "../src/engine/useGameLifecycle.ts";
import { createStartOver } from "../src/engine/startOver.ts";
import {
  useAutosaveController,
  type FreshInstalledAdmission,
  type SelectedInstalledTarget,
  type StartOverOutcome,
} from "../src/saves/useAutosaveController.ts";
import {
  autosaveKey,
  readGameProgress,
  writeAutosave,
  type AutosaveRecord,
} from "../src/saves/gameProgress.ts";
import { readResumePointer, writeResumePointer } from "../src/saves/resumePointer.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import { installedProgressTarget, type ProgressTarget } from "../src/project/progressTarget.ts";
import { bindSavedProgressTarget } from "../src/project/progressBinding.ts";
import { loadAuthoredGame, saveAuthoredGame } from "../src/project/gameStorage.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import type { EngineState } from "../src/engine/useEngineTypes.ts";
import type { BootedGame, InstalledGameDescriptor } from "../src/project/gameTypes.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";

/**
 * Start over's native admission: the served folder's actual bytes decide
 * whether the fresh boot may proceed, proven AFTER every preparation await —
 * the selected physical checkpoint clears only once the fetched build is the
 * build the selection named and the captured operation still owns the slot.
 * A stale or revision-free cached descriptor never substitutes for the bytes;
 * a bare legacy record sharing the convenience spelling is never the selected
 * physical checkpoint's to delete.
 *
 * Real composition throughout: createStartOver, useAutosaveController and
 * useGameLifecycle over real container/assembler bytes, hashing, binding and
 * storage. Only the browser boundary is controlled — an in-memory
 * localStorage, the IndexedDB fixture, fetch responses and a recording
 * worker port.
 */

installIndexedDbFixture();

const CONFIG: LlmConfig = { provider: "stub", apiKey: "", model: "offline-stub" };

const storageValues = new Map<string, string>();
const events: string[] = [];
const storage = {
  getItem: (key: string) => storageValues.get(key) ?? null,
  setItem: (key: string, value: string) => void storageValues.set(key, value),
  removeItem: (key: string) => {
    events.push(`remove:${key}`);
    storageValues.delete(key);
  },
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage,
});

/** Real v2 container bytes: identical vocabulary, one assembled logic. */
function nativeFiles(source: string): Record<string, Uint8Array> {
  const container = createContainer();
  container.putFile("WORDS.TOK", new Uint8Array(52));
  container.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  return Object.fromEntries(container.files);
}
const BUILD_A = nativeFiles("return;");
const BUILD_B = nativeFiles('display(1, 1, "Build B"); return;');
const revA = await gameRevision(BUILD_A);
const revB = await gameRevision(BUILD_B);
assert.notEqual(revA, revB);
assert.deepEqual(BUILD_A["WORDS.TOK"], BUILD_B["WORDS.TOK"]);

function checkpoint(target: ProgressTarget, image = "QQ==", installed = true): AutosaveRecord {
  return {
    format: "monotio.agi.autosave",
    version: 1,
    image,
    room: 1,
    cycle: 1,
    savedAt: 1,
    game: { installed, identity: target.identity },
  };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, release: () => resolve() };
}

interface FakeWorker {
  posted: {
    type: string;
    files?: Record<string, Uint8Array>;
    restoreImage?: string;
  }[];
  postMessage(m: { type: string; files?: Record<string, Uint8Array>; restoreImage?: string }): void;
  terminate(): void;
}

/**
 * The composed start-over stack: real controller and lifecycle, fake only
 * the fetch surface (manifest + file bytes per served folder, with optional
 * per-file parking gates) and the worker port (boot posts recorded).
 * `freshSeam: false` composes the controller without the installed
 * fresh-boot seam, as a composition that never wired it does.
 */
function harness(
  t: TestContext,
  descriptors: InstalledGameDescriptor[],
  options?: { freshSeam?: boolean },
) {
  storageValues.clear();
  events.length = 0;
  const served = new Map<string, Record<string, Uint8Array> | null>();
  const gates = new Map<string, Promise<void>>();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    events.push(`fetch:${url}`);
    assert.ok(url.startsWith("/fixtures/"), `unexpected fetch ${url}`);
    const rest = url.slice("/fixtures/".length);
    if (url.endsWith("/")) {
      const folder = decodeURIComponent(rest.slice(0, -1));
      const files = served.get(folder);
      assert.ok(files !== undefined, `no fixture entry served for ${folder}`);
      return files === null
        ? new Response("missing", { status: 404 })
        : new Response(JSON.stringify(Object.keys(files)));
    }
    const slash = rest.lastIndexOf("/");
    const folder = decodeURIComponent(rest.slice(0, slash));
    const name = decodeURIComponent(rest.slice(slash + 1));
    const gate = gates.get(`${folder}/${name}`);
    if (gate !== undefined) await gate;
    const files = served.get(folder);
    assert.ok(files != null, `no fixture files served for ${folder}`);
    const bytes = files[name];
    assert.ok(bytes !== undefined, `no fixture file ${folder}/${name}`);
    return new Response(new Uint8Array(bytes));
  };

  const state = {
    phase: "idle",
    error: "",
    loading: null as { title: string; generating: boolean } | null,
    resumed: false,
    soundMode: "pc-speaker",
    installedGames: descriptors,
  } as unknown as EngineState;

  let worker: FakeWorker | null = null;
  let session = 0;
  const noop = () => {};
  const autosave = useAutosaveController({
    state,
    getBootedGame: (): BootedGame | null => lifecycle.getBootedGame(),
    getWorker: () => worker as unknown as Worker | null,
    logAgent: noop,
    isInstalledGame: (key) =>
      descriptors.some((d) => d.folder === key || d.alias === key || d.hash === key),
    bootGame: (key) => lifecycle.bootGame(key),
    ...(options?.freshSeam === false
      ? {}
      : {
          bootInstalledFresh: (
            selected: SelectedInstalledTarget,
            admission: FreshInstalledAdmission,
          ) => lifecycle.bootInstalledFresh(selected, admission),
        }),
    bootAuthoredGame: async () => {
      throw new Error("unexpected authored boot");
    },
    configForGame: (_id, config) => config,
    // As useEngine wires it: the lifecycle retires the armed candidate's worker.
    retireFailedRecovery: (game, message) => lifecycle.retireFailedRecovery(game, message),
  });
  const lifecycle = useGameLifecycle({
    state,
    hook: {},
    autosave,
    audio: { useGameFiles: noop, stop: noop, setPaused: noop },
    logAgent: noop,
    link: {
      spawnWorker: () => {
        session++;
        const next: FakeWorker = {
          posted: [],
          postMessage(m) {
            next.posted.push(m);
            if (m.type === "boot") {
              events.push(`worker:boot:${session}`);
              state.phase = "running";
            }
          },
          terminate: noop,
        };
        worker = next;
        return next;
      },
      terminateWorker: noop,
      drainPendingQueries: noop,
      clearShake: noop,
      query: async () => {
        events.push("seal");
        return null;
      },
    },
    authoring: { resetSession: noop },
    testRecorder: { reset: noop },
    promptCancel: noop,
    releaseAgentAudioPreviews: noop,
    pauseEngine: noop,
    resumeEngine: noop,
    resetPauseOwners: noop,
    resetHistoryView: noop,
    getSessionId: () => session,
    nextSessionId: () => ++session,
    getActiveReplaySeed: () => null,
    setActiveReplaySeed: noop,
    setActiveLlmConfig: noop,
    getActiveLlmConfig: () => CONFIG,
    abortWalkthrough: noop,
    drainHistoryCommits: async () => {},
    stopHistoryWriter: noop,
    devFixtures: true,
  } as unknown as GameLifecycleOptions);

  let outcome: StartOverOutcome | void;
  const startOver = createStartOver({
    state,
    getBootedGame: lifecycle.getBootedGame,
    getWorker: () => worker as unknown as Worker | null,
    getSessionId: () => session,
    sealHistory: lifecycle.sealHistory,
    drainHistoryCommits: async () => {},
    pauseEngine: (owner) => events.push(`pause:${owner}`),
    resumeEngine: (owner) => events.push(`resume:${owner}`),
    selectTarget: (key, game) => autosave.selectProgressTarget(key, game),
    hasEarlierSession: async (key) => {
      events.push(`earlier:${key}`);
      return true;
    },
    expectStartOver: (expected = true) => {
      events.push(`intent:${expected}`);
    },
    bootFresh: async (key, config, admission) => {
      const result = await autosave.startOver(key, config, admission);
      outcome = result;
      return result;
    },
    showNote: () => {
      events.push("note");
    },
  });

  return {
    state,
    lifecycle,
    autosave,
    startOver,
    worker: () => worker,
    outcome: () => outcome,
    /** Point the folder's fixture server at new bytes; null fails its manifest. */
    serve: (folder: string, files: Record<string, Uint8Array> | null) =>
      void served.set(folder, files),
    /** Hold one file fetch open until release() — parks a boot mid-prepare. */
    holdFetch: (folder: string, name: string) => {
      const gate = deferred();
      gates.set(`${folder}/${name}`, gate.promise);
      return gate;
    },
  };
}

/** Poll a recorded effect until it lands, so the parked await is genuinely held. */
async function until(took: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !took(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(took(), "the awaited step ran");
}

function descriptor(folder: string, revision = revA): InstalledGameDescriptor {
  return { folder, alias: folder, hash: folder, title: folder, revision };
}

for (const mode of [
  "stale-descriptor-physical",
  "revision-free-physical",
  "running-spelling",
] as const) {
  test(`native admission preserves the running build when the served files moved: ${mode}`, async (t) => {
    const folder = `native-admission-${mode}`;
    const h = harness(t, [descriptor(folder)]);
    h.serve(folder, BUILD_A);
    await h.lifecycle.bootGame(folder);
    assert.equal(h.lifecycle.getBootedGame()?.revision, revA);
    const targetA = h.lifecycle.getBootedGame()!.progressTarget!;
    const targetB = installedProgressTarget({ folder }, revB)!;
    assert.ok(writeAutosave(storage, targetA, checkpoint(targetA)));
    assert.ok(writeAutosave(storage, targetB, checkpoint(targetB, "Qg==")));
    const savedA = storage.getItem(autosaveKey(targetA.locator));
    if (mode === "revision-free-physical")
      h.state.installedGames = [{ folder, alias: folder, hash: folder, title: folder }];
    h.serve(folder, BUILD_B);
    events.length = 0;
    await h.startOver(mode === "running-spelling" ? folder : targetA.locator, CONFIG);
    assert.equal(
      readGameProgress(storage, targetB).autosave?.image,
      "Qg==",
      "B's independent checkpoint stays intact",
    );
    assert.equal(
      storage.getItem(autosaveKey(targetA.locator)),
      savedA,
      "a fetched replacement build must not clear A's checkpoint",
    );
    assert.equal(
      h.lifecycle.getBootedGame()?.revision,
      revA,
      "mismatched actual bytes must not replace A for this Start over",
    );
    assert.notDeepEqual(h.outcome(), { status: "completed" });
    assert.ok(
      !events.some((event) => event.startsWith("worker:boot")),
      "no worker boot posted for the mismatched build",
    );
  });
}

test("matching native bytes admit the fresh boot: one fetch, selected checkpoint cleared, empty resume", async (t) => {
  const folder = "native-admission-matching";
  const h = harness(t, [descriptor(folder)]);
  h.serve(folder, BUILD_A);
  await h.lifecycle.bootGame(folder);
  const target = h.lifecycle.getBootedGame()!.progressTarget!;
  assert.ok(writeAutosave(storage, target, checkpoint(target)));
  events.length = 0;
  await h.startOver(target.locator, CONFIG);
  assert.equal(readGameProgress(storage, target).autosave, null);
  assert.equal(h.lifecycle.getBootedGame()?.revision, revA);
  assert.deepEqual(h.outcome(), { status: "completed" });
  assert.ok(events.includes("note"));
  const fileFetches = events.filter((event) => event.startsWith("fetch:") && !event.endsWith("/"));
  assert.equal(
    fileFetches.length,
    Object.keys(BUILD_A).length,
    "the candidate was fetched exactly once — no prefetch-plus-reboot gap",
  );
  assert.equal(new Set(fileFetches).size, fileFetches.length, "no file was fetched twice");
  const boot = h.worker()!.posted.find((m) => m.type === "boot")!;
  assert.deepEqual(
    boot.files,
    BUILD_A,
    "the bytes posted to the worker are the fetched candidate itself",
  );
  assert.equal(boot.restoreImage, "", "the fresh boot carries an explicitly empty resume payload");
});

test("a descriptor already naming another build refuses before seal, read or fetch", async (t) => {
  const folder = "native-admission-known-mismatch";
  const h = harness(t, [descriptor(folder)]);
  h.serve(folder, BUILD_A);
  await h.lifecycle.bootGame(folder);
  const target = h.lifecycle.getBootedGame()!.progressTarget!;
  assert.ok(writeAutosave(storage, target, checkpoint(target)));
  const saved = storage.getItem(autosaveKey(target.locator));
  h.state.installedGames = [descriptor(folder, revB)];
  h.serve(folder, BUILD_B);
  events.length = 0;
  await h.startOver(target.locator, CONFIG);
  assert.equal(storage.getItem(autosaveKey(target.locator)), saved);
  assert.deepEqual(events, []);
});

test("an installed Start over clears its physical checkpoint but keeps the same-spelling saved legacy record", async (t) => {
  const folder = "native-admission-legacy-collision";
  const h = harness(t, [descriptor(folder)]);
  const id = requireProjectId(folder);
  assert.equal(
    await saveAuthoredGame(id, {
      title: folder,
      provider: "stub",
      model: "offline-stub",
      files: BUILD_A,
      words: [],
    }),
    true,
  );
  const savedTarget = (await bindSavedProgressTarget(id))!;
  assert.ok(savedTarget);
  // The saved body's released-spelling record and its physical record both exist.
  assert.ok(writeAutosave(storage, checkpoint(savedTarget, "Uw==", false)));
  assert.ok(writeAutosave(storage, savedTarget, checkpoint(savedTarget, "Uw==", false)));
  const legacy = storage.getItem(autosaveKey(folder));
  h.serve(folder, BUILD_A);
  await h.lifecycle.bootGame(folder);
  const installedTarget = h.lifecycle.getBootedGame()!.progressTarget!;
  assert.ok(writeAutosave(storage, installedTarget, checkpoint(installedTarget)));
  events.length = 0;
  await h.startOver(folder, CONFIG);
  assert.equal(readGameProgress(storage, savedTarget).autosave?.image, "Uw==");
  assert.equal(readGameProgress(storage, installedTarget).autosave, null);
  assert.equal((await loadAuthoredGame(id)) !== null, true);
  assert.equal(
    storage.getItem(autosaveKey(folder)),
    legacy,
    "the installed selection does not own the saved body's legacy record",
  );
});

test("a native fetch that fails leaves the running world, its checkpoint and the pointer alone", async (t) => {
  const folder = "native-admission-fetch-failure";
  const h = harness(t, [descriptor(folder)]);
  h.serve(folder, BUILD_A);
  await h.lifecycle.bootGame(folder);
  const target = h.lifecycle.getBootedGame()!.progressTarget!;
  assert.ok(writeAutosave(storage, target, checkpoint(target)));
  const saved = storage.getItem(autosaveKey(target.locator));
  const before = h.lifecycle.getBootedGame();
  h.serve(folder, null);
  events.length = 0;
  await assert.rejects(h.startOver(target.locator, CONFIG));
  assert.equal(
    storage.getItem(autosaveKey(target.locator)),
    saved,
    "the checkpoint survives a failed fetch",
  );
  assert.equal(h.lifecycle.getBootedGame(), before, "the old world still owns the slot");
  assert.notDeepEqual(h.outcome(), { status: "completed" });
  assert.ok(!events.some((event) => event.startsWith("worker:boot")));
  assert.ok(
    !events.some((event) => event.startsWith("remove:")),
    "nothing was deleted before the fetch",
  );
  assert.ok(events.includes("intent:false"), "the fresh-boot intent was retracted");
});

test("a start-over parked on the native fetch cannot act once another boot owns the slot", async (t) => {
  const folder = "native-admission-parked-fetch";
  const other = "native-admission-other";
  const h = harness(t, [descriptor(folder), descriptor(other, revB)]);
  h.serve(folder, BUILD_A);
  h.serve(other, BUILD_B);
  await h.lifecycle.bootGame(folder);
  const target = h.lifecycle.getBootedGame()!.progressTarget!;
  assert.ok(writeAutosave(storage, target, checkpoint(target)));
  const saved = storage.getItem(autosaveKey(target.locator));
  const gate = h.holdFetch(folder, "WORDS.TOK");
  const pending = h.startOver(target.locator, CONFIG);
  await until(() => events.some((event) => event === `fetch:/fixtures/${folder}/WORDS.TOK`));
  // Another flow takes the slot while this one's fetch is still in flight.
  await h.lifecycle.bootGame(other);
  gate.release();
  await pending;
  assert.equal(
    storage.getItem(autosaveKey(target.locator)),
    saved,
    "a superseded fetch clears nothing",
  );
  assert.deepEqual(h.outcome(), { status: "superseded" });
  assert.equal(h.lifecycle.getBootedGame()?.folder, other);
  assert.equal(h.lifecycle.getBootedGame()?.revision, revB);
  assert.ok(
    !events.some((event) => event === `remove:${autosaveKey(target.locator)}`),
    "the selected physical checkpoint was never touched",
  );
});

test("an installed Start over without the fresh-boot seam refuses before clear or fetch", async (t) => {
  const folder = "native-admission-no-seam";
  const h = harness(t, [descriptor(folder)], { freshSeam: false });
  h.serve(folder, BUILD_A);
  await h.lifecycle.bootGame(folder);
  const before = h.lifecycle.getBootedGame()!;
  const target = before.progressTarget!;
  assert.ok(writeAutosave(storage, target, checkpoint(target)));
  const saved = storage.getItem(autosaveKey(target.locator));
  assert.ok(writeResumePointer(storage, target.locator));
  events.length = 0;
  await h.startOver(target.locator, CONFIG);
  assert.deepEqual(h.outcome(), { status: "refused" });
  assert.equal(
    storage.getItem(autosaveKey(target.locator)),
    saved,
    "a composition without the seam clears nothing",
  );
  assert.equal(
    readResumePointer(storage)?.value,
    target.locator,
    "the resume pointer still names the checkpoint",
  );
  assert.equal(h.lifecycle.getBootedGame(), before, "the running world keeps the slot");
  assert.equal(h.state.phase, "running");
  assert.ok(
    !events.some((event) => event.startsWith("fetch:")),
    "an unproven boot is never fetched",
  );
  assert.ok(
    !events.some((event) => event.startsWith("remove:")),
    "no physical checkpoint was removed",
  );
  assert.ok(!events.some((event) => event.startsWith("worker:boot")), "no boot posted");
  assert.ok(!events.includes("note"), "no Undo note published");
  assert.ok(events.includes("intent:false"), "the fresh-boot intent was retracted");
  assert.ok(
    events.includes("pause:startOver") && events.includes("resume:startOver"),
    "the operation released its own pause hold",
  );
});

test("a denied selected physical removal fails closed: checkpoint, pointer and world stay", async (t) => {
  const folder = "native-admission-removal-denied";
  const h = harness(t, [descriptor(folder)]);
  h.serve(folder, BUILD_A);
  await h.lifecycle.bootGame(folder);
  const before = h.lifecycle.getBootedGame()!;
  const target = before.progressTarget!;
  assert.ok(writeAutosave(storage, target, checkpoint(target)));
  const saved = storage.getItem(autosaveKey(target.locator));
  assert.ok(writeResumePointer(storage, target.locator));
  const worker = h.worker();
  const loading = h.state.loading;
  h.state.resumed = true;
  const originalRemove = storage.removeItem;
  t.after(() => {
    storage.removeItem = originalRemove;
  });
  storage.removeItem = (key) => {
    if (key === autosaveKey(target.locator)) throw new Error("controlled storage denial");
    originalRemove(key);
  };
  events.length = 0;
  await assert.rejects(h.startOver(target.locator, CONFIG), /controlled storage denial/);
  assert.equal(
    storage.getItem(autosaveKey(target.locator)),
    saved,
    "the selected checkpoint survived byte-for-byte",
  );
  assert.equal(
    readResumePointer(storage)?.value,
    target.locator,
    "the resume pointer was not retracted",
  );
  assert.equal(h.lifecycle.getBootedGame(), before, "the old world still owns the slot");
  assert.equal(h.worker(), worker, "no replacement worker was spawned");
  assert.equal(h.state.phase, "running", "a refused clear is not an error screen");
  assert.equal(h.state.error, "");
  assert.equal(h.state.loading, loading);
  assert.equal(h.state.resumed, true, "the resumed flag was never discarded");
  assert.notDeepEqual(h.outcome(), { status: "completed" });
  assert.ok(!events.some((event) => event.startsWith("worker:boot")), "no boot posted");
  assert.ok(!events.includes("note"), "no Undo note published");
  assert.ok(events.includes("intent:false"), "the fresh-boot intent was retracted");
  assert.ok(events.includes("resume:startOver"), "the operation's own pause hold was released");
});

test("a denied selected checkpoint read refuses — never read as absent", async (t) => {
  const folder = "native-admission-read-denied";
  const h = harness(t, [descriptor(folder)]);
  h.serve(folder, BUILD_A);
  await h.lifecycle.bootGame(folder);
  const before = h.lifecycle.getBootedGame()!;
  const target = before.progressTarget!;
  assert.ok(writeAutosave(storage, target, checkpoint(target)));
  const saved = storageValues.get(autosaveKey(target.locator));
  const worker = h.worker();
  const originalGet = storage.getItem;
  t.after(() => {
    storage.getItem = originalGet;
  });
  storage.getItem = (key) => {
    if (key === autosaveKey(target.locator)) throw new Error("controlled read denial");
    return originalGet(key);
  };
  events.length = 0;
  await assert.rejects(h.startOver(target.locator, CONFIG), /controlled read denial/);
  assert.equal(
    storageValues.get(autosaveKey(target.locator)),
    saved,
    "the unreadable record is untouched",
  );
  assert.equal(h.lifecycle.getBootedGame(), before, "the old world still owns the slot");
  assert.equal(h.worker(), worker);
  assert.equal(h.state.phase, "running");
  assert.notDeepEqual(h.outcome(), { status: "completed" });
  assert.ok(!events.some((event) => event.startsWith("worker:boot")), "no boot posted");
  assert.ok(!events.includes("note"), "no Undo note published");
});

for (const mode of ["corrupt", "foreign"] as const) {
  test(`a value under the selected key that is not this checkpoint refuses, not absence: ${mode}`, async (t) => {
    const folder = `native-admission-incompatible-${mode}`;
    const h = harness(t, [descriptor(folder)]);
    h.serve(folder, BUILD_A);
    await h.lifecycle.bootGame(folder);
    const before = h.lifecycle.getBootedGame()!;
    const target = before.progressTarget!;
    // A readable value that is not this selection's checkpoint: unparseable
    // bytes, or a well-formed record another build owns.
    const stored =
      mode === "corrupt"
        ? "not a stored checkpoint {"
        : JSON.stringify({
            format: "monotio.agi.autosave",
            version: 1,
            image: "QQ==",
            room: 1,
            cycle: 1,
            savedAt: 1,
            game: {
              installed: true,
              identity: { project: target.identity.project, revision: revB },
            },
          });
    storageValues.set(autosaveKey(target.locator), stored);
    const worker = h.worker();
    events.length = 0;
    await assert.rejects(h.startOver(target.locator, CONFIG));
    assert.equal(
      storage.getItem(autosaveKey(target.locator)),
      stored,
      "a record the selection does not own is never removed as absence",
    );
    assert.equal(h.lifecycle.getBootedGame(), before, "the old world still owns the slot");
    assert.equal(h.worker(), worker);
    assert.equal(h.state.phase, "running");
    assert.notDeepEqual(h.outcome(), { status: "completed" });
    assert.ok(!events.some((event) => event.startsWith("worker:boot")), "no boot posted");
    assert.ok(!events.includes("note"), "no Undo note published");
  });
}

test("a commit rejection before install keeps the running world and phase", async (t) => {
  const folder = "native-admission-commit-error";
  const h = harness(t, [descriptor(folder)]);
  h.serve(folder, BUILD_A);
  await h.lifecycle.bootGame(folder);
  const before = h.lifecycle.getBootedGame()!;
  const target = before.progressTarget!;
  assert.ok(writeAutosave(storage, target, checkpoint(target)));
  const raw = storage.getItem(autosaveKey(target.locator));
  const worker = h.worker();
  const loading = h.state.loading;
  events.length = 0;
  await assert.rejects(
    h.lifecycle.bootInstalledFresh(
      { kind: "installed", folder, locator: target.locator },
      {
        admitted: () => true,
        commit: () => {
          throw new Error("controlled commit refusal");
        },
      },
    ),
    /controlled commit refusal/,
  );
  assert.equal(storage.getItem(autosaveKey(target.locator)), raw);
  assert.equal(h.lifecycle.getBootedGame(), before, "the old world still owns the slot");
  assert.equal(h.worker(), worker, "no replacement worker was spawned");
  assert.equal(h.state.loading, loading);
  assert.ok(!events.some((event) => event.startsWith("worker:boot")), "no boot posted");
  assert.equal(
    h.state.phase,
    "running",
    "commit refused before slot mutation: the old world runs on",
  );
});
