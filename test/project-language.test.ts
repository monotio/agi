import assert from "node:assert/strict";
import { test } from "node:test";
import { createProjectLogicLanguageSnapshot } from "../src/authoring/projectLanguage.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";

const context = {
  profile: DEFAULT_V2_PROFILE,
  dictionary: new Map([["open", 100]]),
  bindings: { door: { num: 50 }, score: { num: 30 } },
};

test("project language resolves generated bindings and maps authored UTF-16 ranges", () => {
  const source = "// 🎮\r\nset(door); score = 7; return;";
  const language = createProjectLogicLanguageSnapshot({ source, ...context });
  const use = source.indexOf("door");
  assert.deepEqual(language.diagnostics, []);
  assert.deepEqual(language.generatedDiagnostics, []);
  assert.deepEqual(language.definitionAt(use), {
    kind: "binding",
    name: "door",
    document: "bindings",
  });
  assert.deepEqual(language.referencesAt(use), [{ start: use, end: use + 4 }]);
  assert.deepEqual(language.hoverAt(use), { start: use, end: use + 4, text: "#define door 50" });
  assert.throws(() => language.renameAt(use, "gate"), /coordinated project rename/);
  assert.deepEqual([...compileProjectLogic(source, context).assembly.code], [12, 50, 3, 30, 7, 0]);
});

test("incomplete project source receives binding completion without exposing generated offsets", () => {
  const source = "// 🎮\nset(do";
  const language = createProjectLogicLanguageSnapshot({ source, ...context });
  assert.ok(
    language
      .completeAt(source.length)
      .some((entry) => entry.label === "door" && entry.start === 10 && entry.end === 12),
  );
  assert.equal(language.signatureAt(source.length)?.label, "set(flag)");
  assert.equal(language.diagnostics[0]?.line, 2);
  assert.equal(language.diagnostics[0]?.start, source.indexOf("do"));
  for (const offset of [-1, 0.5, source.length + 1])
    assert.throws(() => language.completeAt(offset), RangeError);
});

test("authored definitions shadow bindings and local renames preserve generated owners", () => {
  const source = "#define door 51\nset(door); return;";
  const language = createProjectLogicLanguageSnapshot({ source, ...context });
  const use = source.indexOf("set(door") + 4;
  assert.deepEqual(language.definitionAt(use), { kind: "define", name: "door", start: 8, end: 12 });
  assert.deepEqual(language.renameAt(use, "gate"), [
    { start: 8, end: 12, text: "gate" },
    { start: use, end: use + 4, text: "gate" },
  ]);
  assert.throws(() => language.renameAt(use, "score"), /already has a definition/);
  assert.equal(language.hoverAt(use)?.text, "#define door 51");
});

test("project diagnostics preserve authored lines and distinguish invalid generated bindings", () => {
  const source = "return;\nunknown();";
  const language = createProjectLogicLanguageSnapshot({ source, ...context });
  assert.equal(language.diagnostics[0]?.line, 2);
  assert.equal(language.diagnostics[0]?.start, 8);
  assert.match(language.diagnostics[0]?.message ?? "", /^2:1: unknown action/);
  const invalid = createProjectLogicLanguageSnapshot({
    source: "return;",
    ...context,
    bindings: { door: { num: 300 } },
  });
  assert.deepEqual(invalid.diagnostics, []);
  assert.equal(invalid.generatedDiagnostics[0]?.binding, "door");
  assert.match(invalid.generatedDiagnostics[0]?.message ?? "", /0\.\.255/);
});
