import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleLogic, AssemblerError } from "../src/logic/assembler.ts";
import { buildLogicResource, parseLogicResource, MESSAGE_KEY } from "../src/logic/resource.ts";

const DICT = new Map([
  ["look", 100],
  ["door", 200],
  ["open", 300],
  ["unlock", 301],
]);

function code(source: string): number[] {
  return [...assembleLogic(source, { dictionary: DICT }).code];
}

test("minimal program: print + return, hand-computed bytes", () => {
  assert.deepEqual(code('#message 1 "Hello."\nprint(1);\nreturn;'), [0x65, 0x01, 0x00]);
});

test("action with multiple operands", () => {
  // display = 0x67, operands row, col, message
  assert.deepEqual(code('#message 1 "x"\ndisplay(2, 3, m1);'), [0x67, 0x02, 0x03, 0x01]);
});

test("if without else: false-delta skips then-branch", () => {
  // ff 07 05 ff <d:2> 65 01  — delta = end(8) - (4+2) = 2
  assert.deepEqual(
    code('#message 1 "x"\nif (isset(f5)) { print(1); }'),
    [0xff, 0x07, 0x05, 0xff, 0x02, 0x00, 0x65, 0x01],
  );
});

test("if/else: false-delta lands on else, goto skips else", () => {
  // ff 07 05 ff <5:2> 65 01 fe <2:2> 65 02
  // false delta = 11 - 6 = 5; goto delta = 13 - 11 = 2
  assert.deepEqual(
    code('#message 1 "a"\n#message 2 "b"\nif (isset(f5)) { print(1); } else { print(2); }'),
    [0xff, 0x07, 0x05, 0xff, 0x05, 0x00, 0x65, 0x01, 0xfe, 0x02, 0x00, 0x65, 0x02],
  );
});

test("goto backward to label: negative s16 delta", () => {
  // fe <d:2> where d = 0 - 3 = -3 -> fd ff
  assert.deepEqual(code("start:\ngoto start;"), [0xfe, 0xfd, 0xff]);
});

test("goto forward over statements", () => {
  // 65 01 at 0..1, fe at 2, delta at 3: label end at 7 (return), delta = 7 - (3+2) = 2
  const bytes = code('#message 1 "x"\nprint(1);\ngoto end;\nprint(1);\nend:\nreturn;');
  assert.deepEqual(bytes, [0x65, 0x01, 0xfe, 0x02, 0x00, 0x65, 0x01, 0x00]);
});

test("said(): variable-length condition with dictionary ids", () => {
  // ff 0e 02 64 00 c8 00 ff <d:2> 00 ; delta = 11 - 10 = 1
  assert.deepEqual(
    code('if (said("look", "door")) { return; }'),
    [0xff, 0x0e, 0x02, 0x64, 0x00, 0xc8, 0x00, 0xff, 0x01, 0x00, 0x00],
  );
});

test("said wildcards: * and ...", () => {
  const bytes = code('if (said("open", "*", "...")) { return; }');
  assert.deepEqual(
    bytes.slice(0, 10),
    [0xff, 0x0e, 0x03, 0x2c, 0x01, 0x01, 0x00, 0x0f, 0x27, 0xff],
  );
  // open=300=0x012c le, *=0x0001 le, ...=0x270f le
});

test("OR group with negated member", () => {
  // fc fd 07 05 01 01 03 fc inside ff ... ff
  assert.deepEqual(
    code("if (!isset(f5) || equaln(v1, 3)) { return; }"),
    [0xff, 0xfc, 0xfd, 0x07, 0x05, 0x01, 0x01, 0x03, 0xfc, 0xff, 0x01, 0x00, 0x00],
  );
});

test("CNF: (A || B) && C emits OR-group then plain condition", () => {
  const bytes = code("if ((isset(f1) || isset(f2)) && isset(f3)) { return; }");
  assert.deepEqual(bytes.slice(0, 9), [0xff, 0xfc, 0x07, 0x01, 0x07, 0x02, 0xfc, 0x07, 0x03]);
});

test("De Morgan: !(A && B) becomes OR of negations", () => {
  const bytes = code("if (!(isset(f1) && isset(f2))) { return; }");
  assert.deepEqual(bytes.slice(0, 9), [0xff, 0xfc, 0xfd, 0x07, 0x01, 0xfd, 0x07, 0x02, 0xfc]);
});

