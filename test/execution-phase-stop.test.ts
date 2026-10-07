import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
import type { ExecutionPhaseKind } from "../src/runtime/executionObservation.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";

/**
 * Resumable phase stops. A stop requested after any operation or phase parks
 * the cycle at a session-local cursor; resuming continues the interrupted
 * phase sequence exactly once — consumed input, applied host answers,
 * completed tails and transitioned rooms are never re-run. `pauseExecution`
 * overlays whatever the engine is already waiting on without synthesizing
 * work, and while stopped the clocks, sound and inputs stay frozen.
 */

class QuietHost implements EngineHost {
  prints: string[] = [];
  sounds: number[] = [];
  input: { line: string | null; polls: number } = { line: null, polls: 0 };

  print(text: string): void {
    this.prints.push(text);
  }
  displayAt(): void {}
  statusLine(): void {}
  soundOutput(): void {
    this.sounds.push(this.sounds.length);
  }
  takeInputLine(): string | null {
    this.input.polls++;
    const line = this.input.line;
    this.input.line = null;
    return line;
  }
  takeKeys(): number[] {
    return [];
  }
}

class SuspendingHost extends QuietHost {
  prompts = 0;
  waitKey(): number {
    throw new HostWait();
  }
  promptNumber(): number {
    this.prompts++;
    throw new HostWait();
  }
}

function game(sources: readonly string[], host: QuietHost = new QuietHost(), budget = 10000) {
  const container = createContainer();
  const dictionary = new Map([["look", 100]]);
  sources.forEach((source, num) =>
    container.putResource("logic", num, assembleLogic(source, { dictionary }).payload),
  );
  return {
    engine: new Engine(container, host, dictionary, { instructionBudget: budget }),
    host,
    container,
  };
}

const CYCLIC_PHASES: ExecutionPhaseKind[] = [
  "cycle-entry",
  "input",
  "pre-logic",
  "cycle-tail",
  "motion",
  "cycle-end",
];

for (const phase of CYCLIC_PHASES) {
  test(`a stop after ${phase} resumes the pass without re-running completed work`, () => {
    const { engine, host } = game(["increment(v60); return;"]);
    let collecting = true;
    engine.setExecutionObserver(
      (o) => collecting && o.cause.type === "phase" && o.cause.phase === phase,
    );
    let stops = 0;
    for (let i = 0; i < 8 && stops < 3; i++) {
      engine.tick();
      const stop = engine.executionStopInfo;
      if (stop === null) continue;
      stops++;
      assert.equal(stop.cause.type, "phase");
      if (stop.cause.type === "phase") assert.equal(stop.cause.phase, phase);
      assert.equal(stop.location, null, "a phase stop carries no instruction blame");
      // A latched stop is frozen: further ticks run nothing.
      const frozen = {
        v: engine.vars[60]!,
        polls: host.input.polls,
        serial: engine.completedCycleSerial,
      };
      engine.tick();
      assert.equal(engine.vars[60], frozen.v);
      assert.equal(host.input.polls, frozen.polls);
      assert.equal(engine.completedCycleSerial, frozen.serial);
      engine.resumeExecution();
    }
    // Drain the parked remainder: the last iteration already resumed, so its
    // pass still owes a finishing tick. The observer stays armed but no longer
    // asks for stops — control can only change at a completed boundary.
    collecting = false;
    for (let i = 0; i < 4; i++) {
      if (engine.executionStopInfo !== null) engine.resumeExecution();
      engine.tick();
    }
    assert.equal(stops, 3, "each cycle's phase observed its own stop");
    assert.equal(engine.vars[60], engine.completedCycleSerial, "one increment per completed pass");
    assert.equal(host.input.polls, engine.vars[60], "one input poll per completed pass");
  });
}

