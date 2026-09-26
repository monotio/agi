import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dominantValues,
  EGA_COLOUR_NAMES,
  groupSceneItems,
  sectionSceneRows,
} from "../src/studio/sceneGroups.ts";

describe("groupSceneItems", () => {
  it("folds consecutive items that share kind and value, in draw order", () => {
    const groups = groupSceneItems([
      { kind: "art", value: 6 }, // 0 brown
      { kind: "art", value: 6 }, // 1 brown
      { kind: "art", value: 6 }, // 2 brown
      { kind: "art", value: 0 }, // 3 black breaks the run
      { kind: "art", value: 6 }, // 4 brown again: a new group, not the first one
      { kind: "mixed", value: 6 }, // 5 same colour, other kind
      { kind: "depth", value: 10 }, // 6
      { kind: "depth", value: 10 }, // 7
      { kind: "walk", value: 10 }, // 8 same value, other kind
      { kind: "walk", value: 0 }, // 9
      { kind: "walk", value: 0 }, // 10
    ]);
    assert.deepEqual(groups, [
      { start: 0, count: 3, kind: "art", value: 6 },
      { start: 3, count: 1, kind: "art", value: 0 },
      { start: 4, count: 1, kind: "art", value: 6 },
      { start: 5, count: 1, kind: "mixed", value: 6 },
      { start: 6, count: 2, kind: "depth", value: 10 },
      { start: 8, count: 1, kind: "walk", value: 10 },
      { start: 9, count: 2, kind: "walk", value: 0 },
    ]);
  });

  it("groups covered items (no pixels left) together and apart from colour 0", () => {
    const groups = groupSceneItems([
      { kind: "art", value: null },
      { kind: "art", value: null },
      { kind: "art", value: 0 },
    ]);
    assert.deepEqual(groups, [
      { start: 0, count: 2, kind: "art", value: null },
      { start: 2, count: 1, kind: "art", value: 0 },
    ]);
  });

  it("covers every item exactly once", () => {
    assert.deepEqual(groupSceneItems([]), []);
    assert.deepEqual(groupSceneItems([{ kind: "walk", value: 2 }]), [
      { start: 0, count: 1, kind: "walk", value: 2 },
    ]);
  });

  it("names the sixteen EGA colours", () => {
    assert.equal(EGA_COLOUR_NAMES.length, 16);
    assert.equal(EGA_COLOUR_NAMES[6], "brown");
    assert.equal(EGA_COLOUR_NAMES[15], "white");
  });
});

describe("sectionSceneRows", () => {
  const ones = (n: number): number[] => Array.from({ length: n }, () => 1);

  it("leaves lists of at most 60 rows alone", () => {
    assert.equal(sectionSceneRows(ones(60)), null);
    assert.notEqual(sectionSceneRows(ones(61)), null);
  });

  it("splits 70 even rows into equal runs", () => {
    // Target 7: a share is 10 commands, so every tenth row closes a section.
    assert.deepEqual(
      sectionSceneRows(ones(70), { target: 7 }),
      Array.from({ length: 7 }, (_, k) => ({ start: 10 * k, count: 10 })),
    );
    // The default target of 36: every share (70/36 = 1.94 rows) needs a row of
    // its own, so 36 sections of one or two rows cover all 70.
    const spans = sectionSceneRows(ones(70))!;
    assert.equal(spans.length, 36);
    assert.equal(
      spans.reduce((n, span) => n + span.count, 0),
      70,
    );
    assert.ok(spans.every((span) => span.count === 1 || span.count === 2));
  });

  it("never splits a heavy row, which swallows the shares it spans", () => {
    // 70 rows weigh 169 (row 5 weighs 100); target 4 puts shares at
    // 42.25, 84.5 and 126.75. Row 5 ends at 105, past the first two shares;
    // row 27 ends at 127, past the third; the rest closes the list.
    const weights = ones(70);
    weights[5] = 100;
    assert.deepEqual(sectionSceneRows(weights, { target: 4 }), [
      { start: 0, count: 6 },
      { start: 6, count: 22 },
      { start: 28, count: 42 },
    ]);
  });

  it("weighs an empty row as one command", () => {
    // 62 rows of weight 0 weigh 62, so target 2 splits at 31.
    assert.deepEqual(
      sectionSceneRows(
        Array.from({ length: 62 }, () => 0),
        { target: 2 },
      ),
      [
        { start: 0, count: 31 },
        { start: 31, count: 31 },
      ],
    );
  });
});

describe("dominantValues", () => {
  it("ranks values by total weight, then by value, skipping null", () => {
    const entries = [
      { value: 6, weight: 5 },
      { value: 0, weight: 2 },
      { value: 6, weight: 1 },
      { value: null, weight: 9 },
      { value: 1, weight: 2 },
      { value: 3, weight: 1 },
    ];
    assert.deepEqual(dominantValues(entries), [6, 0, 1]);
    assert.deepEqual(dominantValues(entries, 2), [6, 0]);
    assert.deepEqual(dominantValues([]), []);
  });
});
