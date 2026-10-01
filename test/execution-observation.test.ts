import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
import type { ExecutionObservation } from "../src/runtime/executionObservation.ts";
import { createContainer } from "../src/container/container.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { assembleLogic } from "../src/logic/assembler.ts";

/**
 * After-operation observations. An armed observer is handed a detached,
 * frozen record after every actually executed action and every actually
 * evaluated predicate, plus an explicit phase record for atomic engine work
 * with no responsible LOGIC instruction. Returning true latches a stop that
 * freezes the run mid-cycle until `resumeExecution`; a suspended or
 * unwinding operation reports its real outcome instead of a completion.
 */

/** Non-suspending host with a scriptable input line and recorded prints. */
class QuietHost implements EngineHost {
  prints: string[] = [];
  input: { line: string | null; polls: number } = { line: null, polls: 0 };

  print(text: string): void {
    this.prints.push(text);
  }
  displayAt(): void {}
  statusLine(): void {}
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

/** Every interaction service suspends; prompt calls are counted. */
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

/** prepareRoom suspends like an authored-room bridge call; calls are counted. */
class AuthoringHost extends QuietHost {
  prepares = 0;
  prepareRoom(): boolean {
    this.prepares++;
    throw new HostWait();
  }
}

function game(
  sources: readonly string[],
  options: {
    host?: EngineHost;
    dictionary?: Map<string, number>;
    budget?: number;
    policy?: "host-segment" | "whole-pass";
  } = {},
) {
  const container = createContainer();
  const dictionary = options.dictionary ?? new Map([["look", 100]]);
  sources.forEach((source, num) =>
    container.putResource("logic", num, assembleLogic(source, { dictionary }).payload),
  );
  const host = options.host ?? new QuietHost();
  return {
    engine: new Engine(container, host, dictionary, {
      instructionBudget: options.budget ?? 10000,
      executionBudgetPolicy: options.policy ?? "host-segment",
    }),
    host,
    container,
  };
}

test("an after-action observation reports post-op state; a stop freezes the next mutation", () => {
  const container = createContainer();
  // Hand-computed: assignn is opcode 0x03 (v, n), return is 0x00.
  container.putResource(
    "logic",
    0,
    buildLogicResource(
      Uint8Array.of(
        0x03,
        40,
        1, // 0: assignn(v40, 1)
        0x03,
        40,
        2, // 3: assignn(v40, 2)
        0x03,
        40,
        1, // 6: assignn(v40, 1) — a 1 -> 2 -> 1 watch sees every write
        0x00, // 9: return
      ),
      [],
    ),
  );
  const engine = new Engine(container, new QuietHost(), new Map());
  const observations: ExecutionObservation[] = [];
  const seen: number[] = [];
  engine.setExecutionObserver((observation) => {
    observations.push(observation);
    if (observation.cause.type === "instruction" && observation.cause.boundary.kind === "action") {
      seen.push(engine.vars[40]!);
      return seen.length === 2;
    }
    return undefined;
  });
  engine.tick();
  assert.deepEqual(seen, [1, 2], "each completed write was observed after its operation");
  assert.equal(engine.vars[40], 2, "the next assignn has not run");

  const stop = engine.executionStopInfo!;
  assert.ok(stop, "the requested stop latched");
  assert.equal(stop.wait, null);
  assert.equal(stop.cause.type, "instruction");
  if (stop.cause.type !== "instruction") assert.fail();
  const boundary = stop.cause.boundary;
  assert.equal(boundary.logic, 0);
  assert.equal(boundary.pc, 3);
  assert.equal(boundary.opcodePc, 3);
  assert.equal(boundary.kind, "action");
  assert.equal(boundary.frames.length, 1);
  assert.equal(boundary.frames[0]!.logic, 0);
  assert.equal(boundary.frames[0]!.invocationId, 1);
  assert.ok(Object.isFrozen(boundary.frames), "the stack snapshot is detached");
  // The cause names the operation that ran; the location is the resume point —
  // the next instruction (assignn at pc 6), a distinct boundary.
  assert.equal(stop.location?.logic, 0);
  assert.equal(stop.location?.pc, 6);
  assert.equal(stop.location?.kind, "action");
  assert.equal(engine.executionStop, stop.location, "the legacy accessor reports the resume point");
  assert.equal(engine.executionStop?.pc, 6);
  assert.equal(engine.continuationPending, true);
  assert.equal(engine.completedCycleSerial, 0, "a stopped pass counts nothing");

  // Frozen: ticks and clock advances run nothing.
  for (let i = 0; i < 3; i++) {
    engine.tick();
    engine.advanceClock(1000);
  }
  assert.equal(engine.vars[40], 2);
  assert.equal(engine.vars[11], 0);
  assert.equal(engine.completedCycleSerial, 0);

  engine.resumeExecution();
  engine.tick();
  assert.deepEqual(seen, [1, 2, 1], "the change back was observed too");
  assert.equal(engine.vars[40], 1);
  assert.equal(engine.completedCycleSerial, 1, "the resumed pass completed its tail");
  assert.equal(engine.executionStopInfo, null);

  const kinds = observations
    .filter(
      (o): o is typeof o & { cause: { type: "instruction" } } => o.cause.type === "instruction",
    )
    .map((o) => o.cause.boundary.kind);
  assert.deepEqual(kinds, ["action", "action", "action", "return"]);
  assert.ok(
    observations.every((o, i) => i === 0 || o.sequence > observations[i - 1]!.sequence),
    "observation sequences are strictly increasing",
  );
  assert.ok(
    observations.some((o) => o.cause.type === "phase" && o.cause.phase === "input"),
    "non-instruction phases report with a phase cause",
  );
});

test("evaluated predicates report their raw result; skipped and structural terms report nothing", () => {
  const container = createContainer();
  // Hand-computed OR group `equaln(v50,1) || !isset(f50) || equaln(v50,9)`:
  // an OR bracket opens/closes with fc; a NOT inside the group negates the
  // following term's raw result. v50 = 0 and f50 = 0 make the second term
  // satisfy the group, so the third is skipped without evaluation.
  container.putResource(
    "logic",
    0,
    buildLogicResource(
      Uint8Array.of(
        0x03,
        50,
        0, // 0: assignn(v50, 0)
        0xff, // 3: IF
        0xfc, // 4: OR open
        0x01,
        50,
        1, // 5: equaln(v50, 1) -> false
        0xfd, // 8: NOT (term prefix inside the OR group)
        0x07,
        50, // 9: isset(f50) -> raw false
        0x01,
        50,
        9, // 11: equaln(v50, 9) — skipped, never evaluated
        0xfc, // 14: OR close
        0xff, // 15: IF end
        4,
        0, // 16: delta 4 -> else lands at 22
        0x03,
        60,
        1, // 18: assignn(v60, 1)
        0x00, // 21: return
        0x00, // 22: return (else path)
      ),
      [],
    ),
  );
  const engine = new Engine(container, new QuietHost(), new Map());
  const predicates: { pc: number; opcodePc: number; result: boolean | undefined }[] = [];
  const ifBoundaries: number[] = [];
  engine.setExecutionObserver((observation) => {
    if (observation.cause.type !== "instruction") return false;
    const { kind, pc, opcodePc } = observation.cause.boundary;
    if (kind === "predicate") predicates.push({ pc, opcodePc, result: observation.result });
    if (kind === "if") ifBoundaries.push(pc);
    return false;
  });
  engine.tick();
  assert.equal(engine.vars[60], 1, "the satisfied OR group ran the body");
  assert.deepEqual(predicates, [
    { pc: 5, opcodePc: 5, result: false },
    { pc: 8, opcodePc: 9, result: false }, // NOT stays on pc; the handler byte is opcodePc
  ]);
  assert.deepEqual(ifBoundaries, [3], "the IF resolution reports once at its instruction");

  // AND short-circuit: the first false term skips the rest of the list.
  container.putResource(
    "logic",
    0,
    buildLogicResource(
      Uint8Array.of(
        0xff, // 0: IF
        0x01,
        50,
        1, // 1: equaln(v50, 1) -> false (v50 is still 0)
        0x07,
        50, // 4: isset(f50) — skipped
        0xff, // 6: IF end
        2,
        0, // 7: delta 2
        0x03,
        61,
        1, // 9: assignn(v61, 1) — unreachable
        0x00, // 12: return
        0x00, // 13: return (else path)
      ),
      [],
    ),
  );
  const second = new Engine(container, new QuietHost(), new Map());
  const secondPredicates: number[] = [];
  second.setExecutionObserver((observation) => {
    if (observation.cause.type === "instruction" && observation.cause.boundary.kind === "predicate")
      secondPredicates.push(observation.cause.boundary.opcodePc);
    return false;
  });
  second.tick();
  assert.equal(second.vars[61], 0, "the failed conjunction skipped the body");
  assert.deepEqual(secondPredicates, [1], "the skipped term never reported");
});

test("said and have.key evaluate once per encounter across a suspended wait", () => {
  const container = createContainer();
  // accept.input(); wait: if ((said("look") || isset(f50)) && !have.key()) { goto wait; }
  //   assignn(v60,1); return;
  // Hand-computed: said's word id is 100 ("look"); have.key suspends on its
  // seventeenth poll of the pass, so the list iterates a busy loop first.
  container.putResource(
    "logic",
    0,
    buildLogicResource(
      Uint8Array.of(
        0x78, // 0: accept.input()
        0xff, // 1: IF (label wait)
        0xfc, // 2: OR open
        0x0e,
        0x01,
        0x64,
        0x00, // 3: said(100) — consumes f4 once
        0x07,
        0x32, // 7: isset(f50)
        0xfc, // 9: OR close
        0xfd, // 10: NOT
        0x0d, // 11: have.key
        0xff, // 12: IF end
        0x03,
        0x00, // 13: delta 3 -> else lands at 18
        0xfe,
        0xef,
        0xff, // 15: goto wait (pc 1; -17)
        0x03,
        0x3c,
        0x01, // 18: assignn(v60, 1)
        0x00, // 21: return
      ),
      [],
    ),
  );
  const host = new SuspendingHost();
  const engine = new Engine(container, host, new Map([["look", 100]]));
  const observations: ExecutionObservation[] = [];
  engine.setExecutionObserver((observation) => {
    observations.push(observation);
    return false;
  });
  // Cycle 1 primes input: a typed line is only consumed once accept.input has
  // run, so the "look" line lands on cycle 2's input phase. With f50 clear the
  // OR clause fails immediately — said@3 and isset@7 report, have.key is
  // skipped and never polls.
  engine.tick();
  assert.equal(engine.vars[60], 1);
  engine.vars[60] = 0;
  engine.flags[50] = 1;
  host.input.line = "look";
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "key", "have.key suspended on its host wait");
  assert.equal(engine.continuationPending, true);

  // Term pcs: said@3, isset@7, have.key@11 (term origin 10 sits on the NOT).
  const predicatePcs = (pcs: number[], results: boolean[]) =>
    observations
      .filter(
        (o): o is ExecutionObservation & { cause: { type: "instruction" } } =>
          o.cause.type === "instruction" &&
          o.cause.boundary.kind === "predicate" &&
          o.outcome === "completed",
      )
      .map((o) => {
        const b = o.cause.boundary;
        pcs.push(b.opcodePc);
        results.push(o.result!);
      });

  const beforePcs: number[] = [];
  const beforeResults: boolean[] = [];
  predicatePcs(beforePcs, beforeResults);
  assert.deepEqual(
    beforePcs,
    // cycle 1: said false, isset false — have.key skipped. Cycle 2, iteration
    //   1: said true (f4 consumed), isset skipped (group satisfied), have.key
    //   false (poll 1); iterations 2..16: said false, isset true, have.key
    //   false; iteration 17's have.key suspends mid-evaluation.
    [3, 7, 3, 11, ...Array.from({ length: 15 }, () => [3, 7, 11]).flat(), 3, 7],
    "every evaluated term reported; the skipped isset of iteration 1 never did",
  );
  assert.deepEqual(beforeResults, [
    false,
    false,
    true,
    false,
    ...Array.from({ length: 15 }, () => [false, true, false]).flat(),
    false,
    true,
  ]);
  const suspensions = observations.filter((o) => o.outcome === "awaiting-host");
  assert.equal(suspensions.length, 1, "one suspension observation for the in-flight wait");
  assert.equal(
    suspensions[0]!.cause.type === "instruction" ? suspensions[0]!.cause.boundary.opcodePc : -1,
    11,
    "the suspended term is identified by its handler byte",
  );
  assert.equal(
    suspensions[0]!.cause.type === "instruction" ? suspensions[0]!.cause.boundary.kind : "",
    "predicate",
  );

  engine.deliverHostAnswer(0x62);
  engine.tick();
  const afterPcs: number[] = [];
  const afterResults: boolean[] = [];
  predicatePcs(afterPcs, afterResults);
  assert.deepEqual(afterPcs.slice(51), [11], "only the suspending term evaluated on resume");
  assert.equal(afterResults[51], true);
  assert.equal(
    afterPcs.slice(0, 51).filter((pc) => pc === 3).length,
    18,
    "the consumed said was never re-evaluated by the resume",
  );
  assert.equal(engine.vars[19], 0x62, "the delivered key reached the IF once");
  assert.equal(engine.vars[60], 1, "the pass continued past the resumed IF");
  assert.equal(engine.completedCycleSerial, 2);
});

