import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerContext, type WorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { createDebugController } from "../src/worker/debugController.ts";
import { createPreviewAdmission } from "../src/worker/previewAdmission.ts";
import { installDebugController } from "../src/worker/debugLoader.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type {
  PreviewUpdateCandidateMessage,
  WorkerInbound,
  WorkerOutbound,
} from "../src/worker/workerProtocol.ts";
import { computeResourceRevision } from "../../src/authoring/resourceRevision.ts";
import { createContainer } from "../../src/container/container.ts";
import { compileProjectLogic } from "../../src/authoring/projectLogic.ts";
import { captureProjectBuild } from "../../src/authoring/projectBuild.ts";
import { PROFILES, type AgiProfile } from "../../src/runtime/profile.ts";
import {
  createTestSession,
  TestRuntimeError,
  type IsolatedTestGame,
  type TestSession,
  type TestSessionEvent,
  type TestWorkerLike,
} from "../src/studio/logic/debug/testSession.ts";

/**
 * The isolated session's play-preview lifecycle against the real worker
 * admission: same-Engine updates, the retained-result reconciliation for a
 * lost ACK, deferred retries under fresh ids, and the run's save namespace
 * moving only when committed source authority says so. Driven on the real
 * dispatch with a fake port worker — the play lane is granted only by an
 * explicit `frozenTest.lane: "play-preview"` boot.
 */

const PROFILE = "2.411";
const profile: AgiProfile = PROFILES[PROFILE];

/** A worker the session drives: the real dispatch, a real Engine, the lane. */
class PreviewWorker implements TestWorkerLike {
  onmessage: ((event: { data: WorkerOutbound }) => void) | null = null;
  terminated = false;
  readonly posts: WorkerInbound[] = [];
  readonly ctx: WorkerContext;
  private now = 0;
  /** Swallow the next outbound previewUpdateResult — a lost ACK. */
  dropNextResult = false;
  /** Swallow the next inbound previewUpdate — a request that never ran. */
  dropNextRequest = false;
  /** Swallow the next inbound previewUpdateStatus — a query never answered. */
  dropNextStatus = false;
  /** Hold outbound previewUpdateResult posts until releaseResults emits them. */
  holdResults = false;
  private heldResults: WorkerOutbound[] = [];

  constructor() {
    this.ctx = createWorkerContext({
      control: (msg) => this.emit(msg),
      presentation: (msg) => this.emit(msg),
      now: () => this.now,
      seedWord: () => 0x1234,
    });
    installDebugController(this.ctx, {
      ...createDebugController(this.ctx),
      ...createPreviewAdmission(this.ctx),
    });
    this.ctx.host = createEngineHost(this.ctx);
  }

  private emit(msg: WorkerOutbound): void {
    if (msg.type === "previewUpdateResult") {
      if (this.dropNextResult) {
        this.dropNextResult = false;
        return;
      }
      if (this.holdResults) {
        this.heldResults.push(msg);
        return;
      }
    }
    if (!this.terminated) this.onmessage?.({ data: msg });
  }

  /** Deliver every held outbound result, in order. */
  releaseResults(): void {
    for (const msg of this.heldResults.splice(0)) {
      if (!this.terminated) this.onmessage?.({ data: msg });
    }
  }

  postMessage(message: WorkerInbound): void {
    if (this.terminated) return;
    this.posts.push(message);
    if (message.type === "previewUpdateStatus" && this.dropNextStatus) {
      this.dropNextStatus = false;
      return;
    }
    if (message.type === "previewUpdate" && this.dropNextRequest) {
      this.dropNextRequest = false;
      return;
    }
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
  }

  emit(msg: WorkerOutbound): void {
    this.onmessage?.({ data: msg });
  }
}

type SourceBindings = Record<string, { kind: string; num: number }>;

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

/**
 * The complete candidate a previewUpdate ships: the capture's own canonical
 * file image and its verified claimed identities — exactly what the worker
 * re-verifies before any commit.
 */
