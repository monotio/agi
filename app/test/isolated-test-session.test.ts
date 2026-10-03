import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerContext, type WorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { createDebugController } from "../src/worker/debugController.ts";
import { installDebugController } from "../src/worker/debugLoader.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerInbound, WorkerOutbound } from "../src/worker/workerProtocol.ts";
import { createContainer } from "../../src/container/container.ts";
import { compileProjectLogic } from "../../src/authoring/projectLogic.ts";
import { captureProjectBuild } from "../../src/authoring/projectBuild.ts";
import { PROFILES, type AgiProfile } from "../../src/runtime/profile.ts";
import {
  createTestSession,
  TestRuntimeError,
  type IsolatedTestGame,
  type TestRun,
  type TestSession,
  type TestSessionEvent,
  type TestStartOptions,
  type TestStop,
  type TestWorkerLike,
} from "../src/studio/logic/debug/testSession.ts";
import type {
  TestDescriptionRequest,
  TestStringRequest,
} from "../src/studio/logic/debug/testHost.ts";

/**
 * The Studio-side isolated Test session: a real browser worker running the
 * production engine under the frozen-test admission policy, an ephemeral
 * save store and an injected live-game pause lease. Driven here on the real
 * dispatch with a fake port worker — the same code path engine.worker.ts
 * serves in the browser.
 */

const PROFILE = "2.411";
const profile: AgiProfile = PROFILES[PROFILE];

/** A worker the session drives: the real dispatch, a real Engine, no timers. */
class FakeWorker implements TestWorkerLike {
  onmessage: ((event: { data: WorkerOutbound }) => void) | null = null;
  terminated = false;
  readonly posts: WorkerInbound[] = [];
  readonly ctx: WorkerContext;
  private now = 0;

  constructor() {
    this.ctx = createWorkerContext({
      control: (msg) => this.emit(msg),
      presentation: (msg) => this.emit(msg),
      now: () => this.now,
      seedWord: () => 0x1234,
    });
    // The production path lazy-loads the controller; the fake-port worker
    // installs it up front so session traffic stays synchronous.
    installDebugController(this.ctx, createDebugController(this.ctx));
    this.ctx.host = createEngineHost(this.ctx);
  }

  private emit(msg: WorkerOutbound): void {
    if (!this.terminated) this.onmessage?.({ data: msg });
  }

  postMessage(message: WorkerInbound): void {
    if (this.terminated) return;
    this.posts.push(message);
    onWorkerMessage(this.ctx, message);
    // Boot arms real timers; stop them after each dispatch so tests drive
    // polls explicitly and stay deterministic.
    this.ctx.fns.stopTimers();
  }

  terminate(): void {
    this.terminated = true;
    this.ctx.fns.stopTimers();
  }

  tick(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.now += 1000 / 60;
      this.ctx.fns.hostTick();
    }
  }
}

/** A scripted worker that never runs dispatch — the test emits replies. */
class ScriptedWorker implements TestWorkerLike {
  onmessage: ((event: { data: WorkerOutbound }) => void) | null = null;
  terminated = false;
  readonly posts: WorkerInbound[] = [];

