import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES } from "../src/runtime/profile.ts";

/**
 * Parser normalization (spec "Parser normalization") and the have.key
 * blocking-wait contract.
 *
 * Normalization rule, verbatim from the spec: space and `, . ? ! ( ) ; : [ ]
 * { }` are separators; apostrophe, backtick, hyphen and double quote are
 * dropped WITHOUT creating a separator; separator runs collapse to one space;
 * a trailing space is removed; matching ignores ASCII case. Every expectation
 * below is the token sequence that rule produces, worked out by hand.
 */

const DICT = new Map([
  ["dont", 10],
  ["open", 11],
  ["the", 0],
  ["xray", 12],
  ["door", 13],
  ["look", 14],
]);

class Host implements EngineHost {
  line: string | null = null;
  keys: number[] = [];
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    const l = this.line;
    this.line = null;
    return l;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
}

const ACCEPT = "accept.input();\nreturn;\n";

function parse(line: string): { words: number[]; texts: string[] } {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(ACCEPT, { dictionary: DICT }).payload);
  const host = new Host();
  const engine = new Engine(container, host, DICT);
  engine.tick();
  host.line = line;
  engine.tick();
  return { words: [...engine.parsedWords], texts: [...engine.parsedWordTexts] };
}

describe("parser normalization", () => {
  test("apostrophes, backticks, hyphens and quotes drop without splitting", () => {
    // "don't" -> "dont" (one token), not "don t".
    assert.deepEqual(parse("don't").texts, ["dont"]);
    assert.deepEqual(parse("don't").words, [10]);
    // Backtick and double quote drop the same way; a hyphen joins the halves.
    assert.deepEqual(parse("x-ray").texts, ["xray"]);
    assert.deepEqual(parse('"do`nt"').texts, ["dont"]);
  });

  test("the full separator set splits tokens", () => {
    // Every one of space , . ? ! ( ) ; : [ ] { } separates.
    assert.deepEqual(parse("open,the.door?").texts, ["open", "door"]);
    assert.deepEqual(parse("open!the(door)").texts, ["open", "door"]);
    assert.deepEqual(parse("open;the:door").texts, ["open", "door"]);
    assert.deepEqual(parse("open[the]door{look}").texts, ["open", "door", "look"]);
    assert.deepEqual(parse("open[the]door{look}").words, [11, 13, 14]);
  });

  test("separator runs collapse and a trailing separator adds no token", () => {
    // "open . . the   door!!" -> "open door"; ids 11 and 13 ("the" is id 0).
    assert.deepEqual(parse("open . . the   door!!").texts, ["open", "door"]);
    assert.deepEqual(parse("open . . the   door!!").words, [11, 13]);
    // A leading separator produces no empty (and therefore no unknown) token.
    assert.deepEqual(parse("  look").texts, ["look"]);
    assert.deepEqual(parse("  look").words, [14]);
  });

  test("matching ignores ASCII case", () => {
    assert.deepEqual(parse("OPEN The DOOR").words, [11, 13]);
  });
});

