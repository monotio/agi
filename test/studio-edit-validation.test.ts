import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import { applyEdit, type EditOperation } from "../src/studio/editOperations.ts";
import {
  compileEditDocument,
  footprintMask,
  unionMask,
  validateEdit,
  type CompiledDocument,
} from "../src/studio/editValidation.ts";
import { inferNativeItems } from "../src/studio/nativeItems.ts";
import {
  parsePictureDocument,
  serializePictureDocument,
  type PictureDocument,
} from "../src/studio/pictureDocument.ts";
import { disassemblePicture } from "../src/picture/source.ts";
import { ORIGINAL_SCENE_PICTURES } from "../games/adventure-department/sceneArt.ts";
import { TUTORIAL_PICTURE_SOURCES } from "../games/adventure-department/game.ts";
import { loadGame } from "./game-fixture.ts";

const profile = DEFAULT_V2_PROFILE;

function doc(...lines: string[]): PictureDocument {
  const { document, diagnostics } = parsePictureDocument(lines.join("\n"));
  assert.deepEqual(diagnostics, []);
  return document;
}

function edited(document: PictureDocument, op: EditOperation): PictureDocument {
  const result = applyEdit(document, op, { profile });
  if ("error" in result) assert.fail(result.error);
  return result.document;
}

const compile = (document: PictureDocument): CompiledDocument =>
  compileEditDocument(document, profile);

/** The allowed area of an edit to `itemId`: its footprint on both planes, before OR after. */
const around = (before: CompiledDocument, after: CompiledDocument, itemId: string): Uint8Array =>
  unionMask(footprintMask(before, itemId, "both"), footprintMask(after, itemId, "both"));

describe("validateEdit", () => {
  const scene = doc(
    '# @item art "Art" art', //        1
    "vis 1", //                        2
    "line 20,40 29,40", //             3
    "# @end", //                       4
    '# @item depth "Depth" depth', //  5
    "vis off", //                      6
    "pri 10", //                       7
    "line 20,50 29,50", //             8
    "# @end", //                       9
    "end", //                          10
  );

  it("reports the exact cells a locked plane lost, and passes an unlocked one", () => {
    const before = compile(scene);
    const after = compile(edited(scene, { type: "moveItem", itemId: "depth", dx: 0, dy: 1 }));
    assert.deepEqual(validateEdit(before, after, { lockedPlanes: ["visual"] }), {
      ok: true,
      violations: [],
    });
    // Ten cells at y 50 fall back to priority 4 and ten at y 51 become 10.
    const locked = validateEdit(before, after, { lockedPlanes: ["priority"] });
    assert.equal(locked.ok, false);
    assert.deepEqual(locked.violations, [
      {
        constraint: "locked-plane",
        plane: "priority",
        count: 20,
        cells: [20, 21, 22, 23, 24, 25, 26, 27].map((x) => ({ x, y: 50 })),
        bbox: { x0: 20, y0: 50, x1: 29, y1: 51 },
        message: "20 cells changed on the locked priority plane, within 20,50..29,51",
      },
    ]);
  });

  it("checks the allowed mask on both planes and the byte budget", () => {
    const before = compile(scene);
    const after = compile(edited(scene, { type: "moveItem", itemId: "art", dx: 1, dy: 0 }));
    assert.equal(after.bytes.length, 16);
    const allowed = around(before, after, "art");
    // The old footprint 20..29 and the new one 21..30 on row 40.
    assert.deepEqual(
      Array.from(allowed.keys()).filter((i) => allowed[i] === 1),
      Array.from({ length: 11 }, (_, k) => 40 * 160 + 20 + k),
    );
    assert.deepEqual(
      validateEdit(before, after, { lockedPlanes: [], allowedMask: allowed, maxBytes: 16 }),
      {
        ok: true,
        violations: [],
      },
    );
    const result = validateEdit(before, after, {
      lockedPlanes: [],
      allowedMask: footprintMask(before, "art", "visual"),
      maxBytes: 15,
    });
    assert.deepEqual(
      result.violations.map((v) =>
        v.constraint === "max-bytes" ? v : [v.plane, v.count, v.cells, v.bbox],
      ),
      [
        ["visual", 1, [{ x: 30, y: 40 }], { x0: 30, y0: 40, x1: 30, y1: 40 }],
        {
          constraint: "max-bytes",
          bytes: 16,
          maxBytes: 15,
          over: 1,
          message: "the picture is 16 bytes, 1 over the 15-byte budget",
        },
      ],
    );
    assert.throws(
      () => validateEdit(before, after, { lockedPlanes: [], allowedMask: new Uint8Array(5) }),
      /allowedMask has 5 cells/,
    );
    assert.throws(
      () =>
        validateEdit(before, after, {
          lockedPlanes: [],
          allowedMask: { priority: new Uint8Array(5) },
        }),
      /allowedMask has 5 cells/,
    );
  });

  it("checks each plane against its own mask: an art footprint does not free the depth under it", () => {
    // An art fill after a mixed fill of the same area draws nothing; moved
    // before it, it paints the same art and leaves the mixed fill nothing
    // to flood, so the floor's depth 9 is gone from the whole room.
    const room = doc(
      '# @item frame "Frame" art',
      "vis 0",
      "rect 10,10 60,60",
      "# @end",
      '# @item floor "Floor" mixed',
      "vis 6",
      "pri 9",
      "fill 30,30",
      "# @end",
      '# @item patch "Patch" art',
      "vis 6",
      "pri off",
      "fill 30,30",
      "# @end",
      "end",
    );
    const before = compile(room);
    const after = compile(edited(room, { type: "reorderItem", itemId: "patch", toIndex: 1 }));
    const own = (plane: "visual" | "priority"): Uint8Array =>
      unionMask(footprintMask(before, "patch", plane), footprintMask(after, "patch", plane));
    // The single mask is the union of both planes: the lost depth lies inside it.
    assert.deepEqual(
      validateEdit(before, after, { lockedPlanes: [], allowedMask: around(before, after, "patch") })
        .violations,
      [],
    );
    const perPlane = validateEdit(before, after, {
      lockedPlanes: [],
      allowedMask: { visual: own("visual"), priority: own("priority") },
    });
    assert.deepEqual(
      perPlane.violations.map(
        (v) => v.constraint !== "max-bytes" && [v.constraint, v.plane, v.count],
      ),
      [["outside-mask", "priority", 49 * 49]],
    );
    // A plane the per-plane form leaves out is not restricted.
    assert.equal(
      validateEdit(before, after, { lockedPlanes: [], allowedMask: { visual: own("visual") } }).ok,
      true,
    );
  });
});

