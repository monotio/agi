/**
 * Checkpoint resume runtime — the acknowledgement contract.
 *
 * A resume reports success only after the worker's own `restored` message
 * for the armed intent lands through the real ingress; a refusal, timeout,
 * supersession or cancellation settles the same promise truthfully and
 * leaves the source checkpoint, its raw bytes and both pointer keys exactly
 * as stored. The composed harness is the real link, lifecycle and autosave
 * controller over a recording worker port whose inbound messages run
 * through the real worker dispatch into a live Engine — the restore
 * acknowledgement is the interpreter's own answer, delivered by FIFO.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../../src/runtime/engine.ts";
import { openContainer } from "../../src/container/container.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import type { ProfileId } from "../../src/runtime/profile.ts";
import type { ResourceRevision } from "../../src/gameIdentity.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import { installedProgressTarget, projectProgressTarget } from "../src/project/progressTarget.ts";
import { readEarlierProgress, type EarlierLocalSource } from "../src/project/earlierProgress.ts";
import {
  listEarlierCheckpoints,
  prepareEarlierCheckpoint,
} from "../src/saves/earlierCheckpoint.ts";
import {
  autosaveKey,
  parseAutosaveRecord,
  type AutosaveRecord,
} from "../src/saves/gameProgress.ts";
import { LEGACY_LAST_GAME_KEY, RESUME_POINTER_KEY } from "../src/saves/resumePointer.ts";
import { bytesToBase64 } from "../src/project/bytes.ts";
import {
  useAutosaveController,
  type AutosaveControllerContext,
} from "../src/saves/useAutosaveController.ts";
import { useGameLifecycle } from "../src/engine/useGameLifecycle.ts";
import { useWorkerLink } from "../src/engine/useWorkerLink.ts";
import { markRemoved, markBehindStorage } from "../src/project/projectTransaction.ts";
import type { EngineState, TextHook } from "../src/engine/useEngineTypes.ts";
import {
  clearCachedGame,
  readHistoryLifetime,
  saveAuthoredGame,
  serializeWrite,
} from "../src/project/gameStorage.ts";
import type { BootedGame, InstalledGameDescriptor } from "../src/project/gameTypes.ts";
import { appendHistoryBatch, loadGameHistory } from "../src/history/historyStorage.ts";
import { createWorkerContext, type WorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerInbound, WorkerOutbound } from "../src/worker/workerProtocol.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";

const db = installIndexedDbFixture();
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  },
});

const STUB: LlmConfig = { provider: "stub", apiKey: "", model: "offline-stub" };
const noop = () => {};
const HOST = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function until(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${label}`);
}

interface Rig {
  readonly files: Record<string, Uint8Array>;
  readonly words: Map<string, number>;
  readonly profileId: ProfileId;
  readonly revision: ResourceRevision;
}

/** A detached native Starter build plus the revision its bytes hash to. */
async function starterRig(): Promise<Rig> {
  const starter = createStarterProject("starter");
  const files = Object.fromEntries(starter.files());
  return {
    files,
    words: new Map(starter.sources.words),
    profileId: starter.profileId,
    revision: await gameRevision(files),
  };
}

/** A real Engine checkpoint image: the starter's first resumable room. */
function starterCheckpoint(rig: Rig): { image: Uint8Array; room: number } {
  const engine = new Engine(
    openContainer(new Map(Object.entries(rig.files)), { profile: rig.profileId }),
    HOST,
    rig.words,
    { profile: rig.profileId },
  );
  for (let i = 0; i < 8 && !engine.autosaveImage(); i++) engine.tick();
  const image = engine.autosaveImage();
  assert.ok(image, "the starter draws a resumable room");
  return { image, room: engine.readState().room };
}

function checkpointRecord(
  image: Uint8Array,
  room: number,
  game: AutosaveRecord["game"],
): AutosaveRecord {
  return {
    format: "monotio.agi.autosave",
    version: 1,
    image: bytesToBase64(image),
    cycle: 8,
    room,
    savedAt: 1_757_000_000_000,
    game,
  };
}

/** A recording worker port driving the real worker dispatch and a live Engine. */
class Port {
  readonly posted: WorkerInbound[] = [];
  readonly out: WorkerOutbound[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  terminated = false;
  wctx: WorkerContext | null = null;
  readonly onRestored: (() => void) | undefined;
  constructor(workers: Port[], onRestored?: () => void) {
    this.onRestored = onRestored;
    workers.push(this);
  }
  postMessage(msg: WorkerInbound): void {
    this.posted.push(msg);
    if (this.terminated) return;
    // A real worker: every inbound message dispatches against this port's
    // own live context; its outbound traffic queues for FIFO delivery.
    this.wctx ??= (() => {
      const ctx = createWorkerContext({
        control: (m) => {
          this.out.push(m as WorkerOutbound);
          if (m.type === "restored") this.onRestored?.();
        },
        presentation: (m) => this.out.push(m as WorkerOutbound),
        now: () => 0,
        seedWord: () => 0x1234,
        schedule: (fn: () => void, ms: number) => ({ fn, ms }),
        cancelSchedule: noop,
      });
      ctx.host = createEngineHost(ctx);
      return ctx;
    })();
    onWorkerMessage(this.wctx, msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Deliver queued worker outputs to the link, oldest first. */
  deliver(count?: number): WorkerOutbound[] {
    const batch = count === undefined ? this.out.splice(0) : this.out.splice(0, count);
    for (const msg of batch) this.onmessage?.({ data: msg });
    return batch;
  }
}

/**
 * The real composition: useWorkerLink + useGameLifecycle + the autosave
 * controller over a fetch stub serving container bytes by folder. Nothing
 * about boot, binding, storage or the worker's own messages is mocked —
 * only the transport is a recording port.
 */
async function composed(
  t: { after: (fn: () => void) => void },
  options?: {
    folders?: Map<string, Record<string, Uint8Array>>;
    ackTimeoutMs?: number;
    damageRestoreTransport?: boolean;
    departureGate?: Promise<void>;
    onRestored?: () => void;
  },
) {
  const rig = await starterRig();
  const folder = "checkpoint-resume";
  const served = new Map<string, Record<string, Uint8Array>>([
    [folder, rig.files],
    ...(options?.folders ?? new Map()),
  ]);
  const gates = new Map<string, Promise<void>>();
  /** Park one served file's fetch until released — the boot's await point. */
  const holdFetch = (gateFolder: string, name: string): (() => void) => {
    let release!: () => void;
    gates.set(`${gateFolder}/${name}`, new Promise<void>((r) => (release = r)));
    return release;
  };
  const workers: Port[] = [];
  const oldWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const oldFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: class extends Port {
      constructor() {
        super(workers, options?.onRestored);
      }
      override postMessage(msg: WorkerInbound): void {
        // Explicit wire fault after the main-thread validator accepted a real
        // image. The worker's actual Engine must still reject and retire it.
        super.postMessage(
          options?.damageRestoreTransport === true &&
            msg.type === "boot" &&
            msg.restoreImage !== undefined
            ? { ...msg, restoreImage: "AA==" }
            : msg,
        );
      }
    },
  });
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/")) {
      const name = decodeURIComponent(path.slice("/fixtures/".length, -1));
      const files = served.get(name);
      return files === undefined
        ? new Response(null, { status: 404 })
        : new Response(JSON.stringify(Object.keys(files)));
    }
    const slash = path.lastIndexOf("/");
    const name = decodeURIComponent(path.slice(slash + 1));
    const dir = decodeURIComponent(
      path.slice(path.indexOf("/fixtures/") + "/fixtures/".length, slash),
    );
    const gate = gates.get(`${dir}/${name}`);
    if (gate !== undefined) await gate;
    const bytes = served.get(dir)?.[name];
    return bytes === undefined
      ? new Response(null, { status: 404 })
      : new Response(new Uint8Array(bytes));
  };
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldWorker) Object.defineProperty(globalThis, "Worker", oldWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  });

  const descriptor: InstalledGameDescriptor = {
    folder,
    alias: folder,
    hash: folder,
    title: "Checkpoint Resume",
    profile: rig.profileId,
  };
  const state = {
    phase: "idle",
    error: "",
    loading: null,
    resumed: false,
    installedGames: [descriptor],
    soundMode: "pc-speaker",
    powerUp: {},
    walkthrough: {},
    roomJournal: [],
    debugTrace: [],
    controls: [],
    rows: [],
    genesisStarter: null,
  } as unknown as EngineState;
  const hook = {} as TextHook;
  const audio = {
    stop: noop,
    setMuted: noop,
    setPaused: noop,
    setPauseOwner: noop,
    useGameFiles: noop,
  };
  let session = 0;
  const link = useWorkerLink({
    state,
    hook,
    audio: audio as never,
    onFrame: noop,
    logAgent: noop,
    getBootedGame: () => lifecycle?.getBootedGame() ?? null,
    getActiveWalkthroughSession: () => session,
    observationListeners: new Set(),
  });
  const historyWrites: Promise<boolean>[] = [];
  const retired: { game: BootedGame | null; message: string }[] = [];
  const controller = useAutosaveController({
    state,
    getBootedGame: () => lifecycle?.getBootedGame() ?? null,
    getWorker: link.getWorker,
    logAgent: noop,
    // The real callback's job: the restored position reaches the text hook.
    onAutosaveRestored: (room, egoX, egoY) => {
      hook.room = room;
      hook.egoX = egoX;
      hook.egoY = egoY;
    },
    isInstalledGame: (target) =>
      (state.installedGames ?? []).some(
        (entry) =>
          (typeof entry === "string" ? entry : entry.folder) === target ||
          (typeof entry === "string" ? entry : entry.alias) === target,
      ),
    bootGame: (target, carrier) => lifecycle.bootGame(target, carrier),
    bootInstalledFresh: (selected, admission) => lifecycle.bootInstalledFresh(selected, admission),
    bootAuthoredGame: (template, config, bootOptions) =>
      lifecycle.bootAuthoredGame(template, config, bootOptions),
    configForGame: (_id, config) => config,
    retireFailedRecovery: (game, message) => {
      retired.push({ game, message });
      lifecycle.retireFailedRecovery(game, message);
    },
    ...(options?.ackTimeoutMs !== undefined ? { resumeAckTimeoutMs: options.ackTimeoutMs } : {}),
  });
  const lifecycle = useGameLifecycle({
    state,
    hook,
    audio: audio as never,
    logAgent: noop,
    link,
    autosave: controller,
    authoring: {
      getSession: () => null,
      resetSession: noop,
      setSession: noop,
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
    getSessionId: () => session,
    nextSessionId: () => ++session,
    getActiveReplaySeed: () => null,
    setActiveReplaySeed: noop,
    setActiveLlmConfig: noop,
    getActiveLlmConfig: () => STUB,
    abortWalkthrough: noop,
    drainHistoryCommits: async () => {
      await options?.departureGate;
    },
    stopHistoryWriter: noop,
    devFixtures: true,
  } as unknown as Parameters<typeof useGameLifecycle>[0]);
  Object.assign(link.deps, {
    resetScreenState: lifecycle.resetScreenState,
    cancelPrompt: noop,
    handleAutosave: controller.handleAutosave,
    handleHistoryBatch: (msg: {
      batch: Parameters<typeof appendHistoryBatch>[1];
      profile?: Parameters<typeof appendHistoryBatch>[2];
    }) => {
      const game = lifecycle.getBootedGame();
      assert.ok(game !== null, "a history batch names the booted game");
      const write = appendHistoryBatch(
        game.progressTarget!,
        msg.batch,
        msg.profile,
        game.historyLifetime,
      );
      historyWrites.push(write);
      return write;
    },
    handleFlushed: controller.handleFlushed,
    handleRestored: controller.handleRestored,
    handleRecoveryError: (message: string) => controller.handleRecoveryError(message),
    getReplayDriver: () => null,
    handleDebugEvent: noop,
  });
  t.after(async () => {
    controller.reset();
    link.terminateWorker();
    // The real worker context arms a real interval on boot; release it or
    // the process never drains. Committed-tape appends are asynchronous:
    // they must land before the next test clears the shared store, or the
    // leftover manifests into the next test's reads.
    for (const port of workers) port.wctx?.fns.stopTimers();
    await Promise.allSettled(historyWrites);
  });
  return {
    rig,
    folder,
    descriptor,
    state,
    hook,
    link,
    controller,
    lifecycle,
    workers,
    historyWrites,
    retired,
    holdFetch,
  };
}

