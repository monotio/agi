import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
import { createContainer } from "../src/container/container.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { assembleLogic } from "../src/logic/assembler.ts";

function game(sources: readonly string[], budget = 10000) {
  const container = createContainer();
  const dictionary = new Map([["look", 100]]);
  sources.forEach((source, num) =>
    container.putResource("logic", num, assembleLogic(source, { dictionary }).payload),
  );
  const input = { line: null as string | null, polls: 0 };
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine() {
      input.polls++;
      const line = input.line;
      input.line = null;
      return line;
    },
    takeKeys: () => [],
  };
  return {
    engine: new Engine(container, host, dictionary, { instructionBudget: budget }),
    input,
    host,
    container,
  };
}

test("execution stops precede mutations; inspection, time and repeated ticks cannot advance them", () => {
  const { engine, input } = game(["increment(v50); return;"]);
  engine.setExecutionGate(() => true);
  engine.tick();
  const stop = engine.executionStop!;
  assert.equal(stop.pc, 0);
  assert.equal(stop.kind, "action");
  assert.equal(engine.vars[50], 0);
  assert.ok(Object.isFrozen(stop.frames));
  for (let i = 0; i < 10; i++) {
    engine.tick();
    engine.advanceClock(1000);
  }
  assert.equal(input.polls, 1);
  assert.equal(engine.vars[11], 0);
  assert.equal(engine.executionStop, stop);
  engine.resumeExecution();
  engine.advanceClock(1000);
  assert.equal(engine.vars[11], 0, "resume is permission to run, not an elapsed-time jump");
  engine.tick();
  assert.equal(engine.vars[50], 1);
  assert.equal(engine.executionStop!.kind, "return");
  assert.notEqual(engine.executionStop!.sequence, stop.sequence);
  assert.throws(() => engine.captureReplayState(), /checkpoint|debug|execution/i);
});

test("resuming inside IF never reevaluates said and never visits a skipped predicate", () => {
  const { engine, input } = game([
    'accept.input(); if (said("look") && (isset(f50) || have.key())) { increment(v50); } return;',
  ]);
  engine.tick();
  input.line = "look";
  engine.flags[50] = 1;
  const visited: number[] = [];
  engine.setExecutionGate((boundary) => {
    if (boundary.kind === "predicate") visited.push(boundary.pc);
    return true;
  });
  const traces: number[] = [];
  engine.setTraceListener((record) => {
    if (record.result !== undefined) traces.push(record.op);
  });
  for (let i = 0; i < 20; i++) {
    engine.tick();
    if (engine.executionStop === null) break;
    engine.resumeExecution();
  }
  assert.equal(engine.vars[50], 1, "said still held when the second predicate resumed");
  assert.deepEqual(traces, [14, 7]);
  assert.equal(visited.length, 2);
  assert.equal(input.polls, 2, "stepping continued the same cycle");
});

test("call invocations and loop encounters have distinct identities at equal PCs", () => {
  const { engine } = game(["call(1); call(1); return;", "increment(v50); return;"]);
  engine.setExecutionGate(() => true);
  const invocations: number[] = [];
  for (let i = 0; i < 20; i++) {
    engine.tick();
    const stop = engine.executionStop;
    if (!stop) break;
    if (stop.logic === 1 && stop.pc === 0) {
      invocations.push(stop.frames.at(-1)!.invocationId);
      assert.equal(stop.frames.length, 2);
      assert.equal(stop.frames.at(-1)!.callsite, invocations.length === 1 ? 0 : 2);
    }
    engine.resumeExecution();
  }
  assert.equal(engine.vars[50], 2);
  assert.equal(new Set(invocations).size, 2);
  const loop = game(["again: goto again;"], 2).engine;
  loop.setExecutionGate(() => true);
  loop.tick();
  const first = loop.executionStop!;
  loop.resumeExecution();
  loop.tick();
  assert.equal(loop.executionStop!.pc, first.pc);
  assert.notEqual(loop.executionStop!.sequence, first.sequence);
  loop.resumeExecution();
  loop.tick();
  loop.resumeExecution();
  assert.throws(() => loop.tick(), /instruction budget/i);
  assert.throws(
    () => loop.tick(),
    /instruction budget/i,
    "a fault cannot silently start a new pass",
  );
});

