import { useTestClock } from "./async.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerContext, type WorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { createDebugController } from "../src/worker/debugController.ts";
import { createPreviewAdmission } from "../src/worker/previewAdmission.ts";
import { installDebugController } from "../src/worker/debugLoader.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerInbound, WorkerOutbound } from "../src/worker/workerProtocol.ts";
import { createContainer } from "../../src/container/container.ts";
import { compileProjectLogic } from "../../src/authoring/projectLogic.ts";
import { captureProjectBuild } from "../../src/authoring/projectBuild.ts";
import { PROFILES, type AgiProfile, type ProfileId } from "../../src/runtime/profile.ts";
import {
  createTestSession,
  type TestSessionOptions,
  type TestWorkerLike,
} from "../src/studio/logic/debug/testSession.ts";
import {
  createDebugWorkspace,
  type DebugDraftSource,
  type DebugTestBuild,
} from "../src/studio/logic/debug/logicDebugWorkspace.ts";

/**
 * The Play lane's live-update orchestration: a completed draft edit reaches
 * the SAME worker as a complete preview candidate, a superseded candidate
 * collapses, a stopped run defers and retries under a fresh id, and the
 * frozen debug lane never updates itself. The fake port runs the real
 * dispatch and admission — every verdict is the worker's own.
 */

const PROFILE: ProfileId = "2.411";
const profile: AgiProfile = PROFILES[PROFILE]!;

class PreviewWorker implements TestWorkerLike {
  onmessage: ((event: { data: WorkerOutbound }) => void) | null = null;
  terminated = false;
  readonly posts: WorkerInbound[] = [];
  readonly ctx: WorkerContext;
  private now = 0;
  /** Hold inbound previewUpdate/previewUpdateStatus posts until releaseHeld. */
  holdUpdates = false;
  readonly held: WorkerInbound[] = [];
  /** Swallow the next inbound previewUpdate — a request that never ran. */
  dropNextRequest = false;
  /** Swallow the next inbound previewUpdateStatus — a query never answered. */
  dropNextStatus = false;
  /** Hold the next outbound previewUpdateResult — an ACK delayed past its deadlines. */
  holdNextResult = false;
  /** Hold the next outbound previewUpdateStatus — a stale in-flight answer. */
  holdNextStatus = false;
  readonly heldOutbound: WorkerOutbound[] = [];

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

  /** Deliver every held outbound reply, in order, unchanged. */
  releaseOutbound(): void {
    for (const msg of this.heldOutbound.splice(0)) this.onmessage?.({ data: msg });
  }

  private emit(msg: WorkerOutbound): void {
    if (
      (msg.type === "previewUpdateResult" && this.holdNextResult) ||
      (msg.type === "previewUpdateStatus" && this.holdNextStatus)
    ) {
      if (msg.type === "previewUpdateResult") this.holdNextResult = false;
      else this.holdNextStatus = false;
      this.heldOutbound.push(msg);
      return;
    }
    if (!this.terminated) this.onmessage?.({ data: msg });
  }

  postMessage(message: WorkerInbound): void {
    if (this.terminated) return;
    this.posts.push(message);
    if (message.type === "previewUpdateStatus") {
      if (this.dropNextStatus) {
        this.dropNextStatus = false;
        return;
      }
      if (this.holdUpdates) {
        this.held.push(message);
        return;
      }
    }
    if (message.type === "previewUpdate") {
      if (this.dropNextRequest) {
        this.dropNextRequest = false;
        return;
      }
      if (this.holdUpdates) {
        this.held.push(message);
        return;
      }
    }
    onWorkerMessage(this.ctx, message);
    this.ctx.fns.stopTimers();
  }