test("De Morgan: !(A || B) becomes AND of negations", () => {
  const bytes = code("if (!(isset(f1) || isset(f2))) { return; }");
  assert.deepEqual(bytes.slice(0, 7), [0xff, 0xfd, 0x07, 0x01, 0xfd, 0x07, 0x02]);
});

test("#define names usable as operands", () => {
  assert.deepEqual(code("#define fDoor 42\nset(fDoor);"), [0x0c, 0x2a]);
});

test("inline strings auto-allocate messages and dedupe", () => {
  const r = assembleLogic('print("Hi there.");\nprint("Hi there.");\nprint("Other.");', {
    dictionary: DICT,
  });
  assert.deepEqual([...r.code], [0x65, 0x01, 0x65, 0x01, 0x65, 0x02]);
  assert.deepEqual(r.messages, ["", "Hi there.", "Other."]);
});

test("explicit and inline messages coexist; inline starts after max explicit", () => {
  const r = assembleLogic('#message 5 "five"\nprint(m5);\nprint("inline");', { dictionary: DICT });
  assert.deepEqual([...r.code], [0x65, 0x05, 0x65, 0x06]);
  assert.equal(r.messages[5], "five");
  assert.equal(r.messages[6], "inline");
});

test("payload framing: hand-computed full resource bytes", () => {
  const r = assembleLogic('#message 1 "Hi"\nreturn;', { dictionary: DICT });
  // code: 00 (1 byte). count: 1. table: 2 entries = 4 bytes.
  // entry0 (end) = 4 + 3 = 7 ("Hi\0"). entry1 = 4.
  const enc = (s: string, offset: number): number[] =>
    [...s].map(
      (c, i) => c.charCodeAt(0) ^ MESSAGE_KEY.charCodeAt((offset + i) % MESSAGE_KEY.length),
    );
  const expected = [
    0x01,
    0x00, // code_length = 1
    0x00, // return
    0x01, // message_count
    0x07,
    0x00,
    0x04,
    0x00, // table: end=7, msg1=4
    ...enc("Hi", 0),
    0x00 ^ MESSAGE_KEY.charCodeAt(2), // terminator at text offset 2
  ];
  assert.deepEqual([...r.payload], expected);
});

test("resource roundtrip: parse(build) returns code and messages", () => {
  const r = assembleLogic('#message 1 "First"\n#message 2 "Second"\nprint(2);\nreturn;', {
    dictionary: DICT,
  });
  const parsed = parseLogicResource(r.payload);
  assert.deepEqual([...parsed.code], [0x65, 0x02, 0x00]);
  assert.deepEqual(parsed.messages, ["First", "Second"]);
});

test("error: said() word not in dictionary names the word", () => {
  assert.throws(
    () => assembleLogic('if (said("xyzzy")) { return; }', { dictionary: DICT }),
    (e: unknown) =>
      e instanceof AssemblerError && /'xyzzy' is not in the dictionary/.test((e as Error).message),
  );
});

test("error: unknown action with position", () => {
  assert.throws(
    () => assembleLogic("frobnicate(1);", { dictionary: DICT }),
    (e: unknown) =>
      e instanceof AssemblerError && /1:1: unknown action 'frobnicate'/.test((e as Error).message),
  );
});

test("error: wrong arity", () => {
  assert.throws(
    () => assembleLogic("print(1, 2);", { dictionary: DICT }),
    (e: unknown) =>
      e instanceof AssemblerError && /takes 1 operand\(s\), got 2/.test((e as Error).message),
  );
});

test("error: goto of undefined label", () => {
  assert.throws(
    () => assembleLogic("goto nowhere;", { dictionary: DICT }),
    (e: unknown) =>
      e instanceof AssemblerError && /undefined label 'nowhere'/.test((e as Error).message),
  );
});

test("error: duplicate #message", () => {
  assert.throws(
    () => assembleLogic('#message 1 "a"\n#message 1 "b"', { dictionary: DICT }),
    (e: unknown) =>
      e instanceof AssemblerError && /duplicate #message 1/.test((e as Error).message),
  );
});

test("error: message 0 rejected", () => {
  assert.throws(
    () => assembleLogic('#message 1 "a"\nprint(m0);', { dictionary: DICT }),
    (e: unknown) => e instanceof AssemblerError && /1-based/.test((e as Error).message),
  );
});