function controllerContext(
  over: Partial<AutosaveControllerContext> = {},
): AutosaveControllerContext {
  return {
    state: { resumed: false } as EngineState,
    getBootedGame: () => null,
    getWorker: () => null,
    logAgent: noop,
    isInstalledGame: () => false,
    bootGame: async () => {},
    bootAuthoredGame: async () => {},
    configForGame: (_p, config) => config,
    retireFailedRecovery: noop,
    ...over,
  };
}

test("an unavailable installed destination keeps the checkpoint and both pointers byte-exact", async () => {
  values.clear();
  db.clear();
  const rig = await starterRig();
  const target = installedProgressTarget({ folder: "unavailable-folder" }, rig.revision);
  assert.ok(target);
  const { image, room } = starterCheckpoint(rig);
  const raw =
    JSON.stringify(
      {
        ...checkpointRecord(image, room, { installed: true, identity: target.identity }),
        preservedExtra: "original bytes",
      },
      null,
      2,
    ) + "\n";
  values.set(autosaveKey(target.locator), raw);
  values.set(RESUME_POINTER_KEY, target.locator);
  values.set(LEGACY_LAST_GAME_KEY, "unavailable-folder");
  const otherRaw = '{ "version": 999, "opaque": [1, 2, 3] }\n';
  values.set("monotio_agi.autosave.historical-source", otherRaw);

  const controller = useAutosaveController(controllerContext());
  assert.equal(await controller.resumeLastGame(STUB), false);
  assert.equal(
    values.get(autosaveKey(target.locator)),
    raw,
    "the checkpoint's raw string survives a resume that found nothing",
  );
  assert.equal(values.get(RESUME_POINTER_KEY), target.locator, "the physical pointer stays");
  assert.equal(values.get(LEGACY_LAST_GAME_KEY), "unavailable-folder");
  assert.equal(values.get("monotio_agi.autosave.historical-source"), otherRaw);
});

test("a retired saved epoch keeps the old incarnation's checkpoint and pointer exact", async () => {
  values.clear();
  db.clear();
  const rig = await starterRig();
  const id = requireProjectId("recreated-body");
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Recreated",
      provider: "stub",
      model: "offline-stub",
      files: rig.files,
      words: [],
    }),
    true,
  );
  const epoch = await readHistoryLifetime(id);
  const target = projectProgressTarget(id, rig.revision, epoch!);
  assert.ok(target);
  const { image, room } = starterCheckpoint(rig);
  const raw =
    JSON.stringify(
      {
        ...checkpointRecord(image, room, { installed: false, identity: target.identity }),
        whitespaceField: { nested: true },
      },
      null,
      2,
    ) + "\n";
  values.set(autosaveKey(target.locator), raw);
  values.set(RESUME_POINTER_KEY, target.locator);

  // Deleted and recreated under the same id: the pointer names the removed
  // incarnation's epoch.
  await clearCachedGame(id);
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Recreated",
      provider: "stub",
      model: "offline-stub",
      files: rig.files,
      words: [],
    }),
    true,
  );
  assert.notEqual(await readHistoryLifetime(id), epoch);

  const controller = useAutosaveController(controllerContext());
  assert.equal(await controller.resumeLastGame(STUB), false);
  assert.equal(
    values.get(autosaveKey(target.locator)),
    raw,
    "the removed incarnation's checkpoint stays stored, byte-exact",
  );
  assert.equal(
    values.get(RESUME_POINTER_KEY),
    target.locator,
    "the pointer is never cleared or moved by the attempt",
  );
});

