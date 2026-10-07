import assert from "node:assert/strict";
import { test } from "node:test";
import { launchAction } from "../src/shell/launchAction.ts";

const base = { pending: false, launch: "carry", launchName: "Carry over", room: "Meadow" };

test("the action names the room and, past Carry over, the selected Launch", () => {
  assert.deepEqual(launchAction({ ...base, here: true }), {
    icon: "restart",
    room: "Meadow",
    launch: "",
    label: "Restart Meadow",
  });
  assert.deepEqual(launchAction({ ...base, here: false }), {
    icon: "play",
    room: "Meadow",
    launch: "",
    label: "Play Meadow",
  });
  assert.deepEqual(launchAction({ ...base, here: true, launch: "key", launchName: "Has key" }), {
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

test("pending changes show the update icon and restart the room", () => {
  assert.deepEqual(launchAction({ ...base, here: false, pending: true }), {
    icon: "update",
    room: "Meadow",
    launch: "",
    label: "Update and restart Meadow",
  });
  assert.deepEqual(
    launchAction({ ...base, here: true, pending: true, launch: "key", launchName: "Has key" }),
    {
      icon: "update",
      room: "Meadow",
      launch: "Has key",
      label: "Update and restart Meadow with the launch Has key",
    },
  );
});

test("From my game returns to the player's own game", () => {
  const mine = { ...base, here: true, launch: "my-game", launchName: "From my game" };
  assert.deepEqual(launchAction(mine), {
    icon: "play",
    room: "My game",
    launch: "",
    label: "Play from my game",
  });
  assert.deepEqual(launchAction({ ...mine, pending: true }), {
    icon: "update",
    room: "My game",
    launch: "",
    label: "Update and return to my game",
  });
});
