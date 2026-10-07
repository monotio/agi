import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectLaunches, repairLaunches } from "../src/studio/workspace/launchRecovery.ts";

test("recovery reports forbidden Launch inputs and repairs them without losing world edits", () => {
  const world = {
    rooms: { "1": { title: "Forest", description: "", exits: {} } },
    facts: { key: "found" },
    quests: {},
    launches: {
      "1": {
        entries: [
          {
            id: "bad",
            name: "Key",
            variables: { "0": 1, "2": 3, "30": 7 },
            flags: { "5": true, "40": true },
          },
        ],
      },
    },
  };
  assert.match(inspectLaunches(world).error, /room transition/);
  const repaired = repairLaunches(world);
  assert.equal(inspectLaunches(repaired).error, "");
  assert.deepEqual(repaired.rooms, world.rooms);
  assert.deepEqual(repaired.facts, world.facts);
  assert.deepEqual(repaired.launches?.["1"]?.entries[0]?.variables, { "30": 7 });
  assert.deepEqual(repaired.launches?.["1"]?.entries[0]?.flags, { "40": true });
  assert.equal(world.launches["1"].entries[0]?.variables["0"], 1);
});
