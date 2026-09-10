import { test } from "node:test";
import assert from "node:assert/strict";
import type { Engine } from "../src/runtime/engine.ts";
import { AGI_KEY } from "../src/runtime/keys.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";
import { Speedrun } from "./speedrun/runner.ts";
import { OPENING_ROUTES, opening, openingRoute } from "./speedrun/openings.ts";

/**
 * Optional fixture tests for title screens and opening input flows.
 * The speedrun driver's seeded random source and virtual 60 Hz host clock
 * make each run repeatable; CycleClock applies the script's v10 delay and
 * each stage has a bounded wait. Expected rooms and prompts are asserted in
 * the individual cases below; room and profile expectations come from the
 * shared opening catalog in test/speedrun/openings.ts.
 */

/** Cold boot through the shared driver, asserting the binary-selected profile. */
function coldBoot(hashOrAlias: string, load?: { checkVolumes?: boolean }): Speedrun {
  const run = new Speedrun(hashOrAlias, 1, load);
  assert.ok(
    opening(hashOrAlias).profiles.includes(run.engine.profile.id),
    `${hashOrAlias}: the installation selects the interpreter profile`,
  );
  return run;
}

function assertNonBlank(engine: Engine, label: string): void {
  const { visual } = engine.getFrame();
  assert.ok(
    visual.some((v) => v !== 0),
    `${label}: the opening screen renders a non-blank frame`,
  );
}

test(
  "sq1: cold boot reaches the Arcada through the title screen and the name prompt",
  { skip: fixtureSkip(KNOWN_GAME_HASH.SQ1, ["AGIDATA.OVL"]) },
  () => {
    const run = coldBoot(KNOWN_GAME_HASH.SQ1);
    run.answer(""); // the boot name prompt accepts an empty first name
    run.until(() => run.state().room === 67, 100, "title screen (room 67)");
    run.advance(60); // let the title settle before the any-key press
    run.key(AGI_KEY.ENTER);
    run.until(() => run.engine.inputEnabled, 600, "first playable room");
    assert.deepEqual(
      run.textPrompts,
      ["First Name: "],
      "the only opening prompt asks the first name",
    );
    assert.equal(run.state().room, 2, "the opening room");
    assert.ok(run.engine.textRow(0).includes("Score: 0 of 202"), "the SQ1 status line is up");
    assertNonBlank(run.engine, "sq1");
  },
);

test(
  "kq2: cold boot reaches the castle exterior through the credits screen",
  { skip: fixtureSkip(KNOWN_GAME_HASH.KQ2, ["AGIDATA.OVL"]) },
  () => {
    const run = coldBoot(KNOWN_GAME_HASH.KQ2);
    run.until(() => run.state().room === 97, 100, "credits screen (room 97)");
    // The credits text fades in on a timer after the room loads.
    run.until(() => run.engine.textRow(1).includes("KING'S QUEST ]["), 1200, "the credits title");
    assert.ok(run.engine.textRow(2).includes("ROMANCING THE THRONE"), "the credits subtitle is up");
    run.key(AGI_KEY.ENTER); // the credits screen waits for any key
    run.until(() => run.engine.inputEnabled, 600, "first playable room");
    assert.equal(run.state().room, 1, "the opening room");
    assert.ok(run.engine.textRow(0).includes("Score: 0 of 185"), "the KQ2 status line is up");
    assertNonBlank(run.engine, "kq2");
  },
);

test(
  "kq3: cold boot reaches Manannan's house through the title screen",
  { skip: fixtureSkip(KNOWN_GAME_HASH.KQ3, ["AGIDATA.OVL"]) },
  () => {
    const run = coldBoot(KNOWN_GAME_HASH.KQ3);
    run.until(() => run.state().room === 45, 100, "title screen (room 45)");
    // The copyright lines fade in on a timer after the room loads.
    run.until(
      () => run.engine.textRow(23).includes("Adventure Game Development System"),
      1200,
      "the title copyright",
    );
    run.key(AGI_KEY.ENTER); // the title waits for any key
    run.until(() => run.engine.inputEnabled, 600, "first playable room");
    assert.equal(run.state().room, 7, "the opening room");
    assert.ok(run.engine.textRow(0).includes("Score: 0 of 210"), "the KQ3 status line is up");
    assertNonBlank(run.engine, "kq3");
  },
);

