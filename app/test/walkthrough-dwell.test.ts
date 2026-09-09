import { test } from "node:test";
import assert from "node:assert/strict";
import { isStoryDialogue, extractDialogWords, calculateModalDwellMs } from "../src/replayRunner.ts";
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

test("extractDialogWords ignores row 0 status bar and tokenizes dialogue text", () => {
  const rows = [
    " Score: 100   Sound: on  ",
    "                         ",
    "   King Edward looks at  ",
    "   you with weary eyes.  ",
    "                         ",
  ];
  const words = extractDialogWords(rows);
  assert.deepEqual(words, ["King", "Edward", "looks", "at", "you", "with", "weary", "eyes"]);
});

test("calculateModalDwellMs handles speeds, word count scaling, and clamping", () => {
  const shortRows = [" Score: 0   Sound: on ", "   Door opened.       "];
  // Speed <= 0 returns 0 immediately (unthrottled / seeking)
  assert.equal(calculateModalDwellMs(shortRows, 0), 0);
  assert.equal(calculateModalDwellMs(shortRows, -1), 0);

  // Short message (2 words) at 1x speed: 1800 + (2 * 120) = 2040ms
  assert.equal(calculateModalDwellMs(shortRows, 1), 2040);

  // Scaled by 2x speed: 2040 / 2 = 1020ms
  assert.equal(calculateModalDwellMs(shortRows, 2), 1020);

  // Scaled by 4x speed: 2040 / 4 = 510ms
  assert.equal(calculateModalDwellMs(shortRows, 4), 510);

  // Very long message hits 5000ms maximum cap at 1x speed:
  const longRows = [
    " Score: 0   Sound: on ",
    " King Edward the Benevolent, ruler of Daventry, is feeling the advanced effects of his years. ",
    " Having no heir to the throne, he has summoned Sir Graham to undertake three perilous quests. ",
    " Find the Magic Mirror, the Magic Shield, and the Chest of Gold, and you shall rule the land.  ",
  ];
  assert.equal(calculateModalDwellMs(longRows, 1), 5000);
  assert.equal(calculateModalDwellMs(longRows, 2), 2500);
});