function makeCandidate(game: IsolatedTestGame): PreviewUpdateCandidateMessage {
  const captured = captureProjectBuild({
    files: game.files,
    profileId: game.profile,
    sources: game.sources,
    bindings: Object.fromEntries(
      Object.entries(game.sourceBindings).map(([name, b]) => [name, { num: b.num }]),
    ),
  });
  const files: Record<string, Uint8Array> = {};
  for (const [name, bytes] of captured.files()) files[name] = new Uint8Array(bytes);
  return {
    files,
    profile: game.profile,
    sources: { ...game.sources },
    sourceBindings: Object.fromEntries(
      Object.entries(game.sourceBindings).map(([name, b]) => [name, { ...b }]),
    ),
    buildId: captured.identity.buildId,
    revision: computeResourceRevision(files),
    origins: [],
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSession(extra: Partial<Parameters<typeof createTestSession>[0]> = {}): {
  session: TestSession;
  workers: PreviewWorker[];
} {
  const workers: PreviewWorker[] = [];
  const session = createTestSession({
    createWorker: () => {
      const worker = new PreviewWorker();
      workers.push(worker);
      return worker;
    },
    ...extra,
  });
  return { session, workers };
}

const COUNT_LOGIC = "increment(count);\nreturn;";
const COUNT_BINDINGS: SourceBindings = { count: { kind: "variable", num: 41 } };

const SAVE_LOGIC = `
if (!isset(save_me)) {
  set(inited);
}
if (isset(save_me)) {
  reset(save_me);
  save.game();
}
increment(count);
return;
`;

const SAVE_BINDINGS: SourceBindings = {
  save_me: { kind: "flag", num: 32 },
  inited: { kind: "flag", num: 34 },
  count: { kind: "variable", num: 41 },
  marker: { kind: "variable", num: 50 },
};

test("ordinary play boots with the explicit play-preview lane and the worker's own token", async () => {
  const { session, workers } = makeSession();
  const game = makeGame([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await session.start(game, { stopOnEntry: false, lane: "play-preview" });
  const worker = workers[0]!;

  const boot = worker.posts[0]! as unknown as { frozenTest: Record<string, unknown> };
  assert.equal(boot.frozenTest["lane"], "play-preview");
  assert.equal(boot.frozenTest["stopOnEntry"], false);
  assert.equal(run.phase, "running");

  // The lane grant is the worker's own block — the session fabricates none of it.
  const lane = run.preview;
  assert.ok(lane !== null, "the play-preview boot published its lane");
  assert.equal(typeof lane.runToken, "string");
  assert.ok(lane.runToken.length > 0);
  assert.equal(lane.epoch, run.epoch);
  assert.equal(lane.buildId, run.buildId);
  assert.equal(lane.updateSerial, 0);
  session.close();
});

test("stopOnEntry alone never grants update authority", async () => {
  const { session, workers } = makeSession();
  const game = makeGame([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await session.start(game, { stopOnEntry: false });
  assert.equal(run.phase, "running");
  assert.equal(run.preview, null, "no lane grant, no token, no identity");

  await assert.rejects(() => session.previewUpdate(makeCandidate(game)), /no play-preview lane/i);
  assert.equal(
    workers[0]!.posts.every((m) => m.type !== "previewUpdate"),
    true,
    "a lane-less run never posts an update",
  );
  session.close();
});

test("an eligible update commits inside the same worker and keeps gameplay state", async () => {
  const { session, workers } = makeSession();
  const game = makeGame([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await session.start(game, { stopOnEntry: false, lane: "play-preview" });
  const worker = workers[0]!;
  worker.tick(3);
  const countBefore = worker.ctx.engine!.vars[41]!;
  assert.ok(countBefore > 0, "the run progressed before the update");
  const epoch = run.epoch;

  const updated = makeGame(
    [{ num: 0, source: "increment(count);\nassignn(v42, 77);\nreturn;" }],
    COUNT_BINDINGS,
  );
  const buildId = expectedBuildId(updated);
  const verdict = await session.previewUpdate(makeCandidate(updated));
  assert.equal(verdict.kind, "settled");
  assert.ok(verdict.kind === "settled" && verdict.outcome.status === "committed");
  assert.equal(workers.length, 1, "the same physical worker kept the run");
  assert.equal(worker.terminated, false);
  // A commit mints a fresh debugger epoch worker-side; the run adopted the
  // lane's recomputed identity rather than keeping the pre-commit epoch.
  assert.equal(run.epoch, verdict.outcome.current!.epoch, "the run adopted the lane's epoch");
  assert.notEqual(run.epoch, epoch, "a committed install moves the debugger epoch");
  assert.equal(worker.ctx.engine!.vars[41], countBefore, "engine state was preserved");
  assert.equal(run.buildId, buildId, "the facade publishes the installed build");
  assert.equal(run.preview!.buildId, buildId);
  assert.equal(run.preview!.updateSerial, 1);

  // The admitted bytes actually run on this engine.
  worker.tick(2);
  await session.pause();
  assert.equal(await session.evaluate("v42"), 77);
  session.close();
});

test("a binding-kind move at the same slot is a real update — the build id never dedupes", async () => {
  const { session } = makeSession();
  const game = makeGame([{ num: 0, source: "return;" }], COUNT_BINDINGS);
  const run = await session.start(game, { stopOnEntry: false, lane: "play-preview" });
  const moved = makeGame([{ num: 0, source: "return;" }], { count: { kind: "flag", num: 41 } });
  const candidate = makeCandidate(moved);
  assert.equal(candidate.buildId, run.buildId, "kind-only drift keeps the captured build identity");
  const verdict = await session.previewUpdate(candidate);
  assert.ok(verdict.kind === "settled" && verdict.outcome.status === "committed");
  assert.equal(run.preview!.updateSerial, 1);
  assert.equal(run.preview!.buildId, run.buildId, "the authority moved under the same id");
  session.close();
});

test("a stopped run defers; a retry under a fresh id commits at a quiet boundary", async () => {
  const { session, workers } = makeSession();
  const game = makeGame([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await session.start(game, { stopOnEntry: false, lane: "play-preview" });
  const worker = workers[0]!;
  worker.tick(2);

  await session.pause();
  const updated = makeGame(
    [{ num: 0, source: "increment(count);\nassignn(v42, 5);\nreturn;" }],
    COUNT_BINDINGS,
  );
  const first = await session.previewUpdate(makeCandidate(updated));
  assert.ok(first.kind === "settled" && first.outcome.status === "deferred");
  assert.equal(run.preview!.updateSerial, 0, "deferred moved nothing");

  await session.resume();
  worker.tick(2);
  const second = await session.previewUpdate(makeCandidate(updated));
  assert.ok(second.kind === "settled" && second.outcome.status === "committed");
  const ids = worker.posts
    .filter((m) => m.type === "previewUpdate")
    .map((m) => (m as { id: number }).id);
  assert.equal(ids.length, 2);
  assert.ok(ids[1]! > ids[0]!, "the retry minted a fresh monotonic id");
  assert.equal(run.preview!.updateSerial, 1);
  session.close();
});

test("a lost update ack reconciles through the retained result on the same run", async () => {
  const { session, workers } = makeSession({ previewAckTimeoutMs: 30 });
  const game = makeGame([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await session.start(game, { stopOnEntry: false, lane: "play-preview" });
  const worker = workers[0]!;
  worker.tick(2);

  worker.dropNextResult = true;
  const updated = makeGame(
    [{ num: 0, source: "increment(count);\nassignn(v42, 9);\nreturn;" }],
    COUNT_BINDINGS,
  );
  const verdict = await session.previewUpdate(makeCandidate(updated));
  assert.equal(verdict.kind, "settled");
  assert.ok(verdict.kind === "settled" && verdict.outcome.status === "committed");

  // The reconciliation rode exactly one status query on this run — no replay.
  const statusPosts = worker.posts.filter((m) => m.type === "previewUpdateStatus");
  assert.equal(statusPosts.length, 1);
  assert.equal((statusPosts[0] as { transactionId?: number }).transactionId, verdict.id);
  assert.equal(
    worker.posts.filter((m) => m.type === "previewUpdate").length,
    1,
    "the transaction id was never replayed",
  );
  assert.equal(run.buildId, expectedBuildId(updated));
  assert.equal(run.preview!.updateSerial, 1);
  session.close();
});

test("a lost request reconciles as indeterminate — nothing committed, nothing replayed", async () => {
  const { session, workers } = makeSession({ previewAckTimeoutMs: 30 });
  const game = makeGame([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await session.start(game, { stopOnEntry: false, lane: "play-preview" });
  const worker = workers[0]!;
  worker.tick(2);
  const laneBefore = { ...run.preview! };

  worker.dropNextRequest = true;
  const updated = makeGame(
    [{ num: 0, source: "increment(count);\nassignn(v42, 3);\nreturn;" }],
    COUNT_BINDINGS,
  );
  const verdict = await session.previewUpdate(makeCandidate(updated));
  assert.equal(verdict.kind, "indeterminate");
  const current = verdict.kind === "indeterminate" ? verdict.current : null;
  // The live identity proves the request never ran: the lane stayed put.
  assert.equal(current?.buildId, laneBefore.buildId);
  assert.equal(current?.updateSerial, laneBefore.updateSerial);
  assert.equal(current?.epoch, laneBefore.epoch);
  assert.equal(run.buildId, laneBefore.buildId, "the run keeps its build");
  assert.equal(
    worker.posts.filter((m) => m.type === "previewUpdate").length,
    1,
    "the lost id was never replayed",
  );

  // A fresh id on the same run still commits — the lane is alive.
  const retry = await session.previewUpdate(makeCandidate(updated));
  assert.ok(retry.kind === "settled" && retry.outcome.status === "committed");
  const updatePosts = worker.posts.filter((m) => m.type === "previewUpdate");
  assert.equal(updatePosts.length, 2);
  assert.ok((updatePosts[1] as { id: number }).id > (updatePosts[0] as { id: number }).id);
  session.close();
});

test("ending the run before a verdict never resurrects the preview", async () => {
  const worker = new ScriptedWorker();
  const session = createTestSession({ createWorker: () => worker });
  const game = makeGame([{ num: 0, source: "return;" }]);
  const buildId = expectedBuildId(game);
  const starting = session.start(game, { stopOnEntry: false, lane: "play-preview" });
  const bootId = (worker.posts[0] as { frozenTest: { id: number } }).frozenTest.id;
  worker.emit({
    type: "debugAttached",
    id: bootId,
    epoch: 1,
    buildId,
    preview: { runToken: "tok-1", epoch: 1, buildId, revision: "rev-1", updateSerial: 0 },
  });
  worker.emit({ type: "booted", profile: PROFILE, kind: "default" });
  const run = await starting;
  assert.ok(run.preview !== null);
  assert.equal(run.preview.runToken, "tok-1");

  const updated = makeGame([{ num: 0, source: "assignn(v42, 1);\nreturn;" }]);
  const pending = session.previewUpdate(makeCandidate(updated));
  const updateId = (worker.posts.at(-1) as { id: number }).id;
  session.close();
  await assert.rejects(pending, /closed/);
  assert.equal(worker.terminated, true);
  assert.equal(session.run, null);

  // A late verdict from the retired worker is inert — no resurrection.
  worker.emit({
    type: "previewUpdateResult",
    id: updateId,
    runToken: "tok-1",
    status: "committed",
    expected: { epoch: 1, buildId, revision: "rev-1", updateSerial: 0 },
    current: { epoch: 1, buildId: "moved", revision: "rev-2", updateSerial: 1 },
    patchGeneration: 0,
  });
  await flush();
  assert.equal(session.run, null);
});

test("a refused update keeps the run, its identity, its slots and its restart target", async () => {
  const { session, workers } = makeSession({
    prompts: { saveDescription: () => "kept slot" },
  });
  const game = makeGame([{ num: 0, source: SAVE_LOGIC }], SAVE_BINDINGS);
  const run = await session.start(game, { stopOnEntry: false, lane: "play-preview" });
  const worker = workers[0]!;
  worker.tick(1);

  // Write one ephemeral save through the run's own selector dance.
  await session.pause();
  await session.setValues({ flags: [[32, 1]] });
  await session.resume();
  worker.tick(1);
  await flush();
  session.key(0x0d); // pick the empty slot
  await flush();
  session.key(0x0d); // confirm the write
  await flush();
  assert.equal(session.saves().length, 1);

  // A forged identity refuses and preserves everything.
  const moved = makeGame([{ num: 0, source: SAVE_LOGIC }], {
    ...SAVE_BINDINGS,
    marker: { kind: "variable", num: 51 },
  });
  const forged = { ...makeCandidate(moved), buildId: "forged-build" };
  const refusal = await session.previewUpdate(forged);
  assert.ok(refusal.kind === "settled" && refusal.outcome.status === "refused");
  assert.equal(session.saves().length, 1, "a refusal keeps the save namespace");
  assert.equal(run.buildId, expectedBuildId(game));
  assert.equal(run.preview!.updateSerial, 0);

  // A kind-only commit keeps the same namespace — same build identity.
  const kindMoved = makeGame([{ num: 0, source: SAVE_LOGIC }], {
    ...SAVE_BINDINGS,
    marker: { kind: "flag", num: 50 },
  });
  const kindVerdict = await session.previewUpdate(makeCandidate(kindMoved));
  assert.ok(kindVerdict.kind === "settled" && kindVerdict.outcome.status === "committed");
  assert.equal(run.preview!.updateSerial, 1);
  assert.equal(session.saves().length, 1, "a kind-only commit keeps the build's slots");

  // A real source change commits under a fresh build — the namespace resets.
  const changed = makeGame(
    [{ num: 0, source: `${SAVE_LOGIC.trimEnd()}\nassignn(v43, 2);\n` }],
    SAVE_BINDINGS,
  );
  const committed = await session.previewUpdate(makeCandidate(changed));
  assert.ok(committed.kind === "settled" && committed.outcome.status === "committed");
  assert.equal(run.buildId, expectedBuildId(changed));
  assert.equal(session.saves().length, 0, "the committed build owns a fresh namespace");

  // The restart target is the committed pair — the new build boots.
  const restarted = await session.restart();
  assert.equal(restarted.buildId, expectedBuildId(changed));
  assert.ok(restarted.preview !== null);
  assert.notEqual(restarted.preview.runToken, run.preview!.runToken);
  session.close();
});

test("a same-build restart reprovisions the lane on the new worker", async () => {
  const { session, workers } = makeSession();
  const game = makeGame([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await session.start(game, { stopOnEntry: false, lane: "play-preview" });
  const first = workers[0]!;
  const firstToken = run.preview!.runToken;

  const restarted = await session.restart();
  assert.equal(workers.length, 2);
  assert.equal(first.terminated, true);
  assert.ok(restarted.preview !== null, "the lane followed the explicit restart");
  assert.notEqual(restarted.preview.runToken, firstToken, "a new physical run, a new token");

  const second = workers[1]!;
  second.tick(1);
  const updated = makeGame(
    [{ num: 0, source: "increment(count);\nassignn(v42, 4);\nreturn;" }],
    COUNT_BINDINGS,
  );
  const verdict = await session.previewUpdate(makeCandidate(updated));
  assert.ok(verdict.kind === "settled" && verdict.outcome.status === "committed");
  assert.equal(restarted.preview!.updateSerial, 1);
  session.close();
});

test("previewStatus reads the live lane identity without claiming an outcome", async () => {
  const { session, workers } = makeSession();
  const game = makeGame([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await session.start(game, { stopOnEntry: false, lane: "play-preview" });
  workers[0]!.tick(1);

  const report = await session.previewStatus();
  assert.equal(report.runToken, run.preview!.runToken);
  assert.equal(report.current!.buildId, run.buildId);
  assert.equal(report.current!.updateSerial, 0);
  assert.equal(report.transaction, null, "no named transaction asserts nothing");

  const updated = makeGame(
    [{ num: 0, source: "increment(count);\nassignn(v42, 6);\nreturn;" }],
    COUNT_BINDINGS,
  );
  const verdict = await session.previewUpdate(makeCandidate(updated));
  assert.ok(verdict.kind === "settled");
  const named = await session.previewStatus(verdict.id);
  assert.ok(typeof named.transaction === "object" && named.transaction !== null);
  const retained = named.transaction as { id: number; outcome: { status: string } };
  assert.equal(retained.id, verdict.id);
  assert.equal(retained.outcome.status, "committed");
  session.close();
});

test("a lane that never materialized fails admission — authority is never fabricated", async () => {
  const worker = new ScriptedWorker();
  const session = createTestSession({ createWorker: () => worker });
  const game = makeGame([{ num: 0, source: "return;" }]);
  const buildId = expectedBuildId(game);
  const starting = session.start(game, { stopOnEntry: false, lane: "play-preview" });
  const bootId = (worker.posts[0] as { frozenTest: { id: number } }).frozenTest.id;
  // The worker attached but granted no preview block: the lane it must
  // carry is absent — the run refuses rather than pretending authority.
  worker.emit({ type: "debugAttached", id: bootId, epoch: 1, buildId });
  worker.emit({ type: "booted", profile: PROFILE, kind: "default" });
  await assert.rejects(starting, TestRuntimeError);
  assert.equal(session.run, null);
  assert.equal(worker.terminated, true);
});

test("a lost request and a lost status answer report no fresh evidence", async (t) => {
  const { session, workers } = makeSession({ previewAckTimeoutMs: 30 });
  t.after(() => session.close());
  const game = makeGame([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await session.start(game, { stopOnEntry: false, lane: "play-preview" });
  const worker = workers[0]!;
  worker.tick(2);

  worker.dropNextRequest = true; // the request never ran
  worker.dropNextStatus = true; // and the reconciliation query is never answered
  const updated = makeGame(
    [{ num: 0, source: "increment(count);\nassignn(v42, 3);\nreturn;" }],
    COUNT_BINDINGS,
  );
  const verdict = await session.previewUpdate(makeCandidate(updated));
  assert.equal(verdict.kind, "indeterminate");
  assert.ok(
    verdict.kind === "indeterminate" && verdict.current === null,
    "silence is not evidence — the session's cached lane identity is no answer",
  );
  assert.equal(verdict.expected.updateSerial, 0);
  assert.equal(verdict.expected.buildId, run.preview!.buildId);
  assert.equal(run.buildId, expectedBuildId(game), "nothing repinned without proof");
  assert.equal(run.preview!.updateSerial, 0, "the lane identity stands untouched");
  assert.equal(
    worker.posts.filter((m) => m.type === "previewUpdate").length,
    1,
    "the lost request is never replayed",
  );
  assert.equal(worker.posts.filter((m) => m.type === "previewUpdateStatus").length, 1);

  // The lane is actually fine: a fresh id still commits against it.
  const retry = await session.previewUpdate(makeCandidate(updated));
  assert.ok(retry.kind === "settled" && retry.outcome.status === "committed");
  assert.ok(retry.id > verdict.id);
  assert.equal(run.preview!.updateSerial, 1);
});

test("a late-correlated result repins the run and publishes the settlement", async (t) => {
  const { session, workers } = makeSession({ previewAckTimeoutMs: 30 });
  t.after(() => session.close());
  const game = makeGame([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await session.start(game, { stopOnEntry: false, lane: "play-preview" });
  const worker = workers[0]!;
  worker.tick(1);

  const events: TestSessionEvent[] = [];
  session.on((event) => events.push(event));

  worker.dropNextStatus = true; // the reconciliation answer never arrives
  worker.holdResults = true; // the real result is delayed past both deadlines
  const updated = makeGame(
    [{ num: 0, source: "increment(count);\nassignn(v42, 5);\nreturn;" }],
    COUNT_BINDINGS,
  );
  const verdict = await session.previewUpdate(makeCandidate(updated));
  assert.equal(verdict.kind, "indeterminate");
  assert.ok(verdict.kind === "indeterminate" && verdict.current === null);

  // The commit did land worker-side — the result simply arrives late. It is
  // the attempt's own evidence: the pinned build repins and the settlement
  // publishes as an event for whoever held the unresolved attempt.
  worker.releaseResults();
  await flush();
  const late = events.find((e) => e.type === "previewOutcome");
  assert.ok(late !== undefined && late.type === "previewOutcome");
  assert.equal(late.id, verdict.id);
  assert.equal(late.outcome.status, "committed");
  assert.equal(run.buildId, expectedBuildId(updated));
  assert.equal(run.preview!.updateSerial, 1);
});

test("a retained-attempt identity proof repins run and restart authority together", async (t) => {
  const workers: ScriptedWorker[] = [];
  const session = createTestSession({
    previewAckTimeoutMs: 30,
    createWorker: () => {
      const worker = new ScriptedWorker();
      workers.push(worker);
      return worker;
    },
  });
  t.after(() => session.close());
  const game = makeGame([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const bootIdentity = captureProjectBuild({
    files: game.files,
    profileId: game.profile,
    sources: game.sources,
    bindings: { count: { num: 41 } },
  }).identity;
  const starting = session.start(game, { stopOnEntry: false, lane: "play-preview" });
  const worker = workers[0]!;
  const bootId = (worker.posts[0] as { frozenTest: { id: number } }).frozenTest.id;
  worker.emit({
    type: "debugAttached",
    id: bootId,
    epoch: 5,
    buildId: bootIdentity.buildId,
    preview: {
      runToken: "tok-1",
      epoch: 5,
      buildId: bootIdentity.buildId,
      revision: bootIdentity.revision,
      updateSerial: 0,
    },
  });
  worker.emit({ type: "booted", profile: PROFILE, kind: "default" });
  const run = await starting;
  assert.equal(run.preview!.runToken, "tok-1");

  const updated = makeGame(
    [{ num: 0, source: "increment(count);\nassignn(v42, 8);\nreturn;" }],
    COUNT_BINDINGS,
  );
  const candidate = makeCandidate(updated);
  const pending = session.previewUpdate(candidate);
  const posted = worker.posts.find((m) => m.type === "previewUpdate") as { id: number } | undefined;
  assert.ok(posted !== undefined);

  // The ACK watchdog's status query posts; the answer carries no retained
  // outcome ("unavailable") but the lane's recomputed identity proves the
  // retained candidate installed — the strongest evidence that exists.
  await sleep(50);
  const statusQuery = worker.posts.find((m) => m.type === "previewUpdateStatus") as
    { id: number; transactionId?: number } | undefined;
  assert.ok(statusQuery !== undefined);
  assert.equal(statusQuery.transactionId, posted.id);
  worker.emit({
    type: "previewUpdateStatus",
    id: statusQuery.id,
    runToken: "tok-1",
    current: {
      epoch: 6,
      buildId: candidate.buildId,
      revision: candidate.revision,
      updateSerial: 1,
    },
    transaction: "unavailable",
  });
  const verdict = await pending;
  assert.equal(verdict.kind, "indeterminate", "no outcome is fabricated for the verdict");
  assert.ok(
    verdict.kind === "indeterminate" &&
      verdict.current !== null &&
      verdict.current.buildId === candidate.buildId,
  );
  assert.equal(run.buildId, candidate.buildId, "the run's pinned build repinned under the proof");
  assert.equal(run.preview!.updateSerial, 1);

  // The restart target is the same repinned authority: a restart boots B.
  const restarting = session.restart();
  const second = workers[1]!;
  const boot2 = second.posts[0] as { frozenTest: { id: number } };
  second.emit({
    type: "debugAttached",
    id: boot2.frozenTest.id,
    epoch: 3,
    buildId: candidate.buildId,
    preview: {
      runToken: "tok-2",
      epoch: 3,
      buildId: candidate.buildId,
      revision: candidate.revision,
      updateSerial: 0,
    },
  });
  second.emit({ type: "booted", profile: PROFILE, kind: "default" });
  const restarted = await restarting;
  assert.equal(restarted.buildId, candidate.buildId, "the restart boots the repinned build");
});