  releaseHeld(): void {
    for (const msg of this.held.splice(0)) {
      onWorkerMessage(this.ctx, msg);
      this.ctx.fns.stopTimers();
    }
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

async function flush(): Promise<void> {
  await clock.advance(0);
}

const clock = useTestClock();

type Bindings = Record<string, { kind: string; num: number }>;

/**
 * A mutable draft authority the workspace freezes: capture compiles the
 * CURRENT source map under the CURRENT binding map, exactly as the real
 * draft source does. `edit` moves a document's version; `setBindings`
 * moves the map's version without touching sources.
 */
function makeDraft(
  logics: { num: number; source: string }[],
  bindings: Bindings = {},
): {
  draft: DebugDraftSource;
  edit(num: number, source: string): void;
  setBindings(next: Bindings): void;
} {
  const current = new Map(logics.map((entry) => [entry.num, entry.source]));
  let map = bindings;
  let version = 1;
  const captureBuild = (): DebugTestBuild => {
    const container = createContainer();
    const projected = Object.fromEntries(
      Object.entries(map).map(([name, b]) => [name, { num: b.num }]),
    );
    const sources: Record<string, string> = {};
    for (const [num, source] of current) {
      sources[String(num)] = source;
      container.putResource(
        "logic",
        num,
        compileProjectLogic(source, {
          profile,
          dictionary: new Map(),
          bindings: projected,
        }).assembly.payload,
      );
    }
    const files = Object.fromEntries(container.files);
    const capture = captureProjectBuild({
      files,
      profileId: PROFILE,
      sources,
      bindings: projected,
    });
    return {
      files,
      profile: PROFILE,
      sources,
      sourceBindings: map as DebugTestBuild["sourceBindings"],
      capture,
      versions: [
        ...[...current.keys()].map((num) => ({ key: `logic:${num}`, version })),
        { key: "bindings", version },
      ],
      diagnostics: [],
    };
  };
  return {
    draft: {
      captureTestBuild: captureBuild,
      currentVersions: () => [
        ...[...current.keys()].map((num) => ({ key: `logic:${num}`, version })),
        { key: "bindings", version },
      ],
    },
    edit(num, source) {
      current.set(num, source);
      version++;
    },
    setBindings(next) {
      map = next;
      version++;
    },
  };
}

interface Harness {
  readonly workspace: ReturnType<typeof createDebugWorkspace>;
  readonly session: ReturnType<typeof createTestSession>;
  readonly workers: PreviewWorker[];
  readonly edit: (num: number, source: string) => void;
  readonly setBindings: (next: Bindings) => void;
}

function makeHarness(logics: { num: number; source: string }[], bindings: Bindings = {}): Harness {
  const workers: PreviewWorker[] = [];
  const { draft, edit, setBindings } = makeDraft(logics, bindings);
  let session!: ReturnType<typeof createTestSession>;
  const workspace = createDebugWorkspace({
    draft,
    previewDebounceMs: 0,
    previewAckTimeoutMs: 40,
    acquirePauseLease: () => ({ release: () => undefined }),
    createSession: (options: TestSessionOptions) =>
      (session = createTestSession({
        ...options,
        prompts: { saveDescription: () => "test save" },
      })),
    createWorker: () => {
      const worker = new PreviewWorker();
      workers.push(worker);
      return worker;
    },
  });
  return {
    workspace,
    workers,
    edit,
    setBindings,
    get session() {
      return session;
    },
  };
}

const COUNT_LOGIC = "increment(count);\nreturn;";
const COUNT_BINDINGS: Bindings = { count: { kind: "variable", num: 41 } };

const updatesOf = (worker: { posts: WorkerInbound[] }) =>
  worker.posts.filter((m) => m.type === "previewUpdate") as (WorkerInbound & {
    type: "previewUpdate";
  })[];

/** A save-capable draft: f32 arms one selector write, then play resumes. */
const SAVE_BASE = `if (isset(f32)) { reset(f32); save.game(); }
increment(count);
`;
const SOURCE_A = `${SAVE_BASE}return;`;
const SOURCE_B = `${SAVE_BASE}assignn(v42, 10);\nreturn;`;
const SOURCE_C = `${SAVE_BASE}assignn(v42, 20);\nreturn;`;

async function editAndFlush(h: Harness, source: string): Promise<void> {
  h.edit(0, source);
  h.workspace.noteDraftChanged();
  await flush();
  await flush();
}

/** One real ephemeral save through the run's own selector. */
async function saveCurrent(h: Harness): Promise<void> {
  const worker = h.workers[0]!;
  await h.session.pause();
  await h.session.setValues({ flags: [[32, 1]] });
  await h.session.resume();
  worker.tick(1);
  await flush();
  h.session.key(0x0d); // pick the empty slot
  await flush();
  h.session.key(0x0d); // confirm the write
  await flush();
  assert.equal(h.session.saves().length, 1, "the current build owns one real save");
}

test("a completed draft edit live-patches the running preview on the same worker", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await h.workspace.play();
  const worker = h.workers[0]!;
  assert.equal(h.workspace.state.runKind, "play");
  assert.equal(h.workspace.state.phase, "running");
  worker.tick(3);
  const countBefore = worker.ctx.engine!.vars[41]!;
  assert.ok(countBefore > 0);

  h.edit(0, "increment(count);\nassignn(v42, 5);\nreturn;");
  h.workspace.noteDraftChanged();
  await flush();
  await flush();

  assert.equal(updatesOf(worker).length, 1, "one previewUpdate reached the wire");
  assert.equal(h.workers.length, 1, "the same physical worker kept the run");
  assert.equal(worker.terminated, false);
  assert.equal(h.workspace.state.stale, false, "the committed draft is the running one");
  assert.equal(h.workspace.state.buildId, run.buildId, "the facade publishes the new build");
  assert.equal(h.workspace.state.update.status, "idle");
  assert.equal(worker.ctx.engine!.vars[41], countBefore, "gameplay state survived");

  // The new bytes actually run on this engine.
  worker.tick(2);
  await h.workspace.pauseRun();
  assert.equal(await h.workspace.evaluate("v42"), 5);
  h.workspace.dispose();
});

test("a mid-flight edit collapses: the newest candidate proposes against the settled identity", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await h.workspace.play();
  const worker = h.workers[0]!;
  worker.tick(1);
  const bootBuild = run.buildId;

  worker.holdUpdates = true;
  h.edit(0, "increment(count);\nassignn(v42, 10);\nreturn;");
  h.workspace.noteDraftChanged();
  await flush();
  await flush();
  assert.equal(updatesOf(worker).length, 1, "the first candidate is in flight");

  // A newer edit lands while the first is held — it queues, it does not post.
  h.edit(0, "increment(count);\nassignn(v42, 20);\nreturn;");
  h.workspace.noteDraftChanged();
  await flush();
  assert.equal(updatesOf(worker).length, 1, "the in-flight proposal stays singular");

  worker.holdUpdates = false;
  worker.releaseHeld();
  await flush();
  await flush();

  const posts = updatesOf(worker);
  assert.equal(posts.length, 2, "the newest draft proposed against the actual installed identity");
  const second = posts[1]!;
  // A's commit is fact: B's request pins A's installed serial and build,
  // never the boot identity it was drafted before.
  assert.equal(second.expected.updateSerial, 1);
  assert.notEqual(second.expected.buildId, bootBuild);
  assert.ok(second.id > posts[0]!.id, "each attempt carries a fresh monotonic id");
  assert.equal(h.workspace.state.stale, false);
  worker.tick(2); // the installed build runs a real cycle before the read
  await h.workspace.pauseRun();
  assert.equal(await h.workspace.evaluate("v42"), 20, "the newest candidate won");
  h.workspace.dispose();
});

