import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Engine,
  HostWait,
  type EngineHost,
  type ExecutionBudgetPolicy,
} from "../src/runtime/engine.ts";
import { createContainer } from "../src/container/container.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { assembleLogic } from "../src/logic/assembler.ts";

function host(overrides: Partial<EngineHost> = {}): EngineHost {
  return {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
    ...overrides,
  };
}

function engine(
  logic0: Uint8Array | string,
  options: {
    messages?: readonly string[];
    instructionBudget?: number;
    policy?: ExecutionBudgetPolicy;
    host?: EngineHost;
    dictionary?: ReadonlyMap<string, number>;
  } = {},
): Engine {
  const container = createContainer();
  const payload =
    typeof logic0 === "string"
      ? assembleLogic(logic0, { dictionary: options.dictionary ?? new Map() }).payload
      : buildLogicResource(logic0, options.messages ?? []);
  container.putResource("logic", 0, payload);
  return new Engine(container, options.host ?? host(), options.dictionary ?? new Map(), {
    ...(options.instructionBudget === undefined
      ? {}
      : { instructionBudget: options.instructionBudget }),
    ...(options.policy === undefined ? {} : { executionBudgetPolicy: options.policy }),
  });
}

test("the constructor validates and reports the execution budget policy", () => {
  assert.throws(
    () =>
      engine(Uint8Array.of(0), {
        policy: "bogus" as ExecutionBudgetPolicy,
      }),
    /executionBudgetPolicy/i,
  );
  const compat = engine(Uint8Array.of(0));
  assert.equal(compat.executionBudgetPolicy, "host-segment", "compatibility is the default");
  compat.setExecutionGate(() => false);
  assert.equal(
    compat.executionBudgetPolicy,
    "host-segment",
    "arming execution control does not select a policy",
  );
  assert.equal(
    engine(Uint8Array.of(0), { policy: "whole-pass" }).executionBudgetPolicy,
    "whole-pass",
  );
});

// inc v60; get.num #1 -> v100; inc v61; inc v62; return — five charged units,
// suspending inside the second.
const FIVE_UNIT_PROMPT = Uint8Array.of(1, 60, 118, 1, 100, 1, 61, 1, 62, 0);

function suspendingPromptHost(): { host: EngineHost; requests: () => number } {
  let requests = 0;
  return {
    requests: () => requests,
    host: host({
      promptNumber: () => {
        requests++;
        throw new HostWait();
      },
    }),
  };
}

test("compatibility host-segment renews the allowance at a real host answer, armed or not", () => {
  for (const armed of [false, true]) {
    const { host: h, requests } = suspendingPromptHost();
    const e = engine(FIVE_UNIT_PROMPT, { messages: ["Number?"], instructionBudget: 3, host: h });
    if (armed) e.setExecutionGate(() => false);
    e.tick();
    assert.equal(e.awaitingHostAnswer, true);
    assert.equal(e.vars[60], 1);
    e.deliverHostAnswer(7);
    assert.doesNotThrow(() => e.tick(), `armed=${armed}: the resumed segment is fresh`);
    assert.deepEqual([e.vars[60], e.vars[100], e.vars[61], e.vars[62]], [1, 7, 1, 1]);
    assert.equal(requests(), 1, "the suspending call is not replayed");
    assert.equal(e.completedCycleSerial, 1);
    // A real new pass renews too — it suspends on the prompt again rather
    // than dying on the leftover units.
    e.tick();
    assert.equal(e.awaitingHostAnswer, true);
    assert.deepEqual([e.vars[60], e.vars[61], e.vars[62]], [2, 1, 1]);
    e.deliverHostAnswer(3);
    e.tick();
    assert.deepEqual([e.vars[100], e.vars[61], e.vars[62]], [3, 2, 2]);
    assert.equal(e.completedCycleSerial, 2);
    assert.equal(requests(), 2, "the host was asked once per pass");
  }
});