test("a real resume stays pending until the worker's own restored:true, then reports its room", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const target = installedProgressTarget(h.descriptor, h.rig.revision);
  assert.ok(target);
  const { image, room } = starterCheckpoint(h.rig);
  const record = checkpointRecord(image, room, { installed: true, identity: target.identity });
  const raw = JSON.stringify(record);
  values.set(autosaveKey(target.locator), raw);
  values.set(RESUME_POINTER_KEY, target.locator);

  let settled: boolean | null = null;
  const pending = h.controller.resumeFromRecord(record, STUB, target.locator).then((v) => {
    settled = v;
    return v;
  });
  await until(
    () => h.workers.length === 1 && h.workers[0]!.posted.some((m) => m.type === "boot"),
    "the destination worker's boot post",
  );
  const port = h.workers[0]!;
  const boot = port.posted.find((m) => m.type === "boot");
  assert.ok(boot && "restoreImage" in boot && boot.restoreImage === record.image);
  // The boot post alone never certifies success: the promise waits for the
  // interpreter's own restore acknowledgement.
  await tick();
  assert.equal(settled, null, "posting the boot does not settle the resume");
  assert.equal(h.state.phase, "loading");
  assert.equal(h.state.resumed, false);
  assert.equal(
    h.controller.pendingProgressTarget()?.locator,
    target.locator,
    "the captured target is surfaced while the resume is pending",
  );

  const restoredIdx = port.out.findIndex((m) => m.type === "restored");
  assert.ok(restoredIdx >= 0, "the real Engine answered the restore image");
  const restored = port.out[restoredIdx]! as { type: "restored"; ok: boolean; room: number };
  assert.equal(restored.ok, true, "the interpreter accepted its own image");
  assert.equal(restored.room, room, "the engine reports the checkpoint's room");

  port.deliver(restoredIdx + 1);
  assert.equal(await pending, true, "the matching restored:true settles the resume");
  assert.equal(h.state.resumed, true);
  assert.equal(h.hook.room, room, "the restored position reaches the text hook");
  assert.equal(h.retired.length, 0);

  port.deliver();
  assert.equal(h.state.phase, "running", "the boot's own booted message lands after the ack");
  assert.equal(
    values.get(autosaveKey(target.locator)),
    raw,
    "the checkpoint is untouched until a real autosave",
  );

  // A later autosave is separate evidence: the interpreter's own next
  // snapshot replaces the resumed checkpoint under the same physical key.
  assert.equal(port.wctx !== null, true);
  const ctx = port.wctx!;
  for (let i = 0; i < 8 && !ctx.engine!.autosaveImage(); i++) ctx.engine!.tick();
  ctx.cycle.cycleCount = 8;
  assert.equal(ctx.fns.autosave(true), true, "the live worker emits a real autosave");
  port.deliver();
  assert.equal(await h.controller.getAutosaveWrite(), true);
  const stored = parseAutosaveRecord(values.get(autosaveKey(target.locator))!);
  assert.ok(stored !== null);
  assert.notEqual(stored.image, record.image, "the durable checkpoint is the new snapshot");
  ctx.fns.stopTimers();
});

test("a real restored:false retires the worker before queued traffic and preserves everything", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t, { damageRestoreTransport: true });
  const target = installedProgressTarget(h.descriptor, h.rig.revision);
  assert.ok(target);
  const { image, room } = starterCheckpoint(h.rig);
  const record = checkpointRecord(image, room, { installed: true, identity: target.identity });
  const raw = JSON.stringify({ ...record, kept: "as stored" }, null, 2);
  values.set(autosaveKey(target.locator), raw);
  values.set(RESUME_POINTER_KEY, target.locator);

  // Valid input passes preflight; the named transport fault damages only
  // the posted image, so the real worker still owns negative-ACK coverage.
  const pending = h.controller.resumeFromRecord(record, STUB, target.locator);
  await until(
    () => h.workers.length === 1 && h.workers[0]!.out.some((m) => m.type === "restored"),
    "the worker's restore refusal",
  );
  const port = h.workers[0]!;
  const restoredIdx = port.out.findIndex((m) => m.type === "restored");
  const refusal = port.out[restoredIdx]! as { ok: boolean; message: string };
  assert.equal(refusal.ok, false, "the interpreter's own decode rejected the payload");
  assert.ok(
    restoredIdx < port.out.length - 1,
    "the worker queued its normal boot traffic after the refusal",
  );

  // The refusal lands first, as it does on the wire: retirement must happen
  // before the queued booted/history/autosave messages can publish.
  const armed = h.lifecycle.getBootedGame();
  assert.ok(armed !== null, "the failed boot's candidate owns the slot");
  port.deliver(1);
  assert.equal(await pending, false, "a refused restore reports failure, never success");
  assert.equal(port.terminated, true, "the refused worker is retired synchronously");
  assert.equal(h.link.getWorker(), null);
  assert.equal(h.state.phase, "error");
  assert.equal(h.retired.length, 1);
  assert.equal(h.retired[0]!.game, armed, "the armed candidate is what retires");
  assert.equal(
    values.get(autosaveKey(target.locator)),
    raw,
    "the failed recovery keeps the destination checkpoint byte-exact",
  );
  assert.equal(values.get(RESUME_POINTER_KEY), target.locator, "the pointer never moved");

  // Everything the retired worker queued is dead traffic: nothing it said
  // may publish into the slot.
  port.deliver();
  await h.controller.getAutosaveWrite();
  assert.equal(h.state.phase, "error", "a queued booted cannot reopen the slot");
  assert.equal(h.state.resumed, false);
  assert.equal(h.historyWrites.length, 0, "no recovery history is adopted");
  assert.equal(values.get(autosaveKey(target.locator)), raw);
  assert.equal(await loadGameHistory(target.locator), null);

  // And the same retained closure replayed later stays dead.
  port.deliver();
  assert.equal(h.state.phase, "error");

  // The next run owns the slot normally: a fresh boot of the same folder.
  await h.lifecycle.bootGame(h.folder);
  const fresh = h.workers[1]!;
  fresh.deliver();
  await until(() => h.state.phase === "running", "the fresh boot's running phase");
  assert.equal(fresh.terminated, false);
  assert.equal(
    values.get(autosaveKey(target.locator)),
    raw,
    "the fresh boot of the same destination still sees the old checkpoint",
  );
});

test("a superseding boot settles a resume parked in preparation privately", async (t) => {
  values.clear();
  db.clear();
  const otherRig = await starterRig();
  const h = await composed(t, {
    folders: new Map([["superseding-folder", otherRig.files]]),
    ackTimeoutMs: Number.POSITIVE_INFINITY,
  });
  (h.state as { installedGames: InstalledGameDescriptor[] }).installedGames.push({
    folder: "superseding-folder",
    alias: "superseding-folder",
    hash: "superseding-folder",
    title: "Superseding",
  });
  const target = installedProgressTarget(h.descriptor, h.rig.revision);
  assert.ok(target);
  const { image, room } = starterCheckpoint(h.rig);
  const record = checkpointRecord(image, room, { installed: true, identity: target.identity });
  const raw = JSON.stringify(record);
  values.set(autosaveKey(target.locator), raw);
  values.set(RESUME_POINTER_KEY, target.locator);

  const firstName = Object.keys(h.rig.files).sort()[0]!;
  const release = h.holdFetch(h.folder, firstName);
  const pending = h.controller.resumeFromRecord(record, STUB, target.locator);
  // The resume is parked inside its own boot's fetch when the newer flow
  // takes the slot completely.
  await h.lifecycle.bootGame("superseding-folder");
  assert.equal(h.workers.length, 1);
  h.workers[0]!.deliver();
  await until(() => h.state.phase === "running", "the superseding boot's running phase");
  assert.equal(h.lifecycle.getBootedGame()?.folder, "superseding-folder");

  release();
  assert.equal(await pending, false, "the superseded resume settles privately");
  assert.equal(h.workers.length, 1, "the superseded resume's boot dies before spawning a worker");
  assert.equal(h.lifecycle.getBootedGame()?.folder, "superseding-folder");
  assert.equal(values.get(autosaveKey(target.locator)), raw);
  // The pointer moved only because the superseding game genuinely booted —
  // the dead resume moved nothing.
  const supersededLocator = installedProgressTarget(
    { folder: "superseding-folder" },
    h.rig.revision,
  )?.locator;
  assert.equal(values.get(RESUME_POINTER_KEY), supersededLocator);
  assert.equal(h.controller.pendingProgressTarget(), null);
});

test("a posted resume whose acknowledgement never arrives times out truthfully", async (t) => {
  values.clear();
  db.clear();
  let restored!: () => void;
  const posted = new Promise<void>((resolve) => (restored = resolve));
  const h = await composed(t, { ackTimeoutMs: 40, onRestored: restored });
  const target = installedProgressTarget(h.descriptor, h.rig.revision);
  assert.ok(target);
  const { image, room } = starterCheckpoint(h.rig);
  const record = checkpointRecord(image, room, { installed: true, identity: target.identity });
  const raw = JSON.stringify(record);
  values.set(autosaveKey(target.locator), raw);
  values.set(RESUME_POINTER_KEY, target.locator);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = h.controller.resumeFromRecord(record, STUB, target.locator);
  // Native hashing and preparation must post the acknowledgement before the deadline advances.
  await Promise.race([posted, pending.then(() => assert.fail("Resume settled before posting."))]);
  assert.ok(h.workers[0]?.out.some((m) => m.type === "restored"));
  t.mock.timers.tick(40);
  const port = h.workers[0]!;
  // The acknowledgement is produced but deliberately never delivered.
  assert.equal(await pending, false, "the ack timeout settles the resume");
  assert.equal(port.terminated, true, "the unanswered worker is retired");
  assert.equal(h.link.getWorker(), null);
  assert.equal(h.state.phase, "error");
  assert.equal(values.get(autosaveKey(target.locator)), raw);
  assert.equal(values.get(RESUME_POINTER_KEY), target.locator);

  // The late acknowledgement is dead traffic: it cannot land on whatever
  // owns the slot now, and it cannot reopen the retired run.
  port.deliver();
  assert.equal(h.state.phase, "error");
  assert.equal(h.state.resumed, false);
  assert.equal(h.historyWrites.length, 0);
});