test("call and return observations carry detached invocation identities", () => {
  const { engine } = game([
    `assignn(v50, 2); call(1); assignn(v60, 1); return;`,
    `if (greatern(v50, 0)) { decrement(v50); call(1); } return;`,
  ]);
  const observations: ExecutionObservation[] = [];
  engine.setExecutionObserver((observation) => {
    observations.push(observation);
    return false;
  });
  engine.tick();
  assert.equal(engine.vars[50], 0, "the recursion counted down");
  assert.equal(engine.vars[60], 1, "the outer call returned");

  const returns = observations.filter(
    (o) =>
      o.cause.type === "instruction" &&
      o.cause.boundary.kind === "return" &&
      o.cause.boundary.logic === 1,
  );
  assert.equal(returns.length, 3, "one observation per nested invocation exit");
  assert.deepEqual(
    returns.map((o) => (o.cause.type === "instruction" ? o.cause.boundary.frames.length : -1)),
    [4, 3, 2],
    "each return reports the pre-pop stack — the responsible callee is still on it",
  );
  const topIds = returns.map((o) =>
    o.cause.type === "instruction" ? o.cause.boundary.frames.at(-1)!.invocationId : -1,
  );
  assert.deepEqual(topIds, [4, 3, 2], "the callee's own invocation is the responsible frame");
  // The top-level return still names its invocation — frames are never empty.
  const topReturn = observations.find(
    (o) =>
      o.cause.type === "instruction" &&
      o.cause.boundary.kind === "return" &&
      o.cause.boundary.logic === 0,
  );
  assert.ok(topReturn && topReturn.cause.type === "instruction");
  assert.deepEqual(
    topReturn.cause.boundary.frames.map((f) => f.invocationId),
    [1],
  );
  // Calls attribute to the caller's stack — the pushed child is not on it.
  // logic1's bytecode is `ff 05 32 00 ff 04 00 02 32 16 01 00`: its call(1)
  // sits at pc9 inside the if-body.
  const calls = observations.filter(
    (o) =>
      o.cause.type === "instruction" && o.cause.boundary.logic === 1 && o.cause.boundary.pc === 9,
  );
  assert.equal(calls.length, 2, "each call invocation reports once");
  for (const o of calls) {
    if (o.cause.type !== "instruction") assert.fail();
    assert.equal(
      o.cause.boundary.frames.at(-1)?.logic,
      1,
      "a call is attributed to its caller, not the pushed child",
    );
    assert.equal(o.cause.boundary.kind, "action");
  }
  const outerCall = observations.find(
    (o) =>
      o.cause.type === "instruction" && o.cause.boundary.logic === 0 && o.cause.boundary.pc === 3,
  );
  assert.ok(outerCall && outerCall.cause.type === "instruction");
  assert.deepEqual(
    outerCall.cause.boundary.frames.map((f) => f.logic),
    [0],
  );
  for (const o of returns)
    assert.ok(
      o.cause.type === "instruction" && Object.isFrozen(o.cause.boundary.frames),
      "return snapshots are detached",
    );
});

