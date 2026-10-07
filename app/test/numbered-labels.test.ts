import { formatMeaningUses } from "../src/studio/workspace/wordsAnalysis.ts";
import { suggestAssertions } from "../src/authoring/gameRecording.ts";
import { buildObjectFile } from "../../src/authoring/inventory.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  numberedOptions,
  numberedLabel,
  numberedSlot,
  numberedExpressionLabel,
} from "../../src/logic/numberedLabels.ts";
import { projectLabelContext } from "../src/shell/projectLabelContext.ts";
import { systemName } from "../../src/logic/systemNames.ts";

test("creator names precede system names and plain fallbacks in every context", () => {
  const context = { bindings: { quiet: { kind: "flag", num: 9 } } };
  assert.equal(numberedLabel("flag", 9, context), "quiet");
  assert.equal(numberedLabel("f", 9, context, "option"), "quiet (Flag 9)");
  assert.equal(numberedLabel("flag", 9, context, "row"), "quiet · Flag 9");
  assert.equal(numberedSlot("flag", 9), "Flag 9");
  assert.equal(numberedLabel("flag", 9), systemName("flag", 9));
  assert.equal(
    numberedLabel("variable", 3, {}, "option"),
    `${systemName("variable", 3)} (Variable 3)`,
  );
  assert.equal(numberedLabel("flag", 200, {}, "option"), "Flag 200");
  assert.equal(numberedLabel("variable", 200), "Variable 200");
});

test("inventory, room titles, Parts names, word groups and controllers use the same formats", () => {
  const context = {
    inventory: ["key"],
    rooms: [{ room: 8, title: "Garden" }],
    names: { "sound:2": "Chime" },
    words: [
      ["open", 10],
      ["unlock", 10],
    ] as const,
    bindings: { action: { kind: "controller", num: 4 }, actor: { kind: "object", num: 0 } },
  };
  assert.equal(numberedLabel("inventory", 0, context, "option"), "key (Item 0)");
  assert.equal(numberedLabel("object", 0, context), "actor");
  assert.equal(numberedLabel("room", 8, context, "option"), "Garden (Room 8)");
  assert.equal(numberedLabel("sound", 2, context, "row"), "Chime · SOUND 2");
  assert.equal(numberedLabel("w", 10, context, "option"), "open, unlock (Word group 10)");
  assert.equal(numberedLabel("c", 4, context), "action");
  assert.equal(numberedLabel("object", 1, context), "Object 1");
  assert.equal(numberedLabel("view", 3, context), "VIEW 3");
  assert.equal(numberedLabel("room", 12, context), "Room 12");
});

test("aliases are deterministic and message names stay in their LOGIC", () => {
  const bindings = {
    zebra: { kind: "flag", num: 40 },
    alpha: { kind: "flag", num: 40 },
    greeting: { kind: "message", num: 1, logic: 2 },
  };
  assert.equal(numberedLabel("flag", 40, { bindings }), "alpha");
  assert.equal(numberedLabel("message", 1, { bindings, logic: 2 }), "greeting");
  assert.equal(numberedLabel("message", 1, { bindings, logic: 3 }), "Message 1");
});

test("incomplete name documents retain valid siblings and numbered fallbacks", () => {
  const context = projectLabelContext({
    inventory: "null",
    words: "{}",
    world: "{",
    bindings: JSON.stringify({ quiet: { kind: "flag", num: 9 } }),
  });
  assert.equal(numberedLabel("flag", 9, context), "quiet");
  assert.equal(numberedLabel("inventory", 0, context), "Item 0");
  assert.equal(numberedLabel("word", 12, context), "Word group 12");
});

test("native and authored inventory and word documents resolve the same labels", () => {
  const items = [{ name: "brass key", startingRoom: 255 }];
  const words: [string, number][] = [
    ["unlock", 10],
    ["open", 10],
  ];
  const text = projectLabelContext({
    inventory: JSON.stringify(items),
    words: JSON.stringify(words),
  });
  const native = projectLabelContext({
    inventory: buildObjectFile(items),
    words: buildWordsTok(words.map(([word, id]) => ({ word, id }))),
  });
  for (const context of [text, native]) {
    assert.equal(numberedLabel("inventory", 0, context, "option"), "brass key (Item 0)");
    assert.equal(numberedLabel("word", 10, context, "option"), "open, unlock (Word group 10)");
  }
});

test("simple watches use names while compound expressions keep their authored text", () => {
  const context = { bindings: { total: { kind: "variable", num: 40 } } };
  assert.equal(numberedExpressionLabel("v40", context), "total (Variable 40)");
  assert.equal(numberedExpressionLabel("v3"), `${systemName("variable", 3)} (Variable 3)`);
  assert.equal(numberedExpressionLabel("v40 + 1", context), "v40 + 1");
});

test("numbered options retain numeric order and creator/system names", () => {
  const options = numberedOptions("flag", [204, 9, 1], {
    bindings: { quiet: { kind: "flag", num: 9 }, chime_done: { kind: "flag", num: 204 } },
  });
  assert.deepEqual(options, [
    { num: 1, label: `${systemName("flag", 1)} (Flag 1)` },
    { num: 9, label: "quiet (Flag 9)" },
    { num: 204, label: "chime_done (Flag 204)" },
  ]);
});

test("recorded-test suggestions use shared named slots without changing assertion identities", () => {
  const start = { room: 1, vars: [], flags: [], inventory: [] };
  const end = {
    room: 2,
    vars: Array.from({ length: 41 }, (_, n) => (n === 40 ? 3 : 0)),
    flags: Array.from({ length: 10 }, (_, n) => (n === 9 ? 1 : 0)),
    inventory: [{ num: 0, name: "key", room: 255 }],
  };
  const context = {
    rooms: [{ room: 2, title: "Garden" }],
    bindings: { quiet: { kind: "flag", num: 9 }, total: { kind: "variable", num: 40 } },
  };
  const suggestions = suggestAssertions(start, end, [], context);
  assert.equal(suggestions.find((s) => s.id === "room")?.label, "Garden (Room 2)");
  assert.equal(suggestions.find((s) => s.id === "flag-9")?.label, "quiet (Flag 9) set");
  assert.equal(suggestions.find((s) => s.id === "var-40")?.label, "total (Variable 40) = 3");
  assert.equal(suggestions.find((s) => s.id === "item-0")?.label, "carrying key (Item 0)");
});

test("room titles use the proved picture association, then explicit room titles", () => {
  const documents = {
    "picture:2": "# Atrium: original artwork\nend",
    "picture:7": "# Other: artwork\nend",
  };
  const source = [{ room: 7, pictures: [2] }];
  assert.equal(
    numberedLabel("room", 7, projectLabelContext(documents, undefined, source)),
    "Atrium",
  );
  assert.equal(
    numberedLabel(
      "room",
      8,
      projectLabelContext(documents, undefined, [{ room: 8, pictures: [] }]),
    ),
    "Room 8",
  );
  assert.equal(
    numberedLabel(
      "room",
      7,
      projectLabelContext(
        { ...documents, world: '{"rooms":{"7":{"title":"Hall"}}}' },
        undefined,
        source,
      ),
    ),
    "Hall",
  );
});

test("word usage links resolve their named LOGIC with the shared row format", () => {
  const context = { bindings: { first_room: { kind: "logic", num: 1 } } };
  assert.equal(
    formatMeaningUses([{ logic: 1, line: 8 }], context).locations[0]?.label,
    "first_room · LOGIC 1 line",
  );
});