test("a saved project's resume arms on the live epoch and reports the engine's restored room", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const id = requireProjectId("saved-resume-target");
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Saved Resume",
      provider: "stub",
      model: "offline-stub",
      files: h.rig.files,
      words: [...h.rig.words.entries()].map(([word, wordId]) => [word, wordId] as [string, number]),
    }),
    true,
  );
  const epoch = await readHistoryLifetime(id);
  const target = projectProgressTarget(id, h.rig.revision, epoch!);
  assert.ok(target);
  const { image, room } = starterCheckpoint(h.rig);
  const record = checkpointRecord(image, room, { installed: false, identity: target.identity });
  const raw = JSON.stringify(record);
  values.set(autosaveKey(target.locator), raw);
  values.set(RESUME_POINTER_KEY, target.locator);

  const pending = h.controller.resumeFromRecord(record, STUB, target.locator);
  await until(
    () => h.workers.length === 1 && h.workers[0]!.out.some((m) => m.type === "restored"),
    "the saved body's restore acknowledgement",
  );
  const port = h.workers[0]!;
  const boot = port.posted.find((m) => m.type === "boot");
  assert.ok(boot && "restoreImage" in boot && boot.restoreImage === record.image);
  port.deliver();
  assert.equal(await pending, true);
  assert.equal(h.state.phase, "running");
  assert.equal(h.hook.room, room);
  assert.equal(h.lifecycle.getBootedGame()?.projectId, id);
  assert.equal(
    values.get(autosaveKey(target.locator)),
    raw,
    "the resumed checkpoint stays until the next real autosave",
  );
});

test("an earlier checkpoint opens into its selected destination and preserves source and old destination bytes", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const rig = h.rig;
  const destId = requireProjectId("earlier-destination");
  assert.equal(
    await saveAuthoredGame(destId, {
      title: "Earlier Destination",
      provider: "stub",
      model: "offline-stub",
      files: rig.files,
      words: [],
    }),
    true,
  );
  const epoch = await readHistoryLifetime(destId);
  const target = projectProgressTarget(destId, rig.revision, epoch!);
  assert.ok(target);

  // The destination's own older checkpoint: it stays byte-exact until the
  // restored destination takes a real autosave of its own.
  const oldRaw = '{ "format": "monotio.agi.autosave", "version": 1, "opaque": "older" }\n';
  values.set(autosaveKey(target.locator), oldRaw);

  const source = "earlier-source";
  const { image, room } = starterCheckpoint(rig);
  const sourceRaw =
    JSON.stringify(
      {
        ...checkpointRecord(image, room, {
          installed: false,
          identity: { project: requireProjectId(source), revision: rig.revision },
        }),
        extraMetadata: { kept: true },
      },
      null,
      2,
    ) + "\n";
  const localSource: EarlierLocalSource = {
    getItem: (key) => values.get(key) ?? null,
    listKeys: () => [...values.keys()],
  };
  values.set(autosaveKey(source), sourceRaw);
  const read = await readEarlierProgress(
    { kind: "live", legacyKey: source },
    { local: localSource },
  );
  const choices = listEarlierCheckpoints(read);
  assert.equal(choices.length, 1);
  const prepared = await prepareEarlierCheckpoint({
    read,
    entryIndex: choices[0]!.index,
    target,
    files: rig.files,
    profile: rig.profileId,
  });

  const outcome = h.controller.resumeEarlierCheckpoint(prepared, STUB);
  await until(
    () => h.workers.length === 1 && h.workers[0]!.out.some((m) => m.type === "restored"),
    "the earlier checkpoint's restore acknowledgement",
  );
  const port = h.workers[0]!;
  const boot = port.posted.find((m) => m.type === "boot");
  assert.ok(
    boot && "restoreImage" in boot && boot.restoreImage === prepared.record.image,
    "the rebound record's image is what the worker restores",
  );
  port.deliver();
  assert.deepEqual(await outcome, { status: "restored" });
  assert.equal(h.state.phase, "running");
  assert.equal(h.hook.room, room, "the restored position reaches the hook");
  assert.equal(h.lifecycle.getBootedGame()?.projectId, destId);

  // Source string and the destination's previous checkpoint: byte-exact.
  assert.equal(values.get(autosaveKey(source)), sourceRaw);
  assert.equal(values.get(autosaveKey(target.locator)), oldRaw);

  // No earlier history is adopted; the destination's own fresh segment is
  // the only tape the locator holds.
  assert.ok(h.historyWrites.length > 0, "the boot recorded its own history batch");
  assert.ok((await Promise.all(h.historyWrites)).every(Boolean));
  const tape = await loadGameHistory(target.locator);
  assert.ok(tape !== null && tape.segments.length > 0, "a new destination segment exists");
  assert.equal(
    await loadGameHistory(`project:${source}:${epoch}`),
    null,
    "no source history adopted",
  );

  // The old destination checkpoint stands until the live engine's own
  // autosave replaces it.
  const ctx = port.wctx!;
  for (let i = 0; i < 8 && !ctx.engine!.autosaveImage(); i++) ctx.engine!.tick();
  ctx.cycle.cycleCount = 8;
  assert.equal(ctx.fns.autosave(true), true);
  port.deliver();
  assert.equal(await h.controller.getAutosaveWrite(), true);
  const stored = parseAutosaveRecord(values.get(autosaveKey(target.locator))!);
  assert.ok(stored !== null, "the real autosave wrote a checkpoint under the destination");
  assert.notEqual(
    values.get(autosaveKey(target.locator)),
    oldRaw,
    "only the live autosave replaced the old checkpoint",
  );
  assert.equal(stored.game.identity.project, destId);
  ctx.fns.stopTimers();
});

test("the earlier-checkpoint service refuses a busy slot and a moved destination before any worker", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const rig = h.rig;
  const destId = requireProjectId("busy-destination");
  assert.equal(
    await saveAuthoredGame(destId, {
      title: "Busy Destination",
      provider: "stub",
      model: "offline-stub",
      files: rig.files,
      words: [],
    }),
    true,
  );
  const epoch = await readHistoryLifetime(destId);
  const target = projectProgressTarget(destId, rig.revision, epoch!);
  assert.ok(target);
  const destRaw = '{ "kept": "destination checkpoint" }\n';
  values.set(autosaveKey(target.locator), destRaw);

  const source = "busy-source";
  const { image, room } = starterCheckpoint(rig);
  const sourceRaw = JSON.stringify(
    checkpointRecord(image, room, {
      installed: false,
      identity: { project: requireProjectId(source), revision: rig.revision },
    }),
  );
  const localSource: EarlierLocalSource = {
    getItem: (key) => values.get(key) ?? null,
    listKeys: () => [...values.keys()],
  };
  values.set(autosaveKey(source), sourceRaw);
  const read = await readEarlierProgress(
    { kind: "live", legacyKey: source },
    { local: localSource },
  );
  const prepared = await prepareEarlierCheckpoint({
    read,
    entryIndex: listEarlierCheckpoints(read)[0]!.index,
    target,
    files: rig.files,
    profile: rig.profileId,
  });

  // A running world occupies the slot: the explicit Earlier adoption is for
  // the idle library only.
  await h.lifecycle.bootGame(h.folder);
  h.workers[0]!.deliver();
  await until(() => h.state.phase === "running", "the running game's phase");
  const outcome = await h.controller.resumeEarlierCheckpoint(prepared, STUB);
  assert.equal(outcome.status, "refused");
  assert.equal(h.workers.length, 1, "no worker spawned for the refused open");
  assert.equal(h.lifecycle.getBootedGame()?.folder, h.folder);

  // Idle again, but the destination body was recreated after the prepare:
  // the ephemeral record is never boot authority — revalidation refuses.
  const ejecting = h.lifecycle.ejectGame();
  // The eject's flush and history queries need the worker's real replies.
  for (let i = 0; i < 60; i++) {
    h.workers[0]!.deliver();
    await tick();
  }
  await ejecting;
  await clearCachedGame(destId);
  assert.equal(
    await saveAuthoredGame(destId, {
      title: "Busy Destination",
      provider: "stub",
      model: "offline-stub",
      files: rig.files,
      words: [],
    }),
    true,
  );
  const workerCount = h.workers.length;
  const second = await h.controller.resumeEarlierCheckpoint(prepared, STUB);
  assert.equal(second.status, "refused");
  assert.equal(h.workers.length, workerCount, "the stale prepared record boots nothing");
  assert.equal(values.get(autosaveKey(target.locator)), destRaw);
  assert.equal(values.get(autosaveKey(source)), sourceRaw);
});

