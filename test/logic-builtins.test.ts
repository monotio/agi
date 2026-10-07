import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleLogic } from "../src/logic/assembler.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { createProjectLogicLanguageSnapshot } from "../src/authoring/projectLanguage.ts";
import { createLogicLspServer } from "../src/logic/lspServer.ts";
import { offsetAt, positionAt, type WorkspaceEdit } from "../src/logic/lspTypes.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { SYSTEM_FLAGS, SYSTEM_VARIABLES } from "../src/logic/systemNames.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import {
  FIRST_STARTUP_LOGIC0_SOURCE,
  FIRST_ROOM_LOGIC_SOURCE,
} from "../src/authoring/firstRoom.ts";
import { menusSource, gameOverSource, scoreSource } from "../src/authoring/boilerplateParts.ts";
import { scanLogicTokens } from "../src/logic/syntax.ts";

const context = { profile: PROFILES["2.936"], dictionary: new Map<string, number>(), bindings: {} };

test("every built-in compiles to the hand-derived numbered operand bytes", () => {
  for (const [names, command, opcode] of [
    [SYSTEM_FLAGS, "set", 12],
    [SYSTEM_VARIABLES, "increment", 1],
  ] as const) {
    for (const [slot, name] of Object.entries(names)) {
      const source = `${command}(${name}); return;`;
      const expected = [opcode, Number(slot), 0];
      assert.deepEqual([...assembleLogic(source, context).code], expected, name);
      assert.deepEqual([...compileProjectLogic(source, context).assembly.code], expected, name);
    }
  }
  const source =
    "score = current_room; if (current_room == prev_room && new_room) { increment(score); } return;";
  assert.deepEqual(
    [...compileProjectLogic(source, context).assembly.code],
    [4, 3, 0, 255, 2, 0, 1, 7, 5, 255, 2, 0, 1, 3, 0],
  );
});

test("completion inserts built-in names once and project bindings take precedence", () => {
  const source = "increment(cur";
  const snapshot = createProjectLogicLanguageSnapshot({ source, ...context });
  assert.deepEqual(
    snapshot
      .completeAt(source.length)
      .filter((entry) => entry.label === "current_room")
      .map((entry) => entry.text),
    ["current_room"],
  );
  const assignment = createProjectLogicLanguageSnapshot({ source: "score = cur", ...context });
  assert.ok(
    assignment.completeAt(assignment.source.length).some((entry) => entry.text === "current_room"),
  );
  const renamed = createProjectLogicLanguageSnapshot({
    source: "increment(",
    ...context,
    bindings: { room: { kind: "variable", num: 0 } },
  });
  const completions = renamed.completeAt(renamed.source.length);
  assert.ok(completions.some((entry) => entry.text === "room"));
  assert.ok(!completions.some((entry) => entry.label === "current_room"));
  assert.throws(
    () =>
      compileProjectLogic("increment(current_room); return;", {
        ...context,
        bindings: { room: { kind: "variable", num: 0 } },
      }),
    /Nothing is named/,
  );
});

test("a colliding project name wins with a clear warning on its authored use", () => {
  const source = "increment(current_room); return;";
  const bindings = { current_room: { kind: "variable", num: 40 } };
  const build = compileProjectLogic(source, { ...context, bindings });
  assert.deepEqual([...build.assembly.code], [1, 40, 0]);
  assert.match(
    build.assembly.diagnostics[0]?.message ?? "",
    /current_room.*Variable 40.*built-in Variable 0/,
  );
  const snapshot = createProjectLogicLanguageSnapshot({ source, ...context, bindings });
  assert.equal(snapshot.diagnostics[0]?.severity, "warning");
  assert.equal(snapshot.diagnostics[0]?.start, source.indexOf("current_room"));
});

test("built-in hover, references and F2 rename include named and raw uses across LOGICs", () => {
  const uri = "agi-project:///logic.1.lgc";
  const sources = [
    "assignn(current_room, 1); call.v(v0); return;",
    "score = current_room; return;",
  ];
  const server = createLogicLspServer({
    project: {
      profileId: "2.936",
      words: [],
      bindings: {},
      documents: Object.fromEntries(
        sources.map((source, index) => [`logic:${index + 1}`, { source }]),
      ),
    },
  });
  const request = (method: string, extra = {}) =>
    server.handle({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        textDocument: { uri },
        position: positionAt(sources[0]!, sources[0]!.indexOf("current_room")),
        ...extra,
      },
    });
  assert.match(JSON.stringify(request("textDocument/hover")?.result), /current_room · Variable 0/);
  assert.equal(
    (
      request("textDocument/references", { context: { includeDeclaration: false } })
        ?.result as unknown[]
    ).length,
    3,
  );
  const result = request("textDocument/rename", { newName: "room_number" });
  assert.ok(!result?.error, JSON.stringify(result));
  const edit = result?.result as WorkspaceEdit;
  const bindings = JSON.parse(edit.documentChanges[0]!.edits[0]!.newText) as {
    room_number: { kind: string; num: number };
  };
  assert.deepEqual(bindings.room_number, { kind: "variable", num: 0 });
  for (const [index, source] of sources.entries()) {
    const change = edit.documentChanges.find(
      (entry) => entry.textDocument.uri === `agi-project:///logic.${index + 1}.lgc`,
    )!;
    let next = source;
    for (const entry of [...change.edits].reverse())
      next =
        next.slice(0, offsetAt(source, entry.range.start)) +
        entry.newText +
        next.slice(offsetAt(source, entry.range.end));
    assert.ok(!next.includes("current_room"));
    assert.deepEqual(
      compileProjectLogic(next, { ...context, bindings }).assembly.payload,
      compileProjectLogic(source, context).assembly.payload,
    );
  }
});