test("a binding-kind move reaches the wire — the build id alone never dedupes", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], {
    count: { kind: "variable", num: 41 },
    marker: { kind: "variable", num: 50 },
  });
  const run = await h.workspace.play();
  const worker = h.workers[0]!;
  const bootBuild = run.buildId;

  h.setBindings({ count: { kind: "variable", num: 41 }, marker: { kind: "flag", num: 50 } });
  h.workspace.noteDraftChanged();
  await flush();
  await flush();

  const posts = updatesOf(worker);
  assert.equal(posts.length, 1, "a kind-only change still ships a candidate");
  assert.equal(posts[0]!.candidate.buildId, bootBuild, "the captured identity did not move");
  assert.equal(
    posts[0]!.candidate.sourceBindings["marker"]!.kind,
    "flag",
    "the full typed map reached the wire",
  );
  assert.equal(h.workspace.state.update.status, "idle");
  assert.equal(run.preview!.updateSerial, 1, "the authority committed");
  assert.equal(h.workspace.state.stale, false);
  h.workspace.dispose();
});

test("an invalid draft keeps the run live and labels the older build", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  await h.workspace.play();
  const worker = h.workers[0]!;
  worker.tick(2);
  const countBefore = worker.ctx.engine!.vars[41]!;

  h.edit(0, "this is not logic");
  h.workspace.noteDraftChanged();
  await flush();
  await flush();

  assert.equal(updatesOf(worker).length, 0, "an unbuildable draft never reaches the wire");
  assert.equal(h.workspace.state.buildFailed, true);
  assert.match(h.workspace.state.error ?? "", /cannot build|expected/i);
  assert.equal(h.workspace.state.phase, "running", "the older build still runs");
  assert.equal(h.workspace.state.stale, true, "the draft still differs");
  assert.equal(worker.terminated, false);
  worker.tick(2);
  assert.ok(worker.ctx.engine!.vars[41]! > countBefore, "play continued undisturbed");

  // The fixed draft live-patches on the next tick — no restart needed.
  h.edit(0, "increment(count);\nassignn(v42, 8);\nreturn;");
  h.workspace.noteDraftChanged();
  await flush();
  await flush();
  assert.equal(updatesOf(worker).length, 1);
  assert.equal(h.workspace.state.buildFailed, false);
  assert.equal(h.workspace.state.stale, false);
  h.workspace.dispose();
});