test("changed Earlier preparation is revalidated before a worker is installed", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const id = requireProjectId("preflight-destination");
  assert.equal(
    await saveAuthoredGame(id, { title: "Destination", files: h.rig.files, words: [] }),
    true,
  );
  const epoch = await readHistoryLifetime(id);
  const target = projectProgressTarget(id, h.rig.revision, epoch!);
  assert.ok(target);
  const source = "preflight-source";
  const checkpoint = starterCheckpoint(h.rig);
  const sourceRaw = JSON.stringify(
    checkpointRecord(checkpoint.image, checkpoint.room, {
      installed: false,
      identity: { project: requireProjectId(source), revision: h.rig.revision },
    }),
  );
  values.set(autosaveKey(source), sourceRaw);
  const previous = '{ "previous": true }\n';
  values.set(autosaveKey(target.locator), previous);
  const read = await readEarlierProgress(
    { kind: "live", legacyKey: source },
    {
      local: { getItem: (key) => values.get(key) ?? null, listKeys: () => [...values.keys()] },
    },
  );
  const prepared = await prepareEarlierCheckpoint({
    read,
    entryIndex: listEarlierCheckpoints(read)[0]!.index,
    target,
    files: h.rig.files,
    profile: h.rig.profileId,
  });
  let outcome: Awaited<ReturnType<typeof h.controller.resumeEarlierCheckpoint>> | null = null;
  const pending = h.controller
    .resumeEarlierCheckpoint({ ...prepared, record: { ...prepared.record, image: "AA==" } }, STUB)
    .then((value) => {
      outcome = value;
      return value;
    });
  await until(() => outcome !== null || h.workers.length > 0, "preflight refusal or worker post");
  assert.equal(
    h.workers.length,
    0,
    "ordinary preparation data must be revalidated before installation",
  );
  assert.notEqual((await pending).status, "restored");
  assert.equal(values.get(autosaveKey(source)), sourceRaw);
  assert.equal(values.get(autosaveKey(target.locator)), previous);
});

test("a saved body recreated during native hashing refuses before installation", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const id = requireProjectId("hash-race-destination");
  const body = {
    title: "Hash race",
    files: h.rig.files,
    words: [],
    library: {
      version: 1 as const,
      revision: h.rig.revision,
      source: "authored" as const,
      profile: h.rig.profileId,
      validation: { status: "unverified" as const, message: "Ready to check." },
    },
  };
  assert.equal(await saveAuthoredGame(id, body), true);
  const epoch = await readHistoryLifetime(id);
  const target = projectProgressTarget(id, h.rig.revision, epoch!);
  assert.ok(target);
  const checkpoint = starterCheckpoint(h.rig);
  const record = checkpointRecord(checkpoint.image, checkpoint.room, {
    installed: false,
    identity: target.identity,
  });
  const raw = JSON.stringify(record);
  values.set(autosaveKey(target.locator), raw);
  values.set(RESUME_POINTER_KEY, target.locator);
  const { resourceRevisionBytes } = await import("../../src/authoring/resourceRevision.ts");
  const fullLength = resourceRevisionBytes(h.rig.files).byteLength;
  const subtle = globalThis.crypto.subtle;
  const previous = Object.getOwnPropertyDescriptor(subtle, "digest");
  const original = subtle.digest.bind(subtle);
  let hashing = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.defineProperty(subtle, "digest", {
    configurable: true,
    value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      if (!hashing && data.byteLength === fullLength) {
        hashing = true;
        await gate;
      }
      return original(algorithm, data);
    },
  });
  t.after(() => {
    release();
    if (previous) Object.defineProperty(subtle, "digest", previous);
    else Reflect.deleteProperty(subtle, "digest");
  });
  let outcome: boolean | null = null;
  const pending = h.controller.resumeFromRecord(record, STUB, target.locator).then((value) => {
    outcome = value;
    return value;
  });
  await until(() => hashing, "the actual full native hash await");
  await clearCachedGame(id);
  assert.equal(await saveAuthoredGame(id, body), true);
  assert.notEqual(await readHistoryLifetime(id), epoch);
  release();
  await until(() => outcome !== null || h.workers.length > 0, "epoch refusal or worker post");
  assert.equal(h.workers.length, 0, "retired body must not install a worker after hashing");
  assert.equal(await pending, false);
  assert.equal(values.get(autosaveKey(target.locator)), raw);
  assert.equal(values.get(RESUME_POINTER_KEY), target.locator);
});

test("same-destination ordinary boot cannot consume a different resume carrier", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const checkpoint = starterCheckpoint(h.rig);
  const target = installedProgressTarget({ folder: h.folder }, h.rig.revision)!;
  const record = checkpointRecord(checkpoint.image, checkpoint.room, {
    installed: true,
    identity: target.identity,
  });
  const fetcher = globalThis.fetch;
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  globalThis.fetch = async (...args) => {
    if (!entered) {
      entered = true;
      await gate;
    }
    return fetcher(...args);
  };
  t.after(release);
  const resume = h.controller.resumeFromRecord(record, STUB, target.locator);
  await until(() => entered, "original carrier fetch");
  await h.lifecycle.bootGame(h.folder);
  const posts = h.workers.flatMap((w) => w.posted).filter((m) => m.type === "boot");
  release();
  for (const w of h.workers) w.deliver();
  await resume;
  assert.equal(posts.length, 1);
  assert.equal(
    "restoreImage" in posts[0]!,
    false,
    "ordinary superseding boot must not steal the old intent",
  );
});

test("reset aborts the original held resume carrier before worker installation", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const checkpoint = starterCheckpoint(h.rig);
  const target = installedProgressTarget({ folder: h.folder }, h.rig.revision)!;
  const record = checkpointRecord(checkpoint.image, checkpoint.room, {
    installed: true,
    identity: target.identity,
  });
  const release = h.holdFetch(h.folder, "WORDS.TOK");
  t.after(release);
  const pending = h.controller.resumeFromRecord(record, STUB, target.locator);
  await tick();
  h.controller.reset();
  release();
  assert.equal(await pending, false);
  assert.equal(h.workers.length, 0, "reset must not turn a cancelled resume into fresh boot");
});

test("a damaged ordinary image is refused before a worker exists", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const target = installedProgressTarget(h.descriptor, h.rig.revision)!;
  const checkpoint = starterCheckpoint(h.rig);
  const record = checkpointRecord(checkpoint.image, checkpoint.room, {
    installed: true,
    identity: target.identity,
  });
  const raw = JSON.stringify(record);
  values.set(autosaveKey(target.locator), raw);
  values.set(RESUME_POINTER_KEY, target.locator);
  assert.equal(
    await h.controller.resumeFromRecord({ ...record, image: "AA==" }, STUB, target.locator),
    false,
  );
  assert.equal(h.workers.length, 0);
  assert.equal(h.retired.length, 0);
  assert.equal(values.get(autosaveKey(target.locator)), raw);
  assert.equal(values.get(RESUME_POINTER_KEY), target.locator);
});

for (const action of ["reset", "timeout"] as const) {
  test(`${action} settles recovery while its original preparation remains held`, async (t) => {
    values.clear();
    db.clear();
    const h = await composed(t, {
      ackTimeoutMs: action === "timeout" ? 20 : Number.POSITIVE_INFINITY,
    });
    const target = installedProgressTarget(h.descriptor, h.rig.revision)!;
    const checkpoint = starterCheckpoint(h.rig);
    const record = checkpointRecord(checkpoint.image, checkpoint.room, {
      installed: true,
      identity: target.identity,
    });
    const raw = JSON.stringify(record);
    values.set(autosaveKey(target.locator), raw);
    values.set(RESUME_POINTER_KEY, target.locator);
    const release = h.holdFetch(h.folder, "WORDS.TOK");
    t.after(release);
    let outcome: boolean | null = null;
    const operation = h.controller.resumeFromRecord(record, STUB, target.locator).then((value) => {
      outcome = value;
      return value;
    });
    await tick();
    if (action === "reset") h.controller.reset();
    await until(() => outcome !== null, "public outcome while its carrier is still held");
    assert.equal(outcome, false);
    assert.equal(h.workers.length, 0);
    assert.equal(values.get(autosaveKey(target.locator)), raw);
    assert.equal(values.get(RESUME_POINTER_KEY), target.locator);
    release();
    await operation;
    await tick();
    await tick();
    assert.equal(h.workers.length, 0, "late preparation keeps its cancellation tombstone");
  });
}

