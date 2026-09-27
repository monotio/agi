import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseLogicDocument,
  ruleDirective,
  ruleFragmentText,
  serializeLogicDocument,
} from "../src/studio/rules/logicDocument.ts";

/** Diagnostics as `line:code`, the part the tests pin exactly. */
function codes(source: string): string[] {
  return parseLogicDocument(source).diagnostics.map((d) => `${d.line}:${d.code}`);
}

describe("logic document", () => {
  const SOURCE = [
    '#message 1 "Hi."', // 1
    "if (isset(f5)) {", // 2
    "  load.pic(v0);", // 3
    "}", // 4
    '  // @rule statue "Statue \\"Bob\\"" region item=bust', // 5
    "  if (!isset(f40) && posn(o0, 1, 2, 3, 4)) { set(f40); }", // 6
    "  // @end", // 7
    '//@rule east "East door" exit', // 8
    "if (equaln(v2, 2)) { new.room(3); }", // 9
    "// @end", // 10
    "// @rules and @ends in prose are plain comments", // 11
    "return;", // 12
    "", // 13
  ].join("\n");

  it("reads rules with their item bindings and round-trips the text", () => {
    const { document, diagnostics } = parseLogicDocument(SOURCE);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(document.rules, [
      {
        id: "statue",
        label: 'Statue "Bob"',
        kind: "region",
        item: "bust",
        openLine: 5,
        closeLine: 7,
        terminated: true,
      },
      {
        id: "east",
        label: "East door",
        kind: "exit",
        item: null,
        openLine: 8,
        closeLine: 10,
        terminated: true,
      },
    ]);
    assert.equal(
      ruleFragmentText(document, document.rules[0]!),
      "  if (!isset(f40) && posn(o0, 1, 2, 3, 4)) { set(f40); }",
    );
    assert.equal(serializeLogicDocument(document), SOURCE);
    assert.equal(
      ruleDirective(document.rules[0]!, "  "),
      '  // @rule statue "Statue \\"Bob\\"" region item=bust',
    );
    assert.equal(ruleDirective(document.rules[1]!), '// @rule east "East door" exit');
  });

  it("keeps CRLF text byte for byte", () => {
    const crlf = SOURCE.replaceAll("\n", "\r\n");
    const { document, diagnostics } = parseLogicDocument(crlf);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      document.rules.map((rule) => [rule.id, rule.kind, rule.item]),
      [
        ["statue", "region", "bust"],
        ["east", "exit", null],
      ],
    );
    assert.equal(serializeLogicDocument(document), crlf);
  });

  it("reports bad directives once each and reads them as comments", () => {
    const source = [
      '// @rule Bad "x" exit', // 1 bad-id
      "// @end", // 2 swallowed by the rejected rule
      "// @rule a exit", // 3 bad-label
      "// @end", // 4
      '// @rule b "B" command', // 5 not a kind of this kernel
      "// @end", // 6
      '// @rule c "C" region', // 7
      '// @rule d "D" region', // 8 nested
      "// @end", // 9 closes c
      "// @end", // 10 unmatched
      '// @rule c "Again" exit', // 11 duplicate
      "// @end", // 12
      "// @end now", // 13 bad @end
      '// @rule f "F" exit item=Door', // 14 bad item id
      "// @end", // 15
      '// @rule g "G" exit door=x', // 16 unknown option
      "// @end", // 17
      '// @rule h "H" exit item=door locked', // 18 extra words
      "// @end", // 19
      '// @rule e "E" region', // 20 unterminated
      "set(f1);", // 21
    ].join("\n");
    assert.deepEqual(codes(source), [
      "1:bad-id",
      "3:bad-label",
      "5:bad-directive",
      "8:nested-item",
      "10:unmatched-end",
      "11:duplicate-id",
      "13:bad-directive",
      "14:bad-directive",
      "16:bad-directive",
      "18:bad-directive",
      "20:unterminated-item",
    ]);
    const { document } = parseLogicDocument(source);
    assert.deepEqual(
      document.rules.map((rule) => [rule.id, rule.openLine, rule.closeLine, rule.terminated]),
      [
        ["c", 7, 9, true],
        ["e", 20, 22, false],
      ],
    );
  });
});
