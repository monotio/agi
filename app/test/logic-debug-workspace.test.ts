import { scheduler as testScheduler } from "node:timers/promises";
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
 * The D6 workspace view model driven through the production session and a
 * real Engine on the worker's own dispatch — no substitute runtime. The fake
 * port only stops timers so tests advance the interpreter explicitly.
 */

const PROFILE: ProfileId = "2.411";
const profile: AgiProfile = PROFILES[PROFILE]!;

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

async function flush(): Promise<void> {
  await testScheduler.yield();
}

type Bindings = Record<string, { kind: string; num: number }>;

/**
 * A mutable draft authority the workspace freezes: `captureTestBuild`
 * compiles the CURRENT source map under the current bindings, exactly as the
 * real draft source does, so a draft edit between builds changes the bytes.
 */
function makeDraft(
  logics: { num: number; source: string }[],
  bindings: Bindings = {},
): { draft: DebugDraftSource; edit(num: number, source: string): void } {
  const current = new Map(logics.map((entry) => [entry.num, entry.source]));
  let version = 1;
  const captureBuild = (): DebugTestBuild => {
    const container = createContainer();
    const projected = Object.fromEntries(
      Object.entries(bindings).map(([name, b]) => [name, { num: b.num }]),
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
      sourceBindings: bindings as DebugTestBuild["sourceBindings"],
      capture,
      versions: [...current.keys()].map((num) => ({ key: `logic:${num}`, version })),
      diagnostics: [],
    };
  };
  return {
    draft: {
      captureTestBuild: captureBuild,
      currentVersions: () => [...current.keys()].map((num) => ({ key: `logic:${num}`, version })),
    },
    edit(num, source) {
      current.set(num, source);
      version++;
    },
  };
}

interface Harness {
  readonly workspace: ReturnType<typeof createDebugWorkspace>;
  readonly workers: FakeWorker[];
  readonly leases: { released: boolean }[];
  readonly navigated: { key: string; line: number; column?: number }[];
}

function makeHarness(
  logics: { num: number; source: string }[],
  bindings: Bindings = {},
  extra: { presentations?: WorkerOutbound[] } = {},
): Harness & { edit(num: number, source: string): void } {
  const workers: FakeWorker[] = [];
  const leases: { released: boolean }[] = [];
  const navigated: { key: string; line: number; column?: number }[] = [];
  const { draft, edit } = makeDraft(logics, bindings);
  const presentations = extra.presentations;
  const workspace = createDebugWorkspace({
    draft,
    acquirePauseLease: () => {
      const lease = { released: false };
      leases.push(lease);
      return { release: () => (lease.released = true) };
    },
    createSession: (options: TestSessionOptions) => createTestSession(options),
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    ...(presentations ? { onPresentation: (msg) => presentations.push(msg) } : {}),
    navigate: (target) => navigated.push(target),
  });
  return { workspace, workers, leases, navigated, edit };
}

const COUNT_LOGIC = "increment(count);\nassignn(v42, 5);\nreturn;";
const COUNT_BINDINGS: Bindings = {
  count: { kind: "variable", num: 41 },
};

test("Test freezes the complete draft; later draft edits stay out of the pinned run", async () => {
  const h = makeHarness([{ num: 0, source: "increment(count);\nreturn;" }], COUNT_BINDINGS);
  const run = await h.workspace.test();
  assert.equal(h.workers.length, 1);
  assert.equal(h.workspace.state.phase, "stopped", "the entry stop latches before cycle one");
  assert.equal(h.workspace.state.buildId, run.buildId);
  assert.equal(h.leases.length, 1);
  assert.equal(h.leases[0]!.released, false);
  assert.equal(h.workspace.state.stale, false, "the draft and the pinned build agree");

  // The author edits the draft while the frozen run stays pinned.
  h.edit(0, "assignn(count, 99);\nreturn;");
  assert.equal(h.workspace.state.stale, true);

  // Continuing runs the OLD bytes: count increments, never assigned 99.
  await h.workspace.continueRun();
  h.workers[0]!.tick(2);
  await h.workspace.pauseRun();
  const count = await h.workspace.evaluate("count");
  assert.ok(typeof count === "number" && count > 0, "the frozen logic incremented");
  assert.notEqual(count, 99, "the draft edit never entered the pinned run");
  assert.equal(count, h.workspace.state.stop!.state.vars[41]);
  h.workspace.dispose();
});

