import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";
import { Speedrun, randomSource } from "./speedrun/runner.ts";

const TARGET_HASH = KNOWN_GAME_HASH.KQ1;

test("speedrun randomness has a stable seed contract", () => {
  const next = randomSource(1);
  assert.deepEqual(Array.from({ length: 4 }, next), [15496, 24200, 33046, 46195]);
});

test(
  "KQ1 speedrun builds death diagnostics only when Graham dies",
  { skip: fixtureSkip(TARGET_HASH, ["AGIDATA.OVL"]) },
  (t) => {
    const run = new Speedrun();
    const state = t.mock.method(run, "state");
    run.advance(30);
    assert.equal(state.mock.callCount(), 0, "successful ticks need no diagnostic snapshots");
    run.engine.flags[63] = 1;
    assert.throws(() => run.advance(), /Graham died: .*"room":83/);
    assert.equal(state.mock.callCount(), 1, "a death still includes its diagnostic snapshot");
  },
);

test(
  "KQ1 speedrun cold boots using inputs and rejects a false progress claim",
  {
    skip: fixtureSkip(TARGET_HASH, ["AGIDATA.OVL"]),
  },
  () => {
    const run = new Speedrun();
    run.advance(30);
    assert.equal(run.state().room, 83);
    run.key(13);
    run.advance(30);
    run.dismiss();
    run.checkpoint("Start", { room: 1, score: 0 });
    assert.equal(run.engine.profile.id, "2.917");
    assert.throws(() => run.checkpoint("False victory", { score: 159 }), /False victory/);
    assert.ok(run.ticks >= 60);
    assert.deepEqual(run.actions.slice(0, 3), [
      { kind: "advance", ticks: 30 },
      { kind: "key", code: 13 },
      { kind: "advance", ticks: 30 },
    ]);
  },
);

test(
  "Speedrun rejects ticks beyond its global ceiling",
  { skip: fixtureSkip(TARGET_HASH, ["AGIDATA.OVL"]) },
  () => {
    const run = new Speedrun(TARGET_HASH, 1, { maxTicks: 50 });
    run.advance(30);
    assert.throws(() => run.advance(25), /Speedrun tick ceiling exceeded \(55 > 50\)/);
  },
);

test(
  "Speedrun walkDirection, walkToUntil, and repeatUntil helpers navigate and terminate cleanly",
  { skip: fixtureSkip(TARGET_HASH, ["AGIDATA.OVL"]) },
  () => {
    const run = new Speedrun();
    run.advance(30);
    run.key(13);
    run.advance(30);
    run.dismiss();
    assert.equal(run.state().room, 1);

    // Test repeatUntil
    let count = 0;
    run.repeatUntil(
      () => {
        count++;
      },
      () => count >= 3,
      "test counter",
      10,
    );
    assert.equal(count, 3);

    // Test walkDirection with compass string
    const startX = run.state().x;
    run.walkDirection("E", () => run.state().x > startX + 5, "walk east a bit", 500);
    assert.ok(run.state().x > startX + 5);
    assert.equal(run.engine.screenObjects[0]?.direction, 0, "ego stopped after walkDirection");

    // Test walkToUntil
    const currentY = run.state().y;
    run.walkToUntil(
      run.state().x,
      currentY + 10,
      () => run.state().y >= currentY + 5,
      "walk south until y",
    );
    assert.ok(run.state().y >= currentY + 5);
    assert.equal(run.engine.screenObjects[0]?.direction, 0, "ego stopped after walkToUntil");

    // Test carried and assertCarried
    assert.equal(run.carried(1), false);
    assert.throws(() => run.assertCarried(1, "Test item"), /Test item \(item 1\) must be carried/);
  },
);
