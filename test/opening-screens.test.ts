import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { CycleClock } from "../src/runtime/cycleClock.ts";
import { detectProfile } from "../src/runtime/profile.ts";
import { fixtureSkip } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Optional fixture tests for title screens and opening input flows.
 * A seeded random source and virtual 60 Hz host clock make each run repeatable.
 * CycleClock applies the script's v10 delay; each stage has a bounded wait.
 * Expected rooms and prompts are asserted in the individual cases below.
 */

/** Repeatable random input (the speedrun harness's LCG), never a chosen result. */
function randomSource(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value >>> 16;
  };
}

const ENTER = 13;

/** Minimal cold-boot driver: 60 Hz host ticks, engine cycles gated by the script cycle delay (v10). */
class Boot {
  readonly engine: Engine;
  readonly prints: string[] = [];
  readonly textPrompts: string[] = [];
  readonly numPrompts: { prompt: string; row: number; room: number; rowText: string }[] = [];
  ticks = 0;
  cycles = 0;
  private readonly keys: number[] = [];
  private readonly clock = new CycleClock(0);

  constructor(slug: string, profileId: string) {
    const { container, dict, files } = loadGame(slug, {
      interpreterFiles: true,
      checkVolumes: false,
    });
    const profile = detectProfile(files);
    assert.equal(
      profile.id,
      profileId,
      `${slug}: the installation selects the interpreter profile`,
    );
    const host: EngineHost = {
      print: (text) => this.prints.push(text),
      displayAt() {},
      statusLine() {},
      takeKeys: () => this.keys.splice(0),
      takeInputLine: () => null,
      promptString: (prompt) => {
        this.textPrompts.push(prompt);
        return "";
      },
      // get.num is a blocking host prompt; 21 keeps the age check on the
      // adult path. What follows (the quiz) is beyond the opening.
      promptNumber: (prompt, row = 23) => {
        this.numPrompts.push({
          prompt,
          row,
          room: this.engine.vars[0]!,
          rowText: this.engine.textRow(row),
        });
        return 21;
      },
      randomWord: randomSource(1),
    };
    this.engine = new Engine(container, host, dict, { profile, instructionBudget: 1_000_000 });
    this.engine.setSoundEnabled(true);
  }

  key(code: number): void {
    this.keys.push(code);
  }

  step(): void {
    this.ticks++;
    this.engine.advanceClock(1000 / 60);
    this.engine.soundTick();
    if (this.engine.modalKind !== null || this.engine.continuationPending) {
      this.engine.tick();
      this.cycles++;
    } else if (this.clock.poll((this.ticks * 1000) / 60, this.engine.vars[10]!)) {
      this.engine.tick();
      this.cycles++;
    }
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }

  /** Step until the predicate holds; the budget is an explicit, observed bound. */
  until(predicate: () => boolean, budget: number, label: string): void {
    for (let i = 0; i < budget; i++) {
      if (predicate()) return;
      this.step();
    }
    assert.ok(predicate(), `${label} within ${budget} ticks`);
  }

  room(): number {
    return this.engine.vars[0]!;
  }
}

function assertNonBlank(engine: Engine, label: string): void {
  const { visual } = engine.getFrame();
  assert.ok(
    visual.some((v) => v !== 0),
    `${label}: the opening screen renders a non-blank frame`,
  );
}

const sq1Skip = fixtureSkip("sq1", ["AGIDATA.OVL"]);
test(
  "sq1: cold boot reaches the Arcada through the title screen and the name prompt",
  { skip: sq1Skip },
  () => {
    const boot = new Boot("sq1", "2.917");
    boot.until(() => boot.room() === 67, 100, "title screen (room 67)");
    boot.run(60); // let the title settle before the any-key press
    boot.key(ENTER);
    boot.until(() => boot.engine.inputEnabled, 600, "first playable room");
    assert.deepEqual(
      boot.textPrompts,
      ["First Name: "],
      "the only opening prompt asks the first name",
    );
    assert.equal(boot.room(), 2, "the opening room");
    assert.ok(boot.engine.textRow(0).includes("Score: 0 of 202"), "the SQ1 status line is up");
    assertNonBlank(boot.engine, "sq1");
  },
);