test("a held stop pulls a repaint frame through the worker's render lane", async () => {
  const presentations: WorkerOutbound[] = [];
  const h = makeHarness([{ num: 0, source: "return;" }], {}, { presentations });
  await h.workspace.test();
  // The poll suppresses frame posts while the entry stop is held; the
  // workspace pulls the parked presentation through `renderFrame`, the same
  // repaint message the live host sends.
  assert.ok(
    h.workers[0]!.posts.some((msg) => msg.type === "renderFrame"),
    "the stop requested a repaint",
  );
  assert.ok(
    presentations.some((msg) => msg.type === "frame"),
    "the parked frame reached the presentation stream",
  );
  h.workspace.dispose();
});

test("a compile failure refuses the test before a worker or lease exists", async () => {
  const h = makeHarness([{ num: 0, source: "this is not logic" }]);
  await assert.rejects(() => h.workspace.test(), /cannot build|expected/i);
  assert.equal(h.workers.length, 0);
  assert.equal(h.leases.length, 0);
  assert.match(h.workspace.state.error ?? "", /cannot build|expected/i);
  assert.equal(h.workspace.state.phase, "idle");
  h.workspace.dispose();
});

test("a source breakpoint binds, stops before its statement, and hits report", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  h.workspace.toggleBreakpoint({ logic: 0, line: 2 }); // assignn(v42, 5)
  assert.ok(
    h.workspace.state.breakpoints.some((b) => b.spec.line === 2),
    "the gutter row exists",
  );

  const run = await h.workspace.test();
  void run;
  const row = h.workspace.state.breakpoints.find((b) => b.spec.line === 2);
  assert.ok(row);
  assert.equal(row?.binding?.bound, true, "the worker bound the spec against the frozen build");

  await h.workspace.continueRun();
  h.workers[0]!.tick(1);
  const stop = h.workspace.state.stop;
  assert.ok(stop, "the breakpoint stopped the run");
  assert.equal(
    stop!.reasons.some((r) => r.kind === "breakpoint"),
    true,
  );
  assert.equal(stop!.state.vars[42], 0, "the statement has not run yet");
  assert.equal(h.workspace.state.phase, "stopped");

  // The stop resolves to the authored line through the exact source map.
  const at = h.workspace.state.stopLocation;
  assert.ok(at !== null);
  assert.equal(at!.key, "logic:0");
  assert.equal(at!.line, 2);
  h.workspace.dispose();
});

test("stale inspection and evaluation replies are dropped on a newer stop", async () => {
  const h = makeHarness(
    [{ num: 0, source: "increment(count);\nincrement(count);\nreturn;" }],
    COUNT_BINDINGS,
  );
  await h.workspace.test();
  const first = h.workspace.state.stop!;
  const early = h.workspace.inspect("state");
  const earlyEval = h.workspace.evaluate("count");

  // A resume invalidates the pinned stop; the late replies must not land.
  await h.workspace.continueRun();
  h.workers[0]!.tick(2);
  await h.workspace.pauseRun();
  await Promise.allSettled([early, earlyEval]);
  const now = h.workspace.state.stop!;
  assert.notEqual(now.stopId, first.stopId);
  // The inspector now reads the new pin, not the old stop's snapshot.
  await flush();
  assert.equal(h.workspace.state.inspection.stopId, now.stopId);
  assert.equal(await h.workspace.evaluate("count"), now.state.vars[41]);
  h.workspace.dispose();
});

test("breakpoint spec validation refuses a bad condition before configure traffic", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  await h.workspace.test();
  h.workspace.toggleBreakpoint({ logic: 0, line: 1 });
  const postsBefore = h.workers[0]!.posts.filter((m) => m.type === "debugConfigure").length;

  const verdict = h.workspace.updateBreakpoint("logic:0:1", { condition: "v41 +++ 2" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? "", /condition|character|expression/i);
  assert.equal(
    h.workers[0]!.posts.filter((m) => m.type === "debugConfigure").length,
    postsBefore,
    "an invalid spec never reaches the worker",
  );
  h.workspace.dispose();
});

test("a hit policy and logpoint validate as real spec fields", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  h.workspace.toggleBreakpoint({ logic: 0, line: 2 });
  const verdict = h.workspace.updateBreakpoint("logic:0:2", {
    hit: { kind: "every", count: 2 },
    log: { segments: [{ type: "literal", text: "count={count}" }] },
  });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  const bad = h.workspace.updateBreakpoint("logic:0:2", {
    hit: { kind: "every", count: 0 },
  });
  assert.equal(bad.ok, false);
  const badLog = h.workspace.updateBreakpoint("logic:0:2", {
    log: { segments: [] },
  });
  assert.equal(badLog.ok, false);
  h.workspace.dispose();
});

