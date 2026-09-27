import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleAuthoredLogic } from "../src/agent/agentState.ts";
import { disassembleLogic } from "../src/logic/disassembler.ts";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import {
  emitRule,
  parseRule,
  ruleModelProblem,
  type RuleModel,
} from "../src/studio/rules/ruleModel.ts";

const BINDINGS = {
  gate_open: { kind: "flag", num: 40 },
  lamp_lit: { kind: "flag", num: 41 },
  statue_seen: { kind: "flag", num: 42 },
} as const;

/** Each shape with the exact fragment the kernel must emit for it. */
const CASES: readonly { name: string; model: RuleModel; text: string }[] = [
  {
    name: "open edge exit",
    model: {
      kind: "exit",
      edge: "right",
      destination: 3,
      requiresFlag: null,
      blockedMessage: null,
    },
    text: ["if (equaln(v2, 2)) {", "  new.room(3);", "}"].join("\n"),
  },
  {
    name: "guarded edge exit",
    model: {
      kind: "exit",
      edge: "left",
      destination: 5,
      requiresFlag: "gate_open",
      blockedMessage: 'The gate is "shut".',
    },
    text: [
      "if (equaln(v2, 4)) {",
      "  if (isset(gate_open)) {",
      "    new.room(5);",
      "  } else {",
      "    assignn(v6, 0);",
      '    print("The gate is \\"shut\\".");',
      "  }",
      "}",
    ].join("\n"),
  },
  {
    name: "silent guarded edge exit",
    model: {
      kind: "exit",
      edge: "top",
      destination: 7,
      requiresFlag: 9,
      blockedMessage: null,
    },
    text: [
      "if (equaln(v2, 1)) {",
      "  if (isset(f9)) {",
      "    new.room(7);",
      "  } else {",
      "    assignn(v6, 0);",
      "  }",
      "}",
    ].join("\n"),
  },
  {
    name: "open door",
    model: {
      kind: "exit",
      edge: null,
      box: { x1: 120, y1: 125, x2: 135, y2: 130 },
      destination: 4,
      requiresFlag: null,
    },
    text: ["if (posn(o0, 120, 125, 135, 130)) {", "  new.room(4);", "}"].join("\n"),
  },
  {
    name: "locked door",
    model: {
      kind: "exit",
      edge: null,
      box: { x1: 0, y1: 150, x2: 10, y2: 167 },
      destination: 6,
      requiresFlag: "gate_open",
    },
    text: ["if (posn(o0, 0, 150, 10, 167) && isset(gate_open)) {", "  new.room(6);", "}"].join(
      "\n",
    ),
  },
  {
    name: "region with message and conditions",
    model: {
      kind: "region",
      box: { x1: 10, y1: 120, x2: 40, y2: 140 },
      flag: "statue_seen",
      when: [
        { flag: "lamp_lit", value: true },
        { flag: "gate_open", value: false },
      ],
      message: "The statue watches you.\nIt blinks.",
    },
    text: [
      "if (!isset(statue_seen) && posn(o0, 10, 120, 40, 140) && isset(lamp_lit) && !isset(gate_open)) {",
      "  set(statue_seen);",
      '  print("The statue watches you.\\nIt blinks.");',
      "}",
    ].join("\n"),
  },
  {
    name: "silent region",
    model: {
      kind: "region",
      box: { x1: 0, y1: 150, x2: 159, y2: 167 },
      flag: "lamp_lit",
      when: [],
      message: null,
    },
    text: ["if (!isset(lamp_lit) && posn(o0, 0, 150, 159, 167)) {", "  set(lamp_lit);", "}"].join(
      "\n",
    ),
  },
];