test("reset after checked admission still vetoes synchronous installation", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const target = installedProgressTarget(h.descriptor, h.rig.revision)!;
  const checkpoint = starterCheckpoint(h.rig);
  const record = checkpointRecord(checkpoint.image, checkpoint.room, {
    installed: true,
    identity: target.identity,
  });
  const admission = h.controller.takeResumeState;
  h.controller.takeResumeState = async (...args) => {
    const result = await admission(...args);
    if (result.status === "restore") h.controller.reset();
    return result;
  };
  assert.equal(await h.controller.resumeFromRecord(record, STUB, target.locator), false);
  assert.equal(h.workers.length, 0, "a final validation answer is not a grant after reset");
});

for (const action of ["reset", "ordinary boot", "replacement resume"] as const) {
  test(`posted recovery cancellation retires queued traffic before ${action}`, async (t) => {
    values.clear();
    db.clear();
    const h = await composed(t, { ackTimeoutMs: Number.POSITIVE_INFINITY });
    const target = installedProgressTarget(h.descriptor, h.rig.revision)!;
    const checkpoint = starterCheckpoint(h.rig);
    const record = checkpointRecord(checkpoint.image, checkpoint.room, {
      installed: true,
      identity: target.identity,
    });
    const raw = JSON.stringify(record);
    values.set(autosaveKey(target.locator), raw);
    values.set(RESUME_POINTER_KEY, "previous-owned-pointer");
    const pending = h.controller.resumeFromRecord(record, STUB, target.locator);
    await until(
      () => h.workers.length === 1 && h.workers[0]!.out.some((m) => m.type === "booted"),
      "posted recovery with real queued acknowledgement and boot",
    );
    const old = h.workers[0]!;
    const release = h.holdFetch(h.folder, "WORDS.TOK");
    t.after(release);
    let replacement: Promise<unknown> | undefined;
    if (action === "reset") h.controller.reset();
    else if (action === "ordinary boot") replacement = h.lifecycle.bootGame(h.folder);
    else replacement = h.controller.resumeFromRecord(record, STUB, target.locator);
    assert.equal(await pending, false, "the canceled recovery settles before replacement fetch");
    assert.equal(old.terminated, true, "cancellation synchronously retires its admitted worker");
    assert.equal(h.link.getWorker(), null);
    const phase = h.state.phase;
    old.deliver();
    await h.controller.getAutosaveWrite();
    assert.equal(h.state.phase, phase, "old queued booted cannot publish a replacement phase");
    assert.equal(h.state.resumed, false);
    assert.equal(h.historyWrites.length, 0);
    assert.equal(values.get(RESUME_POINTER_KEY), "previous-owned-pointer");
    assert.equal(values.get(autosaveKey(target.locator)), raw);
    if (replacement !== undefined) {
      release();
      await until(() => h.workers.length === 2, "replacement's own worker");
      h.workers[1]!.deliver();
      await replacement;
      await until(() => h.state.phase === "running", "replacement's genuine boot");
      assert.equal(values.get(RESUME_POINTER_KEY), target.locator);
    }
  });
}

test("reset after a genuine acknowledgement keeps the playable worker", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const target = installedProgressTarget(h.descriptor, h.rig.revision)!;
  const checkpoint = starterCheckpoint(h.rig);
  const record = checkpointRecord(checkpoint.image, checkpoint.room, {
    installed: true,
    identity: target.identity,
  });
  const pending = h.controller.resumeFromRecord(record, STUB, target.locator);
  await until(() => h.workers.length === 1, "the recovery worker");
  const port = h.workers[0]!;
  port.deliver();
  h.controller.reset();
  assert.equal(await pending, true, "a real acknowledged restore remains successful");
  assert.equal(port.terminated, false, "screen reset keeps the acknowledged playable world");
  assert.equal(h.link.getWorker(), port);
  assert.equal(h.state.phase, "running");
});

/** Hold the real per-body queue before the resume's atomic binding read. */
function holdSavedRead(t: { after: (fn: () => void) => void }, project: string) {
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  void serializeWrite(project, async () => {
    entered = true;
    await gate;
  });
  t.after(release);
  return { entered: () => entered, release };
}

async function savedCheckpoint(h: Awaited<ReturnType<typeof composed>>, name: string) {
  const id = requireProjectId(name);
  assert.equal(
    await saveAuthoredGame(id, {
      title: "Saved checkpoint",
      files: h.rig.files,
      words: [...h.rig.words.entries()],
    }),
    true,
  );
  const epoch = await readHistoryLifetime(id);
  const target = projectProgressTarget(id, h.rig.revision, epoch!);
  assert.ok(target);
  const image = starterCheckpoint(h.rig);
  const record = checkpointRecord(image.image, image.room, {
    installed: false,
    identity: target.identity,
  });
  const raw = JSON.stringify(record);
  values.set(autosaveKey(target.locator), raw);
  values.set(RESUME_POINTER_KEY, target.locator);
  values.set(LEGACY_LAST_GAME_KEY, "previous legacy selection");
  return { target, record, raw };
}

for (const entry of ["record", "last"] as const) {
  test(`reset during pre-intent body read prevents ${entry} resume from installing`, async (t) => {
    values.clear();
    db.clear();
    const h = await composed(t);
    const saved = await savedCheckpoint(h, `pre-intent-${entry}`);
    const gate = holdSavedRead(t, saved.target.project);
    await until(gate.entered, "held body queue");
    let outcome: boolean | null = null;
    const pending = (
      entry === "record"
        ? h.controller.resumeFromRecord(saved.record, STUB, saved.target.locator)
        : h.controller.resumeLastGame(STUB)
    ).then((answer) => {
      outcome = answer;
      return answer;
    });
    await tick(); // The real atomic body binding is queued behind the held turn.
    assert.equal(h.controller.pendingProgressTarget(), null, "binding has not armed an intent");
    h.controller.reset();
    gate.release();
    await until(
      () => outcome !== null || h.workers.length > 0,
      "cancelled binding or unauthorized install",
    );
    assert.equal(h.workers.length, 0, "pre-intent reset must veto worker/session installation");
    assert.equal(await pending, false);
    assert.equal(values.get(autosaveKey(saved.target.locator)), saved.raw);
    assert.equal(values.get(RESUME_POINTER_KEY), saved.target.locator);
    assert.equal(values.get(LEGACY_LAST_GAME_KEY), "previous legacy selection");
  });
}

test("a newer acknowledged resume defeats an older pre-intent binding", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const saved = await savedCheckpoint(h, "pre-intent-newer");
  const gate = holdSavedRead(t, saved.target.project);
  await until(gate.entered, "held body queue");
  let oldOutcome: boolean | null = null;
  const old = h.controller
    .resumeFromRecord(saved.record, STUB, saved.target.locator)
    .then((answer) => {
      oldOutcome = answer;
      return answer;
    });
  await tick();
  assert.equal(h.controller.pendingProgressTarget(), null);
  const latestTarget = installedProgressTarget(h.descriptor, h.rig.revision)!;
  const latestRecord = {
    ...saved.record,
    game: { installed: true, identity: latestTarget.identity },
  };
  const latest = h.controller.resumeFromRecord(latestRecord, STUB, latestTarget.locator);
  await until(
    () => h.workers.length === 1 && h.workers[0]!.out.some((msg) => msg.type === "restored"),
    "newer's real restore",
  );
  const winner = h.workers[0]!;
  winner.deliver();
  assert.equal(await latest, true, "real positive restoration acknowledged");
  const booted = h.lifecycle.getBootedGame();
  gate.release();
  await until(() => oldOutcome !== null || h.workers.length > 1, "older binding settlement");
  assert.equal(
    h.workers.length,
    1,
    "older pre-intent completion cannot replace the acknowledged worker",
  );
  assert.equal(await old, false);
  assert.equal(winner.terminated, false);
  assert.equal(h.lifecycle.getBootedGame(), booted);
});

