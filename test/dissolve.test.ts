import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";

// Durations: the Amiga loop's 68000 cycles from the instruction timings
// (2.082 5,084,134; full 5,259,678; two rows skipped 5,215,198) at the rate
// MAME measured for the skipped loop (794.2 ms): 774.241, 800.974 and 794.2
// ms; a PAL CPU (7.09379 against 7.15909 MHz) takes 801.511 ms for the
// skipped loop. The IIgs took 447.9 ms in MAME.
//
// docs/fidelity.md "Original picture dissolve": on the Amiga and the IIgs,
// show.pic after draw.pic copies the picture in two-pixel cells in the order
// of a 14-bit Galois shift register (shift right, eor 0x3500 on carry) from
// state 1, blocking the pass while the clock runs. Cell s is picture row
// s / 80, x 2 * (s % 80). The register's first ten states, by hand:
//   1 -> 0x3500 (13568, past the limit), 0x1a80 (6784), 0x0d40 (3392),
//   0x06a0 (1696), 0x0350 (848), 0x01a8 (424), 0x00d4 (212), 0x006a (106),
//   0x0035 (53), 0x351a (13594, past the limit).
const FIRST_STATES = [6784, 3392, 1696, 848, 424, 212, 106, 53];

/** A picture flood-filled with one colour from the top left. */
const filled = (colour: number) => Uint8Array.of(0xf0, colour, 0xf8, 0, 0, 0xff);

/**
 * v50 = 1 shows picture 1 at once (overlay.pic); v50 = 2 draws picture 2 and
 * shows it; v50 = 3 shows it again without drawing; v50 = 4 restores; v50 =
 * 5 draws picture 1 and shows it. v100 counts the passes
 * that got past show.pic, v101 every logic 0 entry.
 */
