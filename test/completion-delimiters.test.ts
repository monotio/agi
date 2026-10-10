import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogicLanguageSnapshot } from "../src/logic/language.ts";
import { PROFILES } from "../src/runtime/profile.ts";

const context = {
  profile: PROFILES["2.936"],
  resources: ["view:2"],
  dictionary: new Map([
    ["open", 100],
    ["door", 101],
  ]),
};
for (const [marked, label, expected] of [
  ["load.v|();", "load.view", "load.view();"],
  [
    "#define object_id 1\nset.view(object_i|, 2);",
    "object_id",
    "#define object_id 1\nset.view(object_id, 2);",
  ],
  [
    "#define view_id 2\nload.view(view_i|);",
    "view_id · VIEW 2",
    "#define view_id 2\nload.view(view_id);",
  ],
  ["if (said(|)) { return; }", "open", 'if (said("open")) { return; }'],
  ['if (said("open", |)) { return; }', "door", 'if (said("open", "door")) { return; }'],
  ['if (said("op|")) { return; }', "open", 'if (said("open")) { return; }'],
] as const) {
  test(`completion applies the exact edit at ${marked}`, () => {
    const offset = marked.indexOf("|");
    const source = marked.replaceAll("|", "");
    const language = createLogicLanguageSnapshot({ source, ...context });
    const suggestion = language.completeAt(offset).find((entry) => entry.label === label);
    assert.ok(suggestion, `${label} is offered`);
    assert.equal(
      source.slice(0, suggestion.start) + suggestion.text + source.slice(suggestion.end),
      expected,
    );
  });
}