test("a stop after the input phase does not re-consume the accepted line", () => {
  const { engine, host } = game([`accept.input(); if (said("look")) { increment(v60); } return;`]);
  engine.setExecutionObserver((o) => o.cause.type === "phase" && o.cause.phase === "input");
  engine.tick(); // cycle 1: accepts input hardware; stops after the input phase
  const first = engine.executionStopInfo!;
  assert.equal(first.cause.type, "phase");
  engine.resumeExecution();
  engine.tick(); // cycle 1 finishes
  host.input.line = "look";
  engine.tick(); // cycle 2 stops after consuming the line
  assert.equal(host.input.polls, 2);
  assert.equal(engine.flags[2], 1, "the input landed before the stop");
  assert.equal(engine.vars[60], 0, "logic has not run yet");
  engine.resumeExecution();
  engine.tick();
  assert.equal(engine.vars[60], 1, "the said matched exactly once — the line was not reparsed");
  assert.equal(host.input.polls, 2);
});

test("a delivered answer queues while stopped and applies once on resume", () => {
  const host = new SuspendingHost();
  const { engine } = game(
    [`#message 1 "How many?"\nget.num(1, v100);\nassignn(v101, 7);\nreturn;`],
    host,
  );
  engine.setExecutionObserver((o) => o.cause.type === "phase" && o.cause.phase === "host-answer");
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "getnum");
  assert.equal(engine.vars[100], 0);

  engine.deliverHostAnswer(0x142);
  engine.tick();
  const stop = engine.executionStopInfo!;
  assert.ok(stop, "the host-answer phase stopped");
  assert.equal(stop.cause.type, "phase");
  assert.equal(engine.vars[100], 0x42, "the answer applied atomically before the stop");
  assert.equal(engine.vars[101], 0, "the next instruction has not run");
  assert.equal(engine.completedCycleSerial, 0);
  assert.equal(host.prompts, 1);

  engine.tick();
  assert.equal(engine.vars[101], 0, "frozen while stopped");
  engine.resumeExecution();
  engine.tick();
  assert.equal(engine.vars[101], 7);
  assert.equal(host.prompts, 1, "the answer applied exactly once");
  assert.equal(engine.completedCycleSerial, 1);
});

test("pauseExecution overlays a host wait without mutating state until resume", () => {
  const host = new SuspendingHost();
  const { engine } = game(
    [`#message 1 "How many?"\nget.num(1, v100);\nassignn(v101, 7);\nreturn;`],
    host,
  );
  engine.tick();
  assert.equal(engine.hostInteractionPending, true);
  assert.equal(engine.awaitingHostAnswer, true);

  engine.pauseExecution();
  const stop = engine.executionStopInfo!;
  assert.ok(stop);
  assert.equal(stop.cause.type, "wait");
  if (stop.cause.type === "wait") assert.equal(stop.cause.wait, "getnum");
  assert.equal(stop.wait, "getnum", "the outstanding wait is reported");
  assert.ok(stop.location, "the parked stack is the resume point");
  assert.equal(engine.awaitingHostAnswer, true, "ordinary waiting stays distinguishable");

  // The delivered answer is accepted but cannot apply while stopped.
  engine.deliverHostAnswer(0x33);
  assert.equal(engine.hostInteractionReady, true);
  engine.tick();
  engine.advanceClock(1000);
  engine.soundTick();
  engine.modalKey(13);
  assert.equal(engine.vars[100], 0, "no vars changed while stopped");
  assert.equal(engine.vars[11], 0, "the clock stayed frozen");

  engine.resumeExecution();
  engine.tick();
  assert.equal(engine.vars[100], 0x33);
  assert.equal(engine.vars[101], 7);
  assert.equal(host.prompts, 1, "the prompt ran once");
});

test("pauseExecution between cycles latches an idle stop", () => {
  const { engine, host } = game(["increment(v60); return;"]);
  engine.tick();
  assert.equal(engine.vars[60], 1);
  engine.pauseExecution();
  const stop = engine.executionStopInfo!;
  assert.equal(stop.cause.type, "wait");
  if (stop.cause.type === "wait") assert.equal(stop.cause.wait, "idle");
  assert.equal(stop.location, null);
  engine.tick();
  assert.equal(engine.vars[60], 1);
  assert.equal(host.input.polls, 1);
  engine.pauseExecution();
  assert.equal(
    engine.executionStopInfo!.stopId,
    stop.stopId,
    "pausing a stopped engine is a no-op",
  );
  engine.resumeExecution();
  engine.tick();
  assert.equal(engine.vars[60], 2, "the next pass ran fresh");
  assert.equal(host.input.polls, 2);
});