test("a paused run defers a source edit; Continue retries it under a fresh id", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await h.workspace.play();
  const worker = h.workers[0]!;
  worker.tick(2);

  await h.workspace.pauseRun();
  assert.equal(h.workspace.state.phase, "stopped");

  h.edit(0, "increment(count);\nassignn(v42, 6);\nreturn;");
  h.workspace.noteDraftChanged();
  await flush();
  await flush();
  assert.equal(updatesOf(worker).length, 1);
  assert.equal(
    h.workspace.state.update.status,
    "waiting",
    "the deferred attempt waits for a quiet boundary",
  );
  assert.equal(h.workspace.state.stale, true, "the draft still differs until it lands");
  assert.equal(run.preview!.updateSerial, 0, "deferred moved nothing");

  await h.workspace.continueRun();
  worker.tick(40); // carry the cycle heartbeat past the retry boundary
  await flush();
  await flush();

  const posts = updatesOf(worker);
  assert.equal(posts.length, 2, "the deferred candidate retried at a boundary");
  assert.ok(posts[1]!.id > posts[0]!.id, "the retry minted a fresh id");
  assert.equal(h.workspace.state.update.status, "idle");
  assert.equal(h.workspace.state.stale, false);
  assert.equal(worker.ctx.engine!.vars[42], 6, "the new bytes run in the same engine");
  h.workspace.dispose();
});

test("a lost request reconciles and retries — the lane's truth, not a guess", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  await h.workspace.play();
  const worker = h.workers[0]!;
  worker.tick(2);

  worker.dropNextRequest = true;
  h.edit(0, "increment(count);\nassignn(v42, 7);\nreturn;");
  h.workspace.noteDraftChanged();
  await flush();
  await clock.advance(80); // the ack watchdog fires, then the status query answers
  await flush();

  const statuses = worker.posts.filter((m) => m.type === "previewUpdateStatus");
  assert.equal(statuses.length, 1, "the lost ack reconciled through a status query");
  worker.tick(40);
  await flush();
  await flush();
  const posts = updatesOf(worker);
  assert.equal(posts.length, 2, "the lost id was never replayed; a fresh id retried");
  assert.equal(h.workspace.state.update.status, "idle");
  assert.equal(h.workspace.state.stale, false);
  await h.workspace.pauseRun();
  assert.equal(await h.workspace.evaluate("v42"), 7);
  h.workspace.dispose();
});

test("a refused candidate keeps the run, its pins and its truthful reason", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await h.workspace.play();
  const worker = h.workers[0]!;
  worker.tick(2);
  const bootBuild = run.buildId;

  // `call` to an absent LOGIC survives the local build — the worker's
  // detached project validation refuses the whole candidate.
  h.edit(0, "call(99);\nreturn;");
  h.workspace.noteDraftChanged();
  await flush();
  await flush();

  const posts = updatesOf(worker);
  assert.equal(posts.length, 1, "the candidate reached the wire and was refused there");
  assert.equal(h.workspace.state.update.status, "blocked");
  assert.match(h.workspace.state.update.reason ?? "", /LOGIC 99|absent/i);
  assert.equal(h.workspace.state.buildId, bootBuild, "the run keeps its build");
  assert.equal(h.workspace.state.phase, "running");
  assert.equal(h.workspace.state.stale, true);
  assert.equal(worker.terminated, false);
  worker.tick(1);
  assert.ok(worker.ctx.engine!.vars[41]! > 0, "the old build kept playing");
  h.workspace.dispose();
});

test("the frozen debug lane never auto-updates — not even after Continue", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  await h.workspace.test();
  const worker = h.workers[0]!;
  assert.equal(h.workspace.state.runKind, "debug");
  assert.equal(h.workspace.state.phase, "stopped");

  h.edit(0, "increment(count);\nassignn(v42, 3);\nreturn;");
  h.workspace.noteDraftChanged();
  await flush();
  await flush();
  assert.equal(updatesOf(worker).length, 0, "debug posts no previewUpdate");
  assert.equal(h.workspace.state.stale, true, "the frozen build stays pinned");

  await h.workspace.continueRun();
  worker.tick(3);
  await h.workspace.pauseRun();
  assert.equal(updatesOf(worker).length, 0, "Continue does not unfreeze the lane");
  assert.equal(h.workspace.state.update.status, "idle");
  h.workspace.dispose();
});

test("ending the run with a proposal in flight never resurrects the preview", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  await h.workspace.play();
  const worker = h.workers[0]!;
  worker.holdUpdates = true;

  h.edit(0, "increment(count);\nassignn(v42, 11);\nreturn;");
  h.workspace.noteDraftChanged();
  await flush();
  await flush();
  assert.equal(updatesOf(worker).length, 1);

  h.workspace.endTest();
  assert.equal(worker.terminated, true);
  assert.equal(h.workspace.state.phase, "ended");

  // The held request dispatches into a dead worker — nothing comes back.
  worker.holdUpdates = false;
  worker.releaseHeld();
  await flush();
  await flush();
  assert.equal(h.workspace.state.phase, "ended");
  assert.equal(h.workers.length, 1, "no worker was respawned");
  h.workspace.dispose();
});

