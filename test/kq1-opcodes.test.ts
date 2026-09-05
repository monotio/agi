import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { buildLogicResource, parseLogicResource } from "../src/logic/resource.ts";
import { ACTION_BY_CODE, CONDITION_BY_CODE, GOTO, IF, NOT, OR } from "../src/logic/opcodes.ts";
import { Engine, UnimplementedOpcodeError, type EngineHost } from "../src/runtime/engine.ts";
import { fixtureSkip } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Spec-driven completeness census: statically decode EVERY KQ1 logic
 * resource, collect the action/condition opcodes the game actually uses, and
 * prove each used action has dispatch semantics by executing a probe bytecode
 * through the real engine. Replaces playtest-driven opcode discovery.
 */

/** Linear bytecode walk; see module doc for the padding rule. */
function census(code: Uint8Array, actions: Set<number>, conditions: Set<number>): void {
  let pc = 0;
  // Unreachable tail padding after the final return/goto may fail linear
  // decode: the first undecodable byte in that state ends the stream.
  let afterTerminator = false;
  while (pc < code.length) {
    const b = code[pc]!;
    if (b === 0x00) {
      afterTerminator = true;
      pc++;
      continue;
    }
    if (b === GOTO) {
      afterTerminator = true;
      pc += 3;
      continue;
    }
    if (b === IF) {
      pc = scanConditionList(code, pc + 1, conditions) + 2; // + false delta
      afterTerminator = false;
      continue;
    }
    const spec = ACTION_BY_CODE.get(b);
    if (!spec || pc + 1 + spec.operands.length > code.length) {
      if (afterTerminator) return;
      throw new Error(`undecodable action byte 0x${b.toString(16)} at offset ${pc}`);
    }
    actions.add(b);
    afterTerminator = false;
    pc += 1 + spec.operands.length;
  }
}

/** Scan a condition list after the opening 0xff; returns just past the closer. */
function scanConditionList(code: Uint8Array, from: number, conditions: Set<number>): number {
  let pc = from;
  for (;;) {
    const b = code[pc]!;
    if (b === IF) return pc + 1;
    if (b === NOT) {
      pc++;
      continue;
    }
    if (b === OR) {
      pc++;
      for (;;) {
        const t = code[pc]!;
        if (t === OR) {
          pc++;
          break;
        }
        if (t === NOT) pc++;
        pc = skipCondition(code, pc, conditions);
      }
      continue;
    }
    pc = skipCondition(code, pc, conditions);
  }
}

function skipCondition(code: Uint8Array, pc: number, conditions: Set<number>): number {
  const b = code[pc]!;
  if (b === 0x0e) {
    // said: count byte, then count u16le word ids.
    conditions.add(b);
    return pc + 2 + code[pc + 1]! * 2;
  }
  const spec = CONDITION_BY_CODE.get(b);
  if (!spec) throw new Error(`undecodable condition byte 0x${b.toString(16)} at offset ${pc}`);
  conditions.add(b);
  return pc + 1 + spec.operands.length;
}

/** Host with benign implementations of every optional contract method. */
class ProbeHost implements EngineHost {
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return [];
  }
  shakeScreen(): void {}
  showObj(): void {}
  showPriScreen(): void {}
  statusScreen(_items: { num: number; name: string }[]): void {}
  promptNumber(): number {
    return 7;
  }
  promptString(): string {
    return "x";
  }
  saveGame(): void {}
  restoreGame(): Uint8Array | null {
    return null;
  }
  logText(): void {}
  versionString(): string {
    return "probe";
  }
}

/**
 * Prove dispatch coverage for one action code: run a minimal bytecode
 * containing it through the real engine. Operand bytes are 2 so message(2)
 * resolves and no operand aliases the probe logic itself. Any engine behavior
 * — including errors from nonsensical operands — counts as handled; only
 * UnimplementedOpcodeError fails the proof.
 */
function probeAction(code: number): void {
  const spec = ACTION_BY_CODE.get(code)!;
  const bytecode = new Uint8Array(1 + spec.operands.length + 1);
  bytecode[0] = code;
  bytecode.fill(2, 1, 1 + spec.operands.length);
  bytecode[bytecode.length - 1] = 0x00; // return
  const container = createContainer();
  container.putResource("logic", 1, buildLogicResource(bytecode, ["m one", "m two"]));
  const engine = new Engine(container, new ProbeHost());
  try {
    engine.execute(1);
  } catch (e) {
    assert.ok(
      !(e instanceof UnimplementedOpcodeError),
      `action 0x${code.toString(16)} (${spec.name}) has no dispatch semantics`,
    );
  }
}

test("every opcode KQ1 uses has engine dispatch semantics", { skip: fixtureSkip("kq1") }, () => {
  const { container } = loadGame("kq1");
  const actions = new Set<number>();
  const conditions = new Set<number>();
  let logicCount = 0;
  for (let n = 0; n < 256; n++) {
    const payload = container.getResource("logic", n);
    if (!payload) continue;
    logicCount++;
    census(parseLogicResource(payload).code, actions, conditions);
  }
  assert.equal(logicCount, 90, "static census covers every KQ1 logic resource in LOGDIR");

  // The 13 actions this completeness milestone was driven by: KQ1 really
  // does use all of them.
  for (const code of [
    0x1d, 0x6e, 0x76, 0x7a, 0x7c, 0x7e, 0x85, 0x87, 0x8b, 0x8c, 0x8d, 0x90, 0xa2,
  ]) {
    assert.ok(actions.has(code), `expected KQ1 to use action 0x${code.toString(16)}`);
  }

  for (const code of conditions) {
    assert.ok(CONDITION_BY_CODE.has(code), `condition 0x${code.toString(16)} in table`);
  }
  for (const code of actions) probeAction(code);
});

test("KQ1 OBJECT file decodes to real inventory names", { skip: fixtureSkip("kq1") }, () => {
  const { container } = loadGame("kq1");
  // get(0); status(); return; — lists item 0 by its OBJECT-file name.
  container.putResource(
    "logic",
    250,
    buildLogicResource(new Uint8Array([0x5c, 0x00, 0x7c, 0x00]), []),
  );
  const seen: { num: number; name: string }[][] = [];
  const host = new ProbeHost();
  host.statusScreen = (items) => {
    seen.push(items);
  };
  const engine = new Engine(container, host);
  engine.execute(250);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.length, 1);
  const name = seen[0]![0]!.name;
  assert.ok(
    name.length > 0 && name !== "item 0",
    `item 0 has a decoded OBJECT name, got '${name}'`,
  );
});