test("pauseExecution overlays a parked modal; keys are frozen until resume", () => {
  const { engine } = game([`#message 1 "Hi"\nprint(1); assignn(v100, 7); return;`]);
  engine.tick();
  assert.equal(engine.modalKind, "print");
  assert.equal(engine.continuationPending, true);

  engine.pauseExecution();
  const stop = engine.executionStopInfo!;
  assert.equal(stop.cause.type, "wait");
  if (stop.cause.type === "wait") assert.equal(stop.cause.wait, "modal");
  assert.ok(stop.location);

  engine.modalKey(13); // Enter — dropped while stopped
  assert.equal(engine.modalKind, "print", "input stays frozen");
  engine.tick();
  assert.equal(engine.vars[100], 0);

  engine.resumeExecution();
  engine.modalKey(13);
  assert.equal(engine.modalKind, null);
  engine.tick();
  assert.equal(engine.vars[100], 7, "the parked pass resumed after the window drained");
});

test("out-of-cycle clock and sound observe as phases and freeze while stopped", () => {
  const container = createContainer();
  const dictionary = new Map<string, number>();
  container.putResource(
    "logic",
    0,
    assembleLogic(`load.sound(1); sound(1, f60); increment(v50); return;`, { dictionary }).payload,
  );
  container.putResource(
    "sound",
    1,
    // Channel 0's note carries a 30-tick duration so every polled tick plays.
    Uint8Array.of(8, 0, 15, 0, 17, 0, 19, 0, 30, 0, 0, 0, 15, 255, 255, 255, 255, 255, 255, 255),
  );
  const host = new QuietHost();
  const engine = new Engine(container, host, dictionary);
  const phases: ExecutionPhaseKind[] = [];
  let clockStopped = false;
  engine.setExecutionObserver((o) => {
    if (o.cause.type === "phase") phases.push(o.cause.phase);
    if (o.cause.type === "phase" && o.cause.phase === "clock" && !clockStopped) {
      clockStopped = true;
      return true;
    }
    return false;
  });
  engine.tick();
  assert.equal(engine.vars[50], 1);
  assert.ok(!phases.includes("clock"), "the cycle's phases carry no out-of-cycle clock");

  // The clock advance is its own atomic phase: it completes before the stop.
  engine.advanceClock(1200);
  assert.equal(engine.vars[11], 1);
  assert.equal(phases.at(-1), "clock");
  const clockStop = engine.executionStopInfo!;
  assert.equal(clockStop.cause.type, "phase");
  if (clockStop.cause.type === "phase") assert.equal(clockStop.cause.phase, "clock");

  // Frozen: no clock, sound or presentation progress; a kept input does not drain.
  engine.advanceClock(1000);
  engine.soundTick();
  assert.equal(engine.vars[11], 1);
  assert.equal(phases.at(-1), "clock", "frozen clocks emit nothing");

  engine.resumeExecution();
  const soundBefore = phases.filter((p) => p === "sound").length;
  engine.advanceClock(1000);
  assert.equal(engine.vars[11], 2);
  for (let i = 0; i < 5; i++) engine.soundTick();
  assert.equal(
    phases.filter((p) => p === "sound").length - soundBefore,
    5,
    "each discharged sound tick observed once",
  );
});

test("a mid-pass budget never renews across debugger stops", () => {
  const { engine } = game(
    ["increment(v60); again: increment(v60); goto again;"],
    new QuietHost(),
    20,
  );
  let actions = 0;
  engine.setExecutionObserver((o) => {
    if (o.cause.type === "instruction" && o.cause.boundary.kind === "action") {
      actions++;
      return actions === 4 || actions === 8;
    }
    return false;
  });
  // The allowance survives the stops: charges 1..20 run, the 21st faults.
  engine.tick();
  assert.ok(engine.executionStopInfo);
  engine.resumeExecution();
  engine.tick();
  assert.ok(engine.executionStopInfo);
  engine.resumeExecution();
  assert.throws(() => engine.tick(), /instruction budget/);
  assert.throws(() => engine.tick(), /instruction budget/, "the fault latches");
  assert.equal(engine.vars[60], 11, "every charge stayed in the one allowance");
});

