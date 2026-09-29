import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogicLanguageSnapshot } from "../src/logic/language.ts";
import { PROFILES } from "../src/runtime/profile.ts";

const context = {
  profile: PROFILES["2.936"],
  dictionary: new Map([
    ["open", 100],
    ["door", 101],
  ]),
};

test("completion and signature help work inside an unfinished condition", () => {
  const source = 'if (said("open", ';
  const language = createLogicLanguageSnapshot({ source, ...context });
  assert.equal(language.signatureAt(source.length)?.label, "said(word, ...)");
  assert.equal(language.signatureAt(source.length)?.activeParameter, 1);
  const condition = createLogicLanguageSnapshot({ source: "if (iss", ...context });
  assert.ok(condition.completeAt(7).some((entry) => entry.label === "isset"));
  assert.equal(
    condition.completeAt(7).some((entry) => entry.label === "set"),
    false,
  );
  const action = createLogicLanguageSnapshot({ source: "set.", ...context });
  assert.ok(action.completeAt(4).some((entry) => entry.label === "set.view"));
});

test("hover documentation uses profile-filtered command metadata and ignores strings/comments", () => {
  const source = 'set.view(o0, 1); print("set.view"); // set.view';
  const language = createLogicLanguageSnapshot({ source, ...context });
  assert.match(language.hoverAt(2)?.text ?? "", /VIEW/);
  assert.equal(language.hoverAt(source.indexOf('"set.view') + 2), null);
  assert.deepEqual(language.completeAt(source.length), []);
  const early = createLogicLanguageSnapshot({ source: "mouse.posn", ...context });
  assert.equal(early.hoverAt(2), null);
});

test("local definitions, references and rename use resolved tokens, preserving comments and strings", () => {
  const source = '#define door 41\nset(door); print("door"); // door\nreturn;';
  const language = createLogicLanguageSnapshot({ source, ...context });
  const use = source.indexOf("set(door") + 4;
  assert.equal(language.definitionAt(use)?.start, source.indexOf("door"));
  assert.equal(language.referencesAt(use).length, 2);
  const edits = language.renameAt(use, "gate");
  assert.equal(edits.length, 2);
  let changed = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    changed = changed.slice(0, edit.start) + edit.text + changed.slice(edit.end);
  assert.equal(changed, '#define gate 41\nset(gate); print("door"); // door\nreturn;');
});

test("rename refuses unresolved names, collisions, register spellings and incomplete builds", () => {
  const source = "#define door 41\n#define gate 42\nset(door); return;";
  const language = createLogicLanguageSnapshot({ source, ...context });
  const use = source.indexOf("set(door") + 4;
  for (const name of ["gate", "f41", "two names", ""])
    assert.throws(() => language.renameAt(use, name));
  assert.throws(
    () => createLogicLanguageSnapshot({ source: "set(missing);", ...context }).renameAt(5, "found"),
    /unresolved|definition/i,
  );
  assert.throws(
    () =>
      createLogicLanguageSnapshot({ source: source + " if (", ...context }).renameAt(use, "arch"),
    /invalid|incomplete|compile/i,
  );
});

test("strict diagnostics include semantic errors which tolerant syntax alone cannot detect", () => {
  const source = "not.a.command(); return;";
  const language = createLogicLanguageSnapshot({ source, ...context });
  assert.ok(language.diagnostics.some((entry) => /unknown action/.test(entry.message)));
  assert.equal(language.diagnostics[0]?.start, 0);
});

test("language snapshots own their dictionary and reject invalid cursor positions", () => {
  const dictionary = new Map([["open", 100]]);
  const source = 'if (said("open")) { return; }';
  const language = createLogicLanguageSnapshot({ source, profile: context.profile, dictionary });
  dictionary.clear();
  assert.equal(language.diagnostics.length, 0);
  for (const offset of [-1, 0.5, source.length + 1, NaN])
    assert.throws(() => language.completeAt(offset), RangeError);
});

test("punctuation inside string tokens cannot alter call context", () => {
  const source = 'if (said(")", ';
  const language = createLogicLanguageSnapshot({ source, ...context });
  assert.equal(language.signatureAt(source.length)?.label, "said(word, ...)");
  assert.equal(language.signatureAt(source.length)?.activeParameter, 1);
  assert.ok(language.completeAt(source.length).some((entry) => entry.label === "open"));
});

test("hover follows a local definition even when its name is also an opcode", () => {
  const source = "#define set.view 31\nset(set.view); return;";
  const language = createLogicLanguageSnapshot({ source, ...context });
  assert.equal(language.hoverAt(source.indexOf("set(set.view") + 5)?.text, "#define set.view 31");
});

test("statement completion includes AGI control syntax without inventing command calls", () => {
  const language = createLogicLanguageSnapshot({ source: "ret", ...context });
  assert.ok(
    language.completeAt(3).some((entry) => entry.label === "return" && entry.text === "return"),
  );
  const directive = createLogicLanguageSnapshot({ source: "#def", ...context });
  assert.ok(directive.completeAt(4).some((entry) => entry.label === "#define"));
});

