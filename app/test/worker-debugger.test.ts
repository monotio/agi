import assert from "node:assert/strict";
import { test } from "node:test";
import { gameContainer, workerHarness, type WorkerHarness } from "./worker-ctx.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerInbound } from "../src/worker/workerProtocol.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { openContainer } from "../../src/container/container.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";

/**
 * The execution-controller protocol end to end: real Engine, fake ports,
 * onWorkerMessage driving. Attach/pause/resume/configure/inspect/evaluate/
 * setValues plus the worker-wide freeze: input rejection, queued host
 * answers, sound-batch truncation, capture refusal, history hiatus and
 * session replacement.
 */

function send(ctx: WorkerHarness["ctx"], msg: WorkerInbound): void {
  onWorkerMessage(ctx, msg);
}

function controls(h: WorkerHarness, type: string): Record<string, unknown>[] {
  return h.control.filter((m) => m.type === type) as Record<string, unknown>[];
}

function lastControl(h: WorkerHarness, type: string): Record<string, unknown> {
  const found = controls(h, type);
  assert.ok(found.length > 0, `expected a ${type} message`);
  return found.at(-1)!;
}

function attach(
  h: WorkerHarness,
  sources?: Record<string, string>,
): { epoch: number; buildId: string } {
  send(h.ctx, { type: "debugAttach", id: 1, ...(sources ? { sources } : {}) });
  const reply = lastControl(h, "debugAttached");
  return { epoch: reply["epoch"] as number, buildId: reply["buildId"] as string };
}

test("attach publishes identity; stale epoch and double attach are rejected", () => {
  const h = workerHarness(gameContainer(["return;"]));
  // No engine → structured refusal, not a throw.
  const bare = workerHarness(gameContainer(["return;"]));
  bare.ctx.engine = null;
  send(bare.ctx, { type: "debugAttach", id: 9 });
  assert.equal(lastControl(bare, "debugError")["code"], "noEngine");

  const { epoch, buildId } = attach(h);
  assert.equal(typeof epoch, "number");
  assert.ok(epoch > 0);
  assert.equal(typeof buildId, "string");
  assert.ok(buildId.length > 0);
  assert.equal(h.ctx.debugger.epoch, epoch);

  // A stale epoch is refused on the reliable channel.
  send(h.ctx, { type: "debugPause", id: 2, epoch: epoch + 9 });
  assert.equal(lastControl(h, "debugError")["code"], "staleEpoch");
  assert.equal(h.ctx.engine!.executionStopInfo, null);

  // A second attach supersedes the first: detach event, then a fresh epoch.
  send(h.ctx, { type: "debugAttach", id: 3 });
  const detached = lastControl(h, "debugDetached");
  assert.equal(detached["epoch"], epoch);
  assert.equal(detached["reason"], "superseded");
  const reattached = lastControl(h, "debugAttached");
  assert.ok((reattached["epoch"] as number) > epoch);

  // The old epoch is dead; the new one answers.
  send(h.ctx, { type: "debugPause", id: 4, epoch });
  assert.equal(lastControl(h, "debugError")["code"], "staleEpoch");
});

test("pause publishes exactly one stop; resume releases only the latch", () => {
  const h = workerHarness(gameContainer(["assignn(v40, 1); return;"]));
  const { epoch } = attach(h);
  send(h.ctx, { type: "debugPause", id: 10, epoch });
  assert.equal(lastControl(h, "debugAck")["id"], 10);
  const stopped = lastControl(h, "debugStopped");
  assert.equal(stopped["epoch"], epoch);
  assert.equal(typeof stopped["stopId"], "number");
  assert.deepEqual(stopped["reasons"], [{ kind: "pause" }]);
  assert.equal(h.ctx.engine!.executionStopInfo !== null, true);
  // The stop's audio hold is the debugger's own owner.
  assert.deepEqual(lastControl(h, "debugAudio"), { type: "debugAudio", epoch, paused: true });
  // A second pause reports no second stop — idempotent latch.
  send(h.ctx, { type: "debugPause", id: 11, epoch });
  assert.equal(controls(h, "debugStopped").length, 1);

  // A stopped poll counts no cycle and runs nothing.
  const before = h.ctx.cycle.cycleCount;
  assert.equal(h.ctx.fns.stepHostTick(10, { cycle: true, sound: 0 }), false);
  assert.equal(h.ctx.cycle.cycleCount, before);
  assert.equal(h.ctx.engine!.vars[40], 0);

  // Continue releases the latch; the next fired poll runs the pass.
  send(h.ctx, {
    type: "debugResume",
    id: 12,
    epoch,
    stopId: stopped["stopId"] as number,
    action: "continue",
  });
  assert.equal(lastControl(h, "debugAck")["id"], 12);
  assert.equal(h.ctx.engine!.executionStopInfo, null);
  assert.equal(h.ctx.engine!.vars[40], 1);
  assert.deepEqual(lastControl(h, "debugAudio"), { type: "debugAudio", epoch, paused: false });
});

