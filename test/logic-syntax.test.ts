import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeLogicSyntax, parseLogicSyntax, scanLogicTokens } from "../src/logic/syntax.ts";
import { assembleLogic, AssemblerError } from "../src/logic/assembler.ts";

test("analysis and strict compilation share valid syntax and exact UTF-16 token spans", () => {
  const source = "// 🎮\r\n#define door 41\nif ((isset(door))) { set(f2); }\nreturn;";
  const strict = parseLogicSyntax(source);
  const analysis = analyzeLogicSyntax(source);
  assert.deepEqual(analysis.program, strict.program);
  assert.deepEqual(analysis.tokens, strict.tokens);
  assert.deepEqual(analysis.diagnostics, []);
  const token = analysis.tokens.find((entry) => entry.text === "#define")!;
  assert.deepEqual([token.start, token.end, token.line, token.col], [7, 14, 2, 1]);
  assert.equal(source.slice(token.start, token.end), "#define");
});

test("unfinished calls keep their tokens and produce a precise EOF diagnostic without compiled bytes", () => {
  const source = 'if (said("open", ';
  const analysis = analyzeLogicSyntax(source);
  assert.equal(analysis.tokens.at(-1)?.type, "eof");
  assert.equal(analysis.tokens.at(-2)?.text, ",");
  assert.equal(analysis.diagnostics[0]?.start, source.length);
  assert.equal(analysis.diagnostics[0]?.end, source.length);
  assert.throws(() => assembleLogic(source, { dictionary: new Map() }), AssemblerError);
});

test("statement recovery retains valid following statements and stays inside a block", () => {
  const source = "if (isset(f1)) {\nset(unknown);\nreset(f2);\n}\nreturn;";
  const analysis = analyzeLogicSyntax(source);
  assert.equal(analysis.diagnostics.length, 1);
  assert.match(analysis.diagnostics[0]!.message, /unknown identifier/);
  assert.equal(
    source.slice(analysis.diagnostics[0]!.start, analysis.diagnostics[0]!.end),
    "unknown",
  );
  assert.equal(analysis.program.length, 2);
  const branch = analysis.program[0]!;
  assert.equal(branch.type, "if");
  if (branch.type === "if") assert.equal(branch.then[0]?.type, "action");
  assert.equal(analysis.program[1]?.type, "return");
});

test("lexical recovery keeps later lines and never turns an invalid string into valid source", () => {
  for (const source of ['print("unfinished\nreturn;', 'print("bad\\q");\nreturn;', "@\nreturn;"]) {
    const analysis = analyzeLogicSyntax(source);
    assert.ok(analysis.diagnostics.length > 0);
    assert.ok(analysis.tokens.some((token) => token.type === "invalid"));
    assert.ok(analysis.program.some((statement) => statement.type === "return"));
    assert.throws(() => parseLogicSyntax(source), AssemblerError);
  }
});

test("recovery is bounded for hostile nesting, many errors and oversized source", () => {
  for (const source of ["if (" + "!".repeat(2000), "@\n".repeat(2000), " ".repeat(300_000)]) {
    const result = analyzeLogicSyntax(source);
    assert.ok(result.diagnostics.length > 0);
    assert.ok(result.diagnostics.length <= 101);
    assert.ok(result.diagnostics.some((entry) => /limit|expected|unexpected/.test(entry.message)));
  }
});

test("token scanning uses the grammar's full identifiers and ignores comment directives", () => {
  const source = "// #define door 99\n#define door.other 7\nset(door);";
  const tokens = scanLogicTokens(source);
  assert.equal(tokens.filter((token) => token.type === "directive").length, 1);
  assert.equal(tokens[1]?.text, "door.other");
});

test("symbol origins follow parser resolution, including forward labels and literal register precedence", () => {
  const source =
    '#define door 41\n#define f1 7\nset(door); set(f1); goto done; print("door");\ndone: return;';
  const analysis = analyzeLogicSyntax(source);
  assert.deepEqual(
    analysis.definitions.map(({ kind, name }) => [kind, name]),
    [
      ["define", "door"],
      ["define", "f1"],
      ["label", "done"],
    ],
  );
  assert.deepEqual(
    analysis.references.map(({ kind, name }) => [kind, name]),
    [
      ["define", "door"],
      ["label", "done"],
    ],
  );
  for (const reference of analysis.references) {
    const definition = analysis.definitions.find(
      (entry) => entry.start === reference.definitionStart,
    )!;
    assert.equal(definition.name, reference.name);
    assert.equal(source.slice(reference.start, reference.end), reference.name);
  }
});

test("undefined names remain unresolved and assignment targets retain their own source token", () => {
  const source = "set(later);\n#define later 5\n#define score 32\nscore = later; return;";
  const analysis = analyzeLogicSyntax(source);
  assert.equal(analysis.references[0]?.definitionStart, undefined);
  assert.deepEqual(
    analysis.references.map(({ name }) => name),
    ["later", "score", "later"],
  );
  const target = analysis.references.find((entry) => entry.name === "score")!;
  assert.equal(source.slice(target.start, target.end), "score");
  assert.equal(target.start, source.indexOf("score ="));
});

test("assignment destinations reject out-of-range registers instead of wrapping their byte", () => {
  for (const source of ["v256 = 1;", "v300 = v1;", "v999 = 0;"]) {
    assert.throws(
      () => assembleLogic(source, { dictionary: new Map() }),
      /index out of range 0\.\.255/,
    );
    const analysis = analyzeLogicSyntax(source + "\nreturn;");
    assert.match(analysis.diagnostics[0]?.message ?? "", /index out of range/);
    assert.equal(analysis.diagnostics[0]?.start, 0);
    assert.equal(analysis.program.at(-1)?.type, "return");
  }
  assert.deepEqual(
    [...assembleLogic("v255 = 1; return;", { dictionary: new Map() }).code],
    [3, 255, 1, 0],
  );
});
