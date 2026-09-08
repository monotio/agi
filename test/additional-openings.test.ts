import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureSkip } from "./fixtures.ts";
import {
  ADDITIONAL_OPENINGS,
  additionalOpening,
  ddpOpening,
} from "./speedrun/additional-openings.ts";

for (const game of ADDITIONAL_OPENINGS) {
  test(
    `${game.slug}: opening walkthrough reaches player control and walks east twice`,
    {
      skip: fixtureSkip(game.slug, ["AGIDATA.OVL"]),
    },
    () => {
      const first = additionalOpening(game.slug);
      const second = additionalOpening(game.slug);
      assert.deepEqual(second.actions, first.actions, "cold boots reproduce the same input route");
      assert.deepEqual(second.state(), first.state());
    },
  );
}

test(
  "ddp: DOS opening reaches difficulty selection and accepts movement twice",
  {
    skip: fixtureSkip("ddp", ["AGIDATA.OVL"]),
  },
  () => {
    const first = ddpOpening();
    const second = ddpOpening();
    assert.deepEqual(second.actions, first.actions);
    assert.deepEqual(second.state(), first.state());
  },
);
