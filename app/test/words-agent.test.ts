import assert from "node:assert/strict";
import { test } from "node:test";
import {
  wordsTaskPrompt,
  wordsTaskRequest,
  readWordSuggestions,
} from "../src/studio/workspace/wordsAgent.ts";
test("word tasks scope optional help to meanings or real room resources", () => {
  const documents = {
    "logic:1": 'if(said("look")){print("Tree");}return;',
    "picture:1": "# Tree\nend",
    inventory: '[{"name":"key","startingRoom":1}]',
    words: '[["look",100]]',
  };
  const predict = wordsTaskPrompt({ kind: "predict", room: 1, pictures: [1] }, documents);
  assert.ok(predict.includes("PICTURE"));
  assert.ok(predict.includes(documents["logic:1"]));
  assert.ok(predict.includes("key"));
  assert.ok(
    wordsTaskPrompt({ kind: "suggest", group: 100, words: ["look"] }, documents).includes("100"),
  );
  assert.deepEqual(
    readWordSuggestions('```json\n{"synonyms":["inspect","check"]}\n```', "suggest"),
    ["inspect", "check"],
  );
  assert.deepEqual(readWordSuggestions('{"commands":["look tree","climb tree"]}', "predict"), [
    "look tree",
    "climb tree",
  ]);
  assert.deepEqual(readWordSuggestions('{"synonyms":[{}]}', "suggest"), []);
});

test("word task requests keep readable labels separate from scoped model context", () => {
  const documents = { "logic:1": 'print("Meadow");return;', "logic:2": "Unrelated room" };
  const request = wordsTaskRequest({ kind: "predict", room: 1, roomName: "Meadow" }, documents);
  assert.equal(request.text, "Predict what players will try in Meadow");
  assert.ok(request.context.includes(documents["logic:1"]));
  assert.ok(request.context.includes('{"commands":["look tree"]}'));
  assert.ok(!request.context.includes(documents["logic:2"]));
  const suggest = wordsTaskRequest({ kind: "suggest", group: 100, words: ["look", "examine"] }, {});
  assert.equal(suggest.text, "Suggest words for look");
  assert.ok(suggest.context.includes("meaning 100: look, examine"));
});