test("a breakpoint stops before the bound statement", () => {
  const source = "assignn(v40, 1);\nassignn(v41, 2);\nreturn;";
  const h = workerHarness(gameContainer([source]));
  const { epoch } = attach(h, { "0": source });
  send(h.ctx, {
    type: "debugConfigure",
    id: 20,
    epoch,
    revision: 1,
    breakpoints: [{ id: "b1", enabled: true, logic: 0, line: 2, mode: "statement" }],
  });
  const configured = lastControl(h, "debugConfigured");
  assert.equal(configured["revision"], 1);
  assert.equal((configured["breakpoints"] as { id: string }[])[0]!.id, "b1");

  h.ctx.fns.stepHostTick(10, { cycle: true, sound: 0 });
  const stopped = lastControl(h, "debugStopped");
  const reasons = stopped["reasons"] as { kind: string; id?: string }[];
  assert.equal(reasons[0]!.kind, "breakpoint");
  assert.equal(reasons[0]!.id, "b1");
  // The stop landed before the bound line ran: v40 written, v41 untouched.
  assert.equal(h.ctx.engine!.vars[40], 1);
  assert.equal(h.ctx.engine!.vars[41], 0);
  const cause = stopped["cause"] as { type: string };
  assert.equal(cause.type, "instruction");

  send(h.ctx, {
    type: "debugResume",
    id: 21,
    epoch,
    stopId: stopped["stopId"] as number,
    action: "continue",
  });
  // The breakpoint re-arms: the next pass stops at the same line again.
  assert.equal(h.ctx.engine!.vars[41], 2);
});

test("a watchpoint reports the responsible instruction", () => {
  const h = workerHarness(gameContainer(["assignn(v40, 1); return;"]));
  const { epoch } = attach(h);
  send(h.ctx, {
    type: "debugConfigure",
    id: 30,
    epoch,
    revision: 1,
    watchpoints: [{ id: "w1", enabled: true, target: { kind: "variable", index: 40 } }],
  });
  h.ctx.fns.stepHostTick(10, { cycle: true, sound: 0 });
  const stopped = lastControl(h, "debugStopped");
  const reasons = stopped["reasons"] as {
    kind: string;
    changes?: { id: string; old: unknown; new: unknown }[];
  }[];
  assert.equal(reasons[0]!.kind, "watch");
  assert.equal(reasons[0]!.changes![0]!.id, "w1");
  assert.equal(reasons[0]!.changes![0]!.old, 0);
  assert.equal(reasons[0]!.changes![0]!.new, 1);
  const cause = stopped["cause"] as { type: string; boundary?: { logic: number } };
  assert.equal(cause.type, "instruction");
  assert.equal(cause.boundary!.logic, 0);
});

test("a clock-phase watch truncates the sound batch at the first stop", () => {
  // Seconds counter: advanceClock writes v11 on each whole second crossed.
  const h = workerHarness(gameContainer(["return;"]));
  const { epoch } = attach(h);
  send(h.ctx, {
    type: "debugConfigure",
    id: 40,
    epoch,
    revision: 1,
    watchpoints: [{ id: "w1", enabled: true, target: { kind: "variable", index: 11 } }],
  });
  // 120 due sound ticks span two seconds; the stop at the first-second
  // boundary must end the batch — v11 cannot reach 2.
  h.ctx.fns.stepHostTick(0, { cycle: false, sound: 120 });
  assert.equal(h.ctx.engine!.vars[11], 1);
  const stopped = lastControl(h, "debugStopped");
  const cause = stopped["cause"] as { type: string; phase?: string };
  assert.equal(cause.type, "phase");
  assert.equal(cause.phase, "clock");
  const reasons = stopped["reasons"] as { kind: string }[];
  assert.equal(reasons[0]!.kind, "watch");
  // The latch blocks the rest of the batch: no further clock advance runs.
  const remainder = h.ctx.engine!.vars[12];
  assert.equal(remainder, 0);
});

