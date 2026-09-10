import { test } from "node:test";
import assert from "node:assert/strict";
import { disassembleLogic, disassembleLogicWarnings } from "../src/logic/disassembler.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildLogicResource, parseLogicResource } from "../src/logic/resource.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Disassembler tests. Every byte sequence below is hand-computed from the
 * agi-re "Logic Bytecode" chapter (and cross-checked against the assembler's
 * own hand-computed expectations in assembler.test.ts) — never snapshotted.
 *
 * The contract under test is round-trip byte identity: whatever source comes
 * out must re-assemble to the same bytecode. Anything that cannot round-trip
 * must be reported in the output as a `// !!` warning rather than silently
 * dropped; the fixture test below proves all 348 authentic KQ1/KQ2/KQ3 logics
 * round-trip to the identical payload, with zero warnings between them.
 */

const DICT = new Map([
  ["look", 100],
  ["door", 200],
  ["open", 300],
  ["unlock", 301],
]);

/** Wrap hand-written bytecode in a real logic resource and disassemble it. */
function dis(code: readonly number[], messages: readonly string[] = []): string {
  const payload = buildLogicResource(new Uint8Array(code), messages);
  return disassembleLogic(payload, { dictionary: DICT });
}

function warnings(code: readonly number[], messages: readonly string[] = []): readonly string[] {
  const payload = buildLogicResource(new Uint8Array(code), messages);
  return disassembleLogicWarnings(payload, { dictionary: DICT });
}

test("minimal program: message table becomes #message, action becomes a call", () => {
  // 65 01 = print(message 1), 00 = return.
  assert.equal(dis([0x65, 0x01, 0x00], ["Hello."]), '#message 1 "Hello."\n\nprint(m1);\nreturn;\n');
});

test("operand kinds render with the assembler's sigils", () => {
  // 67 = display(imm row, imm col, message); 0c = set(flag); 04 = assignv(var, var);
  // 29 = set.view(object, resource); 72 = set.string(string, message).
  assert.equal(
    dis(
      [0x67, 0x02, 0x03, 0x01, 0x0c, 0x05, 0x04, 0x0a, 0x0b, 0x29, 0x01, 0x2f, 0x72, 0x02, 0x01],
      ["x"],
    ),
    '#message 1 "x"\n\n' +
      "display(2, 3, m1);\n" +
      "set(f5);\n" +
      "assignv(v10, v11);\n" +
      "set.view(o1, 47);\n" +
      "set.string(s2, m1);\n",
  );
});

test("conditional block: then-block spans exactly the bytes the false-delta skips", () => {
  // ff 07 05 ff 02 00 | 65 01 : false delta 2 skips print, landing at 8 (end).
  assert.equal(
    dis([0xff, 0x07, 0x05, 0xff, 0x02, 0x00, 0x65, 0x01], ["x"]),
    '#message 1 "x"\n\nif (isset(f5)) {\n  print(m1);\n}\n',
  );
});

test("else reconstruction: trailing forward goto in the then-block becomes else", () => {
  // ff 07 05 ff 05 00 | 65 01 fe 02 00 | 65 02 : false delta 5 lands on the
  // else at 11; the goto at 8 jumps 2 forward to 13 = end of the else.
  assert.equal(
    dis([0xff, 0x07, 0x05, 0xff, 0x05, 0x00, 0x65, 0x01, 0xfe, 0x02, 0x00, 0x65, 0x02], ["a", "b"]),
    '#message 1 "a"\n#message 2 "b"\n\nif (isset(f5)) {\n  print(m1);\n} else {\n  print(m2);\n}\n',
  );
});

test("OR group with a negated member; a lone clause drops its parentheses", () => {
  // ff fc fd 07 05 01 01 03 fc ff 01 00 | 00
  assert.equal(
    dis([0xff, 0xfc, 0xfd, 0x07, 0x05, 0x01, 0x01, 0x03, 0xfc, 0xff, 0x01, 0x00, 0x00]),
    "if (!isset(f5) || equaln(v1, 3)) {\n  return;\n}\n",
  );
});