test("a watchpoint on a variable stops with the change recorded", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const verdict = h.workspace.addWatch({ kind: "variable", index: 41 });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  await h.workspace.test();
  await h.workspace.continueRun();
  h.workers[0]!.tick(1);
  await flush();
  const stop = h.workspace.state.stop;
  assert.ok(stop !== null);
  const watch = stop!.reasons.find((r) => r.kind === "watch");
  assert.ok(watch, "the run stopped on the watched variable");
  assert.equal(watch!.kind === "watch" && watch!.changes[0]!.new === 1, true);
  h.workspace.dispose();
});

test("a bad watch target is refused locally before configure", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const bad = h.workspace.addWatch({ kind: "variable", index: 300 });
  assert.equal(bad.ok, false);
  const badCondition = h.workspace.addWatch({ kind: "flag", index: 32 }, "new + 1");
  assert.equal(badCondition.ok, false, "a flag watch's old/new are boolean");
  h.workspace.dispose();
});

test("setValues writes through the service and marks the run modified", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await h.workspace.test();
  const epoch = run.epoch;
  const before = h.workspace.state.stop!;
  const nextId = await h.workspace.setValues({ vars: [[41, 77]] });
  assert.notEqual(nextId, before.stopId);
  assert.equal(h.workspace.state.modified, true);
  assert.equal(await h.workspace.evaluate("count"), 77);
  assert.equal(run.epoch, epoch, "set-values keeps the run's epoch");
  h.workspace.dispose();
});

test("run-to-cursor maps a draft line to the frozen statement pc", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  await h.workspace.test();
  await h.workspace.continueRun();
  h.workers[0]!.tick(1);
  await h.workspace.pauseRun();
  const verdict = await h.workspace.runToCursor("logic:0", 3);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  const posted = h.workers[0]!.posts.find((m) => m.type === "debugRunTo");
  assert.ok(posted && posted.type === "debugRunTo");
  assert.equal(posted.location.logic, 0);
  h.workers[0]!.tick(2);
  await flush();
  assert.equal(await h.workspace.evaluate("v42"), 5, "line 3's assignment ran");
  h.workspace.dispose();
});

test("stop navigation lands on the authored line through the source map", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  await h.workspace.test();
  await h.workspace.continueRun();
  h.workers[0]!.tick(1);
  await h.workspace.pauseRun();
  const done = h.workspace.navigateToStop();
  // Idle/phase stops without a LOGIC location answer false honestly.
  if (h.workspace.state.stopLocation !== null) {
    assert.equal(done, true);
    const last = h.navigated.at(-1)!;
    assert.equal(last.key, "logic:0");
    assert.ok(last.line >= 1);
  } else {
    assert.equal(done, false);
  }
  h.workspace.dispose();
});

test("game input reaches only a running test worker — never a stopped one", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  await h.workspace.test();
  h.workspace.key(0x0d);
  h.workspace.submitInput("look");
  h.workspace.click(10, 10);
  h.workspace.direction(1);
  const posts = h.workers[0]!.posts;
  assert.equal(
    posts.some((m) => m.type === "key"),
    false,
    "stopped input never posts",
  );
  assert.equal(
    posts.some((m) => m.type === "input"),
    false,
  );
  await h.workspace.continueRun();
  h.workers[0]!.tick(1);
  h.workspace.key(0x0d);
  assert.equal(
    posts.some((m) => m.type === "key"),
    true,
    "running input posts",
  );
  h.workspace.dispose();
});

test("an open prompt resolves through the run and aborts on end", async () => {
  const h = makeHarness([
    { num: 0, source: '#message 1 "Name?"\nget.string(s5, m1, 22, 0, 30);\nreturn;' },
  ]);
  await h.workspace.test();
  await h.workspace.continueRun();
  h.workers[0]!.tick(1);
  await flush();
  const prompt = h.workspace.state.prompt;
  assert.ok(prompt !== null, "get.string surfaced a prompt");
  assert.equal(prompt!.kind, "string");
  h.workspace.submitPrompt("ada");
  await flush();
  assert.equal(h.workspace.state.prompt, null);
  await h.workspace.pauseRun();
  assert.equal(await h.workspace.evaluate("s5"), "ada");
  h.workspace.dispose();
});

test("dispose ends the run: worker down, lease released, prompt aborted", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  await h.workspace.test();
  h.workspace.dispose();
  assert.equal(h.workers[0]!.terminated, true);
  assert.equal(h.leases[0]!.released, true);
  assert.equal(h.workspace.state.phase, "ended");
  assert.equal(h.workspace.state.stop, null);
});