describe("edit properties on decoded planes", () => {
  it("moving a depth-only item never changes a visual pixel", () => {
    const document = doc(
      "vis 2",
      "rect 10,10 60,60",
      "fill 30,30",
      '# @item d "Depth" depth',
      "vis off",
      "pri 9",
      "polygon 15,15 40,15 40,40",
      "fill 30,20",
      "# @end",
      "end",
    );
    const before = compile(document);
    for (const [dx, dy] of [
      [3, 2],
      [-5, 7],
      [0, -4],
    ] as const) {
      const after = compile(edited(document, { type: "moveItem", itemId: "d", dx, dy }));
      assert.deepEqual(validateEdit(before, after, { lockedPlanes: ["visual"] }).violations, []);
      assert.ok(!validateEdit(before, after, { lockedPlanes: ["priority"] }).ok);
    }
  });

  // A's line is crossed by B; the loose line after A draws with A's colour.
  const shared = doc(
    '# @item a "A" art', // 1
    "vis 1", //             2
    "line 0,0 9,0", //      3
    "# @end", //            4
    "line 0,5 9,5", //      5
    '# @item b "B" art', // 6
    "vis 3", //             7
    "line 5,0 5,9", //      8
    "# @end", //            9
    "end", //               10
  );

  it("recolouring A changes only A's footprint, though a loose line relied on its state", () => {
    const before = compile(shared);
    const after = compile(
      edited(shared, { type: "setItemColor", itemId: "a", plane: "visual", value: 2 }),
    );
    assert.deepEqual(
      validateEdit(before, after, {
        lockedPlanes: ["priority"],
        allowedMask: around(before, after, "a"),
      }).violations,
      [],
    );
    // A owns nine cells of row 0 (B crosses at 5,0); all nine change.
    const changed = validateEdit(before, after, { lockedPlanes: ["visual"] }).violations[0];
    assert.equal(changed?.constraint === "locked-plane" && changed.count, 9);

    // Control: rewriting A's colour without restoring the state repaints the loose line.
    const naive = compile(doc(...shared.lines.map((line, i) => (i === 1 ? "vis 2" : line))));
    const leaked = validateEdit(before, naive, {
      lockedPlanes: [],
      allowedMask: around(before, naive, "a"),
    }).violations[0];
    assert.equal(leaked?.constraint === "outside-mask" && leaked.count, 9);
  });

  it("deleting A restores the state its followers drew with", () => {
    const before = compile(shared);
    const after = compile(edited(shared, { type: "deleteItem", itemId: "a" }));
    assert.deepEqual(
      validateEdit(before, after, {
        lockedPlanes: ["priority"],
        allowedMask: footprintMask(before, "a", "both"),
      }).violations,
      [],
    );
    assert.equal(after.visual[5 * 160 + 3], 1);
  });

  it("reordering and duplicating keep every pixel outside the items' footprints", () => {
    const before = compile(shared);
    const reordered = compile(edited(shared, { type: "reorderItem", itemId: "a", toIndex: 1 }));
    // Only 5,0, where A and B cross, may change: A now draws over B.
    assert.deepEqual(
      validateEdit(before, reordered, {
        lockedPlanes: [],
        allowedMask: unionMask(around(before, reordered, "a"), around(before, reordered, "b")),
      }).violations,
      [],
    );
    const duplicated = compile(
      edited(shared, {
        type: "duplicateItem",
        itemId: "a",
        dx: 0,
        dy: 20,
        newId: "a2",
        newLabel: "A2",
      }),
    );
    assert.deepEqual(
      validateEdit(before, duplicated, {
        lockedPlanes: ["priority"],
        allowedMask: footprintMask(duplicated, "a2", "both"),
      }).violations,
      [],
    );
  });

  it("setItemMeta produces identical bytes", () => {
    const after = edited(shared, {
      type: "setItemMeta",
      itemId: "b",
      label: "Beam",
      kind: "mixed",
      locked: true,
    });
    assert.deepEqual(compile(after).bytes, compile(shared).bytes);
    assert.equal(after.items[1]?.locked, true);
  });
});

