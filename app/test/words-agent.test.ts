import assert from "node:assert/strict";
import { test } from "node:test";
import { wordsTaskPrompt, readWordSuggestions } from "../src/studio/workspace/wordsAgent.ts";
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