test("a phase-context watch keeps a null location for its condition", () => {
  // v11's clock write has no responsible instruction; the condition must see
  // logic:null and fault — if the snapshot borrowed the next or a stale
  // boundary, `logic == 0` would evaluate true and report a plain change.
  const h = workerHarness(gameContainer(["return;"]));
  const { epoch } = attach(h);
  send(h.ctx, {
    type: "debugConfigure",
    id: 45,
    epoch,
    revision: 1,
    watchpoints: [
      {
        id: "phaseWatch",
        enabled: true,
        target: { kind: "variable", index: 11 },
        condition: "logic == 0",
      },
    ],
  });
  h.ctx.fns.stepHostTick(0, { cycle: false, sound: 120 });
  const stopped = lastControl(h, "debugStopped");
  const cause = stopped["cause"] as { type: string; phase?: string };
  assert.equal(cause.type, "phase");
  const changes = (stopped["reasons"] as { changes?: { reason: string; error?: string }[] }[])[0]!
    .changes!;
  assert.equal(changes[0]!.reason, "error");
  assert.match(changes[0]!.error ?? "", /'logic' is unavailable/);
});

test("stopped input is rejected; direction release queues as cleanup", () => {
  const h = workerHarness(gameContainer(["return;"]));
  const { epoch } = attach(h);
  send(h.ctx, { type: "debugPause", id: 50, epoch });
  assert.equal(h.ctx.engine!.executionStopInfo !== null, true);
  send(h.ctx, { type: "key", code: 13 });
  send(h.ctx, { type: "input", text: "look" });
  send(h.ctx, { type: "direction", dir: 3 });
  send(h.ctx, { type: "edit", text: "x" });
  assert.deepEqual(h.ctx.input.keyQueue, []);
  assert.deepEqual(h.ctx.input.inputBuffer, []);
  assert.deepEqual(h.ctx.input.deferredMovement, []);
  // A release for a pre-stop hold is cleanup, not new input.
  send(h.ctx, { type: "direction", dir: 0 });
  assert.deepEqual(h.ctx.input.deferredMovement, [0]);
});

test("a host answer queues while stopped and applies once on resume", () => {
  const h = workerHarness(
    gameContainer(['#message 1 "num?"\nget.num(1, v100);\nassignn(v101, 9);\nreturn;']),
  );
  const { epoch } = attach(h);
  h.ctx.fns.tickEngine();
  const request = lastControl(h, "hostRequest");
  assert.equal(h.ctx.engine!.hostInteractionPending, true);
  send(h.ctx, { type: "debugPause", id: 60, epoch });
  const stopped = lastControl(h, "debugStopped");
  // The stop overlays the in-flight host wait.
  assert.equal((stopped["wait"] as string | null) ?? null, "getnum");

  send(h.ctx, { type: "hostAnswer", id: request["id"] as number, response: "42" });
  const ready = lastControl(h, "debugAnswerReady");
  assert.equal(ready["epoch"], epoch);
  assert.equal(ready["id"], request["id"]);
  // Raw queued: nothing applied while the latch holds.
  assert.equal(h.ctx.engine!.vars[100], 0);
  assert.equal(h.ctx.engine!.hostInteractionPending, true);
  // A duplicate answer cannot double-apply.
  send(h.ctx, { type: "hostAnswer", id: request["id"] as number, response: "42" });
  assert.equal(controls(h, "debugAnswerReady").length, 1);

  send(h.ctx, {
    type: "debugResume",
    id: 61,
    epoch,
    stopId: stopped["stopId"] as number,
    action: "continue",
  });
  assert.equal(h.ctx.engine!.vars[100], 42);
  assert.equal(h.ctx.engine!.vars[101], 9);
});