describe("parser state between explicit parses", () => {
  for (const profile of Object.values(PROFILES)) {
    test(`${profile.id}: a prompted parse permits a new match in the same cycle`, () => {
      const source = `
        accept.input();
        if (said("look")) {
          get.string(s1, "Title:", 10, 0, 39);
          parse(s1);
          if (said("open", "door")) { assignn(v100, 1); }
          if (said("open", "door")) { assignn(v101, 1); }
        }
        return;
      `;
      const container = createContainer();
      container.putResource(
        "logic",
        0,
        assembleLogic(source, { dictionary: DICT, profile }).payload,
      );
      let prompts = 0;
      const host = new Host();
      const engine = new Engine(
        container,
        {
          print() {},
          displayAt() {},
          statusLine() {},
          takeInputLine: () => host.takeInputLine(),
          takeKeys: () => host.takeKeys(),
          promptString: () => {
            prompts++;
            return "open door";
          },
        },
        DICT,
        { profile },
      );
      engine.tick();
      host.line = "look";
      engine.tick();
      assert.equal(prompts, 1, "one answer is enough");
      assert.equal(engine.vars[100], 1, "the new parsed input matches immediately");
      assert.equal(engine.vars[101], 0, "the same parsed input cannot match twice");
      assert.deepEqual(engine.parsedWords, [11, 13]);
    });
  }

  for (const answer of ["", "the the", "?!"]) {
    test(`parse clears ready and matched state for ${JSON.stringify(answer)}`, () => {
      const source = `
        set.string(s1, "open door");
        parse(s1);
        if (said("open", "door")) {
          set.string(s1, "${answer}");
          parse(s1);
          if (isset(f2)) { assignn(v100, 1); }
          if (isset(f4)) { assignn(v101, 1); }
        }
        return;
      `;
      const engine = run(source, new Host());
      assert.equal(engine.vars[100], 0, "empty input is not ready");
      assert.equal(engine.vars[101], 0, "the previous input's match is cleared");
      assert.deepEqual(engine.parsedWords, []);
      assert.deepEqual(engine.parsedWordTexts, []);
    });
  }
});

/**
 * have.key (condition 0x0d): bytecode busy-loops on it inside one logic
 * invocation. A host that offers a blocking key wait must be used for that
 * loop in graphics mode too — the worker cannot receive key messages while
 * the interpreter spins — but a script that polls have.key once per cycle
 * must NOT block, or the game would freeze waiting for a keypress.
 */
const BUSY = `
  assignn(v100, 0);
wait:
  addn(v100, 1);
  if (!have.key()) { goto wait; }
  assignv(v101, v19);
  return;
`;

class WaitHost extends Host {
  waits = 0;
  key = 0x41;
  waitKey(): number {
    this.waits++;
    return this.key;
  }
}

function run(source: string, host: Host): Engine {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(source, { dictionary: DICT }).payload);
  const engine = new Engine(container, host, DICT);
  engine.tick();
  return engine;
}

describe("have.key blocking wait", () => {
  test("a busy loop in graphics mode uses the host's blocking wait", () => {
    const host = new WaitHost();
    const engine = run(BUSY, host);
    assert.equal(engine.textModeActive, false);
    assert.equal(engine.vars[101], 0x41, "the blocking wait supplied the key");
    assert.equal(host.waits, 1);
    // 16 non-blocking polls identify the loop, the 17th blocks: v100 = 17.
    assert.equal(engine.vars[100], 17);
  });

  test("a busy loop in text mode proves itself the same way", () => {
    const host = new WaitHost();
    const engine = run(`text.screen();\n${BUSY}`, host);
    assert.equal(engine.textModeActive, true);
    assert.equal(engine.vars[101], 0x41);
    assert.equal(host.waits, 1);
    assert.equal(engine.vars[100], 17);
  });

  test("a once-per-cycle poll never blocks, on a text screen either", () => {
    class StrictHost extends Host {
      waitKey(): number {
        throw new Error("have.key must not block a once-per-cycle poll");
      }
    }
    const engine = run("if (have.key()) { assignn(v102, 1); }\nreturn;\n", new StrictHost());
    assert.equal(engine.vars[102], 0);
    // The Space Quest intro shows its captions on a text screen and polls
    // have.key once per cycle so a key can skip them; blocking there froze it.
    const text = run(
      'text.screen(); display(4, 0, "caption"); if (have.key()) { assignn(v102, 1); }\nreturn;\n',
      new StrictHost(),
    );
    assert.equal(text.textModeActive, true);
    assert.equal(text.vars[102], 0);
  });

  test("a key already buffered ends the loop without blocking", () => {
    const host = new WaitHost();
    host.keys.push(0x20);
    const engine = run(BUSY, host);
    assert.equal(engine.vars[101], 0x20);
    assert.equal(host.waits, 0);
    assert.equal(engine.vars[100], 1);
  });
});
