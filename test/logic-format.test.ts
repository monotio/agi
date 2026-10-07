import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLogic } from "../src/logic/format.ts";
import { assembleLogic, AssemblerError, type AssembleOptions } from "../src/logic/assembler.ts";
import { disassembleLogic, disassembleLogicWarnings } from "../src/logic/disassembler.ts";
import { scanFixtures } from "./fixtures.ts";
import { readFileSync } from "node:fs";
import { openContainer } from "../src/container/container.ts";
import { canonicalResourceName, isPlayableFileName } from "../src/container/playableFiles.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { buildTemplateWordEntries, parseAdventureTemplate } from "../src/template/template.ts";
import {
  BASE_TEMPLATE_LOGIC0_SOURCE,
  BASE_TEMPLATE_DEATH_LOGIC_SOURCE,
} from "../src/authoring/baseTemplate.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import { TUTORIAL_LOGIC_SOURCES, TUTORIAL_WORDS } from "../games/adventure-department/game.ts";
import { menusSource, gameOverSource, scoreSource } from "../src/authoring/boilerplateParts.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { PROFILES, detectProfile } from "../src/runtime/profile.ts";

function formatted(source: string): string {
  const edits = formatLogic(source);
  return edits[0]?.newText ?? source;
}
const cases = [
  [
    "blocks, statements and else",
    "if(isset(f1)){load.sound(2);if(f2){v3=4;}}else {return;}",
    "if (isset(f1)) {\n  load.sound(2);\n  if (f2) {\n    v3 = 4;\n  }\n} else {\n  return;\n}\n",
  ],
  [
    "calls, comparisons, boolean operators and parentheses",
    'if ( ( v1>=2 )&& ! isset ( f2 ) ||v3!=4){display ( 1 ,2 ,"x" );}',
    'if ((v1 >= 2) && !isset(f2) || v3 != 4) {\n  display(1, 2, "x");\n}\n',
  ],
  [
    "verbatim comments, strings, directives and labels",
    '  #define X 3\n  #include "ignored"\n  #message 1 "a\\x22 // {}"\nif(f1){ // block\n// inner  comment\n marker: print ("a\\n // ;"); // tail\ngoto marker;} // end',
    '#define X 3\n#include "ignored"\n#message 1 "a\\x22 // {}"\nif (f1) { // block\n  // inner  comment\nmarker:\n  print("a\\n // ;"); // tail\n  goto marker;\n} // end\n',
  ],
  [
    "comments within expressions stay between their tokens",
    "if( // test\nf1 // flag\n){return; // done\n}\n// final",
    "if ( // test\n  f1 // flag\n) {\n  return; // done\n}\n// final\n",
  ],
  [
    "blank lines, trailing whitespace and final newline",
    "\n\nreturn;  \r\n\r\n\r\n// end  \r\n\r\n",
    "return;\n\n// end\n",
  ],
  [
    "comment between a close brace and else prevents joining",
    "if(f1){return;} // then\nelse{ return; }",
    "if (f1) {\n  return;\n} // then\nelse {\n  return;\n}\n",
  ],
  [
    "blank lines inside a header do not detach its brace",
    "if\n\n(\n\nf1\n\n)\n\n{\n\nreturn;\n\n}",
    "if (f1) {\n\n  return;\n\n}\n",
  ],
  [
    "comment trivia retains carriage returns within its text",
    "// one\rtwo\nreturn;",
    "// one\rtwo\nreturn;\n",
  ],
  [
    "labels and directives retain comment positions between tokens",
    'if(f1){ marker // label\n: return;}\n#define X // value\n3\n#message 1 // text\n"hello"\nprint(m1);',
    'if (f1) {\nmarker // label\n:\n  return;\n}\n#define X // value\n3\n#message 1 // text\n"hello"\nprint(m1);\n',
  ],
  ["empty document", "", "\n"],
] as const;
for (const [name, source, expected] of cases) {
  test(`formatter: ${name}`, () => {
    assert.equal(formatted(source), expected);
    assert.deepEqual(formatLogic(expected), [], "already formatted has no edits");
  });
}
for (const source of [
  "if(f1){return;",
  'print("broken);',
  "return",
  "v1+=2;",
  "if () { return; }",
]) {
  test(`formatter refuses syntax errors: ${source}`, () =>
    assert.deepEqual(formatLogic(source), []));
}

