import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureSkip } from "./fixtures.ts";
import { Speedrun } from "./speedrun/runner.ts";
import { sq1Boulder } from "./speedrun/sq1-opening.ts";

test(
  "SQ1 walkthrough crushes the spider droid from a cold boot",
  { skip: fixtureSkip("sq1", ["AGIDATA.OVL"]) },
  () => {
    const first = new Speedrun("sq1", 1);
    assert.equal(first.engine.profile.id, "2.917");
    sq1Boulder(first);
    const state = first.state();
    assert.equal(state.room, 19);
    assert.equal(state.score, 42);
    assert.equal(first.engine.flags[165], 1, "boulder dropped on the droid");
    assert.equal(first.engine.flags[161], 1, "droid destroyed");
    assert.equal(first.engine.vars[108], 2, "boulder resting on the droid");
    const carried = first.engine
      .readState()
      .inventory.filter((item) => item.room === 255)
      .map((item) => item.num)
      .sort((a, b) => a - b);
    assert.deepEqual(
      carried,
      [1, 3, 5, 6, 12, 19, 22],
      "cartridge, translator, keycard, glass and kit contents",
    );

    const replay = new Speedrun("sq1", 1);
    sq1Boulder(replay);
    assert.deepEqual(replay.actions, first.actions, "the seed-1 route is reproducible");
  },
);