test("error: unknown identifier suggests ref syntax", () => {
  assert.throws(
    () => assembleLogic("set(door);", { dictionary: DICT }),
    (e: unknown) =>
      e instanceof AssemblerError && /unknown identifier 'door'/.test((e as Error).message),
  );
});

// ---------- Labels inside blocks ----------

test("label inside a block: goto targets the byte offset it marks", () => {
  // ff 07 05 ff <4:2> | 65 01 (6) | inner: (8) 65 01 | fe <-5:2> (10)
  // then-block spans 6..10 so the false delta is 10 - 6 = 4;
  // the goto at 10 ends at 13 and targets 8, so its delta is 8 - 13 = -5 = fb ff.
  assert.deepEqual(
    code('#message 1 "x"\nif (isset(f5)) { print(1); inner: print(1); }\ngoto inner;'),
    [0xff, 0x07, 0x05, 0xff, 0x04, 0x00, 0x65, 0x01, 0x65, 0x01, 0xfe, 0xfb, 0xff],
  );
});

test("label inside an else-block, jumped to from outside", () => {
  // ff 07 05 ff <5:2> | 65 01 (6) | fe <2:2> (8) | here: (11) 65 02 | fe <-5:2> (13)
  // false delta = 11 - 6 = 5; the else-skipping goto at 8 targets 13, delta 2;
  // the trailing goto at 13 ends at 16 and targets 11, delta -5 = fb ff.
  assert.deepEqual(
    code(
      '#message 1 "a"\n#message 2 "b"\n' +
        "if (isset(f5)) { print(1); } else { here: print(2); }\ngoto here;",
    ),
    [
      0xff, 0x07, 0x05, 0xff, 0x05, 0x00, 0x65, 0x01, 0xfe, 0x02, 0x00, 0x65, 0x02, 0xfe, 0xfb,
      0xff,
    ],
  );
});

test("error: duplicate label across nesting levels", () => {
  assert.throws(
    () => assembleLogic("dup:\nif (isset(f1)) { dup: return; }", { dictionary: DICT }),
    (e: unknown) =>
      e instanceof AssemblerError && /duplicate label 'dup'/.test((e as Error).message),
  );
});

// ---------- Explicitly parenthesized one-term OR group ----------

test("a parenthesized single literal emits 0xfc markers; bare does not", () => {
  // ff fc 07 01 fc ff <1:2> 00 : the group markers wrap the one predicate.
  assert.deepEqual(
    code("if ((isset(f1))) { return; }"),
    [0xff, 0xfc, 0x07, 0x01, 0xfc, 0xff, 0x01, 0x00, 0x00],
  );
  // Without the parentheses the same test is a plain clause: no 0xfc at all.
  assert.deepEqual(code("if (isset(f1)) { return; }"), [0xff, 0x07, 0x01, 0xff, 0x01, 0x00, 0x00]);
});

test("a parenthesized single negated literal keeps the group markers", () => {
  // ff fc fd 07 01 fc ff <1:2> 00
  assert.deepEqual(
    code("if ((!isset(f1))) { return; }"),
    [0xff, 0xfc, 0xfd, 0x07, 0x01, 0xfc, 0xff, 0x01, 0x00, 0x00],
  );
});

test("one-term group beside a plain clause", () => {
  // ff fc 07 01 fc 07 02 ff <1:2> 00
  assert.deepEqual(
    code("if ((isset(f1)) && isset(f2)) { return; }"),
    [0xff, 0xfc, 0x07, 0x01, 0xfc, 0x07, 0x02, 0xff, 0x01, 0x00, 0x00],
  );
});

test("parentheses around a multi-term expression still group as before", () => {
  assert.deepEqual(
    code("if ((isset(f1) || isset(f2))) { return; }"),
    [0xff, 0xfc, 0x07, 0x01, 0x07, 0x02, 0xfc, 0xff, 0x01, 0x00, 0x00],
  );
});

// ---------- Message escapes and byte-exact message text ----------

function messagesOf(source: string): readonly (string | null)[] {
  return parseLogicResource(assembleLogic(source, { dictionary: DICT }).payload).messages;
}

test("lexer decodes C-style escapes in message text", () => {
  assert.deepEqual(messagesOf('#message 1 "a\\nb\\rc\\\\d\\"e"\nreturn;'), ['a\nb\rc\\d"e']);
});