  postMessage(message: WorkerInbound): void {
    if (!this.terminated) this.posts.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(msg: WorkerOutbound): void {
    this.onmessage?.({ data: msg });
  }
}

type SourceBindings = Record<string, { kind: string; num: number }>;

/** Compile real LOGIC payloads under the authored binding map. */
function makeGame(
  logics: { num: number; source: string }[],
  bindings: SourceBindings = {},
): IsolatedTestGame {
  const container = createContainer();
  const projected = Object.fromEntries(
    Object.entries(bindings).map(([name, b]) => [name, { num: b.num }]),
  );
  const sources: Record<string, string> = {};
  for (const { num, source } of logics) {
    sources[String(num)] = source;
    container.putResource(
      "logic",
      num,
      compileProjectLogic(source, { profile, dictionary: new Map(), bindings: projected }).assembly
        .payload,
    );
  }
  return {
    files: Object.fromEntries(container.files),
    profile: PROFILE,
    sources,
    sourceBindings: bindings as IsolatedTestGame["sourceBindings"],
  };
}

function expectedBuildId(game: IsolatedTestGame): string {
  return captureProjectBuild({
    files: game.files,
    profileId: game.profile,
    sources: game.sources,
    bindings: Object.fromEntries(
      Object.entries(game.sourceBindings).map(([name, b]) => [name, { num: b.num }]),
    ),
  }).identity.buildId;
}

/** Microtask-drain: host answers resolve through the session's async turn. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeSession(extra: Partial<Parameters<typeof createTestSession>[0]> = {}): {
  session: TestSession;
  workers: (FakeWorker | ScriptedWorker)[];
} {
  const workers: (FakeWorker | ScriptedWorker)[] = [];
  const session = createTestSession({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    ...extra,
  });
  return { session, workers };
}

const SAVE_LOGIC = `
if (!isset(inited)) {
  set(inited);
  assignn(checkpoint_value, 40);
}
increment(count);
if (isset(save_me)) {
  reset(save_me);
  save.game();
}
if (isset(restore_me)) {
  reset(restore_me);
  restore.game();
}
return;
`;

// Custom flags live at >=32: f10 is the interpreter's trace flag, f11 is
// reserved, and f12 is F_RESTORED — set by an authentic restore and cleared
// at every cycle tail, so it can never carry persistent game intent.
const SAVE_BINDINGS: SourceBindings = {
  save_me: { kind: "flag", num: 32 },
  restore_me: { kind: "flag", num: 33 },
  inited: { kind: "flag", num: 34 },
  checkpoint_value: { kind: "variable", num: 40 },
  count: { kind: "variable", num: 41 },
  second_room: { kind: "logic", num: 1 },
};

test("start admits the frozen run — attach, configure and pause precede ready", async () => {
  const leases: { released: boolean }[] = [];
  const { session, workers } = makeSession({
    acquirePauseLease: () => {
      const lease = { released: false };
      leases.push(lease);
      return { release: () => (lease.released = true) };
    },
  });
  const game = makeGame(
    [{ num: 0, source: "assignn(checkpoint_value, 1);\nassignn(v41, 2);\nreturn;" }],
    SAVE_BINDINGS,
  );
  const run = await session.start(game, {
    breakpoints: [{ id: "b1", enabled: true, logic: 0, line: 2, mode: "statement" }],
  });
  assert.equal(workers.length, 1);
  const worker = workers[0]! as FakeWorker;

  // The single boot message carries the complete admission policy.
  const boot = worker.posts[0]!;
  assert.equal(boot.type, "boot");
  const frozen = (boot as unknown as { frozenTest?: Record<string, unknown> }).frozenTest!;
  assert.ok(frozen, "the run boots under the frozen-test policy");
  assert.deepEqual(frozen["sources"], game.sources);
  assert.deepEqual(frozen["sourceBindings"], game.sourceBindings);
  assert.deepEqual(frozen["bindings"], {
    save_me: { kind: "flag", num: 32 },
    restore_me: { kind: "flag", num: 33 },
    inited: { kind: "flag", num: 34 },
    checkpoint_value: { kind: "variable", num: 40 },
    count: { kind: "variable", num: 41 },
  });
  // A test boot never carries replay or restore-resume fields.
  for (const field of ["replaySeed", "restoreImage", "restoreMenus", "sessionId"])
    assert.equal((boot as unknown as Record<string, unknown>)[field], undefined, field);

  // Ready only after admission: verified identity, real epoch, the entry stop.
  assert.ok(run.epoch > 0);
  assert.equal(run.buildId, expectedBuildId(game));
  assert.equal(run.profileId, PROFILE);
  assert.equal(run.phase, "stopped");
  assert.ok(run.stop !== null);
  const stop: TestStop = run.stop;
  assert.equal(stop.location, null, "the entry stop fabricates no resume point");
  assert.equal(worker.ctx.engine!.executionStopInfo !== null, true);
  assert.equal(worker.ctx.boot.authorRooms, false, "room generation is pinned off");

  // The injected lease parked the live game for the run's lifetime.
  assert.equal(leases.length, 1);
  assert.equal(leases[0]!.released, false);
});

test("input stays frozen until continue; a breakpoint republishes the stop", async () => {
  const { session, workers } = makeSession();
  const events: string[] = [];
  session.on((event: TestSessionEvent) => events.push(event.type));
  const game = makeGame([{ num: 0, source: "assignn(v40, 7);\nreturn;" }]);
  const options: TestStartOptions = {
    breakpoints: [{ id: "first", enabled: true, logic: 0, line: 1, mode: "statement" }],
    stopOnEntry: false,
  };
  const run: TestRun = await session.start(game, options);
  const worker = workers[0]! as FakeWorker;
  assert.equal(run.phase, "running");
  assert.equal(run.stop as unknown, null);

  // The first poll meets the armed breakpoint on the first instruction.
  worker.tick(1);
  assert.equal(run.phase, "stopped");
  const stop = run.stop;
  assert.ok(stop !== null);
  const reason = stop.reasons[0]!;
  assert.equal(reason.kind, "breakpoint");
  assert.equal(worker.ctx.engine!.vars[40], 0, "the stop precedes the assignment");

  // Gameplay input is refused outright while stopped — nothing queues.
  session.key(0x0d);
  session.input("look");
  session.direction(1, true);
  session.click(10, 10);
  assert.equal(worker.ctx.input.keyQueue.length, 0);
  assert.equal(worker.ctx.input.inputBuffer.length, 0);
  worker.tick(3);
  assert.equal(worker.ctx.engine!.vars[40], 0);

  // Continue releases the latch; the pass runs to completion.
  await session.resume();
  assert.equal(run.phase, "running");
  worker.tick(2);
  assert.equal(worker.ctx.engine!.vars[40], 7);
  assert.ok(events.includes("stopped"));
});

test("a source that does not reproduce the build refuses admission", async () => {
  const leases: { released: boolean }[] = [];
  const { session, workers } = makeSession({
    acquirePauseLease: () => {
      const lease = { released: false };
      leases.push(lease);
      return { release: () => (lease.released = true) };
    },
  });
  const game = makeGame([{ num: 0, source: "return;" }]);
  const doctored: IsolatedTestGame = {
    ...game,
    sources: { "0": "assignn(v40, 1);\nreturn;" },
  };
  const refusal = await session.start(doctored).then(
    () => null,
    (error) => error,
  );
  assert.ok(refusal instanceof TestRuntimeError);
  assert.match(String(refusal.message), /reproduce|LOGIC 0/i);
  // The admission captured the inconsistency locally — no worker spawned,
  // nothing parked, no lease.
  assert.equal(workers.length, 0);
  assert.equal(leases.length, 0);
  assert.equal(session.run, null);
});

test("a worker-side admission refusal never falls back to play", async () => {
  const worker = new ScriptedWorker();
  const session = createTestSession({ createWorker: () => worker });
  const game = makeGame([{ num: 0, source: "return;" }]);
  const pending = session.start(game);
  const id = (worker.posts[0] as { frozenTest: { id: number } }).frozenTest.id;
  worker.emit({
    type: "debugError",
    id,
    epoch: null,
    buildId: null,
    code: "invalidRequest",
    error: "source does not reproduce the container",
  });
  worker.emit({ type: "error", message: "isolated test boot refused: source does not reproduce" });
  const refusal = await pending.then(
    () => null,
    (error) => error,
  );
  assert.ok(refusal instanceof TestRuntimeError);
  assert.match(String(refusal.message), /reproduce/);
  assert.equal(session.run, null);
  assert.equal(worker.terminated, true);
});

test("a worker that reports a foreign build identity is refused", async () => {
  const worker = new ScriptedWorker();
  const session = createTestSession({ createWorker: () => worker });
  const game = makeGame([{ num: 0, source: "return;" }]);
  const pending = session.start(game);
  const boot = worker.posts[0] as { frozenTest: { id: number } };
  const id = boot.frozenTest.id;
  worker.emit({ type: "debugAttached", id, epoch: 3, buildId: "not-the-build" });
  worker.emit({ type: "booted", profile: PROFILE, kind: "default" });
  const refusal = await pending.then(
    () => null,
    (error) => error,
  );
  assert.ok(refusal instanceof TestRuntimeError);
  assert.equal(session.run, null);
  assert.equal(worker.terminated, true);
});

test("save and restore round-trip through the ephemeral host store", async () => {
  const described: string[] = [];
  const { session, workers } = makeSession({
    prompts: {
      saveDescription: (req: TestDescriptionRequest) => {
        described.push(`${req.initial}:${req.maxLen}`);
        return "checkpoint one";
      },
    },
  });
  const game = makeGame([{ num: 0, source: SAVE_LOGIC }], SAVE_BINDINGS);
  const run = await session.start(game);
  const worker = workers[0]! as FakeWorker;
  const epochAtBoot = run.epoch;

  // Arm the save flag and release the run; the selector suspends on its list.
  await session.setValues({ flags: [[32, 1]] });
  await session.resume();
  worker.tick(1);
  await flush();
  // Slot list answered (empty), the selector waits on a key.
  assert.equal(run.waiting, "key");
  session.key(0x0d); // pick slot 1 (empty) -> native describe request
  await flush();
  session.key(0x0d); // confirm write
  await flush();
  assert.deepEqual(
    session.saves().map((s) => s.slot),
    [1],
  );
  assert.equal(session.saves()[0]!.description, "checkpoint one");

  // Observe where the image was taken, then overwrite state and restore.
  await session.pause();
  const savedCount = (await session.evaluate("count")) as number;
  await session.setValues({ vars: [[40, 77]], flags: [[33, 1]] });
  await session.resume();
  worker.tick(1);
  await flush();
  session.key(0x0d); // pick the listed slot -> read request
  await flush();

  // The restore replaced the run's identity: fresh epoch, image state back.
  assert.notEqual(run.epoch, epochAtBoot);
  await session.pause();
  assert.equal(await session.evaluate("checkpoint_value"), 40);
  // The image's counter came back, then LOGIC 0 ran again in the same
  // cycle — an authentic restore aborts the continuation and re-enters the
  // logic (docs/fidelity.md, "Original save and restart audit").
  assert.equal(await session.evaluate("count"), savedCount + 1);
});

test("restart keeps the ephemeral slots; a replaced build empties them", async () => {
  const frames: Uint8Array[] = [];
  const { session, workers } = makeSession({
    prompts: { saveDescription: () => "kept slot" },
    onPresentation: (msg) => {
      if (msg.type === "frame") frames.push(msg.text);
    },
  });
  const game = makeGame([{ num: 0, source: SAVE_LOGIC }], SAVE_BINDINGS);
  await session.start(game);
  const first = workers[0]! as FakeWorker;
  await session.setValues({ flags: [[32, 1]] });
  await session.resume();
  first.tick(1);
  await flush();
  session.key(0x0d);
  await flush();
  session.key(0x0d);
  await flush();
  assert.equal(session.saves().length, 1);

  // Same build, fresh run: the slot survives and restores through it.
  const firstRun = session.run!;
  const run = await session.restart();
  assert.equal(first.terminated, true);
  assert.equal(workers.length, 2);
  assert.notEqual(run, firstRun, "restart publishes a fresh run identity");
  assert.equal(session.saves().length, 1, "same-build restart retains the slots");

  const second = workers[1]! as FakeWorker;
  // Let the fresh run accumulate state the image does not carry, then restore.
  await session.resume();
  second.tick(3);
  await session.pause();
  await session.setValues({ flags: [[33, 1]] });
  await session.resume();
  second.tick(1);
  await flush();
  session.key(0x0d);
  await flush();
  await session.pause();
  // The image rolled the counter back to its saved 1, then LOGIC 0's
  // authentic same-cycle re-entry incremented it once (fidelity.md).
  assert.equal(await session.evaluate("count"), 2);

  // A different build is a different identity: the slots are gone, and the
  // engine's own empty-list failure path reports through the frame stream.
  const other = makeGame(
    [
      {
        num: 0,
        source: SAVE_LOGIC.replace(
          "assignn(checkpoint_value, 40)",
          "assignn(checkpoint_value, 41)",
        ),
      },
    ],
    SAVE_BINDINGS,
  );
  await session.start(other);
  assert.equal(workers.length, 3);
  assert.equal(session.saves().length, 0, "a new build starts with empty slots");
  const third = workers[2]! as FakeWorker;
  frames.length = 0;
  await session.setValues({ flags: [[33, 1]] });
  await session.resume();
  third.tick(1);
  await flush(); // the empty listing lands; the selector shows its failure
  third.tick(1);
  const text = frames
    .map((cells) => {
      let out = "";
      for (let i = 0; i + 1 < cells.length; i += 2) out += String.fromCharCode(cells[i]!);
      return out;
    })
    .join("\n");
  assert.match(text, /No saved games/);
});

test("a late prompt answer cannot reach the replaced run", async () => {
  const prompt: { resolve: ((value: string | null) => void) | null } = { resolve: null };
  let aborted = false;
  const { session, workers } = makeSession({
    prompts: {
      getString: (_req: TestStringRequest, cancel) => {
        cancel.addEventListener("abort", () => (aborted = true));
        return new Promise((resolve) => (prompt.resolve = resolve));
      },
    },
  });
  const game = makeGame([
    { num: 0, source: '#message 1 "Name?"\nget.string(s40, m1, 22, 0, 30);\nreturn;' },
  ]);
  const run = await session.start(game);
  const first = workers[0]! as FakeWorker;
  await session.resume();
  first.tick(1);
  await flush();
  // The engine parked on get.string; the prompt callback holds it open.
  assert.ok(prompt.resolve !== null);
  assert.equal(run.waiting, "host");

  const restarted = await session.restart();
  const second = workers[1]! as FakeWorker;
  assert.equal(first.terminated, true);
  assert.equal(aborted, true, "the replaced run's prompt is cancelled");

  // The stale answer resolves late: it reaches neither worker.
  const answer = prompt.resolve;
  assert.ok(answer !== null);
  answer("late answer");
  await flush();
  assert.equal(
    first.posts.every((m) => m.type !== "hostAnswer"),
    true,
  );
  assert.equal(
    second.posts.every((m) => m.type !== "hostAnswer"),
    true,
  );
  assert.ok(restarted.epoch > 0);
});

test("the park gates the worker; a late lease fulfillment releases itself", async () => {
  const pendingResolvers: ((lease: { release(): void }) => void)[] = [];
  let workers = 0;
  const session = createTestSession({
    createWorker: () => {
      workers++;
      return new FakeWorker();
    },
    acquirePauseLease: () =>
      new Promise((resolve) => {
        pendingResolvers.push(resolve);
      }),
  });
  const game = makeGame([{ num: 0, source: "return;" }]);

  // The park is a barrier: no worker exists and nothing is ready while it
  // is unresolved.
  let ready = false;
  const first = session.start(game).then(
    (run) => {
      ready = true;
      return run;
    },
    (error) => error as Error,
  );
  await flush();
  assert.equal(pendingResolvers.length, 1);
  assert.equal(workers, 0, "a pending park must precede the isolated worker");
  assert.equal(ready, false, "ready must not publish while the live game is unparked");

  // Closing mid-park settles the start promptly; the late fulfillment
  // releases only its own acquisition and still never spawns a worker.
  session.close();
  const firstResult = await first;
  assert.ok(firstResult instanceof TestRuntimeError);
  assert.equal((firstResult as TestRuntimeError).code, "closed");
  assert.equal(workers, 0);
  const lateLease = {
    released: false,
    release() {
      this.released = true;
    },
  };
  pendingResolvers[0]!(lateLease);
  await flush();
  assert.equal(lateLease.released, true);
  assert.equal(workers, 0, "a dead run's park never boots a worker");

  // A second run parks independently and proceeds once granted.
  const second = session.start(game);
  await flush();
  assert.equal(pendingResolvers.length, 2);
  const lease2 = {
    released: false,
    release() {
      this.released = true;
    },
  };
  pendingResolvers[1]!(lease2);
  const run2 = await second;
  assert.ok(run2.epoch > 0);
  assert.equal(workers, 1);
  assert.equal(lease2.released, false, "the live run's lease is held");
  session.close();
  assert.equal(lease2.released, true);
  assert.equal(lateLease.released, true);
});

test("close terminates the run and empties the session", async () => {
  const leases: { released: boolean }[] = [];
  const { session, workers } = makeSession({
    acquirePauseLease: () => {
      const lease = { released: false };
      leases.push(lease);
      return { release: () => (lease.released = true) };
    },
    prompts: { saveDescription: () => "x" },
  });
  const game = makeGame([{ num: 0, source: SAVE_LOGIC }], SAVE_BINDINGS);
  await session.start(game);
  const worker = workers[0]! as FakeWorker;
  await session.setValues({ flags: [[32, 1]] });
  await session.resume();
  worker.tick(1);
  await flush();
  session.key(0x0d);
  await flush();
  session.key(0x0d);
  await flush();
  assert.equal(session.saves().length, 1);

  session.close();
  assert.equal(worker.terminated, true);
  assert.equal(session.run, null);
  assert.equal(session.saves().length, 0);
  assert.equal(leases.length, 1);
  assert.equal(leases[0]!.released, true);
  session.close();
  assert.equal(leases.length, 1, "close releases the lease exactly once");

  // Input against a closed session is a no-op, and a fresh start works.
  session.key(0x0d);
  session.input("look");
  const again = await session.start(makeGame([{ num: 0, source: "return;" }]));
  assert.ok(again.epoch > 0);
  assert.equal(leases.length, 2, "a new run acquires its own lease");
  assert.equal(leases[1]!.released, false, "the new run's lease is held");
});

test("evaluate, inspect and configure pin the published stop", async () => {
  const { session, workers } = makeSession();
  const game = makeGame(
    [{ num: 0, source: "assignn(checkpoint_value, 9);\nreturn;" }],
    SAVE_BINDINGS,
  );
  const run = await session.start(game);
  const worker = workers[0]! as FakeWorker;

  // Pure evaluation resolves through the expression binding map.
  assert.equal(await session.evaluate("checkpoint_value + 1"), 1);

  // Inspection reads the pinned stop snapshot's state.
  const state = (await session.inspect("state")) as { vars?: number[] };
  assert.equal(state.vars?.[40], 0);

  // A named mutation republishes the stop with a fresh identity.
  const oldStop = run.stop!.stopId;
  const newStop = await session.setValues({ vars: [[40, 55]] });
  assert.notEqual(newStop, oldStop);
  assert.equal(run.stop!.stopId, newStop);
  assert.equal(await session.evaluate("checkpoint_value"), 55);
  assert.equal(worker.ctx.engine!.vars[40], 55);

  // Configuration is atomic and session-monotonic.
  const configured = await session.configure({
    breakpoints: [{ id: "v40", enabled: true, logic: 0, line: 1, mode: "statement" }],
  });
  assert.equal(configured.revision, 1);
  const posted = worker.posts.at(-1)! as { type: string; revision?: number };
  assert.equal(posted.type, "debugConfigure");
  assert.equal(posted.revision, 1);
});

test("in-flight commands reject when the run is replaced", async () => {
  const workers: ScriptedWorker[] = [];
  const session = createTestSession({
    createWorker: () => {
      const worker = new ScriptedWorker();
      workers.push(worker);
      return worker;
    },
  });
  const game = makeGame([{ num: 0, source: "return;" }]);
  const buildId = expectedBuildId(game);
  const pending = session.start(game);
  const first = workers[0]!;
  const id = (first.posts[0] as { frozenTest: { id: number } }).frozenTest.id;
  first.emit({ type: "debugAttached", id, epoch: 7, buildId });
  first.emit({
    type: "debugStopped",
    epoch: 7,
    buildId,
    stopId: 1,
    boundarySeq: null,
    cause: { type: "wait", wait: "idle" },
    location: null,
    wait: null,
    reasons: [{ kind: "pause" }],
    state: {} as never,
    answerReady: [],
  });
  first.emit({ type: "booted", profile: PROFILE, kind: "default" });
  const run = await pending;
  assert.equal(run.epoch, 7);

  // A command outstanding when the run is replaced rejects, and a reply that
  // arrives for it afterwards is inert.
  const evaluating = session.evaluate("v40");
  const evaluatingId = (first.posts.at(-1) as { type: string; id: number }).id;
  const restarted = session.restart();
  await assert.rejects(evaluating, /replaced|closed|ended/i);
  first.emit({
    type: "debugEvaluation",
    id: evaluatingId,
    epoch: 7,
    buildId,
    stopId: 1,
    ok: true,
    value: 1,
  });
  assert.equal(first.terminated, true);

  const second = workers[1]!;
  const secondId = (second.posts[0] as { frozenTest: { id: number } }).frozenTest.id;
  second.emit({ type: "debugAttached", id: secondId, epoch: 1, buildId });
  second.emit({ type: "booted", profile: PROFILE, kind: "default" });
  const run2 = await restarted;
  assert.equal(run2.epoch, 1);
});
