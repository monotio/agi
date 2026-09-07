import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { openContainer } from "../src/container/container.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { detectProfile } from "../src/runtime/profile.ts";
import { fixtureDir } from "./fixtures.ts";

/**
 * KQ4 (AGI 3.002.086) regressions, replayed from the installed fixture.
 *
 * The fixture's combined KQ4DIR references KQ4VOL.6/7 through four junk
 * entries (pictures 150/151, views 198/199) that no shipped logic ever loads,
 * so the strict fixtureSkip() volume census does not fit this game; the
 * records below are the files the interpreter actually reads.
 */
const KQ4_FILES = [
  "KQ4DIR",
  "KQ4VOL.0",
  "KQ4VOL.1",
  "KQ4VOL.2",
  "KQ4VOL.3",
  "OBJECT",
  "WORDS.TOK",
  "AGIDATA.OVL",
] as const;
const missing = KQ4_FILES.filter((name) => !existsSync(fixtureDir("kq4") + name));
const skip = missing.length
  ? `Place your own game files in games/kq4/ to run this test (missing: ${missing.join(", ")}).`
  : false;

function bootKq4() {
  const dir = fixtureDir("kq4");
  const files = new Map<string, Uint8Array>();
  for (const name of KQ4_FILES) files.set(name, new Uint8Array(readFileSync(dir + name)));
  const profile = detectProfile(files);
  assert.equal(profile.id, "3.002.086", "AGIDATA.OVL selects the KQ4 profile");
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeKeys: () => keys.splice(0),
    takeInputLine: () => null,
    randomWord: () => 66,
  };
  const keys: number[] = [];
  const engine = new Engine(
    openContainer(files),
    host,
    new Map(parseWordsTok(readFileSync(dir + "WORDS.TOK")).map((e) => [e.word, e.id])),
    { profile },
  );
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

test(
  "KQ4: the marble debug bypass clears the copy protection and the keyless intro reaches interactive play",
  { skip },
  () => {
    const { engine, keys } = bootKq4();
    for (let i = 0; i < 300 && !engine.textRow(6).includes("legal"); i++) step(engine);
    assert.equal(engine.vars[0], 143, "the copy protection is the boot room");
    const protection = Array.from({ length: 25 }, (_, row) => engine.textRow(row)).join(" ");
    assert.ok(protection.includes("verify your legal"), "the manual question is up");

    // The documented bypass: Alt+D opens the debug window, Enter passes its
    // version card and reaches the prompt, "marble" plus Enter skips the
    // protection, and one more Enter passes the KQ IV card.
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
    run(engine, 60);
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

    // Run to the closing window ("Well, you're on your own, Rosella.").
    let cycles = 0;
    for (; cycles < 60000 && !engine.inputEnabled; cycles++) {
      step(engine);
      if (engine.vars[0] === 128 && engine.textRow(17).includes("Well, you're on your own,")) break;
    }
    assert.ok(!engine.inputEnabled, "the closing window shows before interactive play");

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
