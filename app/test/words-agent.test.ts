import assert from "node:assert/strict";
import { test } from "node:test";
import {
  wordsTaskPrompt,
  wordsTaskRequest,
  readWordSuggestions,
  wordsTaskReply,
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

test("word task replies summarize usable suggestions and keep the exact raw reply as context", () => {
  const suggest = { kind: "suggest", group: 100, words: ["look"] } as const;
  const raw = '```json\n{"synonyms":["inspect","check","inspect",{}]}\n```';
  assert.deepEqual(wordsTaskReply(raw, suggest), {
    text: "Suggested inspect, check · shown in WORDS",
    context: raw,
  });
  assert.equal(
    wordsTaskReply('{"synonyms":["inspect","check","see","observe"]}', suggest).text,
    "Suggested 4 words · shown in WORDS",
  );
  const predict = { kind: "predict", room: 1, roomName: "Meadow" } as const;
  assert.equal(
    wordsTaskReply('{"commands":["look tree","look tree",{}]}', predict).text,
    "Predicted 1 command · see Players will likely try in Meadow",
  );
  assert.equal(
    wordsTaskReply(
      JSON.stringify({
        commands: Array.from({ length: 12 }, (_, i) => `look ${"a".repeat(i + 1)}`),
      }),
      predict,
    ).text,
    "Predicted 12 commands · see Players will likely try in Meadow",
  );
  assert.equal(
    wordsTaskReply('{"commands":["look tree","climb tree"]}', { kind: "predict", room: 7 }).text,
    "Predicted 2 commands · see Players will likely try in ROOM 7",
  );
});

test("unreadable and empty word replies name the problem and the action to retry", () => {
  const suggest = { kind: "suggest", group: 100, words: ["look"] } as const;
  for (const raw of ["Try looking.", '{"synonyms":', '{"commands":[]}', '{"synonyms":{}}'])
    assert.deepEqual(wordsTaskReply(raw, suggest), {
      text: "The reply’s JSON could not be read. Try ✦ Suggest again.",
      context: raw,
    });
  assert.equal(
    wordsTaskReply('{"commands":', { kind: "predict", room: 1 }).text,
    "The reply’s JSON could not be read. Try ✦ Predict commands again.",
  );
  for (const raw of ['{"synonyms":[]}', '{"synonyms":[{},"UPPER","<script>"]}'])
    assert.equal(
      wordsTaskReply(raw, suggest).text,
      "The reply contained no usable words. Try ✦ Suggest again.",
    );
  assert.equal(
    wordsTaskReply('{"commands":[]}', { kind: "predict", room: 1 }).text,
    "The reply contained no usable commands. Try ✦ Predict commands again.",
  );
  assert.deepEqual(
    wordsTaskReply("Ready for review.", { kind: "review", room: 1, commands: ["look tree"] }),
    { text: "Ready for review." },
  );
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
