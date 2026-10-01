import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { whyNotFilled } from "../../src/studio/pictureQuery.ts";
import { fillFix, fillNotice, spotName } from "../src/studio/fillAdvice.ts";
import { insertionPoint } from "../src/studio/studioTools.ts";
import { useStudioDocument } from "../src/studio/useStudioDocument.ts";

const profile = DEFAULT_V2_PROFILE;

/** A picture modelled as Studio does, with the fill tool's question asked at its end. */
function asked(lines: readonly string[], x: number, y: number) {
  const doc = useStudioDocument(() => ({ source: lines.join("\n"), trusted: true, profile }));
  const at = doc.total.value;
  const why = whyNotFilled(doc.compiledAt(at), x, y, "visual")!;
  const model = { document: doc.model.value.document, spans: doc.model.value.compiled.spans };
  return { doc, at, why, fix: fillFix(why, at, model, doc.compiledAt) };
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
  it("says what the spot holds, why, and moves the drawing before what painted it", () => {
    const { doc, why, fix } = asked(GROUND, 24, 86);
    assert.deepEqual([why.value, why.line, why.fillable], [10, 3, false]);
    // Ground's first command (vis 10) is step 0: drawn there, the new shape goes before it.
    assert.deepEqual(fix, { step: 0, before: "Ground", direct: true });
    const { document, compiled } = doc.model.value;
    assert.deepEqual(insertionPoint(document, compiled.spans, doc.total.value, fix!.step), {
      atLine: 1,
      index: 0,
    });
    assert.deepEqual(fillNotice(why, "Ground", fix), {
      summary: "Fill stops here: this spot is already light green.",
      short: "Fill stops here",
      detail:
        "An AGI fill only spreads over white. The light green here was painted earlier by line 3 (Ground), so draw your shape before it in the draw order. A filled rectangle or polygon paints every pixel itself, so it works anywhere.",
      action: "Draw before Ground",
    });
  });

  it("goes further back, and says so, when something earlier covers the spot too", () => {
    const stripe = [
      ...GROUND.slice(0, 4),
      '# @item stripe "Stripe" art', //  5
      "vis 12", //                       6
      "line 20,86 30,86", //             7
      "# @end", //                       8
      "end",
    ];
    const { why, fix } = asked(stripe, 24, 86);
    assert.deepEqual([why.value, why.line], [12, 7]);
    // Before Stripe (step 2) the spot is still Ground's green; before Ground (step 0) it is white.
    assert.deepEqual(fix, {
      step: 0,
      before: "Ground",
      direct: false,
      still: { value: 10, line: 3, label: "Ground" },
    });
    assert.deepEqual(fillNotice(why, "Stripe", fix), {
      summary: "Fill stops here: this spot is already light red.",
      short: "Fill stops here",
      detail:
        "An AGI fill only spreads over white. The light red here was painted earlier by line 7 (Stripe), so draw your shape before it in the draw order. Before Stripe it is still light green, painted by line 3 (Ground), so it is white only before Ground. A filled rectangle or polygon paints every pixel itself, so it works anywhere.",
      action: "Draw before Ground",
    });
  });

  it("names depth in bands and control lines by what they do", () => {
    assert.equal(spotName("visual", 10), "light green");
    assert.equal(spotName("priority", 9), "depth band 9");
    assert.equal(spotName("priority", 0), "a Wall line");
    const why = { plane: "priority", x: 1, y: 1, value: 9, target: 4, line: 5 } as const;
    assert.equal(
      fillNotice({ ...why, fillable: false, message: "" }, null, null).detail,
      "An AGI fill only spreads over uncoloured depth. The depth band 9 here was painted earlier by line 5, so draw your shape before it in the draw order. A filled rectangle or polygon paints every pixel itself, so it works anywhere.",
    );
  });
});
