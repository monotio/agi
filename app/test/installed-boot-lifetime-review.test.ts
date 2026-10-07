import { test } from "node:test";
import assert from "node:assert/strict";
import { useGameLifecycle, type GameLifecycleOptions } from "../src/engine/useGameLifecycle.ts";
import type { ResumeBootCandidate, ResumeBootCarrier } from "../src/saves/useAutosaveController.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import {
  clearCachedGame,
  loadAuthoredGame,
  readHistoryLifetime,
  saveAuthoredGame,
} from "../src/project/gameStorage.ts";
import { installedProgressLocator } from "../src/project/progressTarget.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import type { InstalledGameDescriptor } from "../src/project/gameTypes.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";

installIndexedDbFixture();
// The project index lives in localStorage; each test file runs in its own process.
const localValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => void localValues.set(key, value),
    removeItem: (key: string) => void localValues.delete(key),
  },
});

/**
 * A boot-path lifecycle: real storage, binding and network behind fakes —
 * the dev gate opens through the explicit test seam, the fixture server is
 * a fetch stub serving real container bytes, and the worker is a recording
 * fake port. Nothing about the boot's storage reads or bindings is mocked.
 */
function bootHarness() {
  const workers: { posted: unknown[]; postMessage(m: unknown): void }[] = [];
  const sessions: unknown[] = [];
  const noop = () => {};
  const state = {
    loading: null as unknown,
    phase: "idle" as string,
    error: "",
    installedGames: [] as InstalledGameDescriptor[],
    genesisStarter: null as unknown,
    soundMode: "pc-speaker" as string,
  };
  const lifecycle = useGameLifecycle({
    state,
    hook: {},
    audio: { useGameFiles: noop, stop: noop, setPaused: noop },
    logAgent: noop,
    link: {
      spawnWorker: () => {
        const worker = {
          posted: [] as unknown[],
          postMessage(msg: unknown) {
            worker.posted.push(msg);
          },
          terminate: noop,
        };
        workers.push(worker);
        return worker;
      },
      terminateWorker: noop,
      drainPendingQueries: noop,
      clearShake: noop,
      query: async () => null,
    },
    autosave: {
      // Ordinary boots and departures only: this harness never arms a
      // resume intent, so a carrier reaching either entry point is foreign
      // — the gate refuses it and admission defers to the carrier's own
      // (already dead) intent.
      beginResumeBoot: (carrier?: ResumeBootCarrier) => carrier === undefined,
      takeResumeState: async (boot: ResumeBootCandidate, carrier?: ResumeBootCarrier) =>
        carrier === undefined ? { status: "none" as const } : carrier.admit(boot),
      resetScreen: noop,
      reset: noop,
      drainFlushWaiters: noop,
      flushAutosaveDetailed: async () => ({ status: "saved" }),
    },
    authoring: {
      getSession: () => null,
      setSession: (session: unknown) => sessions.push(session),
      resetSession: noop,
      attachSessionRuntime: noop,
      postSessionSnapshot: noop,
    },
    testRecorder: { reset: noop },
    promptCancel: noop,
    releaseAgentAudioPreviews: noop,
    pauseEngine: noop,
    resumeEngine: noop,
    resetPauseOwners: noop,
    resetHistoryView: noop,
    getSessionId: () => 1,
    nextSessionId: () => 2,
    getActiveReplaySeed: () => null,
    setActiveReplaySeed: noop,
    setActiveLlmConfig: noop,
    getActiveLlmConfig: () => ({ provider: "stub", apiKey: "", model: "offline-stub" }),
    abortWalkthrough: noop,
    drainHistoryCommits: async () => {},
    stopHistoryWriter: noop,
    devFixtures: true,
  } as unknown as GameLifecycleOptions);
  return { lifecycle, workers, sessions, state };
}

/** A real v2 container's playable bytes: vocabulary plus one assembled logic. */
function fixtureFiles(): Record<string, Uint8Array> {
  const container = createContainer();
  container.putFile("WORDS.TOK", new Uint8Array(52));
  container.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  return Object.fromEntries(container.files);
}

/**
 * The fixture server's fetch surface: a directory manifest for the folder
 * spelling, then each playable file's bytes. Any folder the test serves
 * answers; anything else is a 404 like a missing folder.
 */
function serveFixture(t: { after: (fn: () => void) => void }, files: Record<string, Uint8Array>) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/")) {
      return new Response(JSON.stringify(Object.keys(files)), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const name = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
    const bytes = files[name];
    return bytes === undefined
      ? new Response(null, { status: 404 })
      : new Response(new Uint8Array(bytes));
  };
}

function saveBody(id: ReturnType<typeof testProjectId>, files: Record<string, Uint8Array>) {
  return saveAuthoredGame(id, {
    title: id,
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
  });
}

