import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAuthoringState,
  validateAuthoringState,
  resourceRevision,
} from "../src/agent/authoringState.ts";

test("project authoring state validates and detaches named bindings and world facts", () => {
  const state = createAuthoringState();
  state.bindings["door_open"] = { kind: "flag", num: 40 };
  state.world.rooms["1"] = { title: "Hall", description: "A quiet hall.", exits: { east: 2 } };
  state.world.facts["caretaker"] = "Keeps the brass key.";
  state.world.quests["enter_garden"] = {
    description: "Open the garden gate.",
    requires: [],
    completedFlag: "door_open",
  };
  const restored = validateAuthoringState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored, state);
  restored.bindings["door_open"]!.num = 41;
  assert.equal(state.bindings["door_open"]!.num, 40);
  assert.throws(() => validateAuthoringState({ ...state, version: 9 }), /version/);
  assert.throws(
    () => validateAuthoringState({ ...state, bindings: { bad: { kind: "flag", num: 256 } } }),
    /binding/,
  );
  assert.throws(
    () =>
      validateAuthoringState({
        ...state,
        world: {
          ...state.world,
          rooms: { "1": { title: "Bad", description: "", exits: { east: -1 } } },
        },
      }),
    /exit/,
  );
});

test("resource revisions distinguish absent, empty, and byte changes", () => {
  assert.equal(resourceRevision(null), "absent");
  assert.equal(resourceRevision(new Uint8Array()), "0-811c9dc5");
  assert.notEqual(
    resourceRevision(new Uint8Array([1, 2])),
    resourceRevision(new Uint8Array([2, 1])),
  );
  assert.equal(resourceRevision(new Uint8Array([1, 2])), resourceRevision(new Uint8Array([1, 2])));
});