test("autosave and checkpoint refuse while the latch is held", () => {
  const h = workerHarness(gameContainer(["return;"]));
  h.ctx.fns.tickEngine();
  const { epoch } = attach(h);
  send(h.ctx, { type: "debugPause", id: 70, epoch });
  assert.equal(h.ctx.fns.autosave(true), false);
  send(h.ctx, { type: "checkpoint", id: 71 });
  assert.equal(lastControl(h, "checkpoint")["image"], null);
});

test("debugWrite is refused while attached; debugSetValues is atomic", () => {
  const h = workerHarness(gameContainer(["return;"]));
  const { epoch } = attach(h);
  send(h.ctx, { type: "debugPause", id: 80, epoch });
  const stopId = lastControl(h, "debugStopped")["stopId"] as number;

  send(h.ctx, { type: "debugWrite", id: 81, vars: [[40, 9]] });
  const refused = lastControl(h, "debugWritten");
  assert.match(refused["error"] as string, /debugSetValues/);
  assert.equal(h.ctx.engine!.vars[40], 0);

  // A malformed pair aborts the whole transaction.
  send(h.ctx, {
    type: "debugSetValues",
    id: 82,
    epoch,
    stopId,
    vars: [
      [40, 5],
      [300, 1],
    ],
  });
  assert.equal(lastControl(h, "debugError")["code"], "invalidRequest");
  assert.equal(h.ctx.engine!.vars[40], 0);

  send(h.ctx, { type: "debugSetValues", id: 83, epoch, stopId, vars: [[40, 5]], flags: [[3, 1]] });
  const ack = lastControl(h, "debugSetValuesAck");
  assert.equal(ack["id"], 83);
  assert.equal(h.ctx.engine!.vars[40], 5);
  assert.equal(h.ctx.engine!.flags[3], 1);
  // The mutation repins the stop: a fresh stopId supersedes the old one.
  const mutated = lastControl(h, "debugStopped");
  assert.deepEqual(mutated["reasons"], [{ kind: "mutated" }]);
  assert.notEqual(mutated["stopId"], stopId);
  assert.equal(ack["stopId"], mutated["stopId"]);
});

test("evaluate reads the pinned snapshot; the snapshot cannot mutate the engine", () => {
  const h = workerHarness(gameContainer(["assignn(v40, 3); return;"]));
  const { epoch } = attach(h);
  h.ctx.fns.tickEngine();
  send(h.ctx, { type: "debugPause", id: 90, epoch });
  const stopId = lastControl(h, "debugStopped")["stopId"] as number;

  send(h.ctx, { type: "debugEvaluate", id: 91, epoch, stopId, expression: "v40 + 4" });
  const reply = lastControl(h, "debugEvaluation");
  assert.equal(reply["ok"], true);
  assert.equal(reply["value"], 7);

  // A malformed expression is a structured refusal, never a thrown fault.
  send(h.ctx, { type: "debugEvaluate", id: 92, epoch, stopId, expression: "v40 +" });
  assert.equal(lastControl(h, "debugError")["code"], "invalidExpression");

  // Mutating the returned snapshot object leaves the engine untouched.
  const snapshot = h.ctx.debugger.snapshot!;
  (snapshot.vars as number[])[40] = 99;
  assert.equal(h.ctx.engine!.vars[40], 3);

  // A stale stopId is refused.
  send(h.ctx, { type: "debugEvaluate", id: 93, epoch, stopId: stopId + 5, expression: "1" });
  assert.equal(lastControl(h, "debugError")["code"], "staleStop");
});

test("inspect returns detached sections pinned to the stop", () => {
  const h = workerHarness(gameContainer(["assignn(v40, 8); return;"]));
  const { epoch } = attach(h);
  h.ctx.fns.tickEngine();
  send(h.ctx, { type: "debugPause", id: 100, epoch });
  const stopId = lastControl(h, "debugStopped")["stopId"] as number;
  send(h.ctx, { type: "debugInspect", id: 101, epoch, stopId, section: "state" });
  const reply = lastControl(h, "debugInspection");
  assert.equal(reply["section"], "state");
  assert.equal(reply["stopId"], stopId);
  assert.equal(typeof reply["data"], "object");
});