test("condition list of several clauses: OR groups are parenthesized, ANDs are not", () => {
  // ff fc 07 01 07 02 fc 07 03 ff 01 00 | 00
  assert.equal(
    dis([0xff, 0xfc, 0x07, 0x01, 0x07, 0x02, 0xfc, 0x07, 0x03, 0xff, 0x01, 0x00, 0x00]),
    "if ((isset(f1) || isset(f2)) && isset(f3)) {\n  return;\n}\n",
  );
});

test("said(): word ids render through the dictionary, with * and ... wildcards", () => {
  // ff 0e 02 64 00 c8 00 ff 01 00 | 00   (look=100, door=200)
  assert.equal(
    dis([0xff, 0x0e, 0x02, 0x64, 0x00, 0xc8, 0x00, 0xff, 0x01, 0x00, 0x00]),
    'if (said("look", "door")) {\n  return;\n}\n',
  );
  // open=300=0x012c, *=0x0001, ...=0x270f
  assert.equal(
    dis([0xff, 0x0e, 0x03, 0x2c, 0x01, 0x01, 0x00, 0x0f, 0x27, 0xff, 0x01, 0x00, 0x00]),
    'if (said("open", "*", "...")) {\n  return;\n}\n',
  );
});

test("jumps the block structure cannot express become goto plus a top-level label", () => {
  // 65 01 | fe 02 00 | 65 01 | 00 : the goto at 2 skips to offset 7.
  assert.equal(
    dis([0x65, 0x01, 0xfe, 0x02, 0x00, 0x65, 0x01, 0x00], ["x"]),
    '#message 1 "x"\n\nprint(m1);\ngoto L7;\nprint(m1);\nL7:\nreturn;\n',
  );
  // Backward jump to offset 0: delta -3 = fd ff.
  assert.equal(dis([0xfe, 0xfd, 0xff]), "L0:\ngoto L0;\n");
});

test("a label needed at the very end of the code is emitted after the last statement", () => {
  // fe 00 00 : delta 0 targets offset 3, one past the last byte.
  assert.equal(dis([0xfe, 0x00, 0x00]), "goto L3;\nL3:\n");
});

test("empty then-block (false delta of zero) is preserved as an empty block", () => {
  assert.equal(dis([0xff, 0x07, 0x05, 0xff, 0x00, 0x00]), "if (isset(f5)) {\n}\n");
});

test("unknown opcode byte is emitted as a comment and warned, never dropped", () => {
  // 0xb2 is not an action in the 2.936 profile.
  assert.equal(
    dis([0xb2, 0x00]),
    "// !! raw byte 0xb2 at 0: not an opcode in this profile\n" +
      "return;\n" +
      "\n" +
      "// !! offset 0: unknown opcode byte 0xb2 (emitted as a comment; cannot re-assemble)\n",
  );
});

test("a one-term OR group keeps its parentheses, which is what emits the markers", () => {
  // ff fc 07 01 fc ff 01 00 | 00 — an OR group holding a single predicate.
  // The parentheses survive even though it is the only clause: they are the
  // 0xfc markers. Without them the assembler would emit ff 07 01 ff instead.
  const code = [0xff, 0xfc, 0x07, 0x01, 0xfc, 0xff, 0x01, 0x00, 0x00];
  assert.equal(dis(code), "if ((isset(f1))) {\n  return;\n}\n");
  assert.deepEqual(warnings(code), []);
});

test("a one-term OR group beside a plain clause", () => {
  // ff fc 07 01 fc 07 02 ff 01 00 | 00
  assert.equal(
    dis([0xff, 0xfc, 0x07, 0x01, 0xfc, 0x07, 0x02, 0xff, 0x01, 0x00, 0x00]),
    "if ((isset(f1)) && isset(f2)) {\n  return;\n}\n",
  );
});

test("a jump into a block gets a label at that depth, not a hoisted one", () => {
  // ff 07 05 ff <4:2> | 65 01 (6) | 65 01 (8) | fe <-5:2> (10) targets 8.
  assert.equal(
    dis([0xff, 0x07, 0x05, 0xff, 0x04, 0x00, 0x65, 0x01, 0x65, 0x01, 0xfe, 0xfb, 0xff], ["x"]),
    '#message 1 "x"\n\n' + "if (isset(f5)) {\n  print(m1);\n  L8:\n  print(m1);\n}\ngoto L8;\n",
  );
});

