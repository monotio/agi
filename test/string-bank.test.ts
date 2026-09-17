import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES, type AgiProfile } from "../src/runtime/profile.ts";
import { decodeSave, encodeSave } from "../src/runtime/persistence.ts";

/**
 * The reserved string bank (docs/fidelity.md, "Original string slot
 * addressing"): only parse() checks its slot against twelve. Every other
 * string operand addresses slot × 40 from the table base, so s12..s23 are the
 * twelve reserved records that follow the table. LSL1's pay phone stores an
 * alternative spelling in s12 and compares the typed number against it.
 */

const DICT = new Map([
  ["open", 11],
  ["door", 13],
]);

class Host implements EngineHost {
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return [];
  }
}

function run(source: string, profile: AgiProfile): Engine {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(source, { dictionary: DICT }).payload);
  const engine = new Engine(container, new Host(), DICT, { profile });
  engine.tick();
  return engine;
}

const SOURCE = `
  set.string(s1, "555-6969");
  set.string(s12, "5556969");
  if (compare.strings(s1, s12)) { assignn(v100, 1); }
  set.string(s23, "open door");
  if (compare.strings(s23, s12)) { assignn(v101, 1); }
  parse(s23);
  if (isset(f2)) { assignn(v102, 1); }
  set.string(s24, "beyond the bank");
  if (compare.strings(s24, s12)) { assignn(v103, 1); }
  return;
`;

for (const id of ["2.440", "2.936"] as const) {
  test(`${id}: s12..s23 are storage, parse still stops at twelve`, () => {
    const engine = run(SOURCE, PROFILES[id]);
    assert.equal(engine.vars[100], 1, "s12 holds the alternative and compares equal");
    assert.equal(engine.vars[101], 0, "different reserved records compare unequal");
    assert.equal(engine.vars[102], 0, "parse ignores slot 23");
    assert.equal(engine.vars[103], 0, "slot 24 is outside the modelled bank and reads empty");
  });
}

test("3.002.149 has no reserved bank: s12 stays outside the table", () => {
  const engine = run(SOURCE, PROFILES["3.002.149"]);
  assert.equal(engine.vars[100], 0, "the write is ignored and the comparison reads empty");
});

test("reserved records written by a script travel in the save image", () => {
  const profile = PROFILES["2.440"];
  const engine = run(SOURCE, profile);
  const state = decodeSave(engine.serialize(), profile);
  assert.equal(state.strings[12], "5556969");
  const decoded = decodeSave(encodeSave(state, profile), profile);
  assert.equal(decoded.strings[12], "5556969");
  assert.equal(decoded.strings[23], "open door");
});