function prove(source: string, options: AssembleOptions): void {
  const before = assembleLogic(source, { ...options, sourceMap: true });
  const afterSource = formatted(source);
  const after = assembleLogic(afterSource, { ...options, sourceMap: true });
  assert.deepEqual(after.payload, before.payload);
  const order = (result: typeof before) =>
    result.sourceMap!.entries.map(({ statementId, kind, pc, endPc }) => ({
      statementId,
      kind,
      pc,
      endPc,
    }));
  assert.deepEqual(order(after), order(before));
  assert.equal(formatted(afterSource), afterSource);
}
test("formatter preserves every Starter and Boilerplate LOGIC and source-map statement order", () => {
  for (const kind of ["starter", "boilerplate"] as const) {
    const project = createStarterProject(kind);
    for (const source of project.sources.logics.values()) {
      const context = {
        profile: PROFILES[project.profileId],
        dictionary: project.sources.words,
        bindings: project.bindings,
        sourceMap: true,
      };
      const before = compileProjectLogic(source, context);
      const after = compileProjectLogic(formatted(source), context);
      assert.deepEqual(after.assembly.payload, before.assembly.payload);
      assert.deepEqual(
        after.assembly.sourceMap!.entries.map(({ statementId, kind, pc, endPc }) => ({
          statementId,
          kind,
          pc,
          endPc,
        })),
        before.assembly.sourceMap!.entries.map(({ statementId, kind, pc, endPc }) => ({
          statementId,
          kind,
          pc,
          endPc,
        })),
      );
      prove(before.assembly.sourceMap!.source, { dictionary: project.sources.words });
    }
  }
});
test("formatter preserves the shared seed LOGIC for all four adventure templates", () => {
  for (const name of ["knights-trial", "badge-of-millhaven", "mop-jockey", "polyester-nights"]) {
    const template = parseAdventureTemplate(
      readFileSync(new URL(`../games/${name}/SKILL.md`, import.meta.url), "utf8"),
    );
    const dictionary = new Map(
      buildTemplateWordEntries(template).map(({ word, id }) => [word, id]),
    );
    for (const source of [BASE_TEMPLATE_LOGIC0_SOURCE, BASE_TEMPLATE_DEATH_LOGIC_SOURCE])
      prove(source, { dictionary });
  }
});
test("formatter preserves every reusable boilerplate LOGIC part", () => {
  const sources = [
    menusSource({ menusLogic: "240", menusReady: "f240" }),
    gameOverSource({ gameOverLogic: "241", dead: "f241", chosen: "f242", cursor: "v240" }),
    scoreSource("242"),
  ];
  for (const source of sources) prove(source, { dictionary: new Map() });
});
test("formatter preserves every Adventure Department LOGIC and statement order", () => {
  for (const source of Object.values(TUTORIAL_LOGIC_SOURCES))
    prove(source, { dictionary: new Map(TUTORIAL_WORDS) });
});
test("formatter preserves every locally available decompiled fixture LOGIC", () => {
  let count = 0;
  let invalid = 0;
  let unreadable = 0;
  for (const fixture of scanFixtures().all) {
    // Read this discovered edition, including its interpreter for profile detection.
    const files = new Map(
      [...fixture.files.values()]
        .filter(isPlayableFileName)
        .map((name) => [
          canonicalResourceName(name),
          new Uint8Array(readFileSync(fixture.dir + name)),
        ]),
    );
    const container = openContainer(files);
    const words = files.get("WORDS.TOK");
    const dict = new Map(words ? parseWordsTok(words).map(({ word, id }) => [word, id]) : []);
    const profile = detectProfile(files);
    for (let num = 0; num < 256; num++) {
      let payload: Uint8Array | null;
      try {
        payload = container.getResource("logic", num);
      } catch (error) {
        assert.match(String(error), /corrupt container:/);
        unreadable++;
        continue;
      }
      if (!payload) continue;
      let source: string;
      try {
        source = disassembleLogic(payload, { dictionary: dict, profile });
      } catch (error) {
        assert.match(String(error), /logic bytecode ends mid-instruction|logic resource/i);
        unreadable++;
        continue;
      }
      try {
        assembleLogic(source, { dictionary: dict, profile });
      } catch (error) {
        assert.ok(error instanceof AssemblerError);
        assert.ok(
          disassembleLogicWarnings(payload, { dictionary: dict, profile }).length > 0,
          "invalid decompilation must carry a warning",
        );
        assert.throws(
          () => assembleLogic(formatted(source), { dictionary: dict, profile }),
          (after: unknown) =>
            after instanceof AssemblerError &&
            after.message.replace(/^\d+:\d+: /, "") === error.message.replace(/^\d+:\d+: /, ""),
        );
        invalid++;
        continue;
      }
      prove(source, { dictionary: dict, profile });
      count++;
    }
  }
  // No private fixture is required in public checkouts; installed fixtures are all checked.
  console.info(
    `Formatted ${count} compilable fixture LOGIC resources; ${invalid} warned decompilations retain their compiler failure; ${unreadable} corrupt records cannot be decompiled.`,
  );
});