test("eject invalidates held recovery before its history await", async (t) => {
  values.clear();
  db.clear();
  let releaseDeparture!: () => void;
  const departureGate = new Promise<void>((resolve) => {
    releaseDeparture = resolve;
  });
  t.after(() => releaseDeparture());
  const h = await composed(t, { departureGate });
  const target = installedProgressTarget(h.descriptor, h.rig.revision)!;
  const checkpoint = starterCheckpoint(h.rig);
  const record = checkpointRecord(checkpoint.image, checkpoint.room, {
    installed: true,
    identity: target.identity,
  });
  const raw = JSON.stringify(record);
  values.set(autosaveKey(target.locator), raw);
  values.set(RESUME_POINTER_KEY, target.locator);
  const release = h.holdFetch(h.folder, "WORDS.TOK");
  t.after(release);
  let outcome: boolean | null = null;
  const pending = h.controller.resumeFromRecord(record, STUB, target.locator).then((answer) => {
    outcome = answer;
    return answer;
  });
  const leaving = h.lifecycle.ejectGame({ abandonUnsaved: true, abandonHistory: true });
  release();
  await until(
    () => outcome !== null || h.workers.length > 0,
    "recovery cancellation during departure",
  );
  assert.equal(
    h.workers.length,
    0,
    "departure must veto the prepared recovery while history waits",
  );
  assert.equal(await pending, false);
  releaseDeparture();
  await leaving;
  assert.equal(values.get(autosaveKey(target.locator)), raw);
  assert.equal(values.get(RESUME_POINTER_KEY), target.locator);
});

test("recovery worker error retires before queued restore and boot publications", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const target = installedProgressTarget(h.descriptor, h.rig.revision)!;
  const checkpoint = starterCheckpoint(h.rig);
  const record = checkpointRecord(checkpoint.image, checkpoint.room, {
    installed: true,
    identity: target.identity,
  });
  const raw = JSON.stringify(record);
  values.set(autosaveKey(target.locator), raw);
  values.set(RESUME_POINTER_KEY, target.locator);
  values.set(LEGACY_LAST_GAME_KEY, "earlier legacy pointer");
  const pending = h.controller.resumeFromRecord(record, STUB, target.locator);
  await until(
    () => h.workers.length === 1 && h.workers[0]!.out.some((msg) => msg.type === "restored"),
    "real recovery post",
  );
  const worker = h.workers[0]!;
  // An explicit worker transport failure precedes its already queued native ACK.
  worker.out.unshift({ type: "error", message: "Recovery worker stopped." });
  worker.deliver();
  assert.equal(await pending, false, "an error cannot be followed by a successful recovery ACK");
  assert.equal(worker.terminated, true);
  assert.equal(h.lifecycle.getBootedGame(), null);
  assert.equal(h.state.phase, "error");
  assert.equal(h.state.resumed, false);
  assert.equal(h.historyWrites.length, 0);
  assert.equal(values.get(autosaveKey(target.locator)), raw);
  assert.equal(values.get(RESUME_POINTER_KEY), target.locator);
  assert.equal(values.get(LEGACY_LAST_GAME_KEY), "earlier legacy pointer");
});

for (const moved of ["removed", "behind"] as const) {
  test(`known ${moved} recovery retires before queued acknowledgement`, async (t) => {
    values.clear();
    db.clear();
    const h = await composed(t);
    const target = installedProgressTarget(h.descriptor, h.rig.revision)!;
    const checkpoint = starterCheckpoint(h.rig);
    const record = checkpointRecord(checkpoint.image, checkpoint.room, {
      installed: true,
      identity: target.identity,
    });
    const raw = JSON.stringify(record);
    values.set(autosaveKey(target.locator), raw);
    values.set(RESUME_POINTER_KEY, target.locator);
    values.set(LEGACY_LAST_GAME_KEY, "previous pointer");
    const pending = h.controller.resumeFromRecord(record, STUB, target.locator);
    await until(
      () => h.workers.length === 1 && h.workers[0]!.out.some((msg) => msg.type === "restored"),
      "actual armed recovery",
    );
    const game = h.lifecycle.getBootedGame();
    assert.ok(game);
    if (moved === "removed") markRemoved(game);
    else markBehindStorage(game);
    h.workers[0]!.deliver();
    assert.equal(
      await pending,
      false,
      "known invalid ownership cannot acknowledge successful recovery",
    );
    assert.equal(h.workers[0]!.terminated, true);
    assert.equal(h.lifecycle.getBootedGame(), null);
    assert.equal(h.state.resumed, false);
    assert.equal(h.historyWrites.length, 0);
    assert.equal(values.get(autosaveKey(target.locator)), raw);
    assert.equal(values.get(RESUME_POINTER_KEY), target.locator);
    assert.equal(values.get(LEGACY_LAST_GAME_KEY), "previous pointer");
  });
}

async function preparedSavedCheckpoint(h: Awaited<ReturnType<typeof composed>>, name: string) {
  const saved = await savedCheckpoint(h, name);
  const source = `${name}-source`;
  const raw = JSON.stringify({
    ...saved.record,
    game: {
      installed: false,
      identity: { project: requireProjectId(source), revision: h.rig.revision },
    },
  });
  values.set(autosaveKey(source), raw);
  const read = await readEarlierProgress(
    { kind: "live", legacyKey: source },
    {
      local: { getItem: (key) => values.get(key) ?? null, listKeys: () => [...values.keys()] },
    },
  );
  const prepared = await prepareEarlierCheckpoint({
    read,
    entryIndex: listEarlierCheckpoints(read)[0]!.index,
    target: saved.target,
    files: h.rig.files,
    profile: h.rig.profileId,
  });
  return { ...saved, prepared, source, sourceRaw: raw };
}

test("Earlier storage preparation failure has a truthful failed outcome", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const saved = await preparedSavedCheckpoint(h, "earlier-storage-failure");
  const original = db.get;
  db.get = function (key) {
    if (key === saved.target.project) throw new Error("Body store unavailable");
    return original.call(this, key);
  };
  t.after(() => {
    db.get = original;
  });
  const outcome = await h.controller.resumeEarlierCheckpoint(saved.prepared, STUB);
  assert.equal(
    outcome.status,
    "failed",
    "an actual storage failure is not supersession or moved evidence",
  );
  assert.equal(h.workers.length, 0);
  assert.equal(values.get(autosaveKey(saved.target.locator)), saved.raw);
  assert.equal(values.get(autosaveKey(saved.source)), saved.sourceRaw);
  assert.equal(values.get(RESUME_POINTER_KEY), saved.target.locator);
});

test("Earlier refuses a departing idle surface before worker installation", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const saved = await preparedSavedCheckpoint(h, "earlier-departing");
  h.state.leaving = true;
  let outcome: Awaited<ReturnType<typeof h.controller.resumeEarlierCheckpoint>> | null = null;
  const pending = h.controller.resumeEarlierCheckpoint(saved.prepared, STUB).then((answer) => {
    outcome = answer;
    return answer;
  });
  await until(() => outcome !== null || h.workers.length > 0, "idle-departure refusal");
  assert.equal(h.workers.length, 0, "a departing surface cannot admit Earlier recovery");
  assert.equal((await pending).status, "refused");
  assert.equal(values.get(autosaveKey(saved.source)), saved.sourceRaw);
  assert.equal(values.get(autosaveKey(saved.target.locator)), saved.raw);
});

function holdOpeningHash(t: { after: (fn: () => void) => void }) {
  const subtle = globalThis.crypto.subtle;
  const previous = Object.getOwnPropertyDescriptor(subtle, "digest");
  const original = subtle.digest.bind(subtle);
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.defineProperty(subtle, "digest", {
    configurable: true,
    value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      if (!entered && data.byteLength > 256) {
        entered = true;
        await gate;
      }
      return original(algorithm, data);
    },
  });
  t.after(() => {
    release();
    if (previous) Object.defineProperty(subtle, "digest", previous);
    else Reflect.deleteProperty(subtle, "digest");
  });
  return { entered: () => entered, release };
}

for (const change of ["note", "epoch"] as const) {
  test(`qualified saved opening retains ${change} authority through native preparation`, async (t) => {
    values.clear();
    db.clear();
    const h = await composed(t);
    const saved = await savedCheckpoint(h, `qualified-${change}`);
    const gate = holdOpeningHash(t);
    let current = true;
    const pending = h.lifecycle.bootAuthoredGame("", STUB, {
      projectId: saved.target.project,
      useCached: true,
      opening: { target: saved.target, isCurrent: () => current },
    });
    await until(gate.entered, "qualified native candidate hash");
    if (change === "note") current = false;
    else {
      await clearCachedGame(saved.target.project);
      assert.equal(
        await saveAuthoredGame(saved.target.project, {
          title: "Recreated identical game",
          files: h.rig.files,
          words: [...h.rig.words.entries()],
        }),
        true,
      );
      assert.notEqual(await readHistoryLifetime(saved.target.project), saved.target.bodyEpoch);
    }
    gate.release();
    await pending;
    assert.equal(
      h.workers.length,
      0,
      "withdrawn/replaced qualified intent must not install worker/session/config",
    );
    assert.equal(h.lifecycle.getBootedGame(), null);
    assert.equal(values.get(autosaveKey(saved.target.locator)), saved.raw);
    assert.equal(values.get(RESUME_POINTER_KEY), saved.target.locator);
    assert.equal(values.get(LEGACY_LAST_GAME_KEY), "previous legacy selection");
  });
}