test("a throwing observer faults the run instead of dropping the observation", () => {
  const { engine } = game(["increment(v50); increment(v51); return;"]);
  let calls = 0;
  engine.setExecutionObserver(() => {
    if (++calls === 4) throw new Error("observer boom");
    return false;
  });
  assert.throws(() => engine.tick(), /observer boom/);
  assert.throws(() => engine.tick(), /observer boom/, "the fault latches");
  assert.throws(() => engine.resumeExecution(), /observer boom/);
  engine.advanceClock(1000);
  assert.equal(engine.vars[11], 0, "a faulted run's clock stays frozen");
});

test("an observer that never stops leaves execution identical to unarmed play", () => {
  const sources = [
    `accept.input();
     increment(v60);
     if (said("look") || equaln(v61, 9)) { assignn(v62, 5); }
     call(1);
     again: if (greatern(v64, 0)) { decrement(v64); goto again; }
     return;`,
    `increment(v65); return;`,
  ];
  const dictionary = new Map([["look", 100]]);
  const run = (armed: boolean) => {
    const container = createContainer();
    sources.forEach((source, num) =>
      container.putResource("logic", num, assembleLogic(source, { dictionary }).payload),
    );
    // The first poll lands before accept.input has ever run, so it must offer
    // nothing; the accepted "look" arrives on cycle 2.
    const input = { lines: [null, "look", null, null] as (string | null)[], polls: 0 };
    const host = new QuietHost();
    host.takeInputLine = () => {
      input.polls++;
      return input.lines.shift() ?? null;
    };
    const engine = new Engine(container, host, dictionary);
    if (armed)
      engine.setExecutionObserver(() => {
        return false;
      });
    for (let i = 0; i < 4; i++) engine.tick();
    return {
      vars: Array.from(engine.vars),
      flags: Array.from(engine.flags),
      prints: host.prints,
      polls: input.polls,
      serial: engine.completedCycleSerial,
    };
  };
  const plain = run(false);
  const armed = run(true);
  assert.deepEqual(armed.vars, plain.vars);
  assert.deepEqual(armed.flags, plain.flags);
  assert.deepEqual(armed.prints, plain.prints);
  assert.equal(armed.polls, plain.polls);
  assert.equal(armed.serial, plain.serial);
  assert.equal(plain.vars[62], 5, "the schedule actually exercised the logic");
});

