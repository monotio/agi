import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic, AssemblerError } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";

/**
 * Compatibility characterizations for the traps internals edits break first:
 * #define aliases are numbers, CNF distribution duplicates said() byte-for-
 * byte, and a matched input can be consumed only once. Every byte array is
 * hand-computed from the agi-re "Logic Bytecode" encoding — 0xff opens and
 * closes a condition list, 0xfc wraps an OR group, 0xfd negates, deltas are
 * s16le relative to the byte after the delta — never captured from output.
 */

const DICT = new Map([
  ["look", 100],
  ["door", 200],
  ["open", 300],
]);

function code(source: string): number[] {
  return [...assembleLogic(source, { dictionary: DICT }).code];
}

test("#define aliases stay numeric constants; only a vN ref is a variable", () => {
  // `v9 = STEP` lowers to assignn(v9, 7): the alias is an immediate, not a
  // variable, so the `=` sugar picks assignn even though STEP happens to be 7.
  //   03 09 07 = assignn v9, 7     00 = return
  assert.deepEqual(code("#define STEP 7\nv9 = STEP;\nreturn;"), [0x03, 0x09, 0x07, 0x00]);
  // The same index spelled v7 picks assignv — same operand byte, other opcode.
  //   04 09 07 = assignv v9, v7    00 = return
  assert.deepEqual(code("v9 = v7;\nreturn;"), [0x04, 0x09, 0x07, 0x00]);
  // On the left of `=` the alias DOES name a variable — the destination —
  // so `STEP = v9` is assignv v7, v9, the opposite operand role of `v9 = STEP`.
  assert.deepEqual(code("#define STEP 7\nSTEP = v9;\nreturn;"), [0x04, 0x07, 0x09, 0x00]);
  // An explicit action takes the alias at face value: the constant lands in
  // the var operand slot, so `assignv(v1, STEP)` assembles to assignv v1, v7.
  assert.deepEqual(code("#define STEP 7\nassignv(v1, STEP);"), [0x04, 0x01, 0x07]);

  // A comparison's left operand must be a typed ref; a bare number cannot
  // drive one, so `STEP == v1` is rejected where STEP was written (2:5).
  assert.throws(
    () => assembleLogic("#define STEP 7\nif (STEP == v1) { return; }", { dictionary: DICT }),
    (e: unknown) =>
      e instanceof AssemblerError &&
      e.line === 2 &&
      e.col === 5 &&
      /unsupported comparison operands \(num == v\)/.test(e.message),
  );
  // On the right the constant is fine: v1 == STEP lowers to equaln(v1, 7).
  //   ff 01 01 07 ff | 01 00 | 00   — false-delta 1 skips the 1-byte return.
  assert.deepEqual(
    code("#define STEP 7\nif (v1 == STEP) { return; }"),
    [0xff, 0x01, 0x01, 0x07, 0xff, 0x01, 0x00, 0x00],
  );
  // The flag-comparison rewrite reads the alias as its number: f5 == ON with
  // ON bound to 1 folds to isset f5 (0x07 05), no comparison remains.
  assert.deepEqual(
    code("#define ON 1\nif (f5 == ON) { return; }"),
    [0xff, 0x07, 0x05, 0xff, 0x01, 0x00, 0x00],
  );

  // A define whose name collides with ref syntax is unreachable: `f9` parses
  // as flag 9 before defines are consulted, so `set(f9)` sets flag 9 — the
  // binding for 77 is silently dead. 0c 09 = set f9.
  assert.deepEqual(code("#define f9 77\nset(f9);"), [0x0c, 0x09]);
});

