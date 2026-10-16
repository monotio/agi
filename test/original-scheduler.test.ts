import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { CycleClock } from "../src/runtime/cycleClock.ts";
import { Engine } from "../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";

// overlay.pic shows the empty picture at once on every profile; after draw.pic
// the Amiga and IIgs would hold each pass for their dissolve (test/dissolve.test.ts).
function engine(source: string, profile: ProfileId): Engine {
  const container = createContainer();
  container.putResource("picture", 0, Uint8Array.of(255));
  container.putResource(
    "logic",
    0,
    assembleLogic("load.pic(v0);overlay.pic(v0);show.pic();" + source, {
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
// docs/fidelity.md: original-scheduler-and-modal-timing, F-timing-03, F-SOUND-01.
// Host milliseconds normalize twenty original timer services to one second on
// 2.089..3.002.149, Amiga (NTSC), and IIgs 1.014, and 18.2 INT 1Ch services per
// second on PC booter 2.001.
for (const profile of [
  "2.089",
  "2.230",
  "2.272",
  "2.411",
  "2.440",
  "2.917",
  "2.936",
  "3.002.086",
  "3.002.102",
  "3.002.149",
  "amiga-2.082",
  "amiga-2.176",
  "amiga-2.202",
  "amiga-2.310",
  "amiga-2.316",
  "amiga-2.333",
  "iigs-1.014",
] as const) {
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

// docs/fidelity.md "PC booter clock": 2.001 keeps the BIOS PIT rate, counts
// unpaused ticks, and every 18th tick rewrites v11..v14 from the tick count.
const BIOS_TICK_MS = 65_536_000 / 1_193_182;

test("2.001: BIOS ticks drive sound, pacing and the clock at 18.2065 Hz", () => {
  const e = engine("return;", "2.001");
  assert.equal(e.timing.soundHz, 1_193_182 / 65_536);
  assert.equal(e.timing.timerIncrementMs, BIOS_TICK_MS);
});

test("2.001: the clock refreshes from the tick count every 18 ticks and overwrites script writes", () => {
  const e = engine("if(!isset(f200)){set(f200);assignn(v11,50);}return;", "2.001");
  e.tick();
  const ticks = (n: number) => {
    for (let i = 0; i < n; i++) e.advanceClock(BIOS_TICK_MS);
  };
  ticks(17);
  assert.equal(e.vars[11], 50, "no refresh before the 18th tick");
  ticks(1);
  assert.equal(e.vars[11], 0, "tick 18: floor(180 / 182) = 0 replaces the script's 50");
  ticks(18);
  assert.equal(e.vars[11], 1, "tick 36: floor(360 / 182) = 1");
  ticks(1638 - 36);
  assert.deepEqual([e.vars[11], e.vars[12]], [30, 1], "tick 1638: floor(16380 / 182) = 90 s");
  ticks(18);
  assert.deepEqual([e.vars[11], e.vars[12]], [30, 1], "tick 1656: floor(16560 / 182) still 90 s");
  ticks(18);
  assert.deepEqual([e.vars[11], e.vars[12]], [31, 1], "tick 1674: floor(16740 / 182) = 91 s");
});

test("2.001: pause stops the tick count", () => {
  const e = engine("pause();return;", "2.001");
  e.tick();
  assert.equal(e.timerPaused, true);
  for (let i = 0; i < 36; i++) e.advanceClock(BIOS_TICK_MS);
  e.ackPrint();
  for (let i = 0; i < 35; i++) e.advanceClock(BIOS_TICK_MS);
  assert.equal(e.vars[11], 0, "35 unpaused ticks: last refresh at 18 gives 0");
  e.advanceClock(BIOS_TICK_MS);
  assert.equal(e.vars[11], 1, "36 unpaused ticks give 1");
});

test("2.001: the clock phase survives a replay-state round trip", () => {
  const e = engine("return;", "2.001");
  e.tick();
  for (let i = 0; i < 30; i++) e.advanceClock(BIOS_TICK_MS);
  const image = e.recordingImage()!;
  const state = JSON.parse(JSON.stringify(e.captureReplayState()));
  assert.equal(state.booterClockPhase, 12);
  const restored = engine("return;", "2.001");
  restored.restoreImage(image);
  restored.restoreReplayState(state);
  for (let i = 0; i < 5; i++) restored.advanceClock(BIOS_TICK_MS);
  assert.equal(restored.vars[11], 0, "35 ticks: no second refresh yet");
  restored.advanceClock(BIOS_TICK_MS);
  assert.equal(restored.vars[11], 1, "36 ticks: floor(360 / 182) = 1");
});

test("IIgs pacing admits a pass only after v10 + 1 timer increments", () => {
  // docs/fidelity.md "Input and pacing": the IIgs wait loops while v10 >= counter.
  const iigs = engine("assignn(v10,2);return;", "iigs-1.014");
  iigs.tick();
  assert.equal(iigs.pacingDelay, 3);
  const pc = engine("assignn(v10,2);return;", "2.936");
  pc.tick();
  assert.equal(pc.pacingDelay, 2);
  const clock = new CycleClock(0, 50);
  assert.equal(clock.poll(100, iigs.pacingDelay), false, "two increments do not admit");
  assert.equal(clock.poll(150, iigs.pacingDelay), true, "the third does");
});

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