test("new.room reports its unwind and the transition tail runs once on resume", () => {
  // Sparse: logic 5 exists so new.room(5)'s re-entry can load it.
  const sources: string[] = [];
  sources[0] = `if (equaln(v0, 0)) { new.room(5); } increment(v60); return;`;
  sources[5] = `return;`;
  const { engine } = game(sources);
  const observations: ExecutionObservation[] = [];
  engine.setExecutionObserver((observation) => {
    observations.push(observation);
    return observation.outcome === "unwind";
  });
  engine.tick();
  const stop = engine.executionStopInfo!;
  assert.ok(stop);
  assert.equal(stop.cause.type, "instruction", "the unwinding operation is the cause");
  if (stop.cause.type !== "instruction") assert.fail();
  assert.equal(stop.cause.boundary.kind, "action", "new.room unwinds from its own instruction");
  assert.equal(stop.cause.boundary.frames.length, 1, "the snapshot names the abandoned frame");
  assert.equal(stop.location, null, "an unwound stack is not a resume point");
  assert.equal(engine.vars[0], 5, "the room variable already moved");
  assert.equal(engine.vars[60], 0, "the re-entry pass has not run yet");
  assert.equal(engine.completedCycleSerial, 0);

  engine.resumeExecution();
  engine.tick();
  assert.equal(engine.vars[60], 1, "logic 0 re-entered once after the room tail");
  assert.equal(engine.vars[0], 5);
  assert.equal(engine.completedCycleSerial, 1);
  const unwinds = observations.filter((o) => o.outcome === "unwind");
  assert.equal(unwinds.length, 1, "the unwind is reported exactly once");
  const unwindIndex = observations.indexOf(unwinds[0]!);
  const roomPhase = observations.findIndex(
    (o) => o.cause.type === "phase" && o.cause.phase === "room",
  );
  const nextInstruction = observations.findIndex(
    (o, i) => i > unwindIndex && o.cause.type === "instruction",
  );
  assert.ok(roomPhase > unwindIndex, "the room tail observes after the unwind");
  assert.ok(nextInstruction > roomPhase, "re-entry follows the room phase");
});