test("CNF distribution duplicates said; both source orders emit the same bytes", () => {
  // (said || (f1 && f2)) and ((f1 && f2) || said) both normalize to
  // (f1 || said) && (f2 || said): each distributed clause leads with the AND
  // member whatever the source order, and the said condition is emitted
  // twice — identical 6-byte sequences at PC 4 and PC 14, each
  // `0e 02` + word ids 300 (open) and 200 (door) as u16le.
  const expected = [
    0xff, //       PC 0:  open condition list
    0xfc, //       PC 1:  clause 1 OR group
    0x07,
    0x01, // PC 2:  isset f1
    0x0e,
    0x02, // PC 4:  said, 2 words
    0x2c,
    0x01, // PC 6:  word 300
    0xc8,
    0x00, // PC 8:  word 200
    0xfc, //       PC 10: clause 1 end
    0xfc, //       PC 11: clause 2 OR group
    0x07,
    0x02, // PC 12: isset f2
    0x0e,
    0x02, // PC 14: said, 2 words
    0x2c,
    0x01, // PC 16: word 300
    0xc8,
    0x00, // PC 18: word 200
    0xfc, //       PC 20: clause 2 end
    0xff, //       PC 21: close condition list
    0x01,
    0x00, // PC 22: false-delta 1 (end 25 - after-delta 24)
    0x00, //       PC 24: return
  ];
  const saidFirst = code('if (said("open", "door") || (isset(f1) && isset(f2))) { return; }');
  const flagsFirst = code('if ((isset(f1) && isset(f2)) || said("open", "door")) { return; }');
  assert.deepEqual(saidFirst, expected);
  assert.deepEqual(flagsFirst, expected);
  // The two emitted copies are byte-identical: the same condition, emitted
  // twice, not shared or back-referenced.
  assert.deepEqual(saidFirst.slice(4, 10), saidFirst.slice(14, 20));
});

class InputHost implements EngineHost {
  line: string | null = null;
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    const line = this.line;
    this.line = null;
    return line;
  }
  takeKeys(): number[] {
    return [];
  }
}

// (f100 || said) && (f101 || said) after distribution: said is evaluated per
// clause, and a match latches f4 — the consumed-input contract recorded in
// docs/fidelity.md, "Original parser unknown-word audit".
const DISTRIBUTED = `
  accept.input();
  if (said("open", "door") || (isset(f100) && isset(f101))) { assignn(v100, 1); }
  if (isset(f4)) { assignn(v101, 1); }
  return;
`;

/** Boot pass runs accept.input(); the queued line lands in the second pass. */
function play(setup: (engine: Engine, host: InputHost) => void): Engine {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(DISTRIBUTED, { dictionary: DICT }).payload);
  const host = new InputHost();
  const engine = new Engine(container, host, DICT);
  engine.tick();
  setup(engine, host);
  engine.tick();
  return engine;
}

test("a duplicated said consumes the line once: the second copy sees nothing", () => {
  // No flags held: clause 1's said matches and latches f4, so clause 2's copy
  // evaluates false — the distributed condition fails even though the input
  // matched once. v101 proves the line was consumed, not merely unmatched.
  let engine = play((_e, host) => {
    host.line = "open door";
  });
  assert.equal(engine.vars[100], 0, "the input satisfies only the first copy");
  assert.equal(engine.vars[101], 1, "f4 latched: the line was consumed");

  // f100 held: clause 1 short-circuits on the flag, its said is stepped over
  // without running (satisfied groups skip remaining members' handlers), so
  // clause 2's copy still sees the unconsumed line and matches.
  engine = play((e, host) => {
    e.flags[100] = 1;
    host.line = "open door";
  });
  assert.equal(engine.vars[100], 1);
  assert.equal(engine.vars[101], 1, "the skipped copy did not consume the line");

  // Both flags held: every said is skipped, so f4 never latches — the line
  // parses but is never consumed.
  engine = play((e, host) => {
    e.flags[100] = 1;
    e.flags[101] = 1;
    host.line = "open door";
  });
  assert.equal(engine.vars[100], 1);
  assert.equal(engine.vars[101], 0, "both copies skipped: parsed but never consumed");
});
