import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { detectProfile } from "../src/runtime/profile.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Optional KQ4 (AGI 3.002.086) opening and animation regressions.
 * These scenarios load only the resources needed for their tested rooms.
 */
const TARGET_HASH = KNOWN_GAME_HASH.KQ4;
const skip = fixtureSkip(TARGET_HASH, ["AGIDATA.OVL"], { checkVolumes: false });

function bootKq4() {
  const { container, dict, files } = loadGame(TARGET_HASH, {
    interpreterFiles: true,
    checkVolumes: false,
  });
  const profile = detectProfile(files);
  assert.equal(profile.id, "3.002.086", "AGIDATA.OVL selects the KQ4 profile");
  const keys: number[] = [];
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeKeys: () => keys.splice(0),
    takeInputLine: () => null,
    randomWord: () => 66,
  };
  const engine = new Engine(container, host, dict, { profile });
  return { engine, keys };
}

/** One 50ms interpreter cycle with the sound sequencer. */
function step(engine: Engine): void {
  engine.advanceClock(50);
  engine.soundTick();
  engine.tick();
}

function run(engine: Engine, cycles: number): void {
  for (let i = 0; i < cycles; i++) step(engine);
}

/** Alt+D, Enter, Enter, "marble", Enter, Enter: the copy-protection bypass. */
function passCopyProtection(engine: Engine, keys: number[]): void {
  for (let i = 0; i < 300 && !engine.textRow(6).includes("legal"); i++) step(engine);
  assert.ok(engine.textRow(6).includes("legal"), "the manual question is up");
  keys.push(0x2000);
  run(engine, 10);
  keys.push(0x000d);
  run(engine, 10);
  keys.push(0x000d);
  run(engine, 10);
  for (const ch of "marble") {
    keys.push(ch.charCodeAt(0));
    run(engine, 2);
  }
  keys.push(0x000d);
  run(engine, 10);
  keys.push(0x000d);
  run(engine, 10);
}

test(
  "KQ4: the marble debug bypass clears the copy protection and the keyless intro reaches interactive play",
  { skip },
  () => {
    const { engine, keys } = bootKq4();
    passCopyProtection(engine, keys);
    assert.equal(engine.vars[0] !== 143, true, "left the copy-protection room");

    // The intro is keyless: any key aborts it. If a print blocked on an
    // acknowledgement the run would stall, so reaching interactive play
    // without pressing anything proves the intro's windows stay non-blocking.
    const rooms = new Set<number>();
    let lastWindow = "";
    let cycles = 0;
    for (; cycles < 60000 && !engine.inputEnabled; cycles++) {
      step(engine);
      assert.equal(
        engine.modalKind,
        null,
        `intro stalled on a blocking window in room ${engine.vars[0]}`,
      );
      rooms.add(engine.vars[0]!);
      if (engine.textRow(17).includes("Well, you're on your own,"))
        lastWindow = engine.textRow(17) + engine.textRow(18);
    }
    assert.ok(engine.inputEnabled, "the intro ends in interactive play");
    assert.equal(engine.vars[0], 25, "interactive play starts on the beach");
    assert.ok(rooms.has(120) && rooms.has(130), "the ocean slideshow played");
    assert.match(lastWindow, /Well, you're on your own,\W*Rosella\./);
  },
);

test(
  "KQ4: the intro re-arms f15 for every window and the waves keep cycling underneath",
  { skip },
  () => {
    const { engine, keys } = bootKq4();
    passCopyProtection(engine, keys);

    // Run to the closing window ("Well, you're on your own, Rosella.").
    let found = false;
    for (let cycles = 0; cycles < 60000 && !engine.inputEnabled && !found; cycles++) {
      step(engine);
      if (engine.vars[0] === 128 && engine.textRow(17).includes("Well, you're on your own,"))
        found = true;
    }
    assert.ok(found, "reached the closing window before interactive play");

    // Every intro print arrived through f15 and consumed it (the verified
    // print handlers reset the flag as the non-blocking window opens).
    assert.equal(engine.flags[15], 0, "f15 was consumed by the closing print");

    // The closing window does not suspend the object update: the wave that
    // overlaps its top border keeps cycling, exactly as the shipped 3.002.086
    // main loop behaves (the window-open state gates nothing there).
    const wave = engine.screenObjects.find((o) => o?.active && o.view === 55 && o.y === 122);
    assert.ok(wave, "the cycling wave is drawn at the window's top border");
    const seq = wave.drawSeq;
    const cel = wave.cel;
    run(engine, 12);
    assert.ok(
      wave.drawSeq !== seq || wave.cel !== cel,
      "the wave keeps animating while the window is up",
    );
  },
);