test("a suspended action reports awaiting-host; the host call is never repeated", () => {
  const host = new SuspendingHost();
  const { engine } = game(
    [`#message 1 "How many?"\nget.num(1, v100);\nassignn(v101, 7);\nreturn;`],
    { host },
  );
  const observations: ExecutionObservation[] = [];
  engine.setExecutionObserver((observation) => {
    observations.push(observation);
    return false;
  });
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "getnum");
  assert.equal(host.prompts, 1);
  const suspended = observations.filter((o) => o.outcome === "awaiting-host");
  assert.equal(suspended.length, 1, "one suspension observation");
  const suspendPc =
    suspended[0]!.cause.type === "instruction" ? suspended[0]!.cause.boundary.pc : -1;
  assert.equal(engine.vars[100], 0, "the answer is not yet applied");

  engine.deliverHostAnswer(0x142);
  engine.tick();
  assert.equal(host.prompts, 1, "the prompt was not invoked again on resume");
  assert.equal(engine.vars[100], 0x42);
  assert.equal(engine.vars[101], 7);
  assert.ok(
    observations.some((o) => o.cause.type === "phase" && o.cause.phase === "host-answer"),
    "the answer's application reports as its own phase",
  );
  assert.ok(
    !observations.some(
      (o) =>
        o !== suspended[0] &&
        o.cause.type === "instruction" &&
        o.cause.boundary.pc === suspendPc &&
        o.cause.boundary.kind === "action",
    ),
    "the suspended action never reports twice",
  );
});