test("restart tests the latest draft while the old worker is gone", async () => {
  const h = makeHarness([{ num: 0, source: "increment(count);\nreturn;" }], COUNT_BINDINGS);
  const firstRun = await h.workspace.test();
  h.edit(0, "assignn(count, 40);\nincrement(count);\nreturn;");
  const secondRun = await h.workspace.test();
  assert.equal(h.workers.length, 2);
  assert.equal(h.workers[0]!.terminated, true);
  assert.notEqual(secondRun.buildId, firstRun.buildId);
  assert.equal(h.workspace.state.stale, false);
  await h.workspace.continueRun();
  h.workers[1]!.tick(2);
  await h.workspace.pauseRun();
  assert.equal(await h.workspace.evaluate("count"), 41);
  h.workspace.dispose();
});

test("the read context reports the frozen build, stop and honest stale state", async () => {
  const h = makeHarness([{ num: 0, source: COUNT_LOGIC }], COUNT_BINDINGS);
  const run = await h.workspace.test();
  const ctx = h.workspace.contextLines().join("\n");
  assert.match(ctx, new RegExp(run.buildId.slice(0, 12)));
  assert.match(ctx, /stopped/i);
  h.edit(0, "return;");
  const stale = h.workspace.contextLines().join("\n");
  assert.match(stale, /stale|changed/i);
  h.workspace.dispose();
});

const PROMPT_LOGIC =
  '#message 1 "Name?"\n' +
  "if (isset(f10)) { reset(f10); get.string(s5, m1, 22, 0, 30); }\n" +
  "return;";

test("a host answer queued on a held stop applies on resume, never mid-stop", async () => {
  const h = makeHarness([{ num: 0, source: PROMPT_LOGIC }]);
  await h.workspace.test();
  // Arm the ask via a flag write — the mutation refreshes the held stop.
  await h.workspace.setValues({ flags: [[10, 1]] });
  await h.workspace.continueRun();
  h.workers[0]!.tick(1);
  await flush();
  assert.ok(h.workspace.state.prompt !== null, "get.string parked on a host prompt");
  assert.equal(h.workspace.state.waiting, "host");

  // Pause while the prompt is outstanding: the wait survives the stop.
  await h.workspace.pauseRun();
  assert.equal(h.workspace.state.phase, "stopped");
  h.workspace.submitPrompt("queued");
  await flush();
  assert.equal(h.workspace.state.answersReady, 1, "the answered prompt queues on the held stop");

  await h.workspace.continueRun();
  h.workers[0]!.tick(1);
  await h.workspace.pauseRun();
  assert.equal(await h.workspace.evaluate("s5"), "queued");
  assert.equal(h.workspace.state.prompt, null);
  h.workspace.dispose();
});

const SAVE_LOGIC =
  "if (isset(f10)) { reset(f10); save.game(); }\n" +
  "if (isset(f11)) { reset(f11); restore.game(); }\n" +
  "increment(count);\n" +
  "return;";

test("save and restore round-trip through the run's private ephemeral slots", async () => {
  const h = makeHarness([{ num: 0, source: SAVE_LOGIC }], COUNT_BINDINGS);
  await h.workspace.test();
  assert.equal(h.workspace.saves().length, 0);

  // Drive the real save selector: flag → list → pick slot 1 → describe →
  // confirm → write. Keys route while the engine waits on the selector.
  await h.workspace.setValues({ flags: [[10, 1]] });
  await h.workspace.continueRun();
  h.workers[0]!.tick(2);
  await flush();
  h.workspace.key(13);
  h.workers[0]!.tick(2);
  await flush();
  assert.ok(h.workspace.state.prompt !== null, "the describe need surfaces a prompt");
  h.workspace.submitPrompt("slot one");
  await flush();
  h.workspace.key(13);
  h.workers[0]!.tick(2);
  await flush();
  const saves = h.workspace.saves();
  assert.equal(saves.length, 1, "one private slot in the test store");
  assert.equal(saves[0]!.description, "slot one");

  // Advance state, then restore: count returns to the saved image's value.
  h.workers[0]!.tick(3);
  await h.workspace.pauseRun();
  const grown = await h.workspace.evaluate("count");
  assert.equal(typeof grown === "number" && grown > 0, true);
  await h.workspace.setValues({ flags: [[11, 1]] });
  await h.workspace.continueRun();
  h.workers[0]!.tick(2);
  await flush();
  h.workspace.key(13);
  h.workers[0]!.tick(2);
  await flush();
  await h.workspace.pauseRun();
  const restored = await h.workspace.evaluate("count");
  assert.equal(
    typeof restored === "number" && restored < (grown as number),
    true,
    "the restore put the saved image's counter back",
  );

  // A same-build restart keeps the private store; the session's epoch resets.
  await h.workspace.restartRun();
  assert.equal(h.workspace.saves().length, 1, "slots survive a same-build restart");
  h.workspace.dispose();
});