test("whole-pass spans a host wait identically armed or detached; unanswered polls renew nothing", () => {
  for (const armed of [false, true]) {
    const { host: h, requests } = suspendingPromptHost();
    const e = engine(FIVE_UNIT_PROMPT, {
      messages: ["Number?"],
      instructionBudget: 3,
      policy: "whole-pass",
      host: h,
    });
    if (armed) e.setExecutionGate(() => false);
    e.tick();
    assert.equal(e.awaitingHostAnswer, true);
    // Polls with no answer in flight cannot stretch the pass.
    e.tick();
    e.tick();
    assert.equal(e.vars[61], 0);
    e.deliverHostAnswer(7);
    assert.throws(() => e.tick(), /instruction budget/i, `armed=${armed}`);
    // The answer applied once and inc61 ran; inc62's charge exhausted the pass.
    assert.deepEqual([e.vars[60], e.vars[100], e.vars[61], e.vars[62]], [1, 7, 1, 0]);
    assert.equal(requests(), 1);
    assert.equal(e.completedCycleSerial, 0, "a faulted pass counts no cycle");
    if (armed) assert.throws(() => e.tick(), /instruction budget/i, "armed faults latch");

    // A synchronous host spends the same pass's units, so it dies identically.
    const sync = engine(FIVE_UNIT_PROMPT, {
      messages: ["Number?"],
      instructionBudget: 3,
      policy: "whole-pass",
      host: host({ promptNumber: () => 7 }),
    });
    if (armed) sync.setExecutionGate(() => false);
    assert.throws(() => sync.tick(), /instruction budget/i, `armed=${armed} sync`);
    assert.deepEqual([sync.vars[60], sync.vars[100], sync.vars[61], sync.vars[62]], [1, 7, 1, 0]);
  }
});

test("a debugger stop resume renews neither policy's allowance", () => {
  // inc v40 x4; return — each instruction sits behind its own stop boundary.
  const code = Uint8Array.of(1, 40, 1, 40, 1, 40, 1, 40, 0);
  for (const policy of ["host-segment", "whole-pass"] as const) {
    const e = engine(code, { instructionBudget: 3, policy });
    e.setExecutionGate(() => true);
    e.tick();
    assert.ok(e.executionStop);
    for (let i = 0; i < 3; i++) {
      e.resumeExecution();
      e.tick();
      assert.ok(e.executionStop, `${policy}: stop ${i + 2}`);
    }
    assert.equal(e.vars[40], 3, `${policy}: three increments were charged`);
    e.resumeExecution();
    assert.throws(() => e.tick(), /instruction budget/i, `${policy}: the fourth charge dies`);
    assert.throws(() => e.tick(), /instruction budget/i, `${policy}: the fault stays latched`);
    assert.equal(e.completedCycleSerial, 0);
  }
});

test("cooperative execution slices never renew either policy's allowance", () => {
  // goto -> itself at pc0: target = 0 + 3 + (-3).
  const code = Uint8Array.of(0xfe, 0xfd, 0xff);
  for (const policy of ["host-segment", "whole-pass"] as const) {
    const e = engine(code, { instructionBudget: 2200, policy });
    e.setExecutionGate(() => false);
    e.tick();
    assert.equal(e.executionYieldPending, true);
    e.tick();
    assert.equal(e.executionYieldPending, true);
    assert.throws(() => e.tick(), /instruction budget/i, policy);
  }
});

test("a modal window renews compatibility but not the whole-pass allowance", () => {
  // inc v60; print #1 (opens an acknowledged window); inc v61; return.
  const code = Uint8Array.of(1, 60, 101, 1, 1, 61, 0);
  for (const armed of [false, true]) {
    const seg = engine(code, { messages: ["hi"], instructionBudget: 3 });
    if (armed) seg.setExecutionGate(() => false);
    seg.tick();
    assert.equal(seg.modalKind, "print");
    seg.ackPrint();
    seg.tick();
    assert.deepEqual([seg.vars[60], seg.vars[61]], [1, 1], `armed=${armed}`);

    const whole = engine(code, {
      messages: ["hi"],
      instructionBudget: 3,
      policy: "whole-pass",
    });
    if (armed) whole.setExecutionGate(() => false);
    whole.tick();
    assert.equal(whole.modalKind, "print");
    whole.ackPrint();
    assert.throws(() => whole.tick(), /instruction budget/i, `armed=${armed}`);
    assert.deepEqual([whole.vars[60], whole.vars[61]], [1, 1]);
    assert.equal(whole.completedCycleSerial, 0);
  }
});