test("lexer decodes \\xNN to a single byte, and the byte survives the resource", () => {
  // \x80 is 128, \x0c is a form feed, \x41 is 'A'.
  assert.deepEqual(messagesOf('#message 1 "\\x80\\x0c\\x41"\nreturn;'), ["\u0080\u000cA"]);
  const payload = assembleLogic('#message 1 "\\x80"\nreturn;', { dictionary: DICT }).payload;
  // code_length=1, code=00, count=1, table 4 bytes: end=4+2=6, msg1=4.
  assert.deepEqual(
    [...payload],
    [
      0x01,
      0x00,
      0x00,
      0x01,
      0x06,
      0x00,
      0x04,
      0x00,
      0x80 ^ MESSAGE_KEY.charCodeAt(0),
      0x00 ^ MESSAGE_KEY.charCodeAt(1),
    ],
  );
});

test("every byte 0..255 round-trips through a message losslessly", () => {
  const text = Array.from({ length: 256 }, (_, i) => `\\x${i.toString(16).padStart(2, "0")}`)
    .slice(1) // a NUL byte would terminate the message text
    .join("");
  const got = messagesOf(`#message 1 "${text}"\nreturn;`)[0];
  assert.equal(got?.length, 255);
  for (let i = 1; i < 256; i++) assert.equal(got!.charCodeAt(i - 1), i, `byte ${i}`);
});

test("error: a raw newline inside a string is still rejected", () => {
  assert.throws(
    () => assembleLogic('#message 1 "a\nb"', { dictionary: DICT }),
    (e: unknown) => e instanceof AssemblerError && /unterminated string/.test((e as Error).message),
  );
});

test("error: unknown escape names the offending character", () => {
  assert.throws(
    () => assembleLogic('#message 1 "a\\q"', { dictionary: DICT }),
    (e: unknown) =>
      e instanceof AssemblerError && /unknown escape '\\q'/.test((e as Error).message),
  );
});

// ---------- Absent message slots ----------

test("#message N with no text declares an absent slot (zero offset)", () => {
  const payload = assembleLogic('#message 1\n#message 2 "Hi"\nreturn;', {
    dictionary: DICT,
  }).payload;
  // code_length=1, code=00, count=2, table = 3 entries = 6 bytes.
  // message 1 is absent -> offset 0; message 2 at 6; text "Hi\0" = 3 bytes; end = 9.
  const enc = (s: string, offset: number): number[] =>
    [...s].map(
      (c, i) => c.charCodeAt(0) ^ MESSAGE_KEY.charCodeAt((offset + i) % MESSAGE_KEY.length),
    );
  assert.deepEqual(
    [...payload],
    [
      0x01,
      0x00,
      0x00,
      0x02,
      0x09,
      0x00,
      0x00,
      0x00,
      0x06,
      0x00,
      ...enc("Hi", 0),
      0x00 ^ MESSAGE_KEY.charCodeAt(2),
    ],
  );
  assert.deepEqual(parseLogicResource(payload).messages, [null, "Hi"]);
});

test("an absent slot is distinct from an empty message", () => {
  const empty = assembleLogic('#message 1 ""\nreturn;', { dictionary: DICT }).payload;
  assert.deepEqual(parseLogicResource(empty).messages, [""]);
  // "" still occupies a terminator byte; absent occupies none.
  const absent = assembleLogic("#message 1\nreturn;", { dictionary: DICT }).payload;
  assert.deepEqual(parseLogicResource(absent).messages, [null]);
  assert.equal(empty.length - absent.length, 1);
});

test("buildLogicResource(parseLogicResource(x)) is identity with absent slots", () => {
  const original = new Uint8Array([
    0x01,
    0x00,
    0x00,
    0x03,
    0x0b,
    0x00, // end = 8 + 3
    0x00,
    0x00, // message 1 absent
    0x08,
    0x00, // message 2 at 8 (table is 8 bytes)
    0x00,
    0x00, // message 3 absent
    "H".charCodeAt(0) ^ MESSAGE_KEY.charCodeAt(0),
    "i".charCodeAt(0) ^ MESSAGE_KEY.charCodeAt(1),
    0x00 ^ MESSAGE_KEY.charCodeAt(2),
  ]);
  const parsed = parseLogicResource(original);
  assert.deepEqual(parsed.messages, [null, "Hi", null]);
  assert.deepEqual([...buildLogicResource(parsed.code, parsed.messages)], [...original]);
});
