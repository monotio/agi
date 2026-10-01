import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWorkerContext,
  type WorkerContext,
  type WorkerPorts,
} from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { createDebugController } from "../src/worker/debugController.ts";
import { installDebugController } from "../src/worker/debugLoader.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type {
  SourceBindingKind,
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
} from "../src/worker/workerProtocol.ts";
import { createContainer } from "../../src/container/container.ts";
import { compileProjectLogic } from "../../src/authoring/projectLogic.ts";
import { captureProjectBuild } from "../../src/authoring/projectBuild.ts";
import { PROFILES, type AgiProfile } from "../../src/runtime/profile.ts";

/**
 * The frozen-test boot admission: an optional `frozenTest` policy on the boot
 * message drives debugger attach, atomic configuration and the entry pause
 * synchronously inside the boot branch — before timers start and before
 * `booted` posts. Driven on the real dispatch with fake ports and a real
 * Engine, the same path engine.worker.ts executes.
 */

const PROFILE = "2.411";
const profile: AgiProfile = PROFILES[PROFILE];

interface Harness {
  ctx: WorkerContext;
  control: WorkerControl[];
  presentation: WorkerPresentation[];
  send: (msg: WorkerInbound) => void;
  tick: (n?: number) => void;
}

function harness(): Harness {
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  let now = 0;
  const ports: WorkerPorts = {
    control: (msg) => control.push(msg),
    presentation: (msg) => presentation.push(msg),
    now: () => now,
    seedWord: () => 0x1234,
  };
  const ctx = createWorkerContext(ports);
  // The production path lazy-loads the controller; the fake-port harness
  // installs it up front so the synchronous assertions stay synchronous.
  installDebugController(ctx, createDebugController(ctx));
  ctx.host = createEngineHost(ctx);
  const send = (msg: WorkerInbound): void => {
    onWorkerMessage(ctx, msg);
    // Keep the run deterministic: real timers arm inside the boot branch, so
    // stop them once dispatch returns and drive polls explicitly.
    ctx.fns.stopTimers();
  };
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  return { ctx, control, presentation, send, tick };
}

function controls(h: Harness, type: string): Record<string, unknown>[] {
  return h.control.filter((m) => m.type === type) as Record<string, unknown>[];
}

function lastControl(h: Harness, type: string): Record<string, unknown> {
  const found = controls(h, type);
  assert.ok(found.length > 0, `expected a ${type} control message`);
  return found.at(-1)!;
}

type SourceBindings = Record<string, { kind: SourceBindingKind; num: number }>;

interface TestGame {
  files: Record<string, Uint8Array>;
  sources: Record<string, string>;
  bindings: SourceBindings;
}

/** Compile real LOGIC payloads under the authored binding map, then containerize. */
function testGame(
  logics: { num: number; source: string }[],
  bindings: SourceBindings = {},
): TestGame {
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
  return { files: Object.fromEntries(container.files), sources, bindings };
}

function expectedBuildId(game: TestGame): string {
  return captureProjectBuild({
    files: game.files,
    profileId: PROFILE,
    sources: game.sources,
    bindings: Object.fromEntries(
      Object.entries(game.bindings).map(([name, b]) => [name, { num: b.num }]),
    ),
  }).identity.buildId;
}

