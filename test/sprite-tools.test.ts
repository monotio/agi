import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
import { executeSpriteTool, SPRITE_TOOLS } from "../src/agent/spriteTools.ts";
import { buildView, parseView, selectViewCel } from "../src/view/view.ts";

/** A four-direction actor: right, down and up drawn, left mirrored from right. */
const ACTOR = `view
description "Four-way actor"
cel right 3 2 0
120
340
endcel
cel down 3 2 0
506
780
endcel
cel up 3 2 0
90A
BC0
endcel
loop 0 right
loop 1 mirror 0
loop 2 down
loop 3 up
endview`;

const writeView = (state: ReturnType<typeof createAgentSessionState>, source: string, num = 0) =>
  executeAgentTool(state, "write_view", { num, source });

describe("sprite authoring tools", () => {
  it("advertises strict, bounded schemas", () => {
    assert.deepEqual(
      SPRITE_TOOLS.map((tool) => tool.name),
      ["patch_view_cels"],
    );
    for (const tool of SPRITE_TOOLS) {
      assert.equal(tool.parameters.additionalProperties, false);
      assert.deepEqual(
        Object.keys(tool.parameters.properties).sort(),
        [...tool.parameters.required].sort(),
      );
    }
  });

  it("writes a four-direction actor from source, left mirrored from right", () => {
    const state = createAgentSessionState();
    const result = writeView(state, ACTOR);
    assert.equal(result?.success, true);
    const payload = state.container.getResource("view", 0)!;
    const view = parseView(payload, state.profile);
    assert.equal(view.loops.length, 4);
    assert.deepEqual([...selectViewCel(view, 0, 0)!.pixels], [1, 2, 0, 3, 4, 0]);
    assert.deepEqual([...selectViewCel(view, 1, 0)!.pixels], [0, 2, 1, 0, 4, 3]);
    assert.deepEqual([...selectViewCel(view, 2, 0)!.pixels], [5, 0, 6, 7, 8, 0]);
    assert.deepEqual([...selectViewCel(view, 3, 0)!.pixels], [9, 0, 10, 11, 12, 0]);
    assert.deepEqual(result?.details?.["writtenResources"], [{ kind: "view", num: 0 }]);
    assert.equal(typeof result?.details?.["revision"], "string");
    assert.equal(result?.images?.length, 1);
  });

  it("takes as many cels per loop as the interpreter allows", () => {
    // The facings shorthand capped every direction at 15 cels, the limit of
    // packed-header interpreters only; 2.936 allows 255.
    const state = createAgentSessionState();
    const walk = Array.from({ length: 20 }, (_, index) => (index % 2 ? "a" : "b")).join(" ");
    const long = writeView(
      state,
      `view\ncel a 3 1 0\n120\nendcel\ncel b copy a\nrow 0 021\nendcel\nloop 0 ${walk}\nendview`,
      2,
    );
    assert.equal(long?.success, true, long?.error ?? "");
    assert.equal(
      parseView(state.container.getResource("view", 2)!, state.profile).loops[0]!.cels.length,
      20,
    );
  });

  it("writes a view whose walk does not move, and tells the model why", () => {
    const state = createAgentSessionState();
    const result = writeView(
      state,
      "view\ncel a 3 1 0\n120\nendcel\ncel b copy a\nendcel\nloop 0 a b\nendview",
    );
    assert.equal(result?.success, true, result?.error ?? "");
    assert.match(result?.message ?? "", /Loop 0: cels 0 and 1 are identical/);
    assert.deepEqual(result?.details?.["warnings"], [
      "Loop 0: cels 0 and 1 are identical, so that step shows no motion; change the rows that move (for a walk, the legs).",
    ]);
  });

  it("rejects a malformed row before writing, naming the cel, row and fix", () => {
    const state = createAgentSessionState();
    const uneven = writeView(state, ACTOR.replace("340", "34"));
    assert.equal(uneven?.success, false);
    assert.match(
      uneven?.error ?? "",
      /View 0 was not written: line 5: cel right row 1 has 2 symbols; its width is 3/,
    );
    assert.equal(state.container.getResource("view", 0), null);
    const invalid = writeView(state, ACTOR.replace("120", "12G"));
    assert.equal(invalid?.success, false);
    assert.match(invalid?.error ?? "", /"12G" may use only 0-9, A-F/);
    assert.equal(state.container.getResource("view", 0), null);
  });

  it("reads one selected cel as exact rendered rows, colors and revision", () => {
    const state = createAgentSessionState();
    writeView(state, ACTOR);
    const result = executeAgentTool(state, "read_view", {
      num: 0,
      cels: [{ loop: 1, cel: 0 }],
      rows: true,
    });
    assert.equal(result?.success, true);
    assert.deepEqual(result?.details?.["rows"], [{ loop: 1, cel: 0, rows: ["021", "043"] }]);
    const cels = result?.details?.["cels"] as {
      loop: number;
      cel: number;
      width: number;
      height: number;
    }[];
    assert.ok(cels.some((c) => c.loop === 1 && c.cel === 0 && c.width === 3 && c.height === 2));
    assert.equal(typeof result?.details?.["revision"], "string");
    assert.equal(result?.images?.length, 1);
  });

  it("returns every row of a maximum-height cel in one call", () => {
    const state = createAgentSessionState();
    const row = "1".repeat(160);
    state.container.putResource(
      "view",
      3,
      buildView({
        loops: [
          {
            cels: [
              {
                width: 160,
                height: 168,
                transparentColor: 0,
                pixels: new Uint8Array(160 * 168).fill(1),
              },
            ],
          },
        ],
      }),
    );

    const result = executeAgentTool(state, "read_view", {
      num: 3,
      cels: [{ loop: 0, cel: 0 }],
      rows: true,
    })!;
    assert.equal(result.success, true);
    assert.deepEqual(result.details?.["rows"], [
      { loop: 0, cel: 0, rows: new Array(168).fill(row) },
    ]);
  });

  it("rejects a stale revision atomically", () => {
    const state = createAgentSessionState();
    writeView(state, ACTOR);
    const before = state.container.getResource("view", 0)!.slice();
    const result = executeSpriteTool(state, "patch_view_cels", {
      num: 0,
      expectedRevision: "view:stale",
      patches: [{ loop: 2, cel: 0, rows: ["111", "111"] }],
    });
    assert.equal(result?.success, false);
    assert.match(result?.error ?? "", /stale/i);
    assert.deepEqual(state.container.getResource("view", 0), before);
  });

  it("patches only the selected cel and preserves other cels and mirrored directions", () => {
    const state = createAgentSessionState();
    state.container.putResource(
      "view",
      7,
      buildView({
        description: "Aliased actor",
        loops: [
          {
            cels: [
              { width: 3, height: 1, transparentColor: 0, pixels: [1, 2, 0] },
              { width: 3, height: 1, transparentColor: 0, pixels: [3, 4, 0] },
            ],
          },
          { mirrorLoop: 0 },
          { cels: [{ width: 2, height: 1, transparentColor: 0, pixels: [5, 0] }] },
        ],
      }),
    );
    const read = executeAgentTool(state, "read_view", {
      num: 7,
      cels: [{ loop: 1, cel: 0 }],
      rows: true,
    })!;
    const result = executeSpriteTool(state, "patch_view_cels", {
      num: 7,
      expectedRevision: read.details?.["revision"],
      patches: [{ loop: 1, cel: 0, rows: ["E0D"] }],
    });
    assert.equal(result?.success, true);
    assert.match(result?.adjustments?.[0] ?? "", /isolated/i);

    const view = parseView(state.container.getResource("view", 7)!, state.profile);
    assert.deepEqual([...selectViewCel(view, 0, 0)!.pixels], [1, 2, 0]);
    assert.deepEqual([...selectViewCel(view, 0, 1)!.pixels], [3, 4, 0]);
    assert.deepEqual([...selectViewCel(view, 1, 0)!.pixels], [14, 0, 13]);
    assert.deepEqual([...selectViewCel(view, 1, 1)!.pixels], [0, 4, 3]);
    assert.deepEqual([...selectViewCel(view, 2, 0)!.pixels], [5, 0]);
    assert.equal(view.description, "Aliased actor");
  });

  it("recolors cels in place without touching transparent pixels", () => {
    const state = createAgentSessionState();
    state.container.putResource(
      "view",
      7,
      buildView({
        loops: [
          { cels: [{ width: 3, height: 1, transparentColor: 0, pixels: [4, 6, 0] }] },
          { mirrorLoop: 0 },
        ],
      }),
    );
    const revision = String(
      executeAgentTool(state, "read_view", { num: 7, cels: [{ loop: 0, cel: 0 }], rows: true })!
        .details?.["revision"],
    );
    const result = executeSpriteTool(state, "patch_view_cels", {
      num: 7,
      expectedRevision: revision,
      patches: [{ loop: 0, cel: 0, rows: null, recolor: [{ from: 4, to: 12 }] }],
    });
    assert.equal(result?.success, true, result?.error ?? "");
    const view = parseView(state.container.getResource("view", 7)!, state.profile);
    // Only color 4 remapped; color 6 and the transparent pixel are untouched.
    assert.deepEqual([...selectViewCel(view, 0, 0)!.pixels], [12, 6, 0]);
    // The mirrored loop is copy-on-write: it keeps its original pixels.
    assert.deepEqual([...selectViewCel(view, 1, 0)!.pixels], [0, 6, 4]);

    const remapped = state.container.getResource("view", 7)!.slice();
    const xor = executeSpriteTool(state, "patch_view_cels", {
      num: 7,
      expectedRevision: String(result?.details?.["revision"]),
      patches: [{ loop: 0, cel: 0, rows: ["111"], recolor: [{ from: 1, to: 2 }] }],
    });
    assert.equal(xor?.success, false);
    assert.match(xor?.error ?? "", /exactly one of/);
    const transparent = executeSpriteTool(state, "patch_view_cels", {
      num: 7,
      expectedRevision: String(result?.details?.["revision"]),
      patches: [{ loop: 0, cel: 0, rows: null, recolor: [{ from: 0, to: 5 }] }],
    });
    assert.equal(transparent?.success, false);
    assert.match(transparent?.error ?? "", /transparent/);
    assert.deepEqual(state.container.getResource("view", 7), remapped);
  });

  it("patches a mirrored target and its source in one batch without cross-talk", () => {
    const state = createAgentSessionState();
    state.container.putResource(
      "view",
      7,
      buildView({
        loops: [
          {
            cels: [
              { width: 3, height: 1, transparentColor: 0, pixels: [1, 2, 0] },
              { width: 3, height: 1, transparentColor: 0, pixels: [3, 4, 0] },
            ],
          },
          { mirrorLoop: 0 },
        ],
      }),
    );
    const revision = String(
      executeAgentTool(state, "read_view", { num: 7, cels: [{ loop: 0, cel: 0 }], rows: true })!
        .details?.["revision"],
    );
    const result = executeSpriteTool(state, "patch_view_cels", {
      num: 7,
      expectedRevision: revision,
      patches: [
        { loop: 0, cel: 0, rows: ["ABC"] },
        { loop: 1, cel: 1, rows: ["DEF"] },
      ],
    })!;
    assert.equal(result.success, true, result.error ?? "");
    assert.match(result.adjustments?.[0] ?? "", /isolated/i);

    const view = parseView(state.container.getResource("view", 7)!, state.profile);
    // The source loop keeps its own patch; the mirrored loop keeps the second
    // cel patched and the first cel still mirrored from the original data.
    assert.deepEqual([...selectViewCel(view, 0, 0)!.pixels], [10, 11, 12]);
    assert.deepEqual([...selectViewCel(view, 0, 1)!.pixels], [3, 4, 0]);
    assert.deepEqual([...selectViewCel(view, 1, 0)!.pixels], [0, 2, 1]);
    assert.deepEqual([...selectViewCel(view, 1, 1)!.pixels], [13, 14, 15]);

    const duplicate = executeSpriteTool(state, "patch_view_cels", {
      num: 7,
      expectedRevision: String(result.details?.["revision"]),
      patches: [
        { loop: 0, cel: 0, rows: ["999"] },
        { loop: 0, cel: 0, rows: ["888"] },
      ],
    })!;
    assert.equal(duplicate.success, false);
    assert.match(duplicate.error ?? "", /duplicate target/);

    const absent = executeSpriteTool(state, "patch_view_cels", {
      num: 7,
      expectedRevision: String(result.details?.["revision"]),
      patches: [{ loop: 9, cel: 0, rows: ["999"] }],
    })!;
    assert.equal(absent.success, false);
    assert.match(absent.error ?? "", /no loop 9/);
  });

  it("returns undefined for tools outside its registry", () => {
    assert.equal(executeSpriteTool(createAgentSessionState(), "read_logic", {}), undefined);
  });
});
