import { test } from "node:test";
import assert from "node:assert/strict";
import { isStoryDialogue } from "../src/replayRunner.ts";
import type { ReplayObservation } from "../src/replay.ts";

function fakeObservation(
  modalKind: string | null = null,
  blocked: string | null = null,
  rows: string[] = [],
): ReplayObservation {
  return {
    revision: 1,
    tick: 10,
    cycle: 1,
    blocked,
    state: {
      modalKind,
      room: 1,
      previousRoom: 1,
      egoX: 0,
      egoY: 0,
      egoDirection: 0,
      vars: [1, 0, 0, 0],
      flags: [],
      strings: [],
      parsedWords: [],
      parsedWordTexts: [],
      parserCount: 0,
      lastInputLine: "",
      horizon: 36,
      inputEnabled: true,
      pictureShown: true,
      terminated: false,
      inventory: [],
      profile: "2.917",
    },
    rows,
    egoView: 0,
    releaseGate: 0,
  };
}

test("isStoryDialogue identifies narrative modals and waitkey screens", () => {
  assert.equal(isStoryDialogue(null), false);
  assert.equal(isStoryDialogue(fakeObservation(null, null)), false);
  assert.equal(isStoryDialogue(fakeObservation("menu", null)), false);
  assert.equal(isStoryDialogue(fakeObservation("inventory", null)), false);

  assert.equal(isStoryDialogue(fakeObservation("print", null)), true);
  assert.equal(isStoryDialogue(fakeObservation("showObj", null)), true);
  assert.equal(isStoryDialogue(fakeObservation(null, "waitkey")), true);
  assert.equal(isStoryDialogue(fakeObservation(null, "getnum")), false);
});
