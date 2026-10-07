import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleLogic } from "../src/logic/assembler.ts";
import { disassembleLogic } from "../src/logic/disassembler.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { createLogicLanguageSnapshot } from "../src/logic/language.ts";
import {
  FIRST_ROOM_LOGIC_SOURCE,
  FIRST_STARTUP_LOGIC0_SOURCE,
} from "../src/authoring/firstRoom.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { TUTORIAL_LOGIC_SOURCES, TUTORIAL_WORDS } from "../games/adventure-department/game.ts";
import { PROFILES } from "../src/runtime/profile.ts";

const dictionary = new Map<string, number>();
const profile = PROFILES["2.936"];

test("implicit return terminates empty, action, conditional and labelled programs", () => {
  for (const [source, expected] of [
    ["", [0]],
    ['print("hi");', [101, 1, 0]],
    ["assignn(v1, 0);", [3, 1, 0, 0]],
    ["if (isset(f1)) { return; }", [255, 7, 1, 255, 1, 0, 0, 0]],
    ["goto done; done:", [254, 0, 0, 0]],
    ["return; done:", [0, 0]],
    ["return; // finished", [0]],
    ["return; increment(v1);", [0, 1, 1, 0]],
  ] as const) {
    const result = assembleLogic(source, { dictionary, sourceMap: true });
    assert.deepEqual([...result.code], expected, source);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.sourceMap?.source, source);
    if (!source.startsWith("return; //"))
      assert.deepEqual(
        result.payload,
        assembleLogic(`${source.replace(/return;\s*$/, "")}\nreturn;`, { dictionary }).payload,
      );
  }
});

test("disassembly omits only the final top-level return and keeps its label", () => {
  for (const [code, expected] of [
    [[0], "\n"],
    [[0, 0], "return;\nL1:\n"],
    [[254, 0, 0, 0], "goto L3;\nL3:\n"],
    [[255, 7, 1, 255, 1, 0, 0, 0], "if (isset(f1)) {\n  return;\n}\n"],
  ] as const) {
    const payload = buildLogicResource(new Uint8Array(code), []);
    const source = disassembleLogic(payload);
    assert.equal(source, expected);
    assert.deepEqual(assembleLogic(source, { dictionary }).payload, payload);
  }
});

test("bundled LOGIC omits trailing returns and retains explicit-return byte identity", () => {
  const sources = [
    FIRST_ROOM_LOGIC_SOURCE,
    FIRST_STARTUP_LOGIC0_SOURCE,
    ...Object.values(TUTORIAL_LOGIC_SOURCES),
  ];
  for (const source of sources) {
    assert.doesNotMatch(source, /return;\s*$/);
    const options = { dictionary: new Map(TUTORIAL_WORDS) };
    assert.deepEqual(
      assembleLogic(source, options).payload,
      assembleLogic(`${source}\nreturn;`, options).payload,
    );
  }
  for (const kind of ["starter", "boilerplate"] as const) {
    const project = createStarterProject(kind);
    for (const source of project.sources.logics.values()) {
      assert.doesNotMatch(source, /return;\s*$/);
      const options = { profile, dictionary: project.sources.words, bindings: project.bindings };
      assert.deepEqual(
        compileProjectLogic(source, options).assembly.payload,
        compileProjectLogic(`${source}\nreturn;`, options).assembly.payload,
      );
    }
  }
});

test("language diagnostics and completion accept implicit and early returns", () => {
  for (const source of ['print("hi");', 'if (isset(f1)) { return; } print("hi");']) {
    const language = createLogicLanguageSnapshot({ source, profile, dictionary });
    assert.deepEqual(language.diagnostics, []);
    assert.ok(language.completeAt(0).some((entry) => entry.label === "return"));
  }
});
