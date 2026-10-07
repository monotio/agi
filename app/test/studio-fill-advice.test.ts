import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { whyNotFilled } from "../../src/studio/pictureQuery.ts";
import { fillNotice, spotName } from "../src/studio/fillAdvice.ts";
import { useStudioDocument } from "../src/studio/useStudioDocument.ts";

const profile = DEFAULT_V2_PROFILE;

/** A picture modelled as Studio does, with the fill tool's question asked at its end. */
function asked(lines: readonly string[], x: number, y: number) {
  const doc = useStudioDocument(() => ({ source: lines.join("\n"), trusted: true, profile }));
  const at = doc.total.value;
  const why = whyNotFilled(doc.compiledAt(at), x, y, "visual")!;
  return { doc, at, why };
}

// A white picture flooded light green (10), then a new outline drawn last.
const GROUND = [
  '# @item ground "Ground" art', //   1
  "vis 10", //                        2
  "fill 80,84", //                    3
  "# @end", //                        4
  '# @item outline "Outline" art', // 5
  "vis 0", //                         6
  "rect 20,80 30,90", //              7
  "# @end", //                        8
  "end", //                           9
];

describe("a fill that would flood nothing", () => {
  it("says what the spot holds and why, with no draw-order fix", () => {
    const { why } = asked(GROUND, 24, 86);
    assert.deepEqual([why.value, why.line, why.fillable], [10, 3, false]);
    // The "Draw before …" action is gone: the bucket recolours the painter instead.
    assert.deepEqual(fillNotice(why, "Ground"), {
      summary: "Fill stops here: this spot is already light green.",
      short: "Fill stops here",
      detail:
        "An AGI fill only spreads over white. The light green here was painted earlier by line 3 (Ground), and the step that painted it is one the bucket cannot recolour.",
    });
  });

  it("names depth in bands and control lines by what they do", () => {
    assert.equal(spotName("visual", 10), "light green");
    assert.equal(spotName("priority", 9), "depth band 9");
    assert.equal(spotName("priority", 0), "a Wall line");
    const why = { plane: "priority", x: 1, y: 1, value: 9, target: 4, line: 5 } as const;
    assert.equal(
      fillNotice({ ...why, fillable: false, message: "" }, null).detail,
      "An AGI fill only spreads over uncoloured depth. The depth band 9 here was painted earlier by line 5, and the step that painted it is one the bucket cannot recolour.",
    );
  });
});
