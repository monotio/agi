import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentSessionState, type AgentSessionState } from "../src/agent/agentState.ts";
import { playtestRoom } from "../src/agent/playtest.ts";
import { openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { decodeLogicInsns } from "../src/logic/disassembler.ts";
import { parseLogicResource } from "../src/logic/resource.ts";
import {
  parseLogicDocument,
  serializeLogicDocument,
  type LogicDocument,
} from "../src/studio/rules/logicDocument.ts";
import { applyRuleEdit, type RuleEditResult } from "../src/studio/rules/ruleEdit.ts";
import { readRules, type RuleModel } from "../src/studio/rules/ruleModel.ts";
import { TUTORIAL_LOGIC_SOURCES, buildTutorial } from "../games/adventure-department/game.ts";

const ROOM = [
  '#message 1 "A quiet yard."',
  "if (isset(f5)) {",
  "  animate.obj(o0);",
  "  accept.input();",
  "}",
  'if (said("look")) {',
  "  print(1);",
  "  set(f32);",
  "}",
  "return;",
  "",
].join("\n");

/** A one-room game whose room 1 uses f32, so the first free flag is 33. */
function yard(source = ROOM): { session: AgentSessionState; document: LogicDocument } {
  const session = createAgentSessionState();
  session.sources.words.set("look", 20);
  session.container.putResource(
    "logic",
    1,
    assembleLogic(source, { dictionary: session.sources.words }).payload,
  );
  session.sources.logics.set(1, source);
  return { session, document: parseLogicDocument(source).document };
}

/** Commit an edit the way the caller does: bindings, bytes and source together. */
function commit(session: AgentSessionState, result: RuleEditResult, room = 1): LogicDocument {
  if (!result.ok) assert.fail(result.error);
  Object.assign(session.authoring.bindings, result.newBindings);
  session.container.putResource("logic", room, result.bytes);
  session.sources.logics.set(room, result.source);
  return result.document;
}

const EAST: RuleModel = {
  kind: "exit",
  edge: "right",
  destination: 2,
  requiresFlag: null,
  blockedMessage: null,
};

describe("rule edits", () => {
  it("adds each kind in its section and allocates flags and messages", () => {
    const { session, document } = yard();
    let doc = commit(
      session,
      applyRuleEdit(
        document,
        { op: "addRule", id: "east", label: "East gate", model: EAST },
        session,
      ),
    );
    const mat = applyRuleEdit(
      doc,
      {
        op: "addRule",
        id: "mat",
        label: "Door mat",
        model: {
          kind: "region",
          box: { x1: 60, y1: 150, x2: 90, y2: 160 },
          flag: "mat_seen",
          when: [{ flag: "lamp_lit", value: true }],
          message: "You step on the mat.",
        },
      },
      session,
    );
    assert.ok(mat.ok);
    // Room 1 sets f32, so reserve_name hands out 33, then 34.
    assert.deepEqual(mat.newBindings, {
      mat_seen: { kind: "flag", num: 33 },
      lamp_lit: { kind: "flag", num: 34 },
    });
    doc = commit(session, mat);
    doc = commit(
      session,
      applyRuleEdit(
        doc,
        {
          op: "addRule",
          id: "cellar",
          label: "Trapdoor",
          item: "trapdoor",
          model: {
            kind: "exit",
            edge: null,
            box: { x1: 20, y1: 140, x2: 30, y2: 145 },
            destination: 3,
            requiresFlag: "lamp_lit",
          },
        },
        session,
      ),
    );
    const bench = applyRuleEdit(
      doc,
      {
        op: "addRule",
        id: "bench",
        label: "Bench",
        model: {
          kind: "region",
          box: { x1: 100, y1: 120, x2: 110, y2: 130 },
          flag: 50,
          when: [],
          message: "A bench.",
        },
      },
      session,
    );
    assert.ok(bench.ok);
    assert.deepEqual(bench.newBindings, {});
    doc = commit(session, bench);

    assert.equal(
      serializeLogicDocument(doc),
      [
        '#message 1 "A quiet yard."',
        "if (isset(f5)) {",
        "  animate.obj(o0);",
        "  accept.input();",
        "}",
        '// @rule mat "Door mat" region',
        "if (!isset(mat_seen) && posn(o0, 60, 150, 90, 160) && isset(lamp_lit)) {",
        "  set(mat_seen);",
        '  print("You step on the mat.");',
        "}",
        "// @end",
        '// @rule bench "Bench" region',
        "if (!isset(f50) && posn(o0, 100, 120, 110, 130)) {",
        "  set(f50);",
        '  print("A bench.");',
        "}",
        "// @end",
        'if (said("look")) {',
        "  print(1);",
        "  set(f32);",
        "}",
        '// @rule east "East gate" exit',
        "if (equaln(v2, 2)) {",
        "  new.room(2);",
        "}",
        "// @end",
        '// @rule cellar "Trapdoor" exit item=trapdoor',
        "if (posn(o0, 20, 140, 30, 145) && isset(lamp_lit)) {",
        "  new.room(3);",
        "}",
        "// @end",
        "return;",
        "",
      ].join("\n"),
    );
    // Inline text takes the slots after the highest #message, in code order.
    const { messages } = parseLogicResource(bench.bytes);
    assert.deepEqual(messages, ["A quiet yard.", "You step on the mat.", "A bench."]);
    assert.deepEqual(
      readRules(doc, {
        bindings: session.authoring.bindings,
        messages: [null, ...messages],
      }).map(({ rule, model }) => [rule.id, model === "native" ? "native" : model.kind]),
      [
        ["mat", "region"],
        ["bench", "region"],
        ["east", "exit"],
        ["cellar", "exit"],
      ],
    );
  });

  it("removes what it added, back to the original bytes and text", () => {
    const { session, document } = yard();
    const added = commit(
      session,
      applyRuleEdit(
        document,
        {
          op: "addRule",
          id: "note",
          label: "Note",
          model: {
            kind: "region",
            box: { x1: 0, y1: 0, x2: 9, y2: 9 },
            flag: 60,
            when: [],
            message: "Iron.",
          },
        },
        session,
      ),
    );
    const removed = applyRuleEdit(added, { op: "removeRule", id: "note" }, session);
    assert.ok(removed.ok);
    assert.equal(removed.source, ROOM);
    assert.deepEqual(
      removed.bytes,
      assembleLogic(ROOM, { dictionary: session.sources.words }).payload,
    );
  });

  it("keeps CRLF line endings on the lines it writes", () => {
    const crlf = ROOM.replaceAll("\n", "\r\n");
    const { session, document } = yard(crlf);
    const result = applyRuleEdit(
      document,
      { op: "addRule", id: "east", label: "East", model: EAST },
      session,
    );
    assert.ok(result.ok);
    assert.equal(
      result.source,
      crlf.replace(
        "return;",
        '// @rule east "East" exit\r\nif (equaln(v2, 2)) {\r\n  new.room(2);\r\n}\r\n// @end\r\nreturn;',
      ),
    );
  });

  it("moves a door box and changes only its posn test", () => {
    const { session, document } = yard();
    const doc = commit(
      session,
      applyRuleEdit(
        document,
        {
          op: "addRule",
          id: "door",
          label: "Door",
          model: {
            kind: "exit",
            edge: null,
            box: { x1: 1, y1: 2, x2: 3, y2: 4 },
            destination: 9,
            requiresFlag: null,
          },
        },
        session,
      ),
    );
    const moved = applyRuleEdit(
      doc,
      { op: "moveRegionBox", id: "door", box: { x1: 10, y1: 120, x2: 30, y2: 140 } },
      session,
    );
    assert.ok(moved.ok);
    const before = serializeLogicDocument(doc).split("\n");
    const after = moved.source.split("\n");
    assert.deepEqual(
      after.flatMap((line, index) => (line === before[index] ? [] : [[before[index], line]])),
      [["if (posn(o0, 1, 2, 3, 4)) {", "if (posn(o0, 10, 120, 30, 140)) {"]],
    );
  });

  it("puts a new exit before a final return that shares its line, or refuses", () => {
    const door: RuleModel = {
      kind: "exit",
      edge: null,
      box: { x1: 10, y1: 120, x2: 30, y2: 140 },
      destination: 2,
      requiresFlag: null,
    };
    const shared = ROOM.replace("return;", "assignn(v100, 1); return; // done");
    const { session, document } = yard(shared);
    const result = applyRuleEdit(
      document,
      { op: "addRule", id: "door", label: "Door", model: door },
      session,
    );
    if (!result.ok) assert.fail(result.error);
    assert.match(
      result.source,
      /\nassignn\(v100, 1\);\n\/\/ @rule door "Door" exit\n[^]*\n\/\/ @end\nreturn; \/\/ done\n$/,
    );
    // The door runs before the room's final return, every cycle.
    const order = decodeLogicInsns(result.bytes)
      .filter((insn) => insn.kind !== "data" && insn.kind !== "goto")
      .map((insn) => (insn.kind === "if" ? `if ${insn.text}` : (insn.name ?? insn.kind)));
    assert.deepEqual(order.slice(-4), [
      "assignn",
      "if posn(o0, 10, 120, 30, 140)",
      "new.room",
      "return",
    ]);
    // A label on the line could be a goto target: splitting there changes what runs.
    const labelled = yard(ROOM.replace("return;", "done: return;"));
    const refused = applyRuleEdit(
      labelled.document,
      { op: "addRule", id: "door", label: "Door", model: door },
      labelled.session,
    );
    assert.deepEqual(refused, {
      ok: false,
      error:
        "The room's final return; shares a line with other code; put it on its own line first.",
    });
  });

  it("refuses native fragments and leaves the document untouched", () => {
    const source = ROOM.replace(
      "return;",
      [
        '// @rule odd "Odd" exit',
        'if (said("look")) {',
        "  new.room(2);",
        "}",
        "// @end",
        "return;",
      ].join("\n"),
    );
    const { session, document } = yard(source);
    for (const op of [
      { op: "removeRule", id: "odd" },
      { op: "moveRegionBox", id: "odd", box: { x1: 0, y1: 0, x2: 1, y2: 1 } },
      { op: "updateRule", id: "odd", model: EAST },
    ] as const) {
      assert.deepEqual(applyRuleEdit(document, op, session), {
        ok: false,
        error:
          "Rule 'odd' is written directly in the room's script, which the door editor cannot read. Change it in the script text.",
      });
    }
    assert.equal(serializeLogicDocument(document), source);
  });

  it("refuses an edit that would not assemble, in plain words", () => {
    const full = ROOM.replace('#message 1 "A quiet yard."', '#message 255 "Full."');
    const { session, document } = yard(full.replace("print(1)", "print(255)"));
    const result = applyRuleEdit(
      document,
      {
        op: "addRule",
        id: "more",
        label: "One more message",
        model: {
          kind: "region",
          box: { x1: 0, y1: 0, x2: 9, y2: 9 },
          flag: 60,
          when: [],
          message: "No room left.",
        },
      },
      session,
    );
    assert.equal(result.ok, false);
    assert.match(
      result.ok ? "" : result.error,
      /^The room's logic would not assemble: message table full \(255 messages\) \(line \d+\)\.$/,
    );
  });

  it("refuses clashing edges, misplaced item bindings and non-flag names", () => {
    const { session, document } = yard();
    session.authoring.bindings["hero"] = { kind: "view", num: 0 };
    const doc = commit(
      session,
      applyRuleEdit(document, { op: "addRule", id: "e1", label: "E1", model: EAST }, session),
    );
    const add = (model: RuleModel, item: string | null = null) =>
      applyRuleEdit(doc, { op: "addRule", id: "e2", label: "E2", model, item }, session);
    assert.deepEqual(add(EAST), {
      ok: false,
      error: "Rule 'e1' already leaves by the right edge.",
    });
    const second = commit(
      session,
      applyRuleEdit(
        doc,
        { op: "addRule", id: "w", label: "W", model: { ...EAST, edge: "left" } },
        session,
      ),
    );
    assert.deepEqual(applyRuleEdit(second, { op: "updateRule", id: "w", model: EAST }, session), {
      ok: false,
      error: "Rule 'e1' already leaves by the right edge.",
    });
    assert.deepEqual(add({ ...EAST, edge: "left" }, "doorway"), {
      ok: false,
      error: "Only a door exit or a region has a box that can follow a picture item.",
    });
    const region = (message: string) =>
      add({ kind: "region", box: { x1: 0, y1: 0, x2: 9, y2: 9 }, flag: 60, when: [], message });
    assert.deepEqual(region("Tea \u2615"), {
      ok: false,
      error: "Message text has a character AGI cannot show: '\u2615'.",
    });
    const curly = region("It\u2019s here.");
    assert.ok(curly.ok);
    assert.match(curly.source, /print\("It's here\."\);/);
    assert.deepEqual(curly.adjustments, ['Converted U+2019 to "\'" in authored text.']);
    assert.deepEqual(add({ ...EAST, edge: "left", requiresFlag: "hero" }), {
      ok: false,
      error: "'hero' already names view 0, not a flag.",
    });
    assert.deepEqual(
      applyRuleEdit(
        doc,
        {
          op: "updateRule",
          id: "e1",
          model: {
            kind: "region",
            box: { x1: 0, y1: 0, x2: 1, y2: 1 },
            flag: 1,
            when: [],
            message: null,
          },
        },
        session,
      ),
      {
        ok: false,
        error: "Rule 'e1' is an exit, not a region; remove it and add a new rule instead.",
      },
    );
  });

  it("refuses a flag name that is an AGI sigil, on add and on update", () => {
    const { session, document } = yard();
    const door = (requiresFlag: string | null): RuleModel => ({
      kind: "exit",
      edge: null,
      box: { x1: 1, y1: 2, x2: 3, y2: 4 },
      destination: 2,
      requiresFlag,
    });
    const sigil = (name: string) =>
      `"${name}" is how AGI writes a numbered flag; pick a word name such as door_open.`;
    for (const [i, name] of ["f5", "v3", "o1", "m2", "s0", "i4", "w7", "V12"].entries())
      assert.deepEqual(
        applyRuleEdit(
          document,
          { op: "addRule", id: `door-${i}`, label: "Door", model: door(name) },
          session,
        ),
        { ok: false, error: sigil(name) },
      );
    const doc = commit(
      session,
      applyRuleEdit(
        document,
        { op: "addRule", id: "door", label: "Door", model: door(null) },
        session,
      ),
    );
    for (const name of ["f5", "V12"])
      assert.deepEqual(
        applyRuleEdit(doc, { op: "updateRule", id: "door", model: door(name) }, session),
        { ok: false, error: sigil(name) },
      );
    // A word name still reserves a binding and edits fine.
    const named = applyRuleEdit(
      doc,
      { op: "updateRule", id: "door", model: door("door_open") },
      session,
    );
    assert.ok(named.ok);
    assert.deepEqual(named.newBindings, { door_open: { kind: "flag", num: 33 } });
  });

  it("refuses every edit while a rule annotation is broken", () => {
    const scenarios = [
      {
        name: "a duplicate rule id",
        rules: [
          '// @rule west-door "West" exit',
          "if (equaln(v2, 4)) { new.room(2); }",
          "// @end",
          '// @rule west-door "Second west" exit',
          "if (equaln(v2, 2)) { new.room(3); }",
          "// @end",
        ],
        problem: "rule id 'west-door' is already used",
      },
      {
        name: "a nested rule",
        rules: [
          '// @rule mat "Mat" region',
          "if (!isset(f40) && posn(o0, 1, 2, 3, 4)) { set(f40); }",
          '// @rule inner "Inner" exit',
          "// @end",
        ],
        problem: "rules do not nest; 'mat' is still open",
      },
      {
        name: "an unterminated rule",
        rules: ['// @rule tail "Tail" exit', "if (equaln(v2, 4)) { new.room(2); }"],
        problem: "rule 'tail' has no @end",
      },
    ];
    for (const { name, rules, problem } of scenarios) {
      const source = ROOM.replace("return;", [...rules, "return;"].join("\n"));
      const { session, document } = yard(source);
      const [first] = document.rules;
      assert.ok(first, name);
      for (const op of [
        { op: "addRule", id: "extra", label: "Extra", model: EAST },
        { op: "updateRule", id: first.id, model: { ...EAST, edge: "bottom" } },
        { op: "removeRule", id: first.id },
        { op: "moveRegionBox", id: first.id, box: { x1: 0, y1: 0, x2: 9, y2: 9 } },
      ] as const) {
        const result = applyRuleEdit(document, op, session);
        assert.equal(result.ok, false, `${name}: ${op.op}`);
        assert.ok(
          !result.ok && result.error.includes(problem),
          `${name}: ${op.op}: ${result.ok ? "" : result.error}`,
        );
      }
      assert.equal(serializeLogicDocument(document), source, name);
    }
  });
});

describe("rule edits on the tutorial", () => {
  const EXITS = ["if (equaln(v2, 4)) { new.room(1); }", "if (equaln(v2, 2)) { new.room(3); }"].join(
    "\n",
  );
  const ANNOTATED = [
    '// @rule exit-west "West doorway" exit',
    "if (equaln(v2, 4)) { new.room(1); }",
    "// @end",
    '// @rule exit-east "East doorway" exit',
    "if (equaln(v2, 2)) { new.room(3); }",
    "// @end",
  ].join("\n");

  function tutorial(): AgentSessionState {
    const game = buildTutorial();
    const session = createAgentSessionState(openContainer(new Map(Object.entries(game.files))));
    for (const [word, id] of game.words) session.sources.words.set(word, id);
    const state = game.project!.authoringState as { authoring: AgentSessionState["authoring"] };
    session.authoring = structuredClone(state.authoring);
    return session;
  }

  /** Walk right from beside the lab's east doorway; the room the walk ends in. */
  function walkEast(session: AgentSessionState): number {
    const result = playtestRoom(session, {
      room: 2,
      spawnX: 130,
      spawnY: 151,
      steps: [{ action: "move", direction: "right", ticks: 60 }],
      expect: null,
    });
    assert.ok(result.success, result.error ?? "");
    return (result.details?.["state"] as { room: number }).room;
  }

  it("reads the lab's annotated exits and keeps its bytes", () => {
    const session = tutorial();
    const shipped = TUTORIAL_LOGIC_SOURCES[2]!;
    assert.ok(shipped.includes(EXITS));
    const source = shipped.replace(EXITS, ANNOTATED);
    // Annotations are comments: the annotated text assembles to the shipped bytes.
    assert.deepEqual(
      assembleLogic(source, { dictionary: session.sources.words }).payload,
      session.container.getResource("logic", 2),
    );
    assert.deepEqual(
      readRules(parseLogicDocument(source).document).map(({ rule, model }) => [rule.id, model]),
      [
        [
          "exit-west",
          { kind: "exit", edge: "left", destination: 1, requiresFlag: null, blockedMessage: null },
        ],
        [
          "exit-east",
          { kind: "exit", edge: "right", destination: 3, requiresFlag: null, blockedMessage: null },
        ],
      ],
    );
  });

  it("adds a door to the gallery floor and the engine walks through it", () => {
    const session = tutorial();
    const walk = () => {
      const result = playtestRoom(session, {
        room: 1,
        spawnX: 40,
        spawnY: 151,
        steps: [{ action: "move", direction: "right", ticks: 40 }],
        expect: null,
      });
      assert.ok(result.success, result.error ?? "");
      return (result.details?.["state"] as { room: number }).room;
    };
    assert.equal(walk(), 1);
    const door = applyRuleEdit(
      parseLogicDocument(TUTORIAL_LOGIC_SOURCES[1]!).document,
      {
        op: "addRule",
        id: "trapdoor",
        label: "Trapdoor",
        model: {
          kind: "exit",
          edge: null,
          box: { x1: 60, y1: 145, x2: 70, y2: 155 },
          destination: 3,
          requiresFlag: null,
        },
      },
      session,
    );
    commit(session, door);
    assert.equal(walk(), 3);
  });

  it("moves the lab's east exit and the engine follows it", () => {
    const session = tutorial();
    const shipped = TUTORIAL_LOGIC_SOURCES[2]!;
    const source = shipped.replace(EXITS, ANNOTATED);
    assert.equal(walkEast(session), 3);

    const document = parseLogicDocument(source).document;
    const moved = applyRuleEdit(
      document,
      { op: "updateRule", id: "exit-east", model: { ...EAST, destination: 1 } },
      session,
    );
    assert.ok(moved.ok, moved.ok ? "" : moved.error);
    assert.equal(
      moved.source,
      shipped.replace(
        EXITS,
        [
          '// @rule exit-west "West doorway" exit',
          "if (equaln(v2, 4)) { new.room(1); }",
          "// @end",
          '// @rule exit-east "East doorway" exit',
          "if (equaln(v2, 2)) {",
          "  new.room(1);",
          "}",
          "// @end",
        ].join("\n"),
      ),
    );
    assert.deepEqual(moved.newBindings, {});
    commit(session, moved, 2);
    assert.equal(walkEast(session), 1);
  });
});