test("frozen test admission attaches, configures and pauses before the first tick", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: "assignn(my_count, 1);\nassignn(v41, 2);\nreturn;" }], {
    my_count: { kind: "variable", num: 40 },
    second_room: { kind: "logic", num: 1 },
  });
  h.send({
    type: "boot",
    files: game.files,
    words: [],
    profile: PROFILE,
    // Options a live boot honors are pinned off by the test policy.
    authorRooms: true,
    autosaveMs: 1,
    autosaveFiles: true,
    frozenTest: {
      id: 500,
      sources: game.sources,
      sourceBindings: game.bindings,
      bindings: { my_count: { kind: "variable", num: 40 } },
      breakpoints: [{ id: "b1", enabled: true, logic: 0, line: 2, mode: "statement" }],
    },
  });

  // The full admission landed synchronously ahead of `booted`.
  const order: string[] = h.control.map((m) => m.type);
  const bootedAt = order.indexOf("booted");
  assert.ok(bootedAt > 0, "the frozen boot still reports booted once admitted");
  for (const type of ["debugAttached", "debugConfigured", "debugStopped", "debugAck"]) {
    const at = order.indexOf(type);
    assert.ok(at >= 0 && at < bootedAt, `${type} must precede booted`);
  }
  const attached = lastControl(h, "debugAttached");
  assert.equal(attached["id"], 500);
  assert.equal(attached["buildId"], expectedBuildId(game));
  const epoch = attached["epoch"] as number;

  // The entry stop is honest: an idle wait with no fabricated resume point.
  const stopped = lastControl(h, "debugStopped");
  assert.equal(stopped["epoch"], epoch);
  assert.equal(stopped["location"], null);
  assert.equal(stopped["wait"], null);
  assert.deepEqual(stopped["cause"], { type: "wait", wait: "idle" });
  assert.equal(h.ctx.engine!.executionStopInfo !== null, true);

  // Frozen: polls, sound clock and input all inert until the run resumes.
  h.send({ type: "key", code: 0x0d });
  h.send({ type: "input", text: "look" });
  h.tick(5);
  assert.equal(h.ctx.cycle.cycleCount, 0);
  assert.equal(h.ctx.engine!.vars[40], 0);
  assert.equal(h.ctx.input.keyQueue.length, 0, "stopped input is refused, not queued");
  assert.equal(h.ctx.input.inputBuffer.length, 0);

  // No ordinary recording or autosave machinery runs under a test policy.
  assert.equal(h.ctx.history.segment, null);
  assert.equal(h.ctx.boot.authorRooms, false);
  assert.equal(controls(h, "historyBatch").length, 0);
  assert.equal(
    controls(h, "autosave").length + h.presentation.filter((m) => m.type === "autosave").length,
    0,
  );

  // Continue releases the latch; the armed breakpoint stops the pass at line 2.
  h.send({
    type: "debugResume",
    id: 501,
    epoch,
    stopId: stopped["stopId"] as number,
    action: "continue",
  });
  h.tick(3);
  const hit = lastControl(h, "debugStopped");
  const reasons = hit["reasons"] as { kind: string; id?: string }[];
  assert.deepEqual(reasons[0], { kind: "breakpoint", id: "b1", hitCount: 1 });
  assert.equal(h.ctx.engine!.vars[40], 1);
  assert.equal(h.ctx.engine!.vars[41], 0);
});

test("a breakpoint on the first instruction fires on the poll right after boot", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: "assignn(v40, 7);\nreturn;" }]);
  h.send({
    type: "boot",
    files: game.files,
    words: [],
    profile: PROFILE,
    frozenTest: {
      id: 510,
      sources: game.sources,
      breakpoints: [{ id: "first", enabled: true, logic: 0, line: 1, mode: "statement" }],
      stopOnEntry: false,
    },
  });
  assert.equal(controls(h, "debugError").length, 0);
  assert.equal(controls(h, "booted").length, 1);
  // No stop yet — the run is live but armed; the first boundary still halts it.
  assert.equal(controls(h, "debugStopped").length, 0);
  // A timer delivered immediately after boot handling still meets the breakpoint.
  h.tick(1);
  const stopped = lastControl(h, "debugStopped");
  const reasons = stopped["reasons"] as { kind: string; id?: string }[];
  assert.equal(reasons[0]!.kind, "breakpoint");
  assert.equal(reasons[0]!.id, "first");
  assert.equal(h.ctx.engine!.vars[40], 0, "the stop precedes the first instruction");
});

test("a source that does not reproduce the container refuses admission cleanly", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: "return;" }]);
  h.send({
    type: "boot",
    files: game.files,
    words: [],
    profile: PROFILE,
    frozenTest: {
      id: 520,
      // Claims a program the bytes do not contain.
      sources: { "0": "assignn(v40, 1);\nreturn;" },
    },
  });
  const refused = lastControl(h, "debugError");
  assert.equal(refused["id"], 520);
  assert.equal(refused["code"], "invalidRequest");
  assert.match(String(refused["error"]), /reproduce/);
  // Clean refusal: no ready report, no timers, no runnable engine.
  assert.equal(controls(h, "booted").length, 0);
  assert.equal(h.ctx.engine, null);
  assert.equal(h.ctx.cycle.timer, null);
  assert.equal(h.ctx.cycle.soundTimer, null);
  h.tick(3);
  assert.equal(h.ctx.cycle.cycleCount, 0);
});

