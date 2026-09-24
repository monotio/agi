import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileViewSource, VIEW_SOURCE_DOC } from "../src/view/viewSource.ts";
import { buildView, parseView, selectViewCel } from "../src/view/view.ts";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";

/** A four-facing walking actor, 8x26: side, front and back drawn, left mirrored. */
const ACTOR = `view
cel side0 8 26 F
........
...666..
..66666.
..6E6E6.
...EE...
..CCCC..
..4C4C..
.774447.
.774447.
.744447.
..4444..
..4444..
..4444..
..4444..
..4444..
..4444..
...44...
...44...
...44...
...44...
...44...
...77...
...77...
...77...
..7777..
..8888..
endcel
cel side1 copy side0
row 6 .74C4C7.
row 22 ..77....
row 25 ..88....
endcel
cel front0 copy side0
row 3 .6E66E6.
row 24 ..8..8..
endcel
cel back0 copy front0
row 3 .666666.
endcel
loop 0 side0 side1
loop 1 mirror 0
loop 2 front0
loop 3 back0
endview
`;

const CHEST = `view
description "An iron-bound chest"
cel chest 20 12 F
....................
...00000000000000...
..6666666666666666..
.6EEEEEEEEEEEEEEEE6.
.666666666666666666.
.6666666EEEE6666666.
.0000000E00E0000000.
..666666E00E666666..
..644444EEEE444446..
..6444444444444446..
..6666666666666666..
..0000000000000000..
endcel
loop 0 chest
endview
`;

/** One decoded row of a compiled cel, written back as symbols with "." for transparent. */
function rowOf(source: string, loop: number, cel: number, y: number): string {
  const view = parseView(buildView(compileViewSource(source)), DEFAULT_V2_PROFILE);
  const selected = selectViewCel(view, loop, cel)!;
  const pixels = [...selected.pixels.subarray(y * selected.width, (y + 1) * selected.width)];
  return pixels
    .map((colour) =>
      colour === selected.transparentColor ? "." : colour.toString(16).toUpperCase(),
    )
    .join("");
}