test("qualified installed opening proves served native bytes instead of the descriptor", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const target = installedProgressTarget(h.descriptor, h.rig.revision)!;
  h.state.installedGames = [{ ...h.descriptor, revision: h.rig.revision }];
  const revised = openContainer(new Map(Object.entries(h.rig.files)), { profile: h.rig.profileId });
  revised.putResource("picture", 1, new Uint8Array([0xf0, 4, 0xf8, 0, 0, 0xff]));
  Object.assign(h.rig.files, Object.fromEntries(revised.files));
  assert.notEqual(await gameRevision(h.rig.files), target.identity.revision);
  values.set(RESUME_POINTER_KEY, "preserve previous target");
  await h.lifecycle.bootGame(h.folder, undefined, { target, isCurrent: () => true });
  assert.equal(h.workers.length, 0, "a stale descriptor cannot authorize changed served bytes");
  assert.equal(h.lifecycle.getBootedGame(), null);
  assert.equal(values.get(RESUME_POINTER_KEY), "preserve previous target");
});

test("a withdrawn resume action stays withdrawn through native candidate hashing", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const saved = await savedCheckpoint(h, "resume-note-withdrawal");
  const gate = holdOpeningHash(t);
  let current = true;
  let outcome: boolean | null = null;
  const pending = h.controller
    .resumeFromRecord(saved.record, STUB, saved.target.locator, () => current)
    .then((answer) => {
      outcome = answer;
      return answer;
    });
  await until(gate.entered, "resume candidate hash");
  current = false;
  gate.release();
  await until(() => outcome !== null || h.workers.length > 0, "withdrawn resume settlement");
  assert.equal(h.workers.length, 0, "the original action predicate survives the runtime handoff");
  assert.equal(await pending, false);
  assert.equal(values.get(autosaveKey(saved.target.locator)), saved.raw);
  assert.equal(values.get(RESUME_POINTER_KEY), saved.target.locator);
});

test("qualified unchanged saved opening installs its real native game", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const saved = await savedCheckpoint(h, "qualified-positive");
  await h.lifecycle.bootAuthoredGame("", STUB, {
    projectId: saved.target.project,
    useCached: true,
    opening: { target: saved.target, isCurrent: () => true },
  });
  assert.equal(h.workers.length, 1);
  const worker = h.workers[0]!;
  worker.deliver();
  assert.equal(h.state.phase, "running");
  assert.equal(h.lifecycle.getBootedGame()?.progressTarget?.locator, saved.target.locator);
  const engine = worker.wctx?.engine;
  assert.ok(engine, "qualified boot created a real Engine");
  // This recording port parks cycle scheduling; drive the real opening pass.
  for (let i = 0; i < 8 && engine.readState().room === 0; i++) engine.tick();
  assert.equal(engine.readState().room, 1);
  assert.equal(values.get(autosaveKey(saved.target.locator)), saved.raw);
});

test("Earlier installed fetch error reports failed rather than superseded", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const target = installedProgressTarget(h.descriptor, h.rig.revision)!;
  const image = starterCheckpoint(h.rig);
  const source = "peer-earlier-fetch-failure";
  const record = checkpointRecord(image.image, image.room, {
    installed: false,
    identity: { project: requireProjectId(source), revision: h.rig.revision },
  });
  const raw = JSON.stringify(record);
  values.set(autosaveKey(source), raw);
  const read = await readEarlierProgress(
    { kind: "live", legacyKey: source },
    {
      local: { getItem: (key) => values.get(key) ?? null, listKeys: () => [...values.keys()] },
    },
  );
  const prepared = await prepareEarlierCheckpoint({
    read,
    entryIndex: listEarlierCheckpoints(read)[0]!.index,
    target,
    files: h.rig.files,
    profile: h.rig.profileId,
  });
  values.set(RESUME_POINTER_KEY, "unchanged-pointer");
  globalThis.fetch = async () => {
    throw new Error("Actual fixture transport unavailable");
  };
  const outcome = await h.controller.resumeEarlierCheckpoint(prepared, STUB);
  assert.equal(h.workers.length, 0);
  assert.match(h.state.error, /Actual fixture transport unavailable/);
  assert.equal(values.get(autosaveKey(source)), raw);
  assert.equal(values.get(RESUME_POINTER_KEY), "unchanged-pointer");
  assert.equal(
    outcome.status,
    "failed",
    "a boot's actual transport error must not become supersession",
  );
});

test("qualified installed opening declines changed live descriptor interpreter", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const target = installedProgressTarget(h.descriptor, h.rig.revision)!;
  h.state.installedGames = [{ ...h.descriptor, revision: h.rig.revision }];
  values.set(RESUME_POINTER_KEY, "unchanged-pointer");
  const gate = holdOpeningHash(t);
  const pending = h.lifecycle.bootGame(h.folder, undefined, { target, isCurrent: () => true });
  await until(gate.entered, "native candidate hash");
  assert.equal(h.descriptor.profile, "2.936");
  h.state.installedGames = [{ ...h.descriptor, revision: h.rig.revision, profile: "2.917" }];
  gate.release();
  await pending;
  assert.equal(
    h.workers.length,
    0,
    "a qualified candidate prepared under the retired interpreter must refuse",
  );
  assert.equal(values.get(RESUME_POINTER_KEY), "unchanged-pointer");
});

test("Earlier cached lifecycle read failure preserves a truthful failed outcome", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const saved = await preparedSavedCheckpoint(h, "earlier-lifecycle-read-failure");
  const original = db.get;
  let reads = 0;
  db.get = function (key) {
    if (key === saved.target.project && ++reads === 2)
      throw new Error("Cached opening body read unavailable");
    return original.call(this, key);
  };
  t.after(() => {
    db.get = original;
  });
  const outcome = await h.controller.resumeEarlierCheckpoint(saved.prepared, STUB);
  assert.equal(reads, 2, "preliminary read passed and the lifecycle read failed");
  assert.match(h.state.error, /Cached opening body read unavailable/);
  assert.equal(h.workers.length, 0);
  assert.equal(values.get(autosaveKey(saved.source)), saved.sourceRaw);
  assert.equal(values.get(autosaveKey(saved.target.locator)), saved.raw);
  assert.equal(values.get(RESUME_POINTER_KEY), saved.target.locator);
  assert.equal(outcome.status, "failed", "ordinary cached preparation error is not supersession");
  if (outcome.status === "failed")
    assert.match(outcome.message, /Cached opening body read unavailable/);
});

test("qualified installed opening declines removal of the live interpreter override", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const target = installedProgressTarget(h.descriptor, h.rig.revision)!;
  h.state.installedGames = [{ ...h.descriptor, revision: h.rig.revision, profile: "2.917" }];
  values.set(RESUME_POINTER_KEY, "unchanged-pointer");
  const gate = holdOpeningHash(t);
  const pending = h.lifecycle.bootGame(h.folder, undefined, { target, isCurrent: () => true });
  await until(gate.entered, "native candidate with interpreter override");
  const { profile: _retiredProfile, ...automatic } = h.descriptor;
  h.state.installedGames = [{ ...automatic, revision: h.rig.revision }];
  gate.release();
  await pending;
  assert.equal(h.workers.length, 0, "automatic detection cannot inherit a removed override");
  assert.equal(values.get(RESUME_POINTER_KEY), "unchanged-pointer");
});

test("qualified unchanged installed opening installs its real native game", async (t) => {
  values.clear();
  db.clear();
  const h = await composed(t);
  const target = installedProgressTarget(h.descriptor, h.rig.revision)!;
  h.state.installedGames = [{ ...h.descriptor, revision: h.rig.revision }];
  await h.lifecycle.bootGame(h.folder, undefined, { target, isCurrent: () => true });
  assert.equal(h.workers.length, 1);
  const worker = h.workers[0]!;
  worker.deliver();
  assert.equal(h.state.phase, "running");
  assert.equal(h.lifecycle.getBootedGame()?.progressTarget?.locator, target.locator);
  assert.equal(worker.posted.find((m) => m.type === "boot")?.profile, h.rig.profileId);
});