test("replay and autosave-resume options are refused under a test policy", () => {
  for (const extra of [{ replaySeed: 4 }, { restoreImage: "AAAA" }]) {
    const h = harness();
    const game = testGame([{ num: 0, source: "return;" }]);
    h.send({
      type: "boot",
      files: game.files,
      words: [],
      profile: PROFILE,
      ...extra,
      frozenTest: { id: 530, sources: game.sources },
    });
    assert.equal(lastControl(h, "debugError")["code"], "invalidRequest");
    assert.equal(controls(h, "booted").length, 0);
    assert.equal(h.ctx.engine, null);
  }
});

test("expression bindings must be an exact subview of the source binding map", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: "return;" }], {
    room_castle: { kind: "logic", num: 1 },
  });
  // A name/number that disagrees with the authored map refuses admission.
  h.send({
    type: "boot",
    files: game.files,
    words: [],
    profile: PROFILE,
    frozenTest: {
      id: 540,
      sources: game.sources,
      sourceBindings: game.bindings,
      bindings: { room_castle: { kind: "variable", num: 1 } },
    },
  });
  assert.equal(lastControl(h, "debugError")["code"], "invalidRequest");
  assert.equal(controls(h, "booted").length, 0);

  // A resource-kind name in the expression map refuses too.
  const h2 = harness();
  h2.send({
    type: "boot",
    files: game.files,
    words: [],
    profile: PROFILE,
    frozenTest: {
      id: 541,
      sources: game.sources,
      sourceBindings: game.bindings,
      // A deliberately wrong kind on the wire — the worker must refuse it.
      bindings: { room_castle: { kind: "logic" as "variable", num: 1 } },
    },
  });
  assert.equal(lastControl(h2, "debugError")["code"], "invalidRequest");
  assert.equal(controls(h2, "booted").length, 0);

  // The exact subview admits and the capture identity covers every name.
  const h3 = harness();
  h3.send({
    type: "boot",
    files: game.files,
    words: [],
    profile: PROFILE,
    frozenTest: {
      id: 542,
      sources: game.sources,
      sourceBindings: game.bindings,
      bindings: {},
    },
  });
  assert.equal(lastControl(h3, "debugAttached")["buildId"], expectedBuildId(game));
});

test("an invalid source binding entry refuses admission", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: "return;" }]);
  h.send({
    type: "boot",
    files: game.files,
    words: [],
    profile: PROFILE,
    frozenTest: {
      id: 550,
      sources: game.sources,
      // A kind that is not in the authored vocabulary must refuse.
      sourceBindings: { bogus: { kind: "directory" as SourceBindingKind, num: 1 } },
    },
  });
  assert.equal(lastControl(h, "debugError")["code"], "invalidRequest");
  assert.equal(controls(h, "booted").length, 0);
});

test("frozen test pins room generation off; a missing room reports the engine's outcome", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: "new.room(7);" }]);
  h.send({
    type: "boot",
    files: game.files,
    words: [],
    profile: PROFILE,
    authorRooms: true,
    frozenTest: { id: 560, sources: game.sources },
  });
  assert.equal(h.ctx.boot.authorRooms, false);
  const stopped = lastControl(h, "debugStopped");
  h.send({
    type: "debugResume",
    id: 561,
    epoch: lastControl(h, "debugAttached")["epoch"] as number,
    stopId: stopped["stopId"] as number,
    action: "continue",
  });
  // No generation request ever reaches the host; the real engine faults on
  // the absent LOGIC 7 inside the resume's own tick — the dispatch catch
  // reports it, and the armed engine's fault is sticky for later polls.
  const error = h.control.find((m) => m.type === "error");
  assert.ok(error, "the missing room surfaces a control error");
  assert.match(String(error.message ?? ""), /logic resource 7 not in container/);
  assert.throws(() => h.tick(1), /logic resource 7 not in container/);
  assert.equal(
    h.control.every((m) => !(m.type === "hostRequest" && m.op === "room")),
    true,
  );
});

test("a normal boot is untouched by the test policy path", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: "assignn(v40, 3);\nreturn;" }]);
  h.send({
    type: "boot",
    files: game.files,
    words: [],
    profile: PROFILE,
    authorRooms: true,
    rngSeed: 9,
  });
  assert.equal(controls(h, "booted").length, 1);
  assert.equal(h.ctx.boot.authorRooms, true);
  // No debugger traffic, no freeze: the first poll runs the room script.
  assert.equal(
    h.control.every((m) => !m.type.startsWith("debug")),
    true,
  );
  h.tick(2);
  assert.equal(h.ctx.engine!.vars[40], 3);
  assert.ok(h.ctx.cycle.cycleCount > 0);
  // Ordinary recording opened its segment as usual.
  assert.equal(h.ctx.history.segment !== null, true);
});