test("attach ends the live segment with the debugger reason; detach resumes", () => {
  const h = workerHarness(gameContainer(["return;"]));
  h.ctx.fns.historyBoot({ type: "boot", files: {}, words: [] });
  assert.ok(h.ctx.history.segment !== null);
  attach(h);
  assert.equal(h.ctx.history.segment, null, "the live segment closed at attach");
  const batch = controls(h, "historyBatch").at(-1) as {
    batch?: { end?: { reason?: string } };
  };
  assert.ok(batch !== undefined);
  assert.equal(batch.batch?.end?.reason, "debugger", "the segment's closer carries the reason");

  send(h.ctx, { type: "debugDetach", id: 110, epoch: h.ctx.debugger.epoch });
  assert.equal(lastControl(h, "debugDetached")["reason"], "requested");
  // Normal recording resumes at the next boundary without the session.
  assert.equal(
    h.ctx.history.resumePending || h.ctx.history.segment !== null,
    true,
    "detach requested the normal-recording resume",
  );
});

test("entering replay ends the session instead of binding a scratch engine", () => {
  const h = workerHarness(gameContainer(["return;"]));
  h.ctx.boot.currentBootFiles = gameContainer(["return;"]).files as never;
  h.ctx.boot.currentDictionary = new Map();
  const { epoch } = attach(h);
  send(h.ctx, { type: "resetReplay", sessionId: 1 });
  assert.equal(lastControl(h, "debugDetached")["epoch"], epoch);
  assert.equal(h.ctx.debugger.epoch, 0, "the session ended with the live run");
});

test("step into and cycle publish step stops; over is refused from an idle stop", () => {
  const h = workerHarness(gameContainer(["assignn(v40, 1);\nassignn(v41, 2);\nreturn;"]));
  const { epoch } = attach(h);
  send(h.ctx, { type: "debugPause", id: 140, epoch });
  const idle = lastControl(h, "debugStopped");
  assert.equal(idle["location"], null, "a pause at idle has no resume instruction");

  // over/out need a stopped invocation — the idle stop has no origin.
  send(h.ctx, {
    type: "debugResume",
    id: 141,
    epoch,
    stopId: idle["stopId"] as number,
    action: "over",
  });
  assert.equal(lastControl(h, "debugError")["code"], "invalidRequest");
  assert.ok(h.ctx.engine!.executionStopInfo !== null, "the refused plan kept the stop pinned");

  // into from a null origin stops at the first statement boundary.
  send(h.ctx, {
    type: "debugResume",
    id: 142,
    epoch,
    stopId: idle["stopId"] as number,
    action: "into",
  });
  const stepped = lastControl(h, "debugStopped");
  assert.deepEqual(stepped["reasons"], [{ kind: "step", mode: "into" }]);
  assert.equal((stepped["cause"] as { type: string }).type, "instruction");
  assert.equal(h.ctx.engine!.vars[40], 0, "the step stopped before the statement ran");

  // A cycle step rides the observer to the completed-cycle tail.
  send(h.ctx, {
    type: "debugResume",
    id: 143,
    epoch,
    stopId: stepped["stopId"] as number,
    action: "cycle",
  });
  const cycled = lastControl(h, "debugStopped");
  assert.deepEqual(cycled["reasons"], [{ kind: "step", mode: "cycle" }]);
  assert.deepEqual(cycled["cause"], { type: "phase", phase: "cycle-end" });
  assert.equal(h.ctx.engine!.vars[40], 1);
  assert.equal(h.ctx.engine!.vars[41], 2);
});