test("cooperative execution slices preserve the whole-pass runaway budget", () => {
  const { engine, input } = game(["again: goto again;"], 2200);
  engine.setExecutionGate(() => false);
  engine.tick();
  assert.equal(engine.executionYieldPending, true);
  engine.advanceClock(1000);
  assert.equal(engine.vars[11], 0);
  engine.tick();
  assert.equal(engine.executionYieldPending, true);
  assert.throws(() => engine.tick(), /instruction budget/i);
  assert.equal(input.polls, 1);
});

test("room changes unwind calls without becoming debugger faults", () => {
  const { engine } = game([
    "if (v0 == 0) { call(1); } increment(v50); return;",
    "new.room(1); return;",
  ]);
  engine.setExecutionGate(() => true);
  for (let i = 0; i < 30; i++) {
    engine.tick();
    if (!engine.executionStop) break;
    engine.resumeExecution();
  }
  assert.equal(engine.vars[0], 1);
  assert.equal(engine.vars[50], 1);
  engine.tick();
  assert.ok(engine.executionStop);
});

test("negated predicate boundaries bind the source-map prefix and identify the handler byte", () => {
  const source = "if (!isset(f50) && (!isset(f51) || isset(f52))) { return; }";
  const assembly = assembleLogic(source, { dictionary: new Map(), sourceMap: true });
  const expected = assembly
    .sourceMap!.entries.filter((entry) => entry.kind === "predicate")
    .slice(0, 2)
    .map((entry) => entry.pc);
  const { engine } = game([source]);
  const actual: number[] = [];
  engine.setExecutionGate((boundary) => {
    if (boundary.kind === "predicate") {
      actual.push(boundary.pc);
      assert.equal(boundary.opcodePc, boundary.pc + 1);
    }
    return false;
  });
  engine.tick();
  assert.deepEqual(actual, expected);
});

test("direct execution cannot bypass a reported stop", () => {
  const { engine } = game(["increment(v50); return;"]);
  engine.setExecutionGate(() => true);
  engine.tick();
  const stop = engine.executionStop;
  assert.throws(() => engine.execute(0), /stopped|parked|execution/i);
  assert.equal(engine.vars[50], 0);
  assert.equal(engine.executionStop, stop);
});

test("a resumed host failure remains faulted and freezes the clock", () => {
  const { engine, host } = game(["increment(v50); new.room(1); return;"]);
  host.prepareRoom = () => {
    throw new HostWait();
  };
  engine.setExecutionGate(() => false);
  engine.tick();
  assert.equal(engine.hostInteraction!.kind, "room");
  engine.deliverHostAnswer(true);
  assert.throws(() => engine.tick(), /logic resource 1/);
  assert.throws(() => engine.tick(), /logic resource 1/);
  engine.advanceClock(1000);
  assert.equal(engine.vars[11], 0);
  assert.equal(engine.vars[50], 1);
});

test("sound completion cannot mutate flags while instruction execution is stopped", () => {
  const { engine, container } = game(["load.sound(1); sound(1,f60); increment(v50); return;"]);
  container.putResource(
    "sound",
    1,
    Uint8Array.of(
      8,
      0,
      15,
      0,
      17,
      0,
      19,
      0,
      1,
      0,
      0,
      0,
      15,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
    ),
  );
  engine.setExecutionGate((boundary) => boundary.pc === 5);
  engine.tick();
  assert.equal(engine.executionStop!.pc, 5);
  for (let i = 0; i < 5; i++) engine.soundTick();
  assert.equal(engine.flags[60], 0);
  engine.resumeExecution();
  for (let i = 0; i < 5; i++) engine.soundTick();
  assert.equal(engine.flags[60], 0, "sound waits for execution to actually resume");
  engine.tick();
  for (let i = 0; i < 5; i++) engine.soundTick();
  assert.equal(engine.flags[60], 1);
});

test("an unterminated OR cannot be accepted as a completed IF", () => {
  const { engine, container } = game(["return;"]);
  // ff IF, fc OR, 07 50 isset f50, ff without closing fc, 0000 delta, return.
  container.putResource(
    "logic",
    0,
    buildLogicResource(Uint8Array.of(255, 252, 7, 50, 255, 0, 0, 0), []),
  );
  assert.throws(() => engine.tick(), /invalid condition/i);
});
