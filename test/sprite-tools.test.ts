import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
import { executeSpriteTool, SPRITE_TOOLS } from "../src/agent/spriteTools.ts";
import { buildView, parseView, selectViewCel } from "../src/view/view.ts";

const ACTOR = {
  num: 0,
  description: "Four-way actor",
  transparentColor: 0,
  mirrorLeftFromRight: true,
  right: [["120", "340"]],
  left: null,
  down: [["506", "780"]],
  up: [["90A", "BC0"]],
};

const writeActor = (
  state: ReturnType<typeof createAgentSessionState>,
  args: Record<string, unknown>,
) =>
  executeAgentTool(state, "write_view", {
    num: args["num"],
    spec: {
      description: null,
      loops: null,
      facings: {
        description: args["description"] ?? null,
        transparentColor: args["transparentColor"],
        mirrorLeftFromRight: args["mirrorLeftFromRight"] ?? null,
        mirrorUpFromDown: args["mirrorUpFromDown"] ?? null,
        right: args["right"] ?? null,
        left: args["left"] ?? null,
        down: args["down"] ?? null,
        up: args["up"] ?? null,
      },
    },
  });

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

  it("writes all four named facings in AGI order and mirrors left from right", () => {
    const state = createAgentSessionState();
    const result = writeActor(state, ACTOR);
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

  it("accepts a single direction and safely populates missing loops with warnings", () => {
    const state = createAgentSessionState();
    const result = writeActor(state, {
      num: 1,
      description: "Simple actor",
      transparentColor: 0,
      mirrorLeftFromRight: null,
      mirrorUpFromDown: null,
      right: [["12", "34"]],
      left: null,
      down: null,
      up: null,
    });
    assert.equal(result?.success, true);
    const view = parseView(state.container.getResource("view", 1)!, state.profile);
    assert.equal(view.loops.length, 4);
    assert.deepEqual([...selectViewCel(view, 0, 0)!.pixels], [1, 2, 3, 4]);
    assert.deepEqual([...selectViewCel(view, 1, 0)!.pixels], [2, 1, 4, 3]); // mirrored
    assert.deepEqual([...selectViewCel(view, 2, 0)!.pixels], [1, 2, 3, 4]); // down copied from right
    assert.deepEqual([...selectViewCel(view, 3, 0)!.pixels], [1, 2, 3, 4]); // up copied from down/right
    assert.ok(result?.adjustments?.some((a) => a.includes("down")));
    assert.ok(result?.adjustments?.some((a) => a.includes("up")));
  });

  it("flips up vertically from down when mirrorUpFromDown is true", () => {
    const state = createAgentSessionState();
    const result = writeActor(state, {
      num: 2,
      description: "Top-down vehicle",
      transparentColor: 0,
      mirrorLeftFromRight: true,
      mirrorUpFromDown: true,
      right: [["12", "34"]],
      left: null,
      down: [["12", "34"]],
      up: null,
    });
    assert.equal(result?.success, true);
    const view = parseView(state.container.getResource("view", 2)!, state.profile);
    assert.equal(view.loops.length, 4);
    assert.deepEqual([...selectViewCel(view, 2, 0)!.pixels], [1, 2, 3, 4]);
    // vertically flipped: rows are reversed (row 1 becomes row 0)
    assert.deepEqual([...selectViewCel(view, 3, 0)!.pixels], [3, 4, 1, 2]);
    assert.ok(result?.adjustments?.some((a) => a.includes("vertically")));
  });

  it("rejects inconsistent row widths and invalid colors before writing", () => {
    const state = createAgentSessionState();
    const uneven = writeActor(state, {
      ...ACTOR,
      right: [["123", "45"]],
    });
    assert.equal(uneven?.success, false);
    assert.match(uneven?.error ?? "", /same width/);
    assert.equal(state.container.getResource("view", 0), null);

    const invalid = writeActor(state, {
      ...ACTOR,
      right: [["12G"]],
    });
    assert.equal(invalid?.success, false);
    assert.match(invalid?.error ?? "", /hex digits/);
    assert.equal(state.container.getResource("view", 0), null);
  });

  it("reads one selected cel as exact rendered rows, colors and revision", () => {
    const state = createAgentSessionState();
    writeActor(state, ACTOR);
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
    writeActor(state, ACTOR);
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
