import assert from "node:assert/strict";
import { test } from "node:test";
import { launchAction } from "../src/shell/launchAction.ts";

const base = { pending: false, launch: "carry", launchName: "Carry over", room: "Meadow" };

test("the action names the room and, past Carry over, the selected Launch", () => {
  assert.deepEqual(launchAction({ ...base, here: true }), {
    update: false,
    icon: "restart",
    room: "Meadow",
    launch: "",
    label: "Restart Meadow",
  });
  assert.deepEqual(launchAction({ ...base, here: false }), {
    update: false,
    icon: "play",
    room: "Meadow",
    launch: "",
    label: "Play Meadow",
  });
  assert.deepEqual(launchAction({ ...base, here: true, launch: "key", launchName: "Has key" }), {
    update: false,
    icon: "restart",
    room: "Meadow",
    launch: "Has key",
    label: "Restart Meadow with the launch Has key",
  });
  assert.equal(
    launchAction({ ...base, here: true, launch: "beginning", launchName: "From the beginning" })
      .label,
    "Restart Meadow with the launch From the beginning",
  );
});

test("pending changes keep the word Update and restart the room", () => {
  assert.deepEqual(launchAction({ ...base, here: false, pending: true }), {
    update: true,
    icon: "restart",
    room: "Meadow",
    launch: "",
    label: "Update and restart Meadow",
  });
  assert.equal(
    launchAction({ ...base, here: true, pending: true, launch: "key", launchName: "Has key" })
      .label,
    "Update and restart Meadow with the launch Has key",
  );
});

test("From my game returns to the player's own game", () => {
  const mine = { ...base, here: true, launch: "my-game", launchName: "From my game" };
  assert.deepEqual(launchAction(mine), {
    update: false,
    icon: "play",
    room: "My game",
    launch: "",
    label: "Play from my game",
  });
  assert.equal(launchAction({ ...mine, pending: true }).label, "Update and return to my game");
});
