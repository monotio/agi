import assert from "node:assert/strict";
import { test } from "node:test";
import { gameTestReviewChanges, gameTestReviewLines } from "../src/agent/gameTestReview.ts";
import { PROFILES } from "../src/runtime/profile.ts";
const document = (tests: readonly unknown[]) =>
  JSON.stringify({ format: "monotio.agi.tests.v2", tests });
test("Test edits are visible in review: deletion and expectation changes have separate named lines", () => {
  const before = document([
    { name: "Open door", room: 1, steps: [] },
    { name: "Treasure", room: 1, steps: [], expect: { score: 99 } },
    { name: "Walk", room: 1, steps: [] },
  ]);
  const after = document([
    { name: "Treasure", room: 1, steps: [], expect: { score: 0 } },
    { name: "Walk", room: 2, steps: [] },
    { name: "New", room: 1, steps: [] },
  ]);
  assert.deepEqual(gameTestReviewLines(before, after, PROFILES["2.936"]!), [
    'Deleted test "Open door"',
    'Changed expectation of "Treasure"',
    'Changed test "Walk"',
    'Added test "New"',
  ]);
});

test("A changed test shows its old and new steps and checks in review, so a weakened check is visible", () => {
  const steps = [
    { action: "command", command: "open door" },
    { action: "wait", until: { room: 2 } },
    { action: "move", direction: "up", ticks: 5 },
  ];
  const before = document([
    { name: "Open door", room: 1, steps, expect: { room: 2, score: 5 } },
    { name: "Treasure", room: 1, steps: [], expect: { printed: "Gold!" } },
  ]);
  const after = document([
    { name: "Open door", room: 1, steps: [steps[0]], expect: {} },
    {
      name: "Treasure",
      room: 3,
      steps: [{ action: "key", key: 13 }],
      expect: { printed: "Gold!" },
    },
  ]);
  assert.deepEqual(gameTestReviewChanges(before, after, PROFILES["2.936"]!), [
    {
      line: 'Changed test and expectation of "Open door"',
      rows: [
        {
          label: "Steps",
          before: 'type "open door"; wait until room 2; walk up for 5 ticks',
          after: 'type "open door"',
        },
        { label: "Checks", before: "room 2, score 5", after: "Nothing checked" },
      ],
    },
    {
      line: 'Changed test "Treasure"',
      rows: [
        { label: "Room", before: "1", after: "3" },
        { label: "Steps", before: "None", after: "press key 13" },
        { label: "Checks", before: 'printed "Gold!"', after: 'printed "Gold!"' },
      ],
    },
  ]);
});

test("Malformed or unsupported tests stay visible during creator review instead of losing the review card", async () => {
  const { readGameTestReviewSide } = await import("../src/agent/gameTestReview.ts");
  const malformed = readGameTestReviewSide("{", PROFILES["2.936"]!);
  assert.match(malformed.cause ?? "", /valid JSON/);
  assert.deepEqual(malformed.tests, []);
  const unsupported = readGameTestReviewSide(
    JSON.stringify({ format: "future.tests", tests: [] }),
    PROFILES["2.936"]!,
  );
  assert.match(unsupported.cause ?? "", /format/);
  assert.deepEqual(unsupported.tests, []);
  assert.equal(
    readGameTestReviewSide(document([{ name: "Fixed", room: 5, steps: [] }]), PROFILES["2.936"]!)
      .cause,
    null,
  );
});
