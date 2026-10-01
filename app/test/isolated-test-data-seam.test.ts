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
  type IsolatedTestGame,
  type TestDebugConfig,
  type TestLogEntry,
  type TestSession,
  type TestSessionEvent,
  type TestWorkerLike,
} from "../src/studio/logic/debug/testSession.ts";

/**
 * The D6 data seam: statuses, logpoints, queued-answer ownership and the
 * audio hold are real worker traffic the session must publish detached and
 * identity-pinned — no fabricated snapshots, nothing leaking across runs.
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
    this.onmessage = null;
  }

  emit(msg: WorkerOutbound): void {
    this.onmessage?.({ data: msg });
  }

  /** The admission id this worker was booted under. */
  admissionId(): number {
    return (this.posts[0] as { frozenTest: { id: number } }).frozenTest.id;
  }
}

function makeGame(
  logics: { num: number; source: string }[],
  bindings: Record<string, { kind: string; num: number }> = {},
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

/** Complete a scripted worker's admission: attach, entry stop, booted. */
function scriptedAdmission(worker: ScriptedWorker, buildId: string, epoch = 1, stopId = 1): void {
  worker.emit({ type: "debugAttached", id: worker.admissionId(), epoch, buildId });
  worker.emit({
    type: "debugStopped",
    epoch,
    buildId,
    stopId,
    boundarySeq: null,
    cause: { type: "wait", wait: "idle" },
    location: null,
    wait: null,
    reasons: [{ kind: "pause" }],
    state: {} as never,
    answerReady: [],
  });
  worker.emit({ type: "booted", profile: PROFILE, kind: "default" });
}

function makeScriptedSession(extra: Partial<Parameters<typeof createTestSession>[0]> = {}): {
  session: TestSession;
  workers: ScriptedWorker[];
} {
  const workers: ScriptedWorker[] = [];
  const session = createTestSession({
    createWorker: () => {
      const worker = new ScriptedWorker();
      workers.push(worker);
      return worker;
    },
    ...extra,
  });
  return { session, workers };
}

test("real configure publishes bound and unbound statuses unchanged", async () => {
  const workers: FakeWorker[] = [];
  const session = createTestSession({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  const events: TestSessionEvent[] = [];
  session.on((event) => events.push(event));
  const game = makeGame([{ num: 0, source: "assignn(v40, 7);\nreturn;" }]);
  const run = await session.start(game, { stopOnEntry: false });
  assert.equal(run.phase, "running");
  assert.equal(run.config.revision, 0, "an unconfigured run publishes the empty config");
  assert.equal(run.config.breakpoints.length, 0);

  const configured: TestDebugConfig = await session.configure({
    breakpoints: [
      { id: "bound", enabled: true, logic: 0, line: 1, mode: "statement" },
      { id: "gone", enabled: false, logic: 0, line: 99, mode: "statement" },
    ],
    watchpoints: [{ id: "watch40", enabled: true, target: { kind: "variable", index: 40 } }],
  });
  assert.equal(configured.revision, 1);
  const bound = configured.breakpoints.find((b) => b.id === "bound");
  assert.ok(bound && bound.binding.bound === true, "the valid breakpoint resolved");
  const gone = configured.breakpoints.find((b) => b.id === "gone");
  assert.ok(gone, "the disabled breakpoint keeps its status entry");
  assert.equal(gone.spec.enabled, false);
  assert.equal(gone.binding.bound, false);
  if (gone.binding.bound === false) {
    // The worker's own unbound reason reaches the consumer unchanged.
    assert.equal(gone.binding.reason, "line-out-of-range");
  }
  assert.equal(configured.watchpoints[0]?.id, "watch40");

  // The facade publishes the same detached snapshot; a configured event carried it.
  assert.equal(run.config, configured);
  const published = events.find(
    (e): e is Extract<TestSessionEvent, { type: "configured" }> => e.type === "configured",
  );
  assert.ok(published);
  assert.equal(published.config, configured);
  session.close();
});

test("caller mutation cannot rewrite stored config statuses", async () => {
  const workers: FakeWorker[] = [];
  const session = createTestSession({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  const run = await session.start(makeGame([{ num: 0, source: "return;" }]), {
    stopOnEntry: false,
  });
  const configured = await session.configure({
    breakpoints: [{ id: "bp", enabled: true, logic: 0, line: 1, mode: "statement" }],
  });
  const status = configured.breakpoints[0]!;
  const hits = status.hits;
  try {
    (status as { hits: number }).hits = 99;
  } catch (error) {
    assert.ok(error instanceof TypeError, "a frozen status may reject mutation");
  }
  assert.equal(run.config.breakpoints[0]!.hits, hits, "the stored status is unchanged");
  session.close();
});

test("a real logpoint's text reaches the event stream and the bounded run log", async () => {
  const workers: FakeWorker[] = [];
  const session = createTestSession({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  const events: TestSessionEvent[] = [];
  session.on((event) => events.push(event));
  // line 1 assigns v40=7; the logpoint sits on line 2's `return` boundary,
  // so it reports the assigned value — actual worker text, not a fixture.
  const run = await session.start(makeGame([{ num: 0, source: "assignn(v40, 7);\nreturn;" }]), {
    stopOnEntry: false,
  });
  await session.configure({
    breakpoints: [
      {
        id: "lp",
        enabled: true,
        logic: 0,
        line: 2,
        mode: "statement",
        log: {
          segments: [
            { type: "literal", text: "v40=" },
            { type: "expression", source: "v40" },
          ],
        },
      },
    ],
  });
  workers[0]!.tick(1);
  const logged = events.filter(
    (e): e is Extract<TestSessionEvent, { type: "log" }> => e.type === "log",
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.entry.breakpoint, "lp");
  assert.equal(logged[0]!.entry.text, "v40=7", "the log text is the worker's own render");
  assert.ok(logged[0]!.entry.sequence >= 1);
  const buffer: readonly TestLogEntry[] = run.log;
  assert.deepEqual(
    buffer,
    logged.map((e) => e.entry),
  );
  assert.equal(run.phase, "running", "a logpoint reports without breaking");
  session.close();
});

test("late worker events after replacement or close are dropped", async () => {
  const presented: WorkerOutbound[] = [];
  const { session, workers } = makeScriptedSession({
    onPresentation: (msg) => presented.push(msg),
  });
  const events: TestSessionEvent[] = [];
  session.on((event) => events.push(event));
  const game = makeGame([{ num: 0, source: "return;" }]);
  const buildId = expectedBuildId(game);
  const pending = session.start(game);
  const first = workers[0]!;
  scriptedAdmission(first, buildId, 7);
  const run = await pending;
  assert.equal(run.epoch, 7);

  // Keep the first worker's port: after replacement its handler must drop.
  const staleEmit = first.onmessage!;
  const restarted = session.restart();
  const second = workers[1]!;
  scriptedAdmission(second, buildId, 1);
  await restarted;
  const seen = events.length;
  staleEmit({ data: { type: "debugLog", epoch: 7, sequence: 9, breakpoint: "x", text: "stale" } });
  staleEmit({ data: { type: "debugAudio", epoch: 7, paused: true } });
  staleEmit({ data: { type: "debugAnswerReady", epoch: 7, stopId: 1, id: 9, op: "getstring" } });
  assert.equal(events.length, seen, "no stale event is published after replacement");
  assert.equal(second.posts.length, 1, "the new worker only ever saw its own boot");
  assert.equal(presented.length, 0, "stale debugAudio never reaches presentation");
  assert.equal((session.run!.log as readonly unknown[]).length, 0);

  // Same after close.
  session.close();
  assert.equal(second.onmessage, null, "teardown removed the dead worker's port");
});

test("debugAudio is epoch-scoped and forwarded to presentation after the event", async () => {
  const presented: WorkerOutbound[] = [];
  const { session, workers } = makeScriptedSession({
    onPresentation: (msg) => presented.push(msg),
  });
  const events: TestSessionEvent[] = [];
  session.on((event) => events.push(event));
  const game = makeGame([{ num: 0, source: "return;" }]);
  const buildId = expectedBuildId(game);
  const pending = session.start(game);
  const worker = workers[0]!;
  scriptedAdmission(worker, buildId, 3);
  const run = await pending;

  worker.emit({ type: "debugAudio", epoch: 99, paused: true });
  assert.equal(
    events.some((e) => e.type === "audio"),
    false,
    "a foreign-epoch audio hold is dropped",
  );
  worker.emit({ type: "debugAudio", epoch: 3, paused: false });
  const audio = events.find(
    (e): e is Extract<TestSessionEvent, { type: "audio" }> => e.type === "audio",
  );
  assert.ok(audio);
  assert.equal(audio.epoch, 3);
  assert.equal(audio.paused, false);
  assert.equal(audio.run.epoch, run.epoch);
  assert.ok(
    presented.some((m) => m.type === "debugAudio" && m.epoch === 3),
    "the worker's own message reaches the presentation consumer",
  );
  session.close();
});

test("answerReady is pinned to the current stop and epoch", async () => {
  const { session, workers } = makeScriptedSession();
  const events: TestSessionEvent[] = [];
  session.on((event) => events.push(event));
  const game = makeGame([{ num: 0, source: "return;" }]);
  const buildId = expectedBuildId(game);
  const pending = session.start(game);
  const worker = workers[0]!;
  scriptedAdmission(worker, buildId, 5, 41);
  await pending;

  worker.emit({ type: "debugAnswerReady", epoch: 5, stopId: 40, id: 9, op: "getstring" });
  worker.emit({ type: "debugAnswerReady", epoch: 6, stopId: 41, id: 9, op: "getstring" });
  assert.equal(
    events.some((e) => e.type === "answerReady"),
    false,
    "answers for a stale stop or epoch cannot announce themselves",
  );
  worker.emit({ type: "debugAnswerReady", epoch: 5, stopId: 41, id: 9, op: "getstring" });
  const ready = events.find(
    (e): e is Extract<TestSessionEvent, { type: "answerReady" }> => e.type === "answerReady",
  );
  assert.ok(ready);
  assert.equal(ready.stopId, 41);
  assert.equal(ready.id, 9);
  assert.equal(ready.op, "getstring");
  session.close();
});

test("a session reset republishes the rebound config and voids the old stop", async () => {
  const { session, workers } = makeScriptedSession();
  const events: TestSessionEvent[] = [];
  session.on((event) => events.push(event));
  const game = makeGame([{ num: 0, source: "return;" }]);
  const buildId = expectedBuildId(game);
  const pending = session.start(game);
  const worker = workers[0]!;
  scriptedAdmission(worker, buildId, 5, 7);
  const run = await pending;
  assert.ok(run.stop);
  const rebound: WorkerOutbound = {
    type: "debugSessionReset",
    epoch: 6,
    buildId,
    breakpoints: [
      {
        id: "bp",
        spec: { id: "bp", enabled: true, logic: 0, line: 1, mode: "statement" },
        binding: { bound: false, reason: "no-source-map" },
        hits: 3,
        fault: null,
      },
    ],
    watchpoints: [],
  };
  worker.emit(rebound);
  assert.equal(run.epoch, 6, "the fresh epoch is published");
  assert.equal(run.stop, null, "the replaced stop identity is voided");
  const reboundBp = run.config.breakpoints[0]!;
  assert.equal(reboundBp.hits, 3, "the worker's rebound status arrives unchanged");
  assert.equal(reboundBp.binding.bound, false);
  assert.ok(events.some((e) => e.type === "reset" && e.epoch === 6));
  session.close();
});

test("an observer that closes the run inside an event leaks nothing further", async () => {
  const presented: WorkerOutbound[] = [];
  const owned: ScriptedWorker[] = [];
  const session = createTestSession({
    createWorker: () => {
      const worker = new ScriptedWorker();
      owned.push(worker);
      return worker;
    },
    onPresentation: (msg) => presented.push(msg),
  });
  const game = makeGame([{ num: 0, source: "return;" }]);
  const buildId = expectedBuildId(game);
  session.on((event) => {
    if (event.type === "audio") session.close();
  });
  const pending = session.start(game);
  const worker = owned[0]!;
  scriptedAdmission(worker, buildId, 2);
  await pending;
  worker.emit({ type: "debugAudio", epoch: 2, paused: false });
  assert.equal(session.run, null);
  assert.equal(
    presented.some((m) => m.type === "debugAudio"),
    false,
    "the audio message never reaches the dead run's presentation",
  );
});

test("the run log is bounded", async () => {
  const { session, workers } = makeScriptedSession();
  const game = makeGame([{ num: 0, source: "return;" }]);
  const buildId = expectedBuildId(game);
  const pending = session.start(game);
  const worker = workers[0]!;
  scriptedAdmission(worker, buildId, 1);
  const run = await pending;
  for (let i = 0; i < 300; i++) {
    worker.emit({
      type: "debugLog",
      epoch: 1,
      sequence: i + 1,
      breakpoint: "lp",
      text: `entry ${i}`,
    });
  }
  assert.equal(run.log.length, 256, "the buffer caps at the documented bound");
  assert.equal(run.log[0]!.text, "entry 44", "the oldest entries drop first");
  assert.equal(run.log.at(-1)!.text, "entry 299");
  session.close();
});