test("a clock busy-wait resume renews compatibility but not the whole-pass allowance", () => {
  // loop: if (v49 > v11) goto loop;  inc v60; return.
  //   0: ff            IF
  //   1: 06 31 0b      greaterv v49, v11
  //   4: ff            IF close; delta 3 -> body 7, end 10
  //   7: fe f6 ff      goto 0 (target = 7 + 3 - 10)
  //  10: 01 3c         inc v60
  //  12: 00            return
  const code = Uint8Array.of(
    0xff,
    0x06,
    0x31,
    0x0b,
    0xff,
    0x03,
    0x00,
    0xfe,
    0xf6,
    0xff,
    0x01,
    0x3c,
    0x00,
  );
  // A lap charges 4 (IF, predicate, close marker, goto); the 1000th backward
  // edge parks the clock wait — exactly 4000 units before the wait begins.
  // An armed engine additionally slices every 1024 gated units, so drive
  // through the cooperative yields until the pass actually parks on the wait.
  const driveToWait = (e: Engine): void => {
    e.tick();
    for (let i = 0; i < 20 && e.executionYieldPending; i++) e.tick();
  };
  for (const armed of [false, true]) {
    const seg = engine(code, { instructionBudget: 4000 });
    if (armed) seg.setExecutionGate(() => false);
    seg.vars[49] = 1;
    driveToWait(seg);
    assert.equal(seg.continuationPending, true);
    // The next segment is freshly provisioned even though the wait continues.
    driveToWait(seg);
    assert.equal(seg.continuationPending, true);
    seg.advanceClock(1000);
    driveToWait(seg);
    assert.equal(seg.vars[60], 1, `armed=${armed}`);
    assert.equal(seg.completedCycleSerial, 1);

    const whole = engine(code, { instructionBudget: 4000, policy: "whole-pass" });
    if (armed) whole.setExecutionGate(() => false);
    whole.vars[49] = 1;
    driveToWait(whole);
    assert.equal(whole.continuationPending, true);
    whole.advanceClock(1000);
    assert.throws(() => whole.tick(), /instruction budget/i, `armed=${armed}`);
    assert.equal(whole.vars[60], 0);
    assert.equal(whole.completedCycleSerial, 0);
    if (armed) {
      assert.equal(whole.continuationPending, true, "the faulted armed pass stays parked");
      assert.throws(() => whole.tick(), /instruction budget/i, "latched");
    }
  }
});

test("a suspended have.key never bills its term or its completed prefix twice", () => {
  // loop: if (isset(f50) && !have.key()) goto loop;  inc v60; inc v61; return.
  //   0: ff            IF
  //   1: 07 32         isset f50
  //   3: fd            NOT
  //   4: 0d            have.key
  //   5: ff            IF close; delta 3 -> body 8, end 11
  //   8: fe f5 ff      goto 0 (target = 8 + 3 - 11)
  //  11: 01 3c         inc v60
  //  13: 01 3d         inc v61
  //  15: 00            return
  const code = Uint8Array.of(
    0xff,
    0x07,
    0x32,
    0xfd,
    0x0d,
    0xff,
    0x03,
    0x00,
    0xfe,
    0xf5,
    0xff,
    0x01,
    0x3c,
    0x01,
    0x3d,
    0x00,
  );
  // A lap charges 6 (IF, isset, NOT, have.key, close, goto). Lap 17 suspends
  // inside have.key after its scan charge — 100 units to that point. The resume
  // re-bills neither the suspending term nor the replayed prefix: close marker,
  // two increments and return = 104 charged across the whole pass.
  const blockingKey: EngineHost = host({
    waitKey: () => {
      throw new HostWait();
    },
  });
  for (const armed of [false, true]) {
    // Compatibility renews at the delivered key.
    const seg = engine(code, { instructionBudget: 100, host: blockingKey });
    seg.flags[50] = 1;
    if (armed) seg.setExecutionGate(() => false);
    seg.tick();
    assert.equal(seg.awaitingKey, true);
    seg.deliverHostAnswer(0x62);
    seg.tick();
    assert.deepEqual([seg.vars[60], seg.vars[61]], [1, 1], `armed=${armed}`);

    const whole = engine(code, {
      instructionBudget: 104,
      policy: "whole-pass",
      host: blockingKey,
    });
    let isset = 0;
    let key = 0;
    whole.setTraceListener((record) => {
      if (record.result === undefined) return;
      if (record.op === 7) isset++;
      if (record.op === 13) key++;
    });
    whole.flags[50] = 1;
    if (armed) whole.setExecutionGate(() => false);
    whole.tick();
    assert.equal(whole.awaitingKey, true);
    assert.equal(isset, 17, `armed=${armed}: the prefix ran once per lap`);
    assert.equal(key, 16, `armed=${armed}: the 17th poll is the one that suspends`);
    whole.deliverHostAnswer(0x62);
    whole.tick();
    assert.equal(isset, 17, `armed=${armed}: the completed prefix never re-evaluates`);
    assert.equal(key, 17, `armed=${armed}: have.key completes exactly once more`);
    assert.deepEqual([whole.vars[19], whole.vars[60], whole.vars[61]], [0x62, 1, 1]);
    assert.equal(whole.completedCycleSerial, 1);

    // One unit short: the pass dies at the return — the suspending term was
    // not billed a second time on resume.
    const short = engine(code, {
      instructionBudget: 103,
      policy: "whole-pass",
      host: blockingKey,
    });
    short.flags[50] = 1;
    if (armed) short.setExecutionGate(() => false);
    short.tick();
    assert.equal(short.awaitingKey, true);
    short.deliverHostAnswer(0x62);
    assert.throws(() => short.tick(), /instruction budget/i, `armed=${armed}`);
    assert.deepEqual([short.vars[60], short.vars[61]], [1, 1]);
    assert.equal(short.completedCycleSerial, 0);
  }
});