function engine(
  profile: ProfileId,
  host: Partial<EngineHost> = {},
  setup = "",
): { e: Engine; keys: number[] } {
  const keys: number[] = [];
  const container = createContainer();
  container.putResource("picture", 1, filled(1));
  container.putResource("picture", 2, filled(2));
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `increment(v101);
       if(!isset(f200)){set(f200);${setup}}
       if(v50==1){v50=0;v0=1;load.pic(v0);overlay.pic(v0);show.pic();}
       if(v50==2){v50=0;v0=2;load.pic(v0);draw.pic(v0);show.pic();increment(v100);}
       if(v50==3){v50=0;show.pic();increment(v100);}
       if(v50==4){v50=0;restore.game();}
       if(v50==5){v50=0;v0=1;load.pic(v0);draw.pic(v0);show.pic();}
       return;`,
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

/** Run one pass with v50 set to `stage`. */
function pass(e: Engine, stage: number): void {
  e.vars[50] = stage;
  e.tick();
}

/** Picture cells (row * 80 + x / 2) showing colour 2, the new picture. */
function newCells(e: Engine): number[] {
  const { visual } = e.getFrame();
  const cells: number[] = [];
  for (let cell = 0; cell < 80 * 168; cell++) {
    const pixel = Math.floor(cell / 80) * 160 + (cell % 80) * 2;
    const a = visual[pixel]!;
    const b = visual[pixel + 1]!;
    assert.equal(a, b, `cell ${cell} changes as one`);
    assert.ok(a === 1 || a === 2, `cell ${cell} shows one of the two pictures`);
    if (a === 2) cells.push(cell);
  }
  return cells;
}

const sorted = (cells: number[]) => [...cells].sort((a, b) => a - b);

test("Amiga 2.202 at picture top 0: two cells first, then the register order over all 168 rows", () => {
  const { e } = engine("amiga-2.202");
  pass(e, 1);
  assert.deepEqual(newCells(e), [], "overlay.pic shows picture 1 at once");
  pass(e, 2);
  assert.equal(e.modalKind, "dissolve");
  assert.equal(e.vars[100], 0, "the pass waits inside show.pic");
  assert.deepEqual(newCells(e), [0, 1], "one byte of each bitplane: cells 0 and 1");
  // 800.97 ms for the 16,383 states: 0.5 ms finishes ten.
  e.advanceClock(0.5);
  assert.deepEqual(newCells(e), sorted([0, 1, ...FIRST_STATES]));
});

test("Amiga 2.202 below picture top 0: rows 0 and 1 change at once and state s is cell s + 160", () => {
  const { e } = engine("amiga-2.202", {}, "configure.screen(1,22,0);");
  pass(e, 1);
  pass(e, 2);
  assert.equal(e.modalKind, "dissolve");
  const rows01 = Array.from({ length: 160 }, (_, cell) => cell);
  assert.deepEqual(newCells(e), [...rows01, 160, 161]);
  // 794.2 ms: 0.5 ms finishes ten states.
  e.advanceClock(0.5);
  assert.deepEqual(
    newCells(e),
    sorted([...rows01, 160, 161, ...FIRST_STATES.map((state) => state + 160)]),
  );
});

test("IIgs: one cell first; cell 1 is state 1, the last", () => {
  const { e } = engine("iigs-1.014");
  pass(e, 1);
  pass(e, 2);
  assert.equal(e.modalKind, "dissolve");
  assert.deepEqual(newCells(e), [0], "one word: cell 0");
  // 447.9 ms: 0.3 ms finishes ten states.
  e.advanceClock(0.3);
  assert.deepEqual(newCells(e), sorted([0, ...FIRST_STATES]));
  // 16,382 states take 447.873 ms.
  e.advanceClock(447.58);
  assert.equal(newCells(e).length, 80 * 168 - 1, "16,382 states: only cell 1 is left");
  assert.equal(newCells(e).includes(1), false);
  e.advanceClock(0.2);
  assert.equal(e.modalKind, null);
  assert.equal(newCells(e).length, 80 * 168);
});

test("the first picture dissolves in from a black screen", () => {
  const { e } = engine("amiga-2.202");
  pass(e, 2);
  e.advanceClock(0.5);
  const { visual } = e.getFrame();
  const shown = sorted([0, 1, ...FIRST_STATES]);
  for (let cell = 0; cell < 80 * 168; cell++) {
    const pixel = Math.floor(cell / 80) * 160 + (cell % 80) * 2;
    assert.equal(visual[pixel], shown.includes(cell) ? 2 : 0, `cell ${cell}`);
  }
});

const durations: [ProfileId, string, number][] = [
  ["amiga-2.082", "", 774.241],
  ["amiga-2.176", "", 800.974],
  ["amiga-2.202", "configure.screen(1,22,0);", 794.2],
  ["amiga-2.310", "configure.screen(1,22,0);", 800.974],
  ["amiga-2.316", "configure.screen(1,22,0);status.line.on();", 794.2],
  ["iigs-1.014", "", 447.9],
];
for (const [profile, setup, ms] of durations) {
  test(`${profile} ${setup || "at picture top 0"}: the dissolve holds the pass for ${ms} ms`, () => {
    const { e } = engine(profile, {}, setup);
    pass(e, 1);
    pass(e, 2);
    e.advanceClock(ms - 0.01);
    assert.equal(e.modalKind, "dissolve");
    e.tick();
    assert.equal(e.vars[100], 0);
    e.advanceClock(0.01);
    assert.equal(e.modalKind, null);
    e.tick();
    assert.equal(e.vars[100], 1, "the pass resumes after show.pic");
  });
}

test("a PAL Amiga's slower CPU takes 801.511 ms", () => {
  const { e } = engine("amiga-2.202", {}, "configure.screen(1,22,0);");
  e.amigaRegion = "pal";
  pass(e, 1);
  pass(e, 2);
  e.advanceClock(801.5);
  assert.equal(e.modalKind, "dissolve");
  e.advanceClock(0.011);
  assert.equal(e.modalKind, null);
});

for (const profile of ["2.936", "2.001", "amiga-2.333"] as ProfileId[]) {
  test(`${profile} shows a drawn picture at once`, () => {
    const { e } = engine(profile);
    pass(e, 1);
    pass(e, 2);
    assert.equal(e.modalKind, null);
    assert.equal(e.vars[100], 1);
    assert.equal(newCells(e).length, 80 * 168);
  });
}

test("show.pic after overlay.pic copies at once; a later show.pic after draw.pic dissolves again", () => {
  const { e } = engine("amiga-2.202");
  pass(e, 2);
  e.advanceClock(801);
  e.tick();
  assert.equal(e.vars[100], 1);
  pass(e, 1);
  assert.equal(e.modalKind, null, "overlay.pic set the mode flag");
  pass(e, 2);
  assert.equal(e.modalKind, "dissolve", "draw.pic cleared it");
  e.advanceClock(801);
  e.tick();
  pass(e, 3);
  assert.equal(e.modalKind, "dissolve", "the flag stays clear: show.pic dissolves again");
});

test("the dissolve reads no keys, and the clock runs through it", () => {
  const { e, keys } = engine("amiga-2.202");
  pass(e, 1);
  pass(e, 2);
  keys.push(0x0d);
  e.tick();
  assert.deepEqual(keys, [0x0d], "the key waits for the next input phase");
  e.advanceClock(1000);
  assert.equal(e.modalKind, null);
  assert.equal(e.vars[11], 1, "a second passed during and after the dissolve");
});

test("a dissolve in progress survives a replay-state round trip, frame for frame", () => {
  const { e } = engine("amiga-2.202", {}, "configure.screen(1,22,0);");
  pass(e, 1);
  pass(e, 2);
  e.advanceClock(400);
  const image = e.recordingImage()!;
  const state = JSON.parse(JSON.stringify(e.captureReplayState()));
  const { e: restored } = engine("amiga-2.202", {}, "configure.screen(1,22,0);");
  restored.restoreImage(image);
  restored.restoreReplayState(state);
  assert.equal(restored.modalKind, "dissolve");
  assert.deepEqual(restored.getFrame().visual, e.getFrame().visual, "the half-dissolved frame");
  for (const ms of [100, 200, 94.19]) {
    e.advanceClock(ms);
    restored.advanceClock(ms);
    assert.deepEqual(restored.getFrame().visual, e.getFrame().visual);
  }
  assert.equal(restored.modalKind, "dissolve");
  e.advanceClock(0.02);
  restored.advanceClock(0.02);
  assert.equal(restored.modalKind, null);
  e.tick();
  restored.tick();
  assert.equal(restored.vars[100], 1);
  assert.deepEqual(restored.vars, e.vars);
});

test("the show.pic mode flag rides the replay state", () => {
  const { e } = engine("amiga-2.202");
  pass(e, 1);
  const state = e.captureReplayState();
  assert.equal(state.pictureRevealInstant, true);
  const { e: restored } = engine("amiga-2.202");
  restored.restoreImage(e.recordingImage()!);
  restored.restoreReplayState(JSON.parse(JSON.stringify(state)));
  pass(restored, 3);
  assert.equal(restored.modalKind, null, "after overlay.pic, show.pic copies at once");
  const { e: pc } = engine("2.936");
  pass(pc, 1);
  assert.equal("pictureRevealInstant" in pc.captureReplayState(), false, "PC states omit it");
});

test("restore.game dissolves the restored screen before logic 0 runs again", () => {
  let image: Uint8Array | null = null;
  const { e } = engine("amiga-2.202", { restoreGame: () => image });
  pass(e, 1);
  pass(e, 2);
  e.advanceClock(801);
  e.tick();
  image = e.serialize();
  pass(e, 5);
  e.advanceClock(801);
  e.tick();
  assert.deepEqual(newCells(e), [], "picture 1 is on the screen");
  const entries = e.vars[101]!;
  pass(e, 4);
  assert.equal(e.modalKind, "dissolve", "the restored picture dissolves in");
  assert.deepEqual(newCells(e), [0, 1]);
  e.tick();
  assert.equal(e.vars[101], entries - 1, "logic 0 waits (the image holds one entry fewer)");
  e.advanceClock(801);
  assert.equal(e.modalKind, null);
  e.tick();
  assert.equal(e.vars[101], entries, "logic 0 re-entered once the dissolve ended");
  assert.equal(e.flags[12], 0, "the cycle that re-entered cleared f12");
});

test("a host restore shows the image at once", () => {
  const { e } = engine("amiga-2.202");
  pass(e, 2);
  e.advanceClock(801);
  e.tick();
  const { e: other } = engine("amiga-2.202");
  other.restoreImage(e.recordingImage()!);
  assert.equal(other.modalKind, null);
});
