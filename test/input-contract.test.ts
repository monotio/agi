import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";

/**
 * Parser results contract (spec): v9 is written ONLY at the first unknown
 * token (its one-based position); a fully recognised line leaves v9 at 0
 * while the internal parser count gates said(). Authentic logic 0s test
 * `v9 > 0` to print "I don't understand %w".
 */

const DICT = new Map([
  ["look", 100],
  ["room", 101],
  ["the", 0],
]);

class Host implements EngineHost {
  prints: string[] = [];
  line: string | null = null;
  keys: number[] = [];
  print(text: string): void {
    this.prints.push(text);
  }
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

function engineWith(logic0: string, host: Host): Engine {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(logic0, { dictionary: DICT }).payload);
  return new Engine(container, host, DICT);
}

const PARSER_LOGIC = `
  accept.input();
  if (said("look", "room")) { assignn(v100, 1); }
  if (said("look")) { assignn(v100, 2); }
  if (isset(f2) && !isset(f4) && greatern(v9, 0)) { assignn(v100, 3); }
  return;
`;

test("fully recognised line: v9 stays 0, said() matches through the parser count", () => {
  const host = new Host();
  const engine = engineWith(PARSER_LOGIC, host);
  engine.tick(); // accept.input() runs first
  host.line = "look the room";
  engine.tick();
  assert.equal(engine.vars[9], 0, "no unknown token -> v9 untouched");
  assert.equal(engine.parserCount, 2, "two retained identifiers (id-0 'the' occupies no slot)");
  assert.equal(engine.flags[2], 1);
  assert.equal(engine.vars[100], 1, "said(look, room) matched");
  assert.equal(engine.flags[4], 1, "f4 set by the successful match");
});

test("unknown token: v9 and the parser count take its one-based position", () => {
  const host = new Host();
  const engine = engineWith(PARSER_LOGIC, host);
  engine.tick();
  host.line = "look xyzzyplugh";
  engine.tick();
  assert.equal(engine.vars[9], 2, "'xyzzyplugh' is token 2");
  assert.equal(engine.parserCount, 2);
  assert.equal(engine.vars[100], 3, "the v9 > 0 branch ran, said(look) did not match");
  assert.equal(engine.flags[4], 0);

  host.line = "frobnicate";
  engine.tick();
  assert.equal(engine.vars[9], 1);
  assert.equal(engine.vars[100], 3);
});

test("id-0-only line: no f2, parser count 0, said() cannot match", () => {
  const host = new Host();
  const engine = engineWith(PARSER_LOGIC, host);
  engine.tick();
  host.line = "the";
  engine.tick();
  assert.equal(engine.flags[2], 0);
  assert.equal(engine.parserCount, 0);
  assert.equal(engine.vars[9], 0);
  assert.equal(engine.vars[100], 0);
});

/**
 * have.key busy loops (goto back to the test inside one logic invocation,
 * as help screens do in text mode) must terminate with a minimal host: a
 * key from takeKeys() ends the loop, and a host that never delivers one
 * gets a synthesized Enter after a bounded number of polls.
 */
const HELP_LOGIC = `
  text.screen();
  display(0, 0, "Help");
  assignn(v100, 0);
wait:
  addn(v100, 1);
  if (!have.key()) { goto wait; }
  assignv(v101, v19);
  graphics();
  return;
`;

test("have.key busy loop ends on a key polled from the host", () => {
  const host = new Host();
  const engine = engineWith(HELP_LOGIC, host);
  host.keys.push(0x20);
  engine.tick();
  assert.equal(engine.vars[101], 0x20, "the space key ended the loop");
  assert.equal(engine.vars[100], 1);
  assert.equal(engine.textModeActive, false);
});

test("have.key busy loop ends when the host delivers a key after N polls", () => {
  // A headless host that answers empty N times, then Space: the loop keeps
  // polling takeKeys() each iteration and stops the moment a key arrives.
  class LateHost extends Host {
    polls = 0;
    override takeKeys(): number[] {
      return ++this.polls === 7 ? [0x20] : [];
    }
  }
  const host = new LateHost();
  const engine = engineWith(HELP_LOGIC, host);
  engine.tick();
  assert.equal(engine.vars[101], 0x20);
  // tick's input phase polled once, then the loop polled six times.
  assert.equal(engine.vars[100], 6, "loop iterations until the key arrived");
  assert.equal(engine.textModeActive, false);
});

test("have.key busy loop with a keyless host is bounded and receives Enter", () => {
  const host = new Host();
  const engine = engineWith(HELP_LOGIC, host);
  engine.tick();
  assert.equal(engine.vars[101], 0x0d, "synthesized Enter");
  assert.equal(
    engine.vars[100],
    1001 & 0xff,
    "1000 empty polls, then the key (v100 wraps mod 256)",
  );
});
