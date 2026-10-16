import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";

// docs/fidelity.md "Original shake.screen and picture reveal": the action blocks the interpreter
// while timer services run, and each platform shows its own displacement or
// colour pattern. Expectations are computed by hand from the per-platform
// step tables.

function engine(
  source: string,
  profile: ProfileId,
  host: Partial<EngineHost> = {},
): { e: Engine; keys: number[] } {
  const keys: number[] = [];
  const container = createContainer();
  container.putResource("picture", 0, Uint8Array.of(0xff));
  container.putResource(
    "logic",
    0,
    assembleLogic(
      "if(!isset(f200)){set(f200);load.pic(v0);draw.pic(v0);show.pic();" + source + "}return;",
      { profile: PROFILES[profile], dictionary: new Map() },
    ).payload,
  );
  const e = new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeKeys: () => keys.splice(0),
      takeInputLine: () => null,
      ...host,
    },
    undefined,
    { profile },
  );
  return { e, keys };
}

const offset = (e: Engine) => {
  const f = e.shakeFrame;
  return f === null ? null : [f.dx, f.dy];
};

test("PC EGA: shake.screen(1) alternates the 8 px right, 4 line down page for 32 retraces", () => {
  const { e } = engine("shake.screen(1);increment(v100);", "2.936");
  e.tick();
  assert.equal(e.modalKind, "shake");
  assert.equal(e.vars[100], 0, "the rest of the pass waits");
  assert.deepEqual(offset(e), [8, 4]);
  e.advanceClock(66);
  assert.deepEqual(offset(e), [8, 4], "4 retraces = 66.67 ms on page 1");
  e.advanceClock(1);
  assert.deepEqual(offset(e), [0, 0], "then page 0");
  e.advanceClock(400);
  assert.equal(e.modalKind, "shake", "467 ms is short of 8 steps (533.3 ms)");
  e.advanceClock(67);
  assert.equal(e.modalKind, null);
  assert.equal(e.shakeFrame, null);
  e.tick();
  assert.equal(e.vars[100], 1, "the pass resumes after the shake");
});

test("2.001: four diagonal copies per unit, one BIOS tick each", () => {
  const { e } = engine("shake.screen(1);", "2.001");
  e.tick();
  const tick = e.timing.timerIncrementMs;
  const seen = [offset(e)];
  for (let i = 0; i < 3; i++) {
    e.advanceClock(tick);
    seen.push(offset(e));
  }
  assert.deepEqual(seen, [
    [8, 4],
    [-8, -4],
    [-8, 4],
    [8, -4],
  ]);
  e.advanceClock(tick);
  assert.equal(e.modalKind, null);
});

test("Amiga: five ViewPort offsets of ten pixels and lines, one timer tick each", () => {
  const { e } = engine("shake.screen(2);", "amiga-2.202");
  e.tick();
  const seen = [offset(e)];
  for (let i = 0; i < 9; i++) {
    e.advanceClock(50);
    seen.push(offset(e));
  }
  assert.deepEqual(seen, [
    [10, 10],
    [-10, 10],
    [10, -10],
    [-10, -10],
    [0, 0],
    [10, 10],
    [-10, 10],
    [10, -10],
    [-10, -10],
    [0, 0],
  ]);
  e.advanceClock(50);
  assert.equal(e.modalKind, null, "2 units = 10 ticks = 500 ms");
});

test("a step ends at the next timer tick, so a mid-tick start shortens the first step", () => {
  const { e } = engine("shake.screen(1);", "amiga-2.202");
  e.advanceClock(30);
  e.tick();
  e.advanceClock(19);
  assert.deepEqual(offset(e), [10, 10]);
  e.advanceClock(1);
  assert.deepEqual(offset(e), [-10, 10], "the tick at 50 ms ends the first step");
});

test("IIgs: each tick draws sixteen RNG colours, 80 draws per unit, then later random() continues", () => {
  let draws = 0;
  const { e } = engine("shake.screen(1);random(0,255,v50);", "iigs-1.014", {
    randomByte: () => draws++ & 0xff,
  });
  e.tick();
  assert.deepEqual(offset(e), [0, 0]);
  assert.deepEqual(
    e.shakeFrame!.palette,
    Array.from({ length: 16 }, (_, i) => (i * 17) & 0xfff),
  );
  for (let i = 0; i < 4; i++) e.advanceClock(50);
  assert.deepEqual(e.shakeFrame!.palette!.slice(0, 2), [(64 * 17) & 0xfff, (65 * 17) & 0xfff]);
  e.advanceClock(50);
  assert.equal(e.modalKind, null);
  assert.equal(draws, 80);
  e.tick();
  assert.equal(e.vars[50], 80, "the next random() reads the 81st byte");
});

test("keys typed during a shake wait for the next pass, and timers keep running", () => {
  const { e, keys } = engine("shake.screen(4);", "2.936");
  e.tick();
  keys.push(0x0d);
  e.tick();
  assert.deepEqual(keys, [0x0d], "the shake reads no input");
  e.advanceClock(1000);
  assert.equal(e.vars[11], 1, "the clock ran through the shake");
  assert.equal(e.modalKind, "shake", "4 units = 32 steps = 2133 ms");
  e.advanceClock(1134);
  assert.equal(e.modalKind, null);
  e.tick();
  assert.deepEqual(keys, [0x0d], "the resumed pass finishes without input");
  e.tick();
  assert.deepEqual(keys, [], "the next cycle's input phase reads the waiting key");
});

test("shake.screen(0) does nothing (the original loops 65,536 units)", () => {
  const { e } = engine("shake.screen(0);increment(v100);", "2.936");
  e.tick();
  assert.equal(e.modalKind, null);
  assert.equal(e.vars[100], 1);
});

test("a shake in progress survives a replay-state round trip", () => {
  const { e } = engine("shake.screen(1);increment(v100);", "amiga-2.202");
  e.tick();
  e.advanceClock(100);
  const image = e.recordingImage()!;
  const state = JSON.parse(JSON.stringify(e.captureReplayState()));
  const { e: restored } = engine("shake.screen(1);increment(v100);", "amiga-2.202");
  restored.restoreImage(image);
  restored.restoreReplayState(state);
  assert.deepEqual(offset(restored), [10, -10]);
  restored.advanceClock(100);
  assert.deepEqual(offset(restored), [0, 0], "200 ms: the fifth step");
  restored.advanceClock(50);
  assert.equal(restored.modalKind, null, "5 ticks = 250 ms");
  restored.tick();
  assert.equal(restored.vars[100], 1);
});