test("silence through both deadlines keeps one unresolved proposal — silence is no verdict", async (t) => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  t.after(() => h.workspace.dispose());
  const run = await h.workspace.play();
  const worker = h.workers[0]!;
  const bootBuild = run.buildId;

  worker.holdUpdates = true; // the request AND the reconciliation are held
  h.edit(0, "increment(count);\nassignn(v42, 10);\nreturn;");
  h.workspace.noteDraftChanged();
  await flush();
  await flush();
  assert.equal(updatesOf(worker).length, 1, "exactly one proposal is on the wire");

  // ACK watchdog, then the status watchdog: both expire unanswered. The
  // status query itself is in `held` — the lane never produced evidence.
  await clock.advance(140);
  assert.equal(updatesOf(worker).length, 1, "silence cannot authorize another mutation");
  assert.equal(h.workspace.state.update.status, "indeterminate");
  assert.equal(h.workspace.state.update.restartable, true);
  assert.equal(
    h.workspace.state.frozenSources["0"],
    COUNT_LOGIC,
    "the pinned authority stays the old build while the outcome is unknown",
  );
  assert.equal(h.workspace.state.buildId, bootBuild);
  assert.equal(h.workspace.state.stale, true, "the unproven draft stays stale");

  // A newer edit is held intent — it must not post over an unresolved attempt.
  h.edit(0, "increment(count);\nassignn(v42, 20);\nreturn;");
  h.workspace.noteDraftChanged();
  await flush();
  await clock.advance(60);
  assert.equal(updatesOf(worker).length, 1, "the queued edit cannot bypass the hold");

  // The held request reaches the worker: it commits, and its own late
  // result resolves the attempt — then only the newest draft proposes.
  worker.holdUpdates = false;
  worker.releaseHeld();
  await flush();
  await flush();
  await flush();

  const posts = updatesOf(worker);
  assert.equal(posts.length, 2, "the resolved attempt drained the newest draft once");
  assert.ok(posts[1]!.id > posts[0]!.id, "the drain is a fresh transaction, never a replay");
  assert.equal(
    posts[1]!.expected.updateSerial,
    1,
    "the newest candidate pinned the identity the first install left",
  );
  assert.equal(
    h.workspace.state.frozenSources["0"],
    "increment(count);\nassignn(v42, 20);\nreturn;",
  );
  assert.equal(h.workspace.state.update.status, "idle");
  assert.equal(h.workspace.state.stale, false);
  worker.tick(2);
  await h.workspace.pauseRun();
  assert.equal(await h.workspace.evaluate("v42"), 20);
});

test("a dropped request reconciles as untouched through the paced probe — newest draft, fresh id", async (t) => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  t.after(() => h.workspace.dispose());
  await h.workspace.play();
  const worker = h.workers[0]!;

  worker.dropNextRequest = true; // the request never ran
  worker.dropNextStatus = true; // and the first reconciliation is lost too
  h.edit(0, "increment(count);\nassignn(v42, 7);\nreturn;");
  h.workspace.noteDraftChanged();
  await flush();
  await flush();
  assert.equal(updatesOf(worker).length, 1);

  // Both watchdogs expire with no answer: the attempt holds indeterminate
  // instead of retrying on the cached identity.
  await clock.advance(140);
  assert.equal(h.workspace.state.update.status, "indeterminate");
  assert.equal(updatesOf(worker).length, 1, "no fresh mutation on silence");

  // The read-only probe keeps pacing: the first fresh answer proves the
  // lane untouched, so the newest draft retries under a new transaction.
  h.edit(0, "increment(count);\nassignn(v42, 9);\nreturn;");
  h.workspace.noteDraftChanged();
  await flush();
  await clock.advance(500);

  const statusPosts = worker.posts.filter((m) => m.type === "previewUpdateStatus");
  assert.ok(statusPosts.length >= 2, "reconciliation continued read-only while unknown");
  const posts = updatesOf(worker);
  assert.equal(posts.length, 2, "the proven-untouched lane took exactly one new proposal");
  assert.ok(posts[1]!.id > posts[0]!.id, "the retry minted a fresh id");
  assert.equal(posts[1]!.expected.updateSerial, 0, "the lane was verified still at its origin");
  assert.equal(h.workspace.state.update.status, "idle");
  assert.equal(
    h.workspace.state.frozenSources["0"],
    "increment(count);\nassignn(v42, 9);\nreturn;",
    "the newest draft — not the lost one — is what installed",
  );
  assert.equal(h.workspace.state.stale, false);
});

