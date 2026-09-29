import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compilePictureSource, disassemblePicture } from "../src/picture/source.ts";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import { inferNativeItems, isInferredItemId } from "../src/studio/nativeItems.ts";
import { parsePictureDocument } from "../src/studio/pictureDocument.ts";
import { ORIGINAL_SCENE_PICTURES } from "../games/adventure-department/sceneArt.ts";
import { TUTORIAL_PICTURE_SOURCES } from "../games/adventure-department/game.ts";
import { loadGame } from "./game-fixture.ts";

const opts = { profile: DEFAULT_V2_PROFILE };

function compiled(source: string): number[] {
  return Array.from(compilePictureSource(source).bytes);
}

/** Infer, then check the result parses cleanly and compiles to the same bytes. */
function infer(source: string): string {
  const result = inferNativeItems(source, opts);
  assert.deepEqual(compiled(result), compiled(source));
  assert.deepEqual(parsePictureDocument(result).diagnostics, []);
  return result;
}

const text = (...lines: string[]): string => `${lines.join("\n")}\n`;

describe("inferNativeItems", () => {
  it("wraps a four-element picture, splitting an element whose fill comes later", () => {
    const source = text(
      "vis 0",
      "line 10,10 20,10 20,20 10,20 10,10",
      "vis 4",
      "line 100,100 110,100",
      "vis 2",
      "fill 15,15",
      "vis off",
      "pri 2",
      "line 50,150 60,150",
      "pri 10",
      "line 50,160 70,160",
      "end",
    );
    assert.equal(
      infer(source),
      text(
        '# @item el-1 "Element 1" art',
        "vis 0",
        "line 10,10 20,10 20,20 10,20 10,10",
        "# @end",
        '# @item el-2 "Element 2" art',
        "vis 4",
        "line 100,100 110,100",
        "# @end",
        '# @item el-1-2 "Element 1 part 2" art',
        "vis 2",
        "fill 15,15",
        "# @end",
        '# @item el-3 "Element 3" walk',
        "vis off",
        "pri 2",
        "line 50,150 60,150",
        "# @end",
        '# @item el-4 "Element 4" depth',
        "pri 10",
        "line 50,160 70,160",
        "# @end",
        "end",
      ),
    );
  });

  it("marks an element drawing on both planes mixed and closes before a missing end", () => {
    assert.equal(
      infer(text("vis 1", "pri 5", "line 0,0 3,0")),
      text('# @item el-1 "Element 1" mixed', "vis 1", "pri 5", "line 0,0 3,0", "# @end"),
    );
  });

  it("keeps a raw rel continuation with its command", () => {
    const source = disassemblePicture(new Uint8Array([0xf0, 1, 0xf7, 10, 10, 0x08, 0x11, 0xff]));
    assert.equal(source, text("vis 1", "rel 10,10", "raw 8 17", "end"));
    assert.equal(
      infer(source),
      text('# @item el-1 "Element 1" art', "vis 1", "rel 10,10", "raw 8 17", "# @end", "end"),
    );
  });

  it("treats a raw command line as a drawing command", () => {
    assert.equal(
      infer(text("vis 1", "raw 246 5 5 6 6", "end")),
      text('# @item el-1 "Element 1" art', "vis 1", "raw 246 5 5 6 6", "# @end", "end"),
    );
  });

  it("renumbers copy ranges to the shifted lines", () => {
    assert.equal(
      infer(text("vis 1", "line 10,10 12,10", "copy 1-2 50,50", "end")),
      text(
        '# @item el-1 "Element 1" art',
        "vis 1",
        "line 10,10 12,10",
        "# @end",
        '# @item el-2 "Element 2" art',
        "copy 2-3 50,50",
        "# @end",
        "end",
      ),
    );
  });

  it("leaves leading blank lines loose and keeps comments with the element they precede", () => {
    assert.equal(
      infer(text("", "# the ground", "vis 1", "", "line 0,0 1,0")),
      text(
        "",
        '# @item el-1 "Element 1" art',
        "# the ground",
        "vis 1",
        "",
        "line 0,0 1,0",
        "# @end",
      ),
    );
  });

  it("keeps CRLF line endings", () => {
    assert.equal(
      infer("vis 1\r\nline 0,0 1,0\r\nend\r\n"),
      '# @item el-1 "Element 1" art\r\nvis 1\r\nline 0,0 1,0\r\n# @end\r\nend\r\n',
    );
  });

  it("returns pictures without drawing, and itemized sources, unchanged", () => {
    for (const source of [
      "",
      "end\n",
      text("vis 1", "pri 2", "pen 3", "end"),
      text("vis off", "fill 5,5", "end"),
      text('# @item sky "Sky" art', "vis 1", "line 0,0 1,0", "# @end"),
      text("# @end", "vis 1", "line 0,0 1,0"),
    ]) {
      assert.equal(inferNativeItems(source, opts), source);
    }
  });

  it("is byte-identical over the template corpus", () => {
    const corpus: [string, string][] = [
      ...Object.entries(TUTORIAL_PICTURE_SOURCES).map(([n, s]): [string, string] => [`t${n}`, s]),
      ...Object.entries(ORIGINAL_SCENE_PICTURES).map(([n, s]): [string, string] => [`o${n}`, s]),
    ];
    for (const game of ["synthetic", "adventure-department"]) {
      const { container } = loadGame(game);
      for (let num = 0; num < 256; num++) {
        const bytes = container.getResource("picture", num);
        if (bytes) corpus.push([`${game}/${num}`, disassemblePicture(bytes)]);
      }
    }
    assert.ok(corpus.length >= 12);
    let items = 0;
    for (const [name, source] of corpus) {
      const result = inferNativeItems(source, opts);
      assert.deepEqual(compiled(result), compiled(source), name);
      const { document, diagnostics } = parsePictureDocument(result);
      assert.deepEqual(diagnostics, [], name);
      items += document.items.length;
    }
    assert.ok(items > corpus.length, `${items} items`);
  });

  it("marks its own ids, and only those: el-N and el-N-M", () => {
    for (const id of ["el-1", "el-20", "el-1-2", "el-3-10"])
      assert.equal(isInferredItemId(id), true, id);
    for (const id of ["bench", "el", "el-", "el-x", "element-1", "el-1a", "(unassigned)"])
      assert.equal(isInferredItemId(id), false, id);
  });
});
