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
// docs/fidelity.md: original-scheduler-and-modal-timing, F-timing-03, F-SOUND-01.
// Host milliseconds normalize twenty original timer services to one second on
// 2.089..3.002.149, Amiga (NTSC), and IIgs 1.014, and 18.2 INT 1Ch services per
// second on PC booter 2.001.
for (const profile of [
  "2.001",
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

test("2.001: INT 1Ch 18.2 Hz timing drives both sound and v10 pacing and gates soundTick on timerPaused", () => {
  // docs/fidelity.md F-timing-03, F-SOUND-01: 2.001 InitTimer (0x4bbc) hooks
  // BIOS INT 1Ch without reprogramming PIT channel 0, so TimerInt (0x73c5) runs
  // at 18.2 Hz (182 ticks per 10 s) and tests DS:0x02e3 (pause == 0 at 0x73cd)
  // before advancing sysTimer, pacingCounter, UpdateClock (0x5626), and the
  // row-sound player (0x746b at 0x7401).
  const container = createContainer();
  container.putResource("picture", 0, Uint8Array.of(255));
  // 2.001 row-sound payload: two rows (0x81 0x01 0x00, 0x9f 0x00).
  container.putResource("sound", 1, Uint8Array.of(0x81, 0x01, 0x00, 0x9f, 0x00));
  container.putResource(
    "logic",
    0,
    assembleLogic(
      "if(!isset(f200)){set(f200);set(f9);load.pic(v0);draw.pic(v0);show.pic();load.sound(1);sound(1,f40);}return;",
      {
        profile: PROFILES["2.001"],
        dictionary: new Map(),
      },
    ).payload,
  );
  const e = new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeKeys: () => [],
      takeInputLine: () => null,
    },
    undefined,
    { profile: "2.001" },
  );
  assert.equal(e.profile.frameTiming, "booter-int1c");
  assert.equal(e.timing.soundHz, 18.2);
  assert.equal(e.timing.timerIncrementMs, 1000 / 18.2);
  assert.equal(e.timing.gameSecondMs, 1000);

  e.tick();
  assert.equal(e.flags[40], 0);
  // 182 ticks at 18.2 Hz = 10.0 seconds.
  for (let i = 0; i < 182; i++) {
    e.advanceClock(1000 / e.timing.soundHz);
  }
  assert.equal(e.vars[11], 10);

  // While timerPaused is active on 2.001, TimerInt (0x73cd) skips the row-sound player (0x7401).
  const pausedContainer = createContainer();
  pausedContainer.putResource("picture", 0, Uint8Array.of(255));
  pausedContainer.putResource("sound", 1, Uint8Array.of(0x81, 0x01, 0x00));
  pausedContainer.putResource(
    "logic",
    0,
    assembleLogic("load.pic(v0);draw.pic(v0);show.pic();pause();return;", {
      profile: PROFILES["2.001"],
      dictionary: new Map(),
    }).payload,
  );
  const pausedEngine = new Engine(
    pausedContainer,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeKeys: () => [],
      takeInputLine: () => null,
    },
    undefined,
    { profile: "2.001" },
  );
  pausedEngine.tick();
  assert.equal(pausedEngine.timerPaused, true);
  // Install a sound playback manually or observe that soundTick is a no-op while timerPaused.
  let observedSoundPhases = 0;
  pausedEngine.setExecutionObserver((obs) => {
    if (obs.cause.type === "phase" && obs.cause.phase === "sound") observedSoundPhases++;
  });
  pausedEngine.soundTick();
  assert.equal(observedSoundPhases, 0);
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