test("a refused replacement keeps the incumbent update's publication and its diagnostic", async (t) => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  t.after(() => h.workspace.dispose());
  const run = await h.workspace.play();
  const worker = h.workers[0]!;
  const bootBuild = run.buildId;

  // Candidate B is captured and posted, then held before its result lands.
  worker.holdUpdates = true;
  const sourceB = "increment(count);\nassignn(v42, 10);\nreturn;";
  h.edit(0, sourceB);
  h.workspace.noteDraftChanged();
  await flush();
  await flush();
  assert.equal(updatesOf(worker).length, 1);
  const candidate = updatesOf(worker)[0]!.candidate;

  // A newer draft fails a fresh Play admission — the incumbent run and its
  // in-flight update belong to the still-current physical run.
  h.edit(0, "this is not logic");
  await assert.rejects(h.workspace.play());
  assert.equal(h.workspace.state.buildFailed, true);
  assert.equal(h.workspace.state.phase, "running", "the incumbent kept running");

  worker.holdUpdates = false;
  worker.releaseHeld();
  await flush();
  await flush();
  await flush();

  // B's committed result repins BOTH layers: the session's run/restart
  // authority and the workspace's frozen source authority all name B.
  assert.equal(run.buildId, candidate.buildId, "the session installed B");
  assert.equal(h.workspace.state.buildId, candidate.buildId);
  assert.equal(h.workspace.state.frozenSources["0"], sourceB);
  const pinned = h.workspace.frozenBuild()!;
  assert.equal(pinned.capture.identity.buildId, candidate.buildId);
  assert.equal(pinned.capture.identity.revision, candidate.revision);
  assert.deepEqual(pinned.sourceBindings["count"], { kind: "variable", num: 41 });
  assert.ok(
    pinned.versions.every((v) => v.version === 2),
    "the frozen document versions are the candidate's own pins",
  );
  assert.equal(h.workspace.state.update.status, "idle", "the attempt settled");
  // The newer invalid draft keeps its own diagnostic — publishing B must
  // not erase C's refusal as a side effect.
  assert.equal(h.workspace.state.buildFailed, true);
  assert.match(h.workspace.state.error ?? "", /cannot build|expected/i);
  assert.equal(h.workspace.state.stale, true, "the broken draft still differs from B");

  // The pinned build is the restart target: a same-build restart boots B
  // and republishes B, not the pre-update A.
  await h.workspace.restartRun();
  assert.equal(h.workers.length, 2);
  assert.equal(worker.terminated, true);
  const restarted = h.workspace.run()!;
  assert.equal(restarted.buildId, candidate.buildId);
  assert.notEqual(restarted.buildId, bootBuild);
  assert.equal(h.workspace.state.frozenSources["0"], sourceB);
});