describe("rule model", () => {
  it("emits the canonical fragment for each shape", () => {
    for (const { name, model, text } of CASES) assert.equal(emitRule(model), text, name);
  });

  it("reads each emitted fragment back to the same model", () => {
    for (const { name, model, text } of CASES)
      assert.deepEqual(parseRule(text, { bindings: BINDINGS }), model, name);
  });

  it("survives emit, assemble, disassemble and parse for each shape", () => {
    const session = {
      profile: DEFAULT_V2_PROFILE,
      authoring: { bindings: { ...BINDINGS } },
      sources: { words: new Map<string, number>() },
    };
    for (const { name, model } of CASES) {
      const assembled = assembleAuthoredLogic(session, `${emitRule(model)}\nreturn;`);
      const disassembled = disassembleLogic(assembled.payload);
      // The disassembly is a whole logic: drop its message table and final return.
      const code = disassembled
        .split("\n")
        .filter((line) => !line.startsWith("#message") && line !== "return;")
        .join("\n");
      assert.doesNotMatch(code, /"The|gate_open/, `${name}: text and names became numbers`);
      assert.deepEqual(
        parseRule(code, { bindings: BINDINGS, messages: assembled.messages }),
        model,
        name,
      );
    }
  });

  it("ignores layout: one-line and multi-line forms read the same", () => {
    assert.deepEqual(parseRule("if (equaln(v2,2)) { new.room(3); }"), CASES[0]!.model);
    assert.deepEqual(
      parseRule("// east\nif (equaln(v2, 2))\n{\nnew.room(3); // go\n}"),
      CASES[0]!.model,
    );
  });

  it("reads the tutorial's stand region and names its flag", () => {
    const messages: (string | null)[] = [];
    messages[37] = "Wait: you're BEHIND the ledger stand";
    assert.deepEqual(
      parseRule("if (!isset(f38) && posn(o0, 33, 112, 49, 120)) { set(f38); print(37); }", {
        bindings: { stand_tag_seen: { kind: "flag", num: 38 } },
        messages,
      }),
      {
        kind: "region",
        box: { x1: 33, y1: 112, x2: 49, y2: 120 },
        flag: "stand_tag_seen",
        when: [],
        message: "Wait: you're BEHIND the ledger stand",
      },
    );
  });

  it("leaves every other shape native", () => {
    const native = [
      'if (said("west")) { new.room(1); }', // commands are native in this kernel
      "if ((equaln(v2, 2))) { new.room(3); }", // single-test OR group: different bytes
      "if (equaln(v2, 2)) { new.room(3); } reset(f1);", // extra statement
      "if (equaln(v2, 2)) { new.room.v(v3); }", // computed room
      "if (equaln(v2, 5)) { new.room(3); }", // not an edge code
      "if (equaln(v2, 2)) { new.room(3); } else { print(1); }", // else on an exit
      "if (equaln(v2, 2)) { if (isset(f1)) { new.room(3); } else { print(1); } }", // no stop
      "if (posn(o0, 1, 2, 3, 4) && !isset(f1)) { new.room(3); }", // door opens on a clear flag
      "if (posn(o0, 1, 2, 3, 4)) { new.room(3); print(1); }", // door does more
      "if (posn(o1, 1, 2, 3, 4)) { new.room(3); }", // not ego
      "if (posn(o0, 9, 2, 3, 4)) { new.room(3); }", // inverted box
      "if (isset(f5) && posn(o0, 1, 2, 3, 4)) { set(f5); }", // guard is not a latch
      "if (!isset(f9) && posn(o0, 1, 2, 3, 4)) { set(f8); }", // latch mismatch
      "if (!isset(f9) && posn(o0, 1, 2, 3, 4)) { set(f9); get(1); }", // region does more
      "if (!isset(f9) && posn(o0, 1, 2, 3, 4)) { set(f9); print(m3); }", // message 3 unknown
      "label: set(f1);", // labels are native
      '#message 3 "x"', // directives are native
      "",
    ];
    for (const text of native)
      assert.equal(parseRule(text, { bindings: BINDINGS }), "native", text);
  });

  it("refuses a flag name that is not a flag binding", () => {
    assert.equal(
      parseRule("if (posn(o0, 1, 2, 3, 4) && isset(hero)) { new.room(2); }", {
        bindings: { hero: { kind: "view", num: 0 } },
      }),
      "native",
    );
  });

  it("explains an invalid model in plain words", () => {
    assert.equal(
      ruleModelProblem({
        kind: "region",
        box: { x1: 9, y1: 0, x2: 3, y2: 0 },
        flag: "x",
        when: [],
        message: null,
      }),
      "A box needs x1 <= x2 and y1 <= y2.",
    );
    assert.equal(
      ruleModelProblem({
        kind: "exit",
        edge: null,
        box: { x1: 0, y1: 0, x2: 160, y2: 0 },
        destination: 2,
        requiresFlag: null,
      }),
      "A box must lie inside the 160x168 picture.",
    );
    assert.throws(
      () =>
        emitRule({
          kind: "exit",
          edge: "right",
          destination: 2,
          requiresFlag: null,
          blockedMessage: "x",
        }),
      /blocked message needs a required flag/,
    );
  });
});