test("a jump into an else-block keeps the else and labels inside it", () => {
  // ff 07 05 ff <5:2> | 65 01 (6) | fe <2:2> (8) | 65 02 (11) | fe <-5:2> (13)
  assert.equal(
    dis(
      [
        0xff, 0x07, 0x05, 0xff, 0x05, 0x00, 0x65, 0x01, 0xfe, 0x02, 0x00, 0x65, 0x02, 0xfe, 0xfb,
        0xff,
      ],
      ["a", "b"],
    ),
    '#message 1 "a"\n#message 2 "b"\n\n' +
      "if (isset(f5)) {\n  print(m1);\n} else {\n  L11:\n  print(m2);\n}\ngoto L11;\n",
  );
});

test("an absent message slot is emitted as a bare #message N", () => {
  const payload = buildLogicResource(new Uint8Array([0x00]), [null, "Hi", null]);
  assert.equal(
    disassembleLogic(payload, { dictionary: DICT }),
    '#message 1\n#message 2 "Hi"\n#message 3\n\nreturn;\n',
  );
});

test("non-printable and high message bytes are escaped, not dropped", () => {
  assert.equal(
    dis([0x00], ["a\nb\\c\u0080\u0007"]),
    '#message 1 "a\\nb\\\\c\\x80\\x07"\n\nreturn;\n',
  );
});