describe("view source", () => {
  it("compiles a walking actor: copies replace only their rows, and left mirrors right", () => {
    const input = compileViewSource(ACTOR);
    assert.equal(input.loops.length, 4);
    assert.deepEqual(input.loops[1], { mirrorLoop: 0 });
    // Unchanged rows carry over; replaced rows are exactly the new symbols.
    assert.equal(rowOf(ACTOR, 0, 1, 0), "........");
    assert.equal(rowOf(ACTOR, 0, 1, 5), "..CCCC..");
    assert.equal(rowOf(ACTOR, 0, 1, 6), ".74C4C7.");
    assert.equal(rowOf(ACTOR, 0, 1, 22), "..77....");
    // A copy of a copy sees its base's edits and adds its own.
    assert.equal(rowOf(ACTOR, 3, 0, 3), ".666666.");
    assert.equal(rowOf(ACTOR, 3, 0, 24), "..8..8..");
    // The mirrored loop shows the right-facing cels flipped left to right.
    assert.equal(rowOf(ACTOR, 1, 0, 3), "6E6E6..".padStart(8, "."));
    assert.equal(rowOf(ACTOR, 1, 1, 22), "....77..");
  });

  it("compiles a one-cel prop with its description", () => {
    const input = compileViewSource(CHEST);
    assert.equal(input.description, "An iron-bound chest");
    assert.equal(rowOf(CHEST, 0, 0, 6), ".0000000E00E0000000.");
    const view = parseView(buildView(input), DEFAULT_V2_PROFILE);
    assert.equal(view.description, "An iron-bound chest");
    assert.equal(selectViewCel(view, 0, 0)!.width, 20);
  });

  it("names the line and the fix for every malformed source, and pads nothing", () => {
    const cel = (rows: string, extra = "loop 0 a") =>
      `view\ncel a 3 2 0\n${rows}\nendcel\n${extra}\nendview`;
    const cases: [string, RegExp][] = [
      [cel("123\n1234"), /line 4: cel a row 1 has 4 symbols; its width is 3\. Send exactly 3\./],
      [cel("123"), /line 4: cel a has 1 rows; its height is 2/],
      [cel("123\n12G"), /line 4: cel a row 1 "12G" may use only 0-9, A-F/],
      [cel("123\n123\n123"), /line 5: cel a has more than 2 rows/],
      [cel("123\n123", "loop 0 b"), /line 6: loop 0 uses cel b, which is not defined above/],
      [cel("123\n123", "loop 1 a"), /expected loop 0/],
      [cel("123\n123", "loop 0 a\nloop 1 mirror 1"), /can mirror only an earlier loop/],
      [cel("123\n123", "loop 0 a\nloop 1 mirror 0\nloop 2 mirror 1"), /loop 1 is itself a mirror/],
      [cel("123\n123", "cel b copy c\nendcel\nloop 0 a"), /copies c, which is not defined above/],
      [
        cel("123\n123", "cel b copy a\nrow 0 ...\nrow 0 111\nendcel\nloop 0 b"),
        /replaces row 0 twice/,
      ],
      [cel("123\n123", "cel b copy a\nrow 2 ...\nendcel\nloop 0 b"), /row 2 is outside 0-1/],
      [cel("123\n123", "cel a copy a\nendcel\nloop 0 a"), /cel a is already defined/],
      [cel("123\n123", "loop 0 a\ndance"), /unknown command "dance"/],
      [cel("123\n123", "description 'x'\nloop 0 a"), /description must be a JSON string/],
      ["view\ncel a 0 2 0\nendcel\nendview", /cel a width 0 is outside 1-160/],
      ["view\ncel a 161 1 0\nendcel\nendview", /width 161 is outside 1-160/],
      ["view\ncel a 1 169 0\nendcel\nendview", /height 169 is outside 1-168/],
      ["view\ncel loop 1 1 0\n1\nendcel\nendview", /is not a cel name/],
      [cel("123\n123").replace("\nendview", ""), /must end with "endview"/],
      [`${cel("123\n123")}\nloop 1 a`, /nothing may follow "endview"/],
      ["cel a 1 1 0\n1\nendcel\nendview", /must start with "view"/],
      ["view\nendview", /at least one loop/],
      // Luna left out "copy" once, and four times sent a source that ended
      // after one row; both messages now name the whole fix.
      [cel("123\n123", "cel b a\nendcel\nloop 0 b"), /line 6: to copy a, write "cel b copy a"/],
      [
        "view\ncel a 3 2 0\n123",
        /the source ends inside cel a after 1 of 2 rows: send all 2 rows, then endcel, the loops and endview/,
      ],
    ];
    for (const [source, message] of cases)
      assert.throws(() => compileViewSource(source), message, source);
  });

  it("accepts a name after view and compiles the example in its own documentation", () => {
    // GPT-6 Luna wrote "view wenna" six times; the name carries no meaning.
    assert.deepEqual(
      compileViewSource(CHEST.replace("view\n", "view chest\n")),
      compileViewSource(CHEST),
    );
    assert.throws(
      () => compileViewSource(CHEST.replace("view\n", "view a b\n")),
      /start with "view"/,
    );
    const example = /\n(view\n[\s\S]*?\nendview)/.exec(VIEW_SOURCE_DOC)?.[1];
    assert.ok(example, "the documentation shows a complete view");
    const input = compileViewSource(example);
    assert.equal(input.loops.length, 2);
    assert.deepEqual(input.loops[1], { mirrorLoop: 0 });
  });

  it("accepts the description before view as well as inside it", () => {
    // GPT-6 Luna opened both of its first views with the description line.
    const inside = compileViewSource(CHEST);
    const before = compileViewSource(
      `description "An iron-bound chest"\n${CHEST.replace('description "An iron-bound chest"\n', "")}`,
    );
    assert.deepEqual(before, inside);
    assert.throws(
      () => compileViewSource(`description "a"\n${CHEST}`),
      /line 3: a view has one description/,
    );
  });

  it("treats a transparent digit and a dot alike, and reads blank lines and CRLF", () => {
    const input = compileViewSource(
      "view\r\n\r\ncel a 3 1 5\r\n.5A\r\nendcel\r\nloop 0 a\r\nendview\r\n",
    );
    assert.deepEqual([...input.loops[0]!.cels![0]!.pixels], [5, 5, 10]);
  });
});
