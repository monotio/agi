import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/runtime/engine.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { CycleClock } from "../src/runtime/cycleClock.ts";

const host = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeKeys: () => [],
  takeInputLine: () => null,
};

for (const region of ["ntsc", "pal"] as const) {
  test(`Amiga ${region}: 3 frames per pacing increment and 60 frames per game second`, () => {
    const engine = new Engine(createContainer(), host, undefined, {
      profile: "amiga-2.310",
      amigaRegion: region,
    });
    const hz = region === "pal" ? 50 : 60;
    const cycle = new CycleClock(0, engine.timing.timerIncrementMs);
    let callbacks = 0;
    for (let frame = 1; frame <= 59; frame++) {
      const now = (frame * 1000) / hz;
      if (cycle.poll(now, 1)) callbacks++;
      engine.advanceClock(1000 / hz);
    }
    assert.equal(callbacks, 19);
    assert.equal(engine.vars[11], 0);
    engine.advanceClock(1000 / hz);
    assert.equal(engine.vars[11], 1);
    assert.equal(cycle.poll((60 * 1000) / hz, 1), true);
  });
}

test("PAL preference leaves PC and IIgs timing at 60 Hz", () => {
  for (const profile of ["2.936", "iigs-1.014"] as const) {
    const engine = new Engine(createContainer(), host, undefined, { profile, amigaRegion: "pal" });
    assert.equal(engine.timing.soundHz, 60);
    engine.advanceClock(1000);
    assert.equal(engine.vars[11], 1);
  }
});

test("PAL timed print uses half of a 1.2-second game second", () => {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic('assignn(v21,1);print("Wait.");increment(v200);return;', {
      dictionary: new Map(),
    }).payload,
  );
  const engine = new Engine(container, host, undefined, {
    profile: "amiga-2.310",
    amigaRegion: "pal",
  });
  engine.tick();
  engine.advanceClock(500);
  engine.tick();
  assert.equal(engine.modalKind, "print");
  assert.equal(engine.vars[200], 0);
  engine.advanceClock(100);
  engine.tick();
  assert.equal(engine.modalKind, null);
  assert.equal(engine.vars[200], 1);
});
