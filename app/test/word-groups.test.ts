import assert from "node:assert/strict";
import { test } from "node:test";
import { wordGroups, nextWordGroup } from "../src/studio/workspace/wordGroups.ts";
import { buildWordsTok, parseWordsTok } from "../../src/logic/words.ts";

test("meaning rows retain ignored and reserved dictionary ids and encode unchanged", () => {
  const entries: [string, number][] = [
    ["look", 100],
    ["a", 0],
    ["l", 100],
    ["anyword", 1],
    ["rest", 9999],
  ];
  const groups = wordGroups(entries);
  assert.deepEqual(groups, [
    { id: 100, words: ["look", "l"] },
    { id: 0, words: ["a"] },
    { id: 1, words: ["anyword"] },
    { id: 9999, words: ["rest"] },
  ]);
  assert.deepEqual(
    parseWordsTok(
      buildWordsTok(groups.flatMap(({ id, words }) => words.map((word) => ({ word, id })))),
    ),
    [
      { word: "a", id: 0 },
      { word: "anyword", id: 1 },
      { word: "l", id: 100 },
      { word: "look", id: 100 },
      { word: "rest", id: 9999 },
    ],
  );
  assert.equal(nextWordGroup(entries), 2);
  assert.equal(
    nextWordGroup([
      ["a", 0],
      ["any", 1],
      ["b", 2],
    ]),
    3,
  );
});
