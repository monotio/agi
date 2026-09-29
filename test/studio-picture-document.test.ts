import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parsePictureDocument,
  pictureItemAtLine,
  serializePictureDocument,
} from "../src/studio/pictureDocument.ts";

/** Diagnostics as `line:code`, the part the tests pin exactly. */
function codes(source: string): string[] {
  return parsePictureDocument(source).diagnostics.map((d) => `${d.line}:${d.code}`);
}

describe("picture document", () => {
  const SOURCE = [
    "vis 2", //                                          1
    '# @item sky "Sky \\"blue\\"" art locked', //         2
    "line 0,0 10,0   # top", //                          3
    "# plain comment", //                                4
    "", //                                               5
    "fill 1,1", //                                       6
    "# @end", //                                         7
    "line 5,5", //                                       8
    '  #@item door "Door"', //                           9
    "pri 3", //                                          10
    "# @end", //                                         11
    "# @items and # @ends are plain comments", //        12
    "end", //                                            13
    "", //                                               14
  ].join("\n");

  it("reads flat items with their command lines and round-trips the text", () => {
    const { document, diagnostics } = parsePictureDocument(SOURCE);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(document.items, [
      {
        id: "sky",
        label: 'Sky "blue"',
        kind: "art",
        locked: true,
        openLine: 2,
        closeLine: 7,
        commandLines: [3, 6],
      },
      {
        id: "door",
        label: "Door",
        kind: "mixed",
        locked: false,
        openLine: 9,
        closeLine: 11,
        commandLines: [10],
      },
    ]);
    assert.equal(serializePictureDocument(document), SOURCE);
    assert.equal(pictureItemAtLine(document, 6)?.id, "sky");
    assert.equal(pictureItemAtLine(document, 7), undefined);
    assert.equal(pictureItemAtLine(document, 8), undefined);
  });

  it("keeps CRLF text byte for byte", () => {
    const crlf = SOURCE.replaceAll("\n", "\r\n");
    const { document, diagnostics } = parsePictureDocument(crlf);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      document.items.map((item) => [item.id, item.kind, item.locked, item.commandLines]),
      [
        ["sky", "art", true, [3, 6]],
        ["door", "mixed", false, [10]],
      ],
    );
    assert.equal(serializePictureDocument(document), crlf);
  });

  it("reports a duplicate id and reads the second item as comments", () => {
    const source = ['# @item a "A"', "vis 1", "# @end", '# @item a "Again"', "vis 2", "# @end"];
    const { document } = parsePictureDocument(source.join("\n"));
    assert.deepEqual(codes(source.join("\n")), ["4:duplicate-id"]);
    assert.deepEqual(
      document.items.map((item) => [item.id, item.openLine, item.closeLine]),
      [["a", 1, 3]],
    );
  });

  it("reports nesting; the inner directive is a comment and the first @end closes", () => {
    const source = ['# @item a "A"', '# @item b "B"', "vis 1", "# @end", "# @end"].join("\n");
    assert.deepEqual(codes(source), ["2:nested-item", "5:unmatched-end"]);
    const [item] = parsePictureDocument(source).document.items;
    assert.deepEqual([item?.id, item?.closeLine, item?.commandLines], ["a", 4, [3]]);
  });

  it("reports an unmatched @end", () => {
    assert.deepEqual(codes("vis 1\n# @end"), ["2:unmatched-end"]);
  });

  it("closes an unterminated item at the end of the file", () => {
    const source = '# @item a "A"\nvis 1\nline 1,1';
    assert.deepEqual(codes(source), ["1:unterminated-item"]);
    const [item] = parsePictureDocument(source).document.items;
    assert.deepEqual([item?.closeLine, item?.commandLines], [4, [2, 3]]);
  });

  it("rejects bad ids and labels; the rejected item's @end is not reported again", () => {
    const cases: [string, string][] = [
      ['# @item Sky "Sky"', "bad-id"],
      ['# @item 9a "x"', "bad-id"],
      [`# @item a${"b".repeat(32)} "x"`, "bad-id"],
      ["# @item", "bad-id"],
      ["# @item sky unquoted", "bad-label"],
      ['# @item sky ""', "bad-label"],
      ['# @item sky "bad \\q"', "bad-label"],
      ['# @item sky "open', "bad-label"],
      ['# @item sky "Sky" sometimes', "bad-directive"],
      ['# @item sky "Sky" locked art', "bad-directive"],
    ];
    for (const [directive, code] of cases) {
      const source = `${directive}\nvis 1\n# @end`;
      assert.deepEqual(codes(source), [`1:${code}`], directive);
      assert.deepEqual(parsePictureDocument(source).document.items, [], directive);
    }
    assert.deepEqual(codes('# @item a "A"\nvis 1\n# @end now\n# @end'), ["3:bad-directive"]);
  });

  it("accepts the longest id and every kind", () => {
    const id = `a${"b".repeat(31)}`;
    const source = ["art", "depth", "walk", "mixed"]
      .map((kind, i) => `# @item ${i === 0 ? id : kind} "${kind}" ${kind}\n# @end`)
      .join("\n");
    const { document, diagnostics } = parsePictureDocument(source);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      document.items.map((item) => [item.id, item.kind]),
      [
        [id, "art"],
        ["depth", "depth"],
        ["walk", "walk"],
        ["mixed", "mixed"],
      ],
    );
  });
});