/**
 * Move every item +1,0 then -1,0: the round trip must give back the same
 * source and bytes, or the first move must refuse for a stated reason.
 */
function roundTrips(corpus: readonly (readonly [string, string])[]): Record<string, number> {
  const counts = { items: 0, roundTrips: 0, edge: 0, raw: 0, copy: 0 };
  for (const [name, source] of corpus) {
    const { document, diagnostics } = parsePictureDocument(inferNativeItems(source, { profile }));
    assert.deepEqual(diagnostics, [], name);
    const original = compile(document).bytes;
    for (const item of document.items) {
      counts.items++;
      const where = `${name}/${item.id}`;
      const there = applyEdit(document, { type: "moveItem", itemId: item.id, dx: 1, dy: 0 });
      if ("error" in there) {
        const category = /off the surface/.test(there.error)
          ? "edge"
          : /raw bytes/.test(there.error)
            ? "raw"
            : /copy/.test(there.error)
              ? "copy"
              : assert.fail(`${where}: ${there.error}`);
        counts[category]++;
        if (category === "edge") {
          // Independent check: the item really reaches the right edge.
          const body = document.lines.slice(item.openLine, item.closeLine - 1).join(" ");
          assert.match(body, /\b159\b/, where);
        }
        continue;
      }
      const back = applyEdit(there.document, { type: "moveItem", itemId: item.id, dx: -1, dy: 0 });
      if ("error" in back) assert.fail(`${where}: ${back.error}`);
      assert.equal(
        serializePictureDocument(back.document),
        serializePictureDocument(document),
        where,
      );
      assert.deepEqual(compile(back.document).bytes, original, where);
      counts.roundTrips++;
    }
  }
  assert.equal(counts.items, counts.roundTrips + counts.edge + counts.raw + counts.copy);
  assert.ok(counts.roundTrips > 0);
  return counts;
}

describe("moveItem round trip", () => {
  it("returns every movable item of the original scene corpus to identical source and bytes", (t) => {
    const counts = roundTrips(Object.entries(ORIGINAL_SCENE_PICTURES));
    t.diagnostic(JSON.stringify(counts));
  });

  it("does the same over the tutorial sources and the built games' disassembled pictures", (t) => {
    const corpus: [string, string][] = Object.entries(TUTORIAL_PICTURE_SOURCES).map(
      ([n, s]): [string, string] => [`t${n}`, s],
    );
    for (const game of ["synthetic", "adventure-department"]) {
      const { container } = loadGame(game);
      for (let num = 0; num < 256; num++) {
        const bytes = container.getResource("picture", num);
        if (bytes) corpus.push([`${game}/${num}`, disassemblePicture(bytes, { profile })]);
      }
    }
    const counts = roundTrips(corpus);
    t.diagnostic(JSON.stringify(counts));
  });
});