test("said() word id above 255 without a dictionary is reported, not silently truncated", () => {
  const payload = buildLogicResource(
    new Uint8Array([0xff, 0x0e, 0x01, 0x2c, 0x01, 0xff, 0x01, 0x00, 0x00]),
    [],
  );
  const w = disassembleLogicWarnings(payload);
  assert.equal(w.length, 1);
  assert.match(w[0]!, /word id 300 is not in the supplied dictionary/);
  assert.match(disassembleLogic(payload), /said\(300 \/\* !! word id out of byte range \*\//);
});

test("message text is escaped so the assembler's lexer reads it back", () => {
  assert.equal(dis([0x00], ['He said "hi".']), '#message 1 "He said \\"hi\\"."\n\nreturn;\n');
});

// ---------- Round-trip: the actual contract ----------

/** assemble(source) -> disassemble -> assemble again must give the same bytes. */
function roundTrip(source: string): void {
  const first = assembleLogic(source, { dictionary: DICT });
  const src = disassembleLogic(first.payload, { dictionary: DICT });
  assert.deepEqual(disassembleLogicWarnings(first.payload, { dictionary: DICT }), [], src);
  const second = assembleLogic(src, { dictionary: DICT });
  assert.deepEqual([...second.code], [...first.code], `code differs for:\n${src}`);
  assert.deepEqual([...second.payload], [...first.payload], `payload differs for:\n${src}`);
}

test("round-trip: every source shape the assembler tests cover", () => {
  const corpus = [
    '#message 1 "Hello."\nprint(1);\nreturn;',
    '#message 1 "x"\ndisplay(2, 3, m1);',
    '#message 1 "x"\nif (isset(f5)) { print(1); }',
    '#message 1 "a"\n#message 2 "b"\nif (isset(f5)) { print(1); } else { print(2); }',
    "start:\ngoto start;",
    '#message 1 "x"\nprint(1);\ngoto end;\nprint(1);\nend:\nreturn;',
    'if (said("look", "door")) { return; }',
    'if (said("open", "*", "...")) { return; }',
    "if (!isset(f5) || equaln(v1, 3)) { return; }",
    "if ((isset(f1) || isset(f2)) && isset(f3)) { return; }",
    "if (!(isset(f1) && isset(f2))) { return; }",
    "if (!(isset(f1) || isset(f2))) { return; }",
    "#define fDoor 42\nset(fDoor);",
    'print("Hi there.");\nprint("Hi there.");\nprint("Other.");',
    '#message 5 "five"\nprint(m5);\nprint("inline");',
    // Nesting, an else holding an if, and every operand sigil in one program.
    '#message 1 "a"\n#message 2 "b"\n' +
      "if (isset(f1)) {\n" +
      "  if (equaln(v2, 7)) { print(1); } else { print(2); }\n" +
      "  set.view(o1, 47);\n" +
      "} else {\n" +
      "  set.string(s2, m1);\n" +
      "  assignv(v10, v11);\n" +
      "}\n" +
      "return;",
    // A goto out of a nested block to a top-level label.
    "if (isset(f1)) {\n  if (isset(f2)) { goto done; }\n  set(f3);\n}\nreset(f4);\ndone:\nreturn;",
  ];
  for (const source of corpus) roundTrip(source);
});

// ---------- Authentic fixtures (local-only, skipped when absent) ----------

interface Expectation {
  readonly hash: string;
  readonly alias: string;
  /** Logic resources present in LOGDIR. */
  readonly logics: number;
  /** Logics whose disassembly carries no round-trip warning at all. */
  readonly clean: number;
  /** Logics whose source re-assembles to byte-identical bytecode. */
  readonly codeIdentical: number;
}

/**
 * Expected logic counts for the optional fixture editions. Each logic must
 * disassemble without warnings and reassemble to the identical payload:
 * bytecode, message table shape and encrypted text.
 */
const EXPECTED: readonly Expectation[] = [
  { hash: KNOWN_GAME_HASH.KQ1, alias: "kq1", logics: 90, clean: 90, codeIdentical: 90 },
  { hash: KNOWN_GAME_HASH.KQ2, alias: "kq2", logics: 133, clean: 133, codeIdentical: 133 },
  { hash: KNOWN_GAME_HASH.KQ3, alias: "kq3", logics: 125, clean: 125, codeIdentical: 125 },
];

for (const expected of EXPECTED) {
  test(
    `fixture ${expected.alias}: every logic round-trips or says why not`,
    { skip: fixtureSkip(expected.hash) },
    () => {
      const { container, dict } = loadGame(expected.hash);
      let logics = 0;
      let clean = 0;
      let codeIdentical = 0;
      let payloadChecked = 0;
      for (let num = 0; num < 256; num++) {
        const payload = container.getResource("logic", num);
        if (payload === null) continue;
        logics++;
        const original = parseLogicResource(payload);
        const source = disassembleLogic(payload, { dictionary: dict });
        const warns = disassembleLogicWarnings(payload, { dictionary: dict });
        // Nothing is dropped in silence: every warning is visible in the source.
        for (const w of warns)
          assert.ok(source.includes(w), `${expected.alias} logic ${num}: warning not in source`);
        if (warns.length === 0) clean++;

        let assembled: ReturnType<typeof assembleLogic> | null = null;
        try {
          assembled = assembleLogic(source, { dictionary: dict });
        } catch (e) {
          assert.ok(
            warns.length > 0,
            `${expected.alias} logic ${num}: source failed to assemble with no warning: ${(e as Error).message}`,
          );
        }
        if (assembled === null) continue;
        const same =
          assembled.code.length === original.code.length &&
          assembled.code.every((b, i) => b === original.code[i]);
        if (same) codeIdentical++;
        // A warning-free logic MUST be byte-identical.
        assert.ok(
          same || warns.length > 0,
          `${expected.alias} logic ${num}: bytecode differs with no warning`,
        );

        // The resource framing is identity on its own: parse -> build gives
        // back the very bytes, absent (zero-offset) message slots included.
        assert.deepEqual(
          [...buildLogicResource(original.code, original.messages)],
          [...payload],
          `${expected.alias} logic ${num}: parse->build is not identity`,
        );
        // ...and so is the whole assemble(disassemble(x)) pipeline.
        payloadChecked++;
        assert.deepEqual(
          [...assembled.payload],
          [...payload],
          `${expected.alias} logic ${num}: payload differs`,
        );
      }
      assert.equal(logics, expected.logics, "logic count");
      assert.equal(clean, expected.clean, "warning-free logics");
      assert.equal(
        codeIdentical,
        expected.codeIdentical,
        "logics whose bytecode re-assembles identically",
      );
      assert.equal(payloadChecked, expected.logics, "whole-payload identity checks run");
    },
  );
}