test("runTo stops once at the target pc, coincident with the bound breakpoint", () => {
  const source = "assignn(v40, 1);\nassignn(v41, 2);\nreturn;";
  const h = workerHarness(gameContainer([source]));
  const { epoch } = attach(h, { "0": source });
  send(h.ctx, {
    type: "debugConfigure",
    id: 150,
    epoch,
    revision: 1,
    breakpoints: [
      { id: "l1", enabled: true, logic: 0, line: 1, mode: "statement" },
      { id: "l2", enabled: true, logic: 0, line: 2, mode: "statement" },
    ],
  });
  const entries = lastControl(h, "debugConfigured")["breakpoints"] as {
    id: string;
    binding: { bound: boolean; pcs?: number[] };
  }[];
  const pcs = Object.fromEntries(
    entries.map((entry) => [entry.id, entry.binding.bound ? entry.binding.pcs![0]! : -1]),
  );
  assert.ok(pcs["l1"]! >= 0 && pcs["l2"]! >= 0, "both statements bound to emitted pcs");

  h.ctx.fns.tickEngine(); // stops on l1 before the first statement
  const first = lastControl(h, "debugStopped");
  assert.deepEqual(first["reasons"], [{ kind: "breakpoint", id: "l1", hitCount: 1 }]);
  send(h.ctx, {
    type: "debugRunTo",
    id: 151,
    epoch,
    stopId: first["stopId"] as number,
    location: { logic: 0, pc: pcs["l2"]! },
  });
  assert.equal(lastControl(h, "debugAck")["id"], 151);
  const reached = lastControl(h, "debugStopped");
  const kinds = (reached["reasons"] as { kind: string }[]).map((r) => r.kind);
  assert.ok(kinds.includes("runTo"), `runTo among the coincident reasons: ${kinds}`);
  assert.ok(kinds.includes("breakpoint"), "the bound l2 breakpoint reported alongside");
  assert.equal((reached["location"] as { pc: number }).pc, pcs["l2"]);
  assert.equal(h.ctx.engine!.vars[40], 1, "the first statement completed");
  assert.equal(h.ctx.engine!.vars[41], 0, "the runTo target itself has not executed");
});

test("a stale stopId is refused while a newer stop is pinned", () => {
  const h = workerHarness(gameContainer(["return;"]));
  const { epoch } = attach(h);
  send(h.ctx, { type: "debugPause", id: 160, epoch });
  const staleId = lastControl(h, "debugStopped")["stopId"] as number;
  send(h.ctx, { type: "debugResume", id: 161, epoch, stopId: staleId, action: "continue" });
  send(h.ctx, { type: "debugPause", id: 162, epoch });
  const fresh = lastControl(h, "debugStopped");
  assert.notEqual(fresh["stopId"], staleId);
  send(h.ctx, { type: "debugResume", id: 163, epoch, stopId: staleId, action: "continue" });
  assert.equal(lastControl(h, "debugError")["code"], "staleStop");
  assert.ok(h.ctx.engine!.executionStopInfo !== null, "the live stop stays pinned");
});

test("a room answer queued while stopped applies its patch once on resume", () => {
  const h = workerHarness(gameContainer(["new.room(9);"]));
  h.ctx.boot.authorRooms = true;
  const { epoch } = attach(h);
  h.ctx.fns.tickEngine(); // newRoom(9) suspends on the missing room
  const request = lastControl(h, "hostRequest");
  assert.equal(request["op"], "room");
  assert.equal(h.ctx.engine!.hostInteractionPending, true);

  send(h.ctx, { type: "debugPause", id: 170, epoch });
  const stopped = lastControl(h, "debugStopped");
  assert.equal(stopped["wait"], "room", "the pause overlays the room authoring wait");

  const response = JSON.stringify({
    room: 9,
    words: [],
    resources: [
      {
        kind: "logic",
        num: 9,
        data: [...assembleLogic("return;", { dictionary: new Map() }).payload],
      },
      {
        kind: "picture",
        num: 9,
        data: [
          ...compilePictureSource(["vis 1", "fill 80,80", "end"].join("\n"), {
            profile: DEFAULT_V2_PROFILE,
          }).bytes,
        ],
      },
    ],
  });
  send(h.ctx, { type: "hostAnswer", id: request["id"] as number, response });
  assert.equal(lastControl(h, "debugAnswerReady")["id"], request["id"]);
  // Raw queued data only: no patch, no delivery, the outstanding request stays.
  assert.equal(h.ctx.hostRequests.hostRequestOutstanding !== null, true);
  assert.equal(h.ctx.engine!.patchGeneration, 0, "no resource mutation while the latch held");

  send(h.ctx, {
    type: "debugResume",
    id: 171,
    epoch,
    stopId: stopped["stopId"] as number,
    action: "continue",
  });
  // The patch applied inside the resume and rebound the session's identity —
  // the new bytes are a different build than the one the stop pinned.
  const reset = lastControl(h, "debugSessionReset");
  assert.ok((reset["epoch"] as number) > epoch, "the room patch rebound the session");
  assert.ok(h.ctx.engine!.patchGeneration > 0, "the queued room patch applied exactly once");
  assert.ok(
    openContainer(h.ctx.engine!.containerFiles, { profile: h.ctx.engine!.profile }).getResource(
      "logic",
      9,
    ) !== null,
    "room 9's logic landed in the live container",
  );
  // A duplicate or late answer names a settled request and is dropped.
  send(h.ctx, { type: "hostAnswer", id: request["id"] as number, response });
  assert.equal(controls(h, "debugAnswerReady").length, 1);
});

