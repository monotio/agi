import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sentenceOutcomes,
  meaningUses,
  formatMeaningUses,
  changeMeaning,
} from "../src/studio/workspace/wordsAnalysis.ts";
const words: [string, number][] = [
  ["look", 100],
  ["examine", 100],
  ["tree", 120],
  ["oak", 120],
  ["at", 0],
];
const documents = {
  words: JSON.stringify(words),
  "logic:0": 'if (said("help")) { print("Help"); } return;',
  "logic:1":
    'if (said("look", "tree")) { print("A tree."); }\nif (isset(f20) && said("look")) { print("A secret."); } return;',
};
test("outcomes locate room responses and retain runtime guards", () => {
  assert.deepEqual(
    sentenceOutcomes("examine at oak", words, documents, 1).map((r) => [
      r.logic,
      r.line,
      r.message,
      r.conditional,
    ]),
    [[1, 1, "A tree.", false]],
  );
  assert.equal(sentenceOutcomes("look", words, documents, 1)[0]?.conditional, true);
  assert.equal(sentenceOutcomes("look tree", words, documents, 2).length, 0);
  const nested = {
    "logic:0": 'if (isset(f30)) { if (said(1, 9999)) { print("Maybe"); } } return;',
  };
  assert.equal(sentenceOutcomes("look tree", words, nested, 1)[0]?.conditional, true);
  assert.equal(sentenceOutcomes("look missing tree", words, documents, 1).length, 0);
});
test("uses count said references, excluding messages and comments", () => {
  assert.deepEqual(
    meaningUses(words, documents)["100"]?.map((u) => [u.logic, u.line]),
    [
      [1, 1],
      [1, 2],
    ],
  );
});
test("a merge rewrites every said reference while preserving the survivor and other text", () => {
  const docs = {
    words: JSON.stringify(words),
    "logic:1": 'if (said("tree")) { print("tree"); } // tree\nif (said(120)) { return; }',
  };
  const changes = changeMeaning(words, docs, { from: 120, to: 100 });
  assert.deepEqual(JSON.parse(changes.find((c) => c.key === "words")!.content as string), [
    ["look", 100],
    ["examine", 100],
    ["tree", 100],
    ["oak", 100],
    ["at", 0],
  ]);
  assert.equal(
    changes.find((c) => c.key === "logic:1")?.content,
    'if (said("look")) { print("tree"); } // tree\nif (said("look")) { return; }',
  );
});
test("moving one synonym preserves existing responses to its original meaning", () => {
  const docs = { "logic:1": 'if (said("oak")) { print("Tree"); } return;' };
  const changes = changeMeaning(words, docs, { from: 120, to: 100, word: "oak" });
  assert.equal(
    changes.find((c) => c.key === "logic:1")?.content,
    'if (said("tree")) { print("Tree"); } return;',
  );
});

test("project bindings retain authored said line locations", () => {
  const docs = {
    bindings: '{"room_pic":{"kind":"picture","num":1}}',
    "logic:1": 'assignn(v50, room_pic);\nif (said("look")) { print("Clearing"); } return;',
  };
  assert.equal(sentenceOutcomes("look", words, docs, 1)[0]?.line, 2);
  assert.equal(meaningUses(words, docs)["100"]?.[0]?.line, 2);
});

test("responses that change state still answer; a consumed said prevents a second answer", () => {
  const docs = {
    "logic:1":
      'if (said("look")) { assignn(v40,1); }\nif (said("look")) { print("Second"); } return;',
  };
  const result = sentenceOutcomes("look", words, docs, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.line, 1);
});
test("removing a referenced head preserves said operands with the remaining synonym", async () => {
  const { removeMeaningWord } = await import("../src/studio/workspace/wordsAnalysis.ts");
  const docs = { "logic:1": 'if(said("look")){print("Look");}return;' };
  assert.equal(
    removeMeaningWord(words, docs, "look").find((c) => c.key === "logic:1")?.content,
    'if(said("examine")){print("Look");}return;',
  );
  assert.throws(() => removeMeaningWord([["look", 100]], docs, "look"), /Move this meaning/);
});

test("native LOGIC uses and responses participate in coordinated vocabulary moves", async () => {
  const { assembleLogic } = await import("../../src/logic/assembler.ts");
  const source = 'if (said("tree")) { print("Tree"); } return;';
  const payload = assembleLogic(source, { dictionary: new Map(words) }).payload;
  const docs = { "logic:1": payload };
  assert.equal(meaningUses(words, docs)["120"]?.[0]?.logic, 1);
  assert.equal(sentenceOutcomes("tree", words, docs, 1)[0]?.message, "Tree");
  const changes = changeMeaning(words, docs, { from: 120, to: 100 });
  const rewritten = changes.find((c) => c.key === "logic:1")?.content;
  assert.equal(typeof rewritten, "string");
  assert.ok((rewritten as string).includes('said("look")'));
});

test("meaning uses retain said source spellings for the head chip", () => {
  assert.deepEqual(
    meaningUses(words, {
      "logic:1": 'if (said("examine", "oak")) { return; }',
    })["100"]?.[0]?.words,
    ["examine"],
  );
  assert.deepEqual(
    meaningUses(words, {
      "logic:1": "if (said(100)) { return; }",
    })["100"]?.[0]?.words,
    [],
  );
});

test("uses group LOGIC labels, sort and deduplicate linked lines, and retain reference counts", () => {
  const formatted = formatMeaningUses([
    { logic: 1, line: 34 },
    { logic: 0, line: 58 },
    { logic: 1, line: 32 },
    { logic: 1, line: 33 },
    { logic: 1, line: 32 },
  ]);
  assert.deepEqual(formatted, {
    count: "5 uses",
    locations: [
      { logic: 1, label: "LOGIC 1 lines", lines: [32, 33, 34] },
      { logic: 0, label: "LOGIC 0 line", lines: [58] },
    ],
  });
  assert.deepEqual(formatMeaningUses([{ logic: 3, line: 8 }]), {
    count: "1 use",
    locations: [{ logic: 3, label: "LOGIC 3 line", lines: [8] }],
  });
  assert.deepEqual(formatMeaningUses([]), { count: "0 uses", locations: [] });
});