test("a restart abort unwinds through the reset phase and re-enters logic once", () => {
  const { engine } = game([
    `if (isset(f6)) { assignn(v101, 1); return; }
     increment(v60);
     set(f16);
     if (equaln(v60, 1)) { restart.game(); }
     return;`,
  ]);
  const phases: ExecutionPhaseKind[] = [];
  let unwinds = 0;
  engine.setExecutionObserver((o) => {
    if (o.cause.type === "phase") phases.push(o.cause.phase);
    if (o.outcome === "unwind") {
      unwinds++;
      return true;
    }
    return false;
  });
  engine.tick();
  assert.equal(unwinds, 1, "the restart unwound once");
  assert.ok(engine.executionStopInfo);
  assert.equal(engine.vars[60], 0, "restart cleared the pass's writes");
  assert.equal(engine.vars[101], 0, "re-entry has not run yet");
  engine.resumeExecution();
  engine.tick();
  assert.equal(engine.vars[101], 1, "the re-entered logic saw the restart flag");
  assert.equal(engine.vars[60], 0, "the aborted pass did not re-run");
  assert.equal(engine.completedCycleSerial, 1);
  assert.equal(phases.filter((p) => p === "reset").length, 1, "one reset phase observation");
});

test("a suspended key wait overlays a pause without losing the wait", () => {
  const host = new SuspendingHost();
  const { engine } = game([`wait: if (!have.key()) { goto wait; } assignn(v60, 1); return;`], host);
  engine.tick();
  assert.equal(engine.awaitingKey, true);
  engine.pauseExecution();
  const stop = engine.executionStopInfo!;
  assert.equal(stop.cause.type, "wait");
  if (stop.cause.type === "wait") assert.equal(stop.cause.wait, "key");
  engine.deliverHostAnswer(0x62);
  engine.tick();
  assert.equal(engine.vars[19], 0, "the delivered key stays queued while stopped");
  engine.resumeExecution();
  engine.tick();
  assert.equal(engine.vars[19], 0x62);
  assert.equal(engine.vars[60], 1);
});

test("debug stops and pauses refuse checkpoint capture", () => {
  const { engine } = game(["increment(v50); increment(v51); return;"]);
  engine.setExecutionObserver(
    (o) => o.cause.type === "instruction" && o.cause.boundary.kind === "action",
  );
  engine.tick();
  assert.ok(engine.executionStopInfo);
  assert.throws(() => engine.captureReplayState(), /checkpoint|debug|execution/i);

  const { engine: phaseEngine } = game(["increment(v50); return;"]);
  let stoppedOnce = false;
  phaseEngine.setExecutionObserver(
    (o) =>
      !stoppedOnce &&
      o.cause.type === "phase" &&
      o.cause.phase === "cycle-tail" &&
      (stoppedOnce = true),
  );
  phaseEngine.tick();
  assert.equal(phaseEngine.executionStopInfo!.cause.type, "phase");
  assert.throws(() => phaseEngine.captureReplayState(), /checkpoint|debug|execution/i);

  const { engine: idle } = game(["return;"]);
  idle.tick();
  idle.pauseExecution();
  assert.throws(() => idle.captureReplayState(), /checkpoint|debug|execution/i);
  idle.resumeExecution();
  idle.tick();
});

test("inspection while stopped is observational and side-effect free", () => {
  const { engine, host } = game(["increment(v50); increment(v51); return;"]);
  engine.setExecutionObserver(
    (o) => o.cause.type === "instruction" && o.cause.boundary.kind === "action",
  );
  engine.tick();
  const stop = engine.executionStopInfo!;
  const cells = engine.textCells.slice();
  for (let i = 0; i < 5; i++) {
    engine.readState();
    engine.getPresentation();
    engine.textRow(0);
    engine.getOwnership();
  }
  assert.equal(engine.vars[50], 1);
  assert.equal(engine.vars[51], 0);
  assert.equal(engine.executionStopInfo!.stopId, stop.stopId);
  assert.deepEqual(engine.textCells.slice(), cells);
  assert.equal(host.input.polls, 1);
});