test("every template LOGIC uses names with identical bytes to the original numbered source", () => {
  const aliases: Record<string, string> = {
    current_room: "v0",
    prev_room: "v1",
    ego_edge: "v2",
    score: "v3",
    ego_direction: "v6",
    max_score: "v7",
    parser_status: "v9",
    cycle_speed: "v10",
    key_pressed: "v19",
    new_room: "f5",
    input_received: "f2",
    input_handled: "f4",
    sound_on: "f9",
    menus_on: "f14",
  };
  const parts = [
    menusSource({ menusLogic: "v40", menusReady: "f40" }),
    gameOverSource({ gameOverLogic: "v41", dead: "f41", chosen: "f42", cursor: "v42" }),
    scoreSource("43"),
  ];
  const projects = [createStarterProject("starter"), createStarterProject("boilerplate")];
  const entries = [
    ...[FIRST_STARTUP_LOGIC0_SOURCE, FIRST_ROOM_LOGIC_SOURCE, ...parts].map((source) => ({
      source,
      bindings: {},
      dictionary: context.dictionary,
    })),
    ...projects.flatMap((project) =>
      [...project.sources.logics.values()].map((source) => ({
        source,
        bindings: project.bindings,
        dictionary: project.sources.words,
      })),
    ),
  ];
  for (const entry of entries) {
    const tokens = scanLogicTokens(entry.source);
    assert.ok(
      tokens.some((token) => token.type === "ident" && Object.hasOwn(aliases, token.text)) ||
        entry.source.includes("%v3"),
      entry.source,
    );
    assert.ok(
      !tokens.some(
        (token) => token.type === "ident" && Object.values(aliases).includes(token.text),
      ),
      entry.source,
    );
    let oldSource = entry.source;
    for (const token of [...tokens].reverse())
      if (token.type === "ident" && Object.hasOwn(aliases, token.text))
        oldSource =
          oldSource.slice(0, token.start) + aliases[token.text]! + oldSource.slice(token.end);
    assert.deepEqual(
      compileProjectLogic(entry.source, { ...context, ...entry }).assembly.payload,
      compileProjectLogic(oldSource, { ...context, ...entry }).assembly.payload,
    );
  }
});

test("overridden slots use the project name in hover and reject conflicting renames", () => {
  const server = createLogicLspServer({
    project: {
      profileId: "2.936",
      words: [],
      bindings: { room: { kind: "variable", num: 0 }, gate: { kind: "flag", num: 40 } },
      documents: { "logic:1": { source: "increment(room); set(gate); return;" } },
    },
  });
  const hover = server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "textDocument/hover",
    params: {
      textDocument: { uri: "agi-project:///logic.1.lgc" },
      position: { line: 0, character: 10 },
    },
  });
  assert.match(JSON.stringify(hover?.result), /room · Variable 0/);
  assert.doesNotMatch(JSON.stringify(hover?.result), /current_room/);
});

test("renaming a project binding cannot claim another built-in slot", () => {
  const server = createLogicLspServer({
    project: {
      profileId: "2.936",
      words: [],
      bindings: { gate: { kind: "flag", num: 40 } },
      documents: {},
    },
  });
  const rename = server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "agi/renameBinding",
    params: { name: "gate", newName: "current_room" },
  });
  assert.match(rename?.error?.message ?? "", /belongs to Variable 0/);
});

test("only declared built-in identifiers resolve", () => {
  assert.throws(
    () => assembleLogic("increment(constructor); return;", context),
    /Nothing is named/,
  );
});

test("a colliding typed project binding keeps its operand kind in shorthand", () => {
  const source = "score = current_room; if (score == current_room && gate) { set(gate); } return;";
  const bindings = { current_room: { kind: "variable", num: 40 }, gate: { kind: "flag", num: 41 } };
  assert.deepEqual(
    [...compileProjectLogic(source, { ...context, bindings }).assembly.code],
    [4, 3, 40, 255, 2, 3, 40, 7, 41, 255, 2, 0, 12, 41, 0],
  );
});