test(
  "pq1: cold boot reaches the station through the title screen",
  { skip: fixtureSkip(KNOWN_GAME_HASH.PQ1, ["AGIDATA.OVL"]) },
  () => {
    const run = coldBoot(KNOWN_GAME_HASH.PQ1);
    run.until(() => run.state().room === 1, 100, "title screen (room 1)");
    run.advance(60);
    run.key(AGI_KEY.ENTER); // the title waits for any key
    run.until(() => run.engine.inputEnabled, 600, "first playable room");
    assert.equal(run.state().room, 6, "the opening room");
    assert.ok(run.engine.textRow(0).includes("Score: 0 of 245"), "the PQ1 status line is up");
    assertNonBlank(run.engine, "pq1");
  },
);

test(
  "lsl1: cold boot reaches the age-check prompt through the title and the content warning",
  { skip: fixtureSkip(KNOWN_GAME_HASH.LSL1, ["AGIDATA.OVL"]) },
  () => {
    const run = coldBoot(KNOWN_GAME_HASH.LSL1);
    // 21 keeps the age check on the adult path. What follows (the quiz) is
    // beyond the opening.
    run.answerNumber(21);
    run.until(() => run.state().room === 1, 100, "title screen (room 1)");
    run.advance(60);
    run.key(AGI_KEY.ENTER); // the title waits for any key
    run.until(() => run.engine.modalKind === "print", 600, "the content warning window");
    assert.ok(
      run.messages[0]!.includes("contains some elements of plot"),
      "the content warning text is up",
    );
    run.advance(5);
    run.key(AGI_KEY.ENTER); // dismiss the warning
    run.until(() => run.numPrompts.length > 0, 600, "the age-check prompt");
    const prompt = run.numPrompts[0]!;
    assert.equal(prompt.room, 6, "the age check happens in its opening room");
    assert.equal(prompt.prompt, "How old are you?  ");
    assert.deepEqual(
      run.actions.filter((action) => action.kind === "answer"),
      [{ kind: "answer", text: "21" }],
      "the age answer is preserved for browser replay",
    );
    assert.ok(prompt.rowText.includes("How old are you?"), "the question is on the input row");
    assertNonBlank(run.engine, "lsl1");
  },
);

test(
  "gr1: cold boot reaches Jerrod's street through the keyless intro slideshow",
  { skip: fixtureSkip(KNOWN_GAME_HASH.GR1, ["AGIDATA.OVL"]) },
  () => {
    const run = coldBoot(KNOWN_GAME_HASH.GR1);
    // The slideshow (rooms 129, 73, 191, 196, 199, 200) plays on timers alone.
    run.until(() => run.engine.inputEnabled, 9000, "first playable room");
    assert.equal(run.state().room, 1, "the opening room");
    assertNonBlank(run.engine, "gr1");
  },
);

test(
  "kq4: cold boot reaches the copy-protection question",
  { skip: fixtureSkip(KNOWN_GAME_HASH.KQ4, ["AGIDATA.OVL"], { checkVolumes: false }) },
  () => {
    const run = coldBoot(KNOWN_GAME_HASH.KQ4, { checkVolumes: false });
    run.until(() => run.engine.textRow(6).includes("legal"), 200, "the manual question");
    // The question room and the question itself are random() picks; both pins
    // are the deterministic seed-1 outcome. The picture underneath is solid
    // black, so the exact printed rows are the (only) observable here.
    assert.equal(run.state().room, 141, "the seed-1 question room");
    assert.equal(
      run.messages[0],
      "In order to verify your legal ownership, please use your King's Quest IV manual to answer the following question:\n\n On page 3, what is the eighth word in the third paragraph?",
      "the seed-1 manual question",
    );
  },
);

for (const { gameId, hash } of OPENING_ROUTES) {
  test(
    `${gameId}: opening walkthrough reaches player control and moves twice`,
    {
      skip: fixtureSkip(hash, ["AGIDATA.OVL"]),
    },
    () => {
      const first = openingRoute(hash);
      const second = openingRoute(hash);
      assert.deepEqual(second.actions, first.actions, "cold boots reproduce the same input route");
      assert.deepEqual(second.state(), first.state());
    },
  );
}