test("a consumed said prefix evaluates once and is never billed again across predicate stops", () => {
  const source = 'accept.input(); if (said("look") && have.key()) { increment(v60); } return;';
  const dictionary = new Map([["look", 100]]);
  // Six charged units in the input pass: accept.input, the IF, said, have.key,
  // the close marker and return. said consumes the input, have.key answers
  // false without a blocking host, the body never runs.
  for (const armed of [false, true]) {
    const input: { line: string | null } = { line: null };
    const e = engine(source, {
      dictionary,
      instructionBudget: 6,
      policy: "whole-pass",
      host: host({ takeInputLine: () => input.line }),
    });
    e.tick(); // pass 1: no input yet, said is false
    assert.equal(e.completedCycleSerial, 1);
    let said = 0;
    let key = 0;
    e.setTraceListener((record) => {
      if (record.result === undefined) return;
      if (record.op === 14) said++;
      if (record.op === 13) key++;
    });
    if (armed) e.setExecutionGate(() => true);
    input.line = "look";
    for (let i = 0; i < 20 && e.completedCycleSerial < 2; i++) {
      e.tick();
      if (e.executionStop !== null) e.resumeExecution();
    }
    assert.equal(e.completedCycleSerial, 2, `armed=${armed}`);
    assert.equal(said, 1, `armed=${armed}: the matched said ran once`);
    assert.equal(key, 1, `armed=${armed}: have.key ran once`);
    assert.equal(e.flags[4], 1, "said consumed the input");
    assert.equal(e.vars[60], 0);
  }
  // One unit short dies under either policy before the pass can complete.
  for (const policy of ["host-segment", "whole-pass"] as const) {
    const input: { line: string | null } = { line: "look" };
    const e = engine(source, {
      dictionary,
      instructionBudget: 5,
      policy,
      host: host({ takeInputLine: () => input.line }),
    });
    assert.throws(() => e.tick(), /instruction budget/i, policy);
    assert.equal(e.completedCycleSerial, 0);
  }
});

test("short-circuited condition scanning stays bounded work", () => {
  // if (isset(f200) && isset(f201) x20) {} return — the false head skips twenty
  // terms. IF + head + 20 skips + close + return = 24 charged units.
  const andCode = Uint8Array.of(
    0xff,
    0x07,
    0xc8,
    ...Array.from({ length: 20 }, () => [0x07, 0xc9]).flat(),
    0xff,
    0x00,
    0x00,
    0x00,
  );
  // if (isset(f200) || said(...) x20) {} return — the true OR head skips twenty
  // said terms (4 bytes each). IF + OR + head + 20 skips + OR close + IF close
  // + return = 26.
  const orCode = Uint8Array.of(
    0xff,
    0xfc,
    0x07,
    0xc8,
    ...Array.from({ length: 20 }, () => [0x0e, 0x01, 0x64, 0x00]).flat(),
    0xfc,
    0xff,
    0x00,
    0x00,
    0x00,
  );
  for (const armed of [false, true]) {
    for (const policy of ["host-segment", "whole-pass"] as const) {
      const andFail = engine(andCode, { instructionBudget: 23, policy });
      if (armed) andFail.setExecutionGate(() => false);
      assert.throws(() => andFail.tick(), /instruction budget/i, `${policy} armed=${armed}`);
      const andOk = engine(andCode, { instructionBudget: 24, policy });
      if (armed) andOk.setExecutionGate(() => false);
      andOk.tick();
      assert.equal(andOk.completedCycleSerial, 1);

      const orFail = engine(orCode, { instructionBudget: 25, policy });
      if (armed) orFail.setExecutionGate(() => false);
      orFail.flags[200] = 1;
      assert.throws(() => orFail.tick(), /instruction budget/i, `${policy} armed=${armed}`);
      const orOk = engine(orCode, { instructionBudget: 26, policy });
      if (armed) orOk.setExecutionGate(() => false);
      orOk.flags[200] = 1;
      orOk.tick();
      assert.equal(orOk.completedCycleSerial, 1);
    }
  }
});