test("a pending step accepts a genuine host answer while parked at the wait", () => {
  const source = 'get.num("n?", v11);\nassignn(v40, v11);\nreturn;';
  const h = workerHarness(gameContainer([source]));
  const { epoch } = attach(h, { "0": source });
  send(h.ctx, {
    type: "debugConfigure",
    id: 180,
    epoch,
    revision: 1,
    breakpoints: [{ id: "prompt", enabled: true, logic: 0, line: 1, mode: "statement" }],
  });
  h.ctx.fns.tickEngine(); // stops before get.num
  const stopped = lastControl(h, "debugStopped");
  send(h.ctx, {
    type: "debugResume",
    id: 181,
    epoch,
    stopId: stopped["stopId"] as number,
    action: "into",
  });
  // get.num ran and parked: the step stays armed, no stop is latched.
  const request = lastControl(h, "hostRequest");
  assert.equal(request["op"], "getnum");
  assert.equal(h.ctx.engine!.executionStopInfo, null, "a parked host wait is not a debug stop");
  assert.equal(h.ctx.debugger.step !== null, true, "the step remains armed across the wait");

  send(h.ctx, { type: "hostAnswer", id: request["id"] as number, response: "7" });
  assert.equal(controls(h, "debugAnswerReady").length, 0, "delivered, never queued");
  const stepped = lastControl(h, "debugStopped");
  assert.deepEqual(stepped["reasons"], [{ kind: "step", mode: "into" }]);
  assert.equal(h.ctx.engine!.vars[11], 7);
  assert.equal(h.ctx.engine!.vars[40], 0, "the step pinned the next statement before it ran");
});

test("a resource patch while running resets the session with a fresh epoch", () => {
  const h = workerHarness(gameContainer(["return;"]));
  const { epoch } = attach(h);
  send(h.ctx, {
    type: "patch",
    resources: [
      {
        kind: "logic",
        num: 0,
        payload: assembleLogic("assignn(v40, 9); return;", { dictionary: new Map() }).payload,
      },
    ],
  });
  const reset = lastControl(h, "debugSessionReset");
  assert.ok((reset["epoch"] as number) > epoch, "the patched run carries a new epoch");
  assert.equal(h.ctx.debugger.epoch, reset["epoch"]);
  // Every request the old epoch issued is stale.
  send(h.ctx, { type: "debugPause", id: 190, epoch });
  assert.equal(lastControl(h, "debugError")["code"], "staleEpoch");
  send(h.ctx, { type: "debugPause", id: 191, epoch: h.ctx.debugger.epoch });
  assert.equal(lastControl(h, "debugAck")["id"], 191);
});

test("a resource patch while stopped is refused without dropping the stop", () => {
  const h = workerHarness(gameContainer(["return;"]));
  const { epoch } = attach(h);
  send(h.ctx, { type: "debugPause", id: 130, epoch });
  const stopId = lastControl(h, "debugStopped")["stopId"] as number;
  send(h.ctx, {
    type: "patch",
    resources: [{ kind: "logic", num: 0, payload: new Uint8Array([0xff]) }],
  });
  const refused = lastControl(h, "patched");
  assert.match(refused["error"] as string, /stopped or parked/);
  // The pinned stop survived the refusal.
  assert.equal(h.ctx.engine!.executionStopInfo !== null, true);
  assert.equal(h.ctx.debugger.stopId, stopId);
});