test("a latched then resumed prepareRoom wait still admits the delivered room", () => {
  // The detach-deferred-disarm scenario: an explicit pause overlays the
  // parked prepareRoom wait; mutation stays refused while latched and the
  // answer-preparation boundary returns on resume alone.
  const host = new AuthoringHost();
  const { engine, container } = game(
    ["increment(v60); if (equaln(v0, 0)) { new.room(5); } if (equaln(v0, 5)) { call(5); } return;"],
    { host },
  );
  engine.setExecutionObserver(() => false);
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "room");
  assert.equal(host.prepares, 1);

  const destination = {
    kind: "logic" as const,
    num: 5,
    payload: assembleLogic("assignn(v101, 7); return;", { dictionary: new Map() }).payload,
  };
  const generation = engine.patchGeneration;

  engine.pauseExecution();
  assert.ok(engine.executionStopInfo);
  assert.throws(() => engine.patchResources([destination]), /parked execution/);
  assert.throws(() => engine.captureReplayState(), /checkpoint/i);
  assert.equal(container.getResource("logic", 5), null);
  assert.equal(engine.patchGeneration, generation, "a refused patch leaves bytes and generation");

  engine.resumeExecution();
  engine.patchResources([destination]);
  assert.deepEqual(container.getResource("logic", 5), destination.payload);
  assert.equal(engine.patchGeneration, generation + 1);
  // The admission opened no checkpoint path: armed + parked still refuses.
  assert.throws(() => engine.captureReplayState(), /checkpoint/i);

  engine.deliverHostAnswer(true);
  engine.tick();
  assert.equal(host.prepares, 1, "the suspended hook is never re-invoked");
  assert.equal(engine.vars[0], 5);
  assert.equal(engine.vars[101], 7);
  assert.equal(engine.completedCycleSerial, 1);
});

test("an observer stop that parks a newly opened modal keeps its host boundary", () => {
  // show.pri.screen (0x1d) — a modal opener with no window text or resources,
  // proving the parked-modal classification is not special-cased to print.
  // Hand-computed: increment 2 bytes at pc0, show.pri.screen at pc2.
  const { engine } = game(["increment(v40);\nshow.pri.screen();\nincrement(v41);\nreturn;"], {
    budget: 3,
    policy: "host-segment",
  });
  let stopped = false;
  engine.setExecutionObserver((observation) => {
    if (
      !stopped &&
      observation.cause.type === "instruction" &&
      observation.cause.boundary.opcodePc === 2
    ) {
      stopped = true;
      return true;
    }
    return false;
  });
  engine.tick();
  assert.equal(stopped, true);
  assert.equal(engine.modalKind, "showPri");
  assert.deepEqual([engine.vars[40], engine.vars[41]], [1, 0]);

  engine.resumeExecution();
  engine.ackPrint();
  assert.equal(engine.modalKind, null);
  assert.doesNotThrow(() => engine.tick(), "the acknowledged modal still renews its host segment");
  assert.deepEqual([engine.vars[40], engine.vars[41]], [1, 1]);
  assert.equal(engine.completedCycleSerial, 1);
});
