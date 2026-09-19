import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";

const DICTIONARY = new Map([["save", 200]]);

function formatFromLogic(logics: string[], answer = ""): string[] {
  const container = createContainer();
  for (const [num, source] of logics.entries()) {
    container.putResource("logic", num, assembleLogic(source, { dictionary: DICTIONARY }).payload);
  }
  const output: string[] = [];
  const host: EngineHost = {
    print: (text) => output.push(text),
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
    promptString: () => answer,
  };
  new Engine(container, host, DICTIONARY).tick();
  return output;
}

test("global inserts keep logic 0's message context throughout their subtree and restore it", () => {
  // Original machine-code observation: docs/fidelity.md, "Original message formatter".
  assert.deepEqual(
    formatFromLogic(
      [
        `#message 1 "%s1"
       #message 2 "GLOBAL"
       get.string(s1, "Name?", 0, 0, 39);
       call(1); return;`,
        `#message 1 "%g1/%m2"
       #message 2 "LOCAL"
       print(m1); return;`,
      ],
      "%m2",
    ),
    ["GLOBAL/LOCAL"],
  );
});

test("only variable substitutions consume the width suffix", () => {
  assert.deepEqual(
    formatFromLogic(
      [
        `#message 1 "global"
       get.string(s1, "Name?", 0, 0, 39);
       set.string(s2, "save"); parse(s2);
       assignn(v48, 7); call(1); return;`,
        `#message 1 "local"
       print("%g1|5 %m1|5 %s1|5 %w1|5 %v48|3"); return;`,
      ],
      "hello",
    ),
    ["global|5 local|5 hello|5 save|5 007"],
  );
});

test("unknown substitution characters consume exactly the percent sign and next character", () => {
  assert.deepEqual(formatFromLogic(['print("100%% done %Q42 %q42|5 tail%"); return;']), [
    "100 done 42 42|5 tail",
  ]);
});

test("work exhaustion while reading an index returns the prefix without resolving a partial code", () => {
  assert.deepEqual(formatFromLogic([`print("prefix%m${"0".repeat(20_000)}"); return;`]), [
    "prefix",
  ]);
});

test("acyclic message chains may exceed nineteen nested inserts", () => {
  const messages = Array.from(
    { length: 32 },
    (_, i) => `#message ${i + 1} "${i === 31 ? "end" : `%m${i + 2}`}"`,
  ).join("\n");
  assert.deepEqual(formatFromLogic([`${messages}\nprint(m1); return;`]), ["end"]);
});

test("prompt text cannot monopolize an opcode with productive or non-emitting recursion", () => {
  // A separate process makes a synchronous formatter regression fail promptly;
  // a node:test timeout alone cannot interrupt a monopolized event loop.
  const imports = [
    ["createContainer", "../src/container/container.ts"],
    ["assembleLogic", "../src/logic/assembler.ts"],
    ["Engine", "../src/runtime/engine.ts"],
  ].map(
    ([name, path]) =>
      `import { ${name} } from ${JSON.stringify(new URL(path!, import.meta.url).href)};`,
  );
  const run = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `
    ${imports.join("\n")}
    const outputs = [];
    for (const answer of ["x%s1%s1%s1", "%s1%s1%s1"]) {
      const container = createContainer();
      container.putResource("logic", 0, assembleLogic(
        'get.string(s1, "Name?", 0, 0, 39); print("%s1"); return;',
        { dictionary: new Map() },
      ).payload);
      const engine = new Engine(container, {
        print: text => outputs.push(text), displayAt() {}, statusLine() {},
        takeInputLine: () => null, takeKeys: () => [], promptString: () => answer,
      }, new Map(), { instructionBudget: 100 });
      engine.tick();
    }
    process.stdout.write(JSON.stringify(outputs));
  `,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(run.error, undefined, "message expansion must finish within the subprocess limit");
  assert.equal(run.status, 0, run.stderr);
  // Capacity and work guards are host policy; wrapLines owns window geometry.
  assert.deepEqual(JSON.parse(run.stdout), ["x".repeat(800), ""]);
});