test("an installed boot whose same-slug saved body was removed captures its own physical lifetime", async (t) => {
  const folder = "lifetime-collision";
  const files = fixtureFiles();
  const slugId = testProjectId(folder);
  assert.equal(await saveBody(slugId, files), true);
  await clearCachedGame(slugId);
  assert.equal(await readHistoryLifetime(slugId), null, "the removed slug's receipt ended");
  serveFixture(t, files);
  const { lifecycle, workers, state } = bootHarness();
  state.installedGames = [{ folder, alias: folder, hash: folder, title: folder }];
  await lifecycle.bootGame(folder);
  assert.notEqual(state.phase, "error", String(state.error));

  const locator = installedProgressLocator(folder, await gameRevision(files));
  assert.ok(locator?.startsWith("installed:"));
  const game = lifecycle.getBootedGame();
  assert.equal(game?.progressTarget?.kind, "installed");
  assert.equal(game?.progressTarget?.locator, locator);
  assert.equal(
    await readHistoryLifetime(locator!),
    "initial",
    "the physical locator has no receipt of its own yet",
  );
  assert.equal(
    game?.historyLifetime,
    "initial",
    "the installed capture is the locator's own lifetime, not the removed slug's",
  );
  assert.equal(
    await readHistoryLifetime(slugId),
    null,
    "the removed body stays removed — nothing is adopted or revived",
  );
  assert.equal(workers.length, 1);
  const boot = workers[0]!.posted.find((m) => (m as { type: string }).type === "boot");
  assert.ok(boot, "the bound game is the one posted to the worker");
});

test("an installed boot beside a live saved body under the same slug keeps the body's epoch out of its capture", async (t) => {
  const folder = "live-slug-collision";
  const files = fixtureFiles();
  const slugId = testProjectId(folder);
  assert.equal(await saveBody(slugId, files), true);
  const bodyEpoch = await readHistoryLifetime(slugId);
  assert.ok(bodyEpoch !== null && bodyEpoch !== "initial", "the live body minted a UUID epoch");
  t.after(() => void clearCachedGame(slugId));
  serveFixture(t, files);
  const { lifecycle, workers, state } = bootHarness();
  state.installedGames = [{ folder, alias: folder, hash: folder, title: folder }];
  await lifecycle.bootGame(folder);
  assert.notEqual(state.phase, "error", String(state.error));

  const locator = installedProgressLocator(folder, await gameRevision(files));
  const game = lifecycle.getBootedGame();
  assert.equal(game?.progressTarget?.locator, locator);
  // The physical locator is the installed instance's own authority: its
  // unreceipted lifetime is `initial`, never the live body's epoch.
  assert.equal(game?.historyLifetime, "initial");
  assert.notEqual(game?.historyLifetime, bodyEpoch);
  assert.deepEqual(
    game?.progressTarget?.legacyKeys,
    [folder],
    "the same-slug body stays readable as legacy context only",
  );
  assert.equal(await readHistoryLifetime(slugId), bodyEpoch, "the saved body keeps its epoch");
  assert.ok(await loadAuthoredGame(slugId), "the saved body is untouched");
  assert.equal(workers.length, 1);
  const boot = workers[0]!.posted.find((m) => (m as { type: string }).type === "boot");
  assert.ok(boot, "the bound game is the one posted to the worker");
});

test("a folder outside the project-id alphabet sharing a hash and alias still captures its own physical lifetime", async (t) => {
  const folder = "quest ünï dûx";
  const shared = testProjectId("shared-edition-spelling");
  const files = fixtureFiles();
  assert.equal(await saveBody(shared, files), true);
  const sharedEpoch = await readHistoryLifetime(shared);
  t.after(() => void clearCachedGame(shared));
  serveFixture(t, files);
  const { lifecycle, workers, state } = bootHarness();
  // The released storage key for this folder falls back to the shared hash
  // spelling — under it sits a live body whose epoch is another record's.
  state.installedGames = [{ folder, alias: shared, hash: shared, title: "QUEST ÜNÏ DÛX" }];
  await lifecycle.bootGame(folder);
  assert.notEqual(state.phase, "error", String(state.error));

  const locator = installedProgressLocator(folder, await gameRevision(files));
  const game = lifecycle.getBootedGame();
  assert.equal(game?.progressTarget?.kind, "installed");
  assert.equal(game?.progressTarget?.locator, locator, "the folder's exact bytes own the locator");
  assert.equal(
    game?.progressTarget && "folder" in game.progressTarget && game.progressTarget.folder,
    folder,
    "the exact Unicode and space spelling is preserved",
  );
  assert.equal(game?.historyLifetime, "initial");
  assert.notEqual(game?.historyLifetime, sharedEpoch);
  assert.equal(
    await readHistoryLifetime(shared),
    sharedEpoch,
    "the shared-spelling body keeps its own epoch",
  );
  assert.equal(workers.length, 1);
});

test("an installed boot that cannot bind a physical target keeps no lifetime rather than minting one", async (t) => {
  const files = fixtureFiles();
  serveFixture(t, files);
  const { lifecycle, workers, state } = bootHarness();
  // An empty folder spelling encodes no single physical instance: the
  // binding refuses, and the game still boots and plays unbound.
  state.installedGames = [];
  await lifecycle.bootGame("");
  assert.notEqual(state.phase, "error", String(state.error));
  const game = lifecycle.getBootedGame();
  assert.equal(game?.progressTarget, undefined, "no physical target binds");
  assert.equal(game?.historyLifetime, null, "no fabricated 'initial' epoch");
  assert.equal(workers.length, 1, "the unbound game still boots and plays");
});
