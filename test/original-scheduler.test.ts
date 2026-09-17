import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine } from "../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";

function engine(source: string, profile: ProfileId): Engine {
  const container = createContainer();
  container.putResource("picture", 0, Uint8Array.of(255));
  container.putResource(
    "logic",
    0,
    assembleLogic("load.pic(v0);draw.pic(v0);show.pic();" + source, {
      profile: PROFILES[profile],
      dictionary: new Map(),
    }).payload,
  );
  return new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeKeys: () => [],
      takeInputLine: () => null,
    },
    undefined,
    { profile },
  );
}

// Independently controlled original timer/print execution, not self-replay:
// docs/fidelity.md: original-scheduler-and-modal-timing.
// Host milliseconds normalize twenty original timer services to one second.
for (const profile of ["2.936", "3.002.102"] as const) {
  test(`${profile}: print blocks script execution while timer services continue`, () => {
    const e = engine('print("Wait.");assignv(v100,v11);return;', profile);
    e.tick();
    e.advanceClock(1000);
    assert.equal(e.vars[11], 1);
    assert.equal(e.vars[100], 0);
    assert.equal(e.modalKind, "print");
    e.ackPrint();
    e.tick();
    assert.equal(e.vars[100], 1, "the resumed script observes elapsed timer time");
  });

  test(`${profile}: pause alone freezes fractional script time across a retained boundary`, () => {
    const e = engine("pause();assignv(v100,v11);return;", profile);
    e.advanceClock(750);
    e.tick();
    const state = e.captureReplayState();
    e.restoreReplayState(state);
    e.advanceClock(1000);
    assert.equal(e.vars[11], 0);
    e.ackPrint();
    e.tick();
    e.advanceClock(250);
    assert.equal(e.vars[11], 1);
  });
}

test("a menu suspends script passes while independently serviced time keeps advancing", () => {
  const e = engine(
    `
    if(!isset(f200)){
      set(f200);set(f14);set.menu("Game");set.menu.item("Continue",1);submit.menu();menu.input();
    }
    increment(v100);return;
  `,
    "2.936",
  );
  e.tick();
  e.tick();
  assert.equal(e.modalKind, "menu");
  e.advanceClock(1000);
  assert.equal(e.vars[11], 1);
  assert.equal(e.vars[100], 1);
});

test("timer rollover normalizes script-written minutes and hours independently", () => {
  const e = engine("return;", "2.936");
  for (const [initial, expected] of [
    [
      [80, 80, 30, 7],
      [0, 0, 0, 8],
    ],
    [
      [255, 90, 30, 255],
      [0, 0, 0, 0],
    ],
    [
      [0, 60, 0, 0],
      [1, 0, 1, 0],
    ],
  ]) {
    e.vars.set(initial!, 11);
    e.advanceClock(1000);
    assert.deepEqual(Array.from(e.vars.slice(11, 15)), expected);
  }
});

test("interactive inventory preserves timer service while awaiting a selection", () => {
  const e = engine("set(f13);status();increment(v100);return;", "2.936");
  e.tick();
  assert.equal(e.modalKind, "inventory");
  e.advanceClock(1000);
  assert.equal(e.vars[11], 1);
  assert.equal(e.vars[100], 0);
});

test("the priority inspection wait keeps timer services running", () => {
  const e = engine("show.pri.screen();increment(v100);return;", "2.936");
  e.tick();
  assert.equal(e.modalKind, "showPri");
  e.advanceClock(1000);
  assert.equal(e.vars[11], 1);
  assert.equal(e.vars[100], 0);
});
