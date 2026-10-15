import assert from "node:assert/strict";
import { test } from "node:test";
import { launchAction } from "../src/shell/launchAction.ts";

const base = { pending: false, launch: "carry", launchName: "Carry over", room: "Meadow" };

test("the action names the room and, past Carry over, the selected Launch", () => {
  assert.deepEqual(launchAction({ ...base, here: true }), {
    icon: "restart",
    text: "Meadow",
    launch: "",
    label: "Restart Meadow",
  });
  assert.deepEqual(launchAction({ ...base, here: false }), {
    icon: "play",
    text: "Meadow",
    launch: "",
    label: "Play Meadow",
  });
  assert.deepEqual(launchAction({ ...base, here: true, launch: "key", launchName: "Has key" }), {
    icon: "restart",
    text: "Meadow",
    launch: "Has key",
    label: "Restart Meadow with the launch Has key",
  });
  assert.equal(
    launchAction({ ...base, here: true, launch: "beginning", launchName: "From the beginning" })
      .label,
    "From the beginning",
  );
});

test("pending changes show the update icon and restart the room", () => {
  assert.deepEqual(launchAction({ ...base, here: false, pending: true }), {
    icon: "update",
    text: "Meadow",
    launch: "",
    label: "Update and restart Meadow",
  });
  assert.deepEqual(
    launchAction({ ...base, here: true, pending: true, launch: "key", launchName: "Has key" }),
    {
      icon: "update",
      text: "Meadow",
      launch: "Has key",
      label: "Update and restart Meadow with the launch Has key",
    },
  );
});

test("From my game returns to the player's own game", () => {
  const mine = { ...base, here: true, launch: "my-game", launchName: "From my game" };
  assert.deepEqual(launchAction(mine), {
    icon: "play",
    text: "My game",
    launch: "",
    label: "Play from my game",
  });
  assert.deepEqual(launchAction({ ...mine, pending: true }), {
    icon: "update",
    text: "My game",
    launch: "",
    label: "Update and return to my game",
  });
});

test("From the beginning names the action without guessing an opening room", () => {
  for (const room of ["Meadow", "Room 0", ""]) {
    const action = launchAction({
      ...base,
      room,
      here: false,
      pending: true,
      launch: "beginning",
      launchName: "From the beginning",
    });
    assert.equal(action.text, "Update and restart · From the beginning");
    assert.equal(action.launch, "");
    assert.equal(action.label, "Update and restart · From the beginning");
  }
});
