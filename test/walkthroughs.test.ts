import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureSkip } from "./fixtures.ts";
import { WALKTHROUGHS, runWalkthrough } from "./speedrun/walkthroughs.ts";

for (const route of WALKTHROUGHS) {
  test(
    `${route.slug}: ${route.label} from two cold boots`,
    {
      skip: fixtureSkip(route.slug, ["AGIDATA.OVL"]),
      timeout: 30_000,
    },
    () => {
      const first = runWalkthrough(route);
      const second = runWalkthrough(route);
      assert.deepEqual(second.actions, first.actions, "identical input tapes");
      assert.deepEqual(
        second.engine.readState(),
        first.engine.readState(),
        "identical final state",
      );
      assert.equal(second.ticks, first.ticks, "identical virtual time");
    },
  );
}