const kq2Skip = fixtureSkip("kq2", ["AGIDATA.OVL"]);
test(
  "kq2: cold boot reaches the castle exterior through the credits screen",
  { skip: kq2Skip },
  () => {
    const boot = new Boot("kq2", "2.411");
    boot.until(() => boot.room() === 97, 100, "credits screen (room 97)");
    // The credits text fades in on a timer after the room loads.
    boot.until(() => boot.engine.textRow(1).includes("KING'S QUEST ]["), 1200, "the credits title");
    assert.ok(
      boot.engine.textRow(2).includes("ROMANCING THE THRONE"),
      "the credits subtitle is up",
    );
    boot.key(ENTER); // the credits screen waits for any key
    boot.until(() => boot.engine.inputEnabled, 600, "first playable room");
    assert.equal(boot.room(), 1, "the opening room");
    assert.ok(boot.engine.textRow(0).includes("Score: 0 of 185"), "the KQ2 status line is up");
    assertNonBlank(boot.engine, "kq2");
  },
);

const kq3Skip = fixtureSkip("kq3", ["AGIDATA.OVL"]);
test("kq3: cold boot reaches Manannan's house through the title screen", { skip: kq3Skip }, () => {
  const boot = new Boot("kq3", "2.936");
  boot.until(() => boot.room() === 45, 100, "title screen (room 45)");
  // The copyright lines fade in on a timer after the room loads.
  boot.until(
    () => boot.engine.textRow(23).includes("Adventure Game Development System"),
    1200,
    "the title copyright",
  );
  boot.key(ENTER); // the title waits for any key
  boot.until(() => boot.engine.inputEnabled, 600, "first playable room");
  assert.equal(boot.room(), 7, "the opening room");
  assert.ok(boot.engine.textRow(0).includes("Score: 0 of 210"), "the KQ3 status line is up");
  assertNonBlank(boot.engine, "kq3");
});

const pq1Skip = fixtureSkip("pq1", ["AGIDATA.OVL"]);
test("pq1: cold boot reaches the station through the title screen", { skip: pq1Skip }, () => {
  const boot = new Boot("pq1", "2.936");
  boot.until(() => boot.room() === 1, 100, "title screen (room 1)");
  boot.run(60);
  boot.key(ENTER); // the title waits for any key
  boot.until(() => boot.engine.inputEnabled, 600, "first playable room");
  assert.equal(boot.room(), 6, "the opening room");
  assert.ok(boot.engine.textRow(0).includes("Score: 0 of 245"), "the PQ1 status line is up");
  assertNonBlank(boot.engine, "pq1");
});

const lsl1Skip = fixtureSkip("lsl1", ["AGIDATA.OVL"]);
test(
  "lsl1: cold boot reaches the age-check prompt through the title and the content warning",
  { skip: lsl1Skip },
  () => {
    const boot = new Boot("lsl1", "2.440");
    boot.until(() => boot.room() === 1, 100, "title screen (room 1)");
    boot.run(60);
    boot.key(ENTER); // the title waits for any key
    boot.until(() => boot.engine.modalKind === "print", 600, "the content warning window");
    assert.ok(
      boot.prints[0]!.includes("contains some elements of plot"),
      "the content warning text is up",
    );
    boot.run(5);
    boot.key(ENTER); // dismiss the warning
    boot.until(() => boot.numPrompts.length > 0, 600, "the age-check prompt");
    const prompt = boot.numPrompts[0]!;
    assert.equal(prompt.room, 6, "the age check happens in its opening room");
    assert.equal(prompt.prompt, "How old are you?  ");
    assert.ok(prompt.rowText.includes("How old are you?"), "the question is on the input row");
    assertNonBlank(boot.engine, "lsl1");
  },
);

const gr1Skip = fixtureSkip("gr1", ["AGIDATA.OVL"]);
test(
  "gr1: cold boot reaches Jerrod's street through the keyless intro slideshow",
  { skip: gr1Skip },
  () => {
    const boot = new Boot("gr1", "3.002.149");
    // The slideshow (rooms 129, 73, 191, 196, 199, 200) plays on timers alone.
    boot.until(() => boot.engine.inputEnabled, 9000, "first playable room");
    assert.equal(boot.room(), 1, "the opening room");
    assertNonBlank(boot.engine, "gr1");
  },
);

const kq4Skip = fixtureSkip("kq4", ["AGIDATA.OVL"], { checkVolumes: false });
test("kq4: cold boot reaches the copy-protection question", { skip: kq4Skip }, () => {
  const boot = new Boot("kq4", "3.002.086");
  boot.until(() => boot.engine.textRow(6).includes("legal"), 200, "the manual question");
  // The question room and the question itself are random() picks; both pins
  // are the deterministic seed-1 outcome. The picture underneath is solid
  // black, so the exact printed rows are the (only) observable here.
  assert.equal(boot.room(), 141, "the seed-1 question room");
  assert.equal(
    boot.prints[0],
    "In order to verify your legal ownership, please use your King's Quest IV manual to answer the following question:\n\n On page 3, what is the eighth word in the third paragraph?",
    "the seed-1 manual question",
  );
});