test("an identity-proven commit publishes and repins both layers under retained custody", async (t) => {
  // The worker processed the request and committed it, but every outcome
  // record was lost — only a fresh status answer's recomputed identity can
  // prove the landing. A scripted port emits the real wire shapes.
  const workers: ScriptedWorker[] = [];
  const { draft, edit } = makeDraft([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const workspace = createDebugWorkspace({
    draft,
    previewDebounceMs: 0,
    previewAckTimeoutMs: 60,
    acquirePauseLease: () => ({ release: () => undefined }),
    createSession: (options: TestSessionOptions) =>
      createTestSession({
        ...options,
        createWorker: () => {
          const worker = new ScriptedWorker();
          workers.push(worker);
          return worker;
        },
      }),
  });
  t.after(() => workspace.dispose());
  {
    const buildA = draft.captureTestBuild();
    const starting = workspace.play();
    const worker = workers[0]!;
    const bootId = (worker.posts[0] as { frozenTest: { id: number } }).frozenTest.id;
    worker.emit({
      type: "debugAttached",
      id: bootId,
      epoch: 7,
      buildId: buildA.capture.identity.buildId,
      preview: {
        runToken: "tok-1",
        epoch: 7,
        buildId: buildA.capture.identity.buildId,
        revision: buildA.capture.identity.revision,
        updateSerial: 0,
      },
    });
    worker.emit({ type: "booted", profile: PROFILE, kind: "default" });
    const run = await starting;
    assert.equal(run.preview!.runToken, "tok-1");

    edit(0, "increment(count);\nassignn(v42, 12);\nreturn;");
    workspace.noteDraftChanged();
    await flush();
    await flush();
    const posts = updatesOf(worker);
    assert.equal(posts.length, 1);
    const updateId = posts[0]!.id;
    const candidate = posts[0]!.candidate;

    // The ACK watchdog's own status query lands on the wire — answered with
    // no retained outcome but a recomputed identity that proves the
    // candidate's exact build at the next serial on this physical run.
    await clock.advance(80);
    const statusQuery = worker.posts.find((m) => m.type === "previewUpdateStatus") as
      { id: number; transactionId?: number } | undefined;
    assert.ok(statusQuery !== undefined);
    assert.equal(statusQuery.transactionId, updateId);
    worker.emit({
      type: "previewUpdateStatus",
      id: statusQuery.id,
      runToken: "tok-1",
      current: {
        epoch: 8,
        buildId: candidate.buildId,
        revision: candidate.revision,
        updateSerial: 1,
      },
      transaction: "unavailable",
    });
    await flush();
    await flush();

    // No fabricated outcome — the verdict stays indeterminate to the last —
    // but the identity proof repins the session's build AND publishes the
    // workspace's frozen authority under the retained candidate's custody.
    assert.equal(workspace.state.update.status, "idle");
    assert.equal(
      workspace.state.frozenSources["0"],
      "increment(count);\nassignn(v42, 12);\nreturn;",
    );
    assert.equal(workspace.state.buildId, candidate.buildId);
    assert.equal(workspace.state.stale, false);
    assert.equal(run.buildId, candidate.buildId, "the session repinned the same candidate");
    assert.equal(run.preview!.updateSerial, 1);
    assert.equal(run.preview!.epoch, 8);
  }
});

test("a delayed commit result settles its attempt without demoting the newer install or its saves", async (t) => {
  const h = makeHarness([{ num: 0, source: SOURCE_A }], COUNT_BINDINGS);
  t.after(() => h.workspace.dispose());
  const run = await h.workspace.play();
  const worker = h.workers[0]!;
  worker.tick(2);

  // B commits on the real worker, but its result is held past the ACK
  // watchdog — the retained ledger settles B honestly while it is newest.
  worker.holdNextResult = true;
  await editAndFlush(h, SOURCE_B);
  assert.equal(worker.heldOutbound.length, 1, "B's real commit result is held");
  const b = updatesOf(worker)[0]!;
  await clock.advance(65);
  assert.equal(run.buildId, b.candidate.buildId, "the status reconciliation proved B");
  assert.equal(h.workspace.state.frozenSources["0"], SOURCE_B);

  // C then commits normally and writes a real save under its own namespace.
  await editAndFlush(h, SOURCE_C);
  const c = updatesOf(worker)[1]!;
  assert.equal(run.buildId, c.candidate.buildId);
  assert.equal(run.preview!.updateSerial, 2);
  assert.equal(h.workspace.state.frozenSources["0"], SOURCE_C);
  await saveCurrent(h);
  worker.tick(2);
  assert.equal(worker.ctx.engine!.vars[42], 20, "the engine still runs C");
  const epochC = run.epoch;

  // B's delayed result is still fact about its own attempt — and nothing
  // else: C keeps every authority it already proved.
  worker.releaseOutbound();
  await flush();
  assert.equal(run.buildId, c.candidate.buildId, "the delayed result cannot demote C");
  assert.equal(run.preview!.buildId, c.candidate.buildId);
  assert.equal(run.preview!.updateSerial, 2);
  assert.equal(run.epoch, epochC, "the session epoch cannot regress");
  assert.equal(h.workspace.state.buildId, c.candidate.buildId);
  assert.equal(h.workspace.state.frozenSources["0"], SOURCE_C);
  assert.equal(h.workspace.state.stale, false);
  assert.equal(h.session.saves().length, 1, "C's save namespace was never cleared");
  assert.equal(worker.ctx.engine!.vars[42], 20);

  await h.workspace.restartRun();
  assert.equal(h.workers.length, 2, "restart boots a fresh worker");
  assert.equal(h.workspace.run()!.buildId, c.candidate.buildId, "restart still targets C");
});

test("a named status read of a superseded commit reports it without demoting the run", async (t) => {
  const h = makeHarness([{ num: 0, source: SOURCE_A }], COUNT_BINDINGS);
  t.after(() => h.workspace.dispose());
  const run = await h.workspace.play();
  const worker = h.workers[0]!;
  worker.tick(2);
  await editAndFlush(h, SOURCE_B);
  const b = updatesOf(worker)[0]!;
  await editAndFlush(h, SOURCE_C);
  const c = updatesOf(worker)[1]!;
  assert.equal(run.buildId, c.candidate.buildId);
  await saveCurrent(h);

  // The public read names B's transaction: the retained record is B's own
  // outcome and must read back truthfully — on normal FIFO, with nothing
  // lost — while the recomputed identity still reports C.
  const report = await h.session.previewStatus(b.id);
  assert.ok(
    typeof report.transaction === "object" && report.transaction !== null,
    "the named transaction's retained record reads back",
  );
  assert.equal(report.transaction.id, b.id);
  assert.equal(report.transaction.outcome.status, "committed");
  assert.equal(report.current!.buildId, c.candidate.buildId, "the worker still reports C");

  assert.equal(run.buildId, c.candidate.buildId, "a historical read cannot demote C");
  assert.equal(run.preview!.buildId, c.candidate.buildId);
  assert.equal(run.preview!.updateSerial, 2);
  assert.equal(h.workspace.state.buildId, c.candidate.buildId);
  assert.equal(h.session.saves().length, 1, "the read never cleared C's saves");

  const restarted = await h.session.restart();
  assert.equal(restarted.buildId, c.candidate.buildId, "restart still targets C");
});

test("a stale probe answer settles nothing once the late result already drained the newest draft", async (t) => {
  const h = makeHarness([{ num: 0, source: SOURCE_A }], COUNT_BINDINGS);
  t.after(() => h.workspace.dispose());
  const run = await h.workspace.play();
  const worker = h.workers[0]!;
  worker.tick(2);

  // B's result is held and its first reconciliation is lost: the attempt
  // holds unresolved and the paced read-only probe takes over.
  worker.holdNextResult = true;
  worker.dropNextStatus = true;
  await editAndFlush(h, SOURCE_B);
  const b = updatesOf(worker)[0]!;
  await clock.advance(100);
  assert.equal(h.workspace.state.update.status, "indeterminate");
  await editAndFlush(h, SOURCE_C);
  assert.equal(updatesOf(worker).length, 1, "C queues behind the unresolved B");

  // Hold the probe's real answer — computed while B was still the newest
  // known authority — while B's own late result lands and drains C.
  worker.holdNextStatus = true;
  await clock.advance(400);
  assert.equal(worker.heldOutbound.length, 2, "the paced probe's real answer is held");
  const ack = worker.heldOutbound.shift()!;
  assert.equal(ack.type, "previewUpdateResult");
  const heldStatus = worker.heldOutbound[0]!;
  assert.equal(heldStatus.type, "previewUpdateStatus");
  assert.equal(
    (heldStatus as { transaction: { id: number } | null }).transaction?.id,
    b.id,
    "the held answer carries B's own retained record",
  );
  worker.onmessage?.({ data: ack });
  await flush();
  await flush();
  const c = updatesOf(worker)[1]!;
  assert.equal(run.buildId, c.candidate.buildId, "B's late result resolved it and drained C");
  assert.equal(run.preview!.updateSerial, 2);
  await saveCurrent(h);

  // The stale answer still resolves its own read — and changes nothing:
  // its pre-C snapshot cannot regress the lane and its retained B record
  // cannot demote C's installed authority.
  worker.releaseOutbound();
  await flush();
  assert.equal(run.buildId, c.candidate.buildId, "the stale answer cannot demote C");
  assert.equal(run.preview!.buildId, c.candidate.buildId);
  assert.equal(run.preview!.updateSerial, 2);
  assert.equal(h.workspace.state.buildId, c.candidate.buildId);
  assert.equal(h.workspace.state.frozenSources["0"], SOURCE_C);
  assert.equal(h.workspace.state.stale, false);
  assert.equal(h.session.saves().length, 1, "C's save survives the stale answer");
});

test("a delayed same-build commit proves itself on serial and keeps the namespace through restart", async (t) => {
  const h = makeHarness([{ num: 0, source: SOURCE_A }], {
    count: { kind: "variable", num: 41 },
    marker: { kind: "variable", num: 50 },
  });
  t.after(() => h.workspace.dispose());
  const run = await h.workspace.play();
  const worker = h.workers[0]!;
  worker.tick(2);
  const bootBuild = run.buildId;
  await saveCurrent(h);

  // A kind-only binding change commits under the SAME build identity —
  // the serial bump, not a different build id, is the install's proof.
  worker.holdNextResult = true;
  h.setBindings({ count: { kind: "variable", num: 41 }, marker: { kind: "flag", num: 50 } });
  h.workspace.noteDraftChanged();
  await flush();
  await flush();
  const b = updatesOf(worker)[0]!;
  assert.equal(b.candidate.buildId, bootBuild, "kind-only drift keeps the captured identity");
  await clock.advance(65); // the watchdog reconciles the held commit
  assert.equal(run.buildId, bootBuild);
  assert.equal(run.preview!.updateSerial, 1, "the same-build commit still installed");
  assert.equal(h.session.saves().length, 1, "the namespace is still the same build's");
  assert.equal(h.workspace.state.update.status, "idle");
  assert.equal(h.workspace.state.stale, false);

  // The held result arrives after its own reconciliation: the identical
  // bookkeeping applies once — nothing demotes and nothing clears.
  worker.releaseOutbound();
  await flush();
  assert.equal(run.buildId, bootBuild);
  assert.equal(run.preview!.updateSerial, 1);
  assert.equal(h.session.saves().length, 1);

  await h.workspace.restartRun();
  assert.equal(h.workers.length, 2);
  assert.equal(h.workspace.run()!.buildId, bootBuild, "restart boots the same-build authority");
  assert.equal(h.session.saves().length, 1, "the same-build restart kept its slots");
});