test("a previous line's comment does not suppress completion on the next line", () => {
  for (const source of ["// room logic\n", "return; // done\n", "// room logic\r\n  "]) {
    const language = createLogicLanguageSnapshot({ source, ...context });
    assert.ok(language.completeAt(source.length).some((entry) => entry.label === "if"));
  }
  const source = "return; // still a comment";
  assert.deepEqual(
    createLogicLanguageSnapshot({ source, ...context }).completeAt(source.length),
    [],
  );
});

test("invalid rename spellings produce an identifier diagnostic instead of a source lexer error", () => {
  const source = "#define door 41\nset(door); return;";
  const language = createLogicLanguageSnapshot({ source, ...context });
  for (const name of ['a"b', "a@b", "a\\b"])
    assert.throws(
      () => language.renameAt(source.indexOf("set(door") + 4, name),
      /not a safe source identifier/,
    );
});

test("vocabulary completion replaces an unfinished quoted word through the caret at EOF", () => {
  const source = 'if (said("op';
  const language = createLogicLanguageSnapshot({ source, ...context });
  assert.deepEqual(language.completeAt(source.length), [
    { label: "open", detail: "Word group 100", start: 9, end: 12, text: '"open"' },
  ]);
  const closed = 'if (said("open"';
  assert.deepEqual(
    createLogicLanguageSnapshot({ source: closed, ...context }).completeAt(closed.length),
    [],
  );
});

test("completion prefers the identifier ending at the caret over a following delimiter", () => {
  for (const [marked, label, expected] of [
    ["loa|d.view();", "load.view", "load.view();"],
    ["#define obj_id 1\nset.view(obj_|, 2);", "obj_id", "#define obj_id 1\nset.view(obj_id, 2);"],
    ["#define obj_id 1\nset.view(obj_id|)", "obj_id", "#define obj_id 1\nset.view(obj_id)"],
  ] as const) {
    const offset = marked.indexOf("|");
    const source = marked.replace("|", "");
    const language = createLogicLanguageSnapshot({ source, ...context });
    const suggestion = language.completeAt(offset).find((entry) => entry.label === label);
    assert.ok(suggestion, `${label} is offered at ${marked}`);
    assert.equal(
      source.slice(0, suggestion.start) + suggestion.text + source.slice(suggestion.end),
      expected,
    );
  }
});

test("an empty argument offers a zero-width target without consuming the closing delimiter", () => {
  for (const [marked, label, expected] of [
    ["if (said(|)) { return; }", "open", 'if (said("open")) { return; }'],
    ['if (said("open", |)) { return; }', "door", 'if (said("open", "door")) { return; }'],
    ['if (said("open", |', "door", 'if (said("open", "door"'],
    ["#define obj_id 1\nset.view(|)", "obj_id", "#define obj_id 1\nset.view(obj_id)"],
  ] as const) {
    const offset = marked.indexOf("|");
    const source = marked.replace("|", "");
    const language = createLogicLanguageSnapshot({ source, ...context });
    const suggestion = language.completeAt(offset).find((entry) => entry.label === label);
    assert.ok(suggestion, `${label} is offered at ${marked}`);
    assert.equal(suggestion.start, offset);
    assert.equal(suggestion.end, offset);
    assert.equal(
      source.slice(0, suggestion.start) + suggestion.text + source.slice(suggestion.end),
      expected,
    );
  }
});

test("a finished quoted argument is not reopened as the next completion target", () => {
  for (const marked of ['if (said("open"|)) { return; }', 'if (said("open"|, 2)) { return; }']) {
    const offset = marked.indexOf("|");
    const source = marked.replace("|", "");
    assert.deepEqual(createLogicLanguageSnapshot({ source, ...context }).completeAt(offset), []);
  }
  const partial = "if (said(op|)) { return; }";
  const source = partial.replace("|", "");
  const suggestion = createLogicLanguageSnapshot({ source, ...context })
    .completeAt(partial.indexOf("|"))
    .find((entry) => entry.label === "open");
  assert.ok(suggestion, "an unquoted said argument still filters vocabulary by its prefix");
  assert.equal(
    source.slice(0, suggestion.start) + suggestion.text + source.slice(suggestion.end),
    'if (said("open")) { return; }',
  );
});

test("completion offsets stay in UTF-16 code units across CRLF and surrogate pairs", () => {
  const marked = "// \u{1f3ae}\r\nload.v|();";
  const offset = marked.indexOf("|");
  const source = marked.replace("|", "");
  const language = createLogicLanguageSnapshot({ source, ...context });
  const suggestion = language.completeAt(offset).find((entry) => entry.label === "load.view");
  assert.ok(suggestion, "load.view is offered after a CRLF line and a surrogate pair");
  assert.equal(suggestion.start, 7);
  assert.equal(suggestion.end, 13);
  assert.equal(
    source.slice(0, suggestion.start) + suggestion.text + source.slice(suggestion.end),
    "// \u{1f3ae}\r\nload.view();",
  );
});
