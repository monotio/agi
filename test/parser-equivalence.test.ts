import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSentence } from "../src/runtime/parser.ts";
import { Engine } from "../src/runtime/engine.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";

test("the sentence tester and interpreter retain identical parser results", () => {
  const dictionary = new Map([
    ["look", 100],
    ["look at", 101],
    ["the old", 0],
    ["tree", 120],
    ["dont", 130],
  ]);
  for (const line of [
    "LOOK AT the old tree",
    "look missing tree",
    "don't,tree!",
    "the old",
    "",
    "??",
    " look tree",
    Array(12).fill("look").join(" "),
    Array(11).fill("look").join(" ") + " missing tree",
  ]) {
    const game = createContainer();
    game.putResource("logic", 0, assembleLogic("accept.input(); return;", { dictionary }).payload);
    let input: string | null = null;
    const engine = new Engine(
      game,
      {
        print() {},
        displayAt() {},
        statusLine() {},
        takeKeys: () => [],
        takeInputLine() {
          const result = input;
          input = null;
          return result;
        },
      },
      dictionary,
    );
    engine.tick();
    input = line;
    engine.tick();
    const parsed = parseSentence(line, dictionary);
    assert.deepEqual(parsed.words, engine.parsedWords, line);
    assert.deepEqual(parsed.texts, engine.parsedWordTexts, line);
    assert.equal(parsed.count, engine.parserCount, line);
    assert.equal(parsed.unknownPosition, engine.vars[9], line);
    assert.equal(Number(parsed.count > 0), engine.flags[2], line);
  }
  assert.deepEqual(
    parseSentence("look the old missing tree", dictionary).tokens.map((t) => [t.text, t.status]),
    [
      ["look", "known"],
      ["the old", "skipped"],
      ["missing", "new"],
      ["tree", "unread"],
    ],
  );
});
