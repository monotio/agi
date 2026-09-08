import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureSkip } from "./fixtures.ts";
import { Speedrun } from "./speedrun/runner.ts";
import { kq2Bridge } from "./speedrun/kq2-opening.ts";

test(
  "KQ2 walkthrough reads the first inscription and returns across the bridge",
  { skip: fixtureSkip("kq2", ["AGIDATA.OVL"]) },
  () => {
    const runs = Array.from({ length: 2 }, () => {
      const run = new Speedrun("kq2", 1);
      assert.equal(run.engine.profile.id, "2.411");
      kq2Bridge(run);
      assert.equal(run.state().room, 48);
      assert.equal(run.state().score, 41);
      assert.equal(run.engine.flags[67], 1, "first inscription read");
      assert.equal(run.engine.flags[119], 0, "no chasm fall");
      for (const num of [52, 55, 59, 68, 69]) {
        assert.ok(
          run.engine.readState().inventory.some((item) => item.num === num && item.room === 255),
          `inventory item ${num} carried`,
        );
      }
      return run;
    });
    assert.deepEqual(runs[0]!.actions, runs[1]!.actions, "identical cold-boot action tapes");
    assert.deepEqual(runs[0]!.state(), runs[1]!.state(), "identical final state");
  },
);
