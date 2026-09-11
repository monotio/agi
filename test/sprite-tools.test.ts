import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentSessionState } from "../src/agent/tools.ts";
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

describe("sprite authoring tools", () => {
  it("advertises strict, bounded schemas", () => {
    assert.deepEqual(
      SPRITE_TOOLS.map((tool) => tool.name),
      ["write_actor", "read_view_cel", "patch_view_cels"],
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
    const result = executeSpriteTool(state, "write_actor", ACTOR);
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
    const result = executeSpriteTool(state, "write_actor", {
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
    const result = executeSpriteTool(state, "write_actor", {
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
    const uneven = executeSpriteTool(state, "write_actor", {
      ...ACTOR,
      right: [["123", "45"]],
    });
    assert.equal(uneven?.success, false);
    assert.match(uneven?.error ?? "", /same width/);
    assert.equal(state.container.getResource("view", 0), null);

    const invalid = executeSpriteTool(state, "write_actor", {
      ...ACTOR,
      right: [["12G"]],
    });
    assert.equal(invalid?.success, false);
    assert.match(invalid?.error ?? "", /hex digits/);
    assert.equal(state.container.getResource("view", 0), null);
  });

  it("reads one selected cel as exact rendered rows, metadata, revision, and bounded PNG", () => {
    const state = createAgentSessionState();
    executeSpriteTool(state, "write_actor", ACTOR);
    const result = executeSpriteTool(state, "read_view_cel", {
      num: 0,
      loop: 1,
      cel: 0,
      rowOffset: null,
      rowLimit: null,
    });
    assert.equal(result?.success, true);
    assert.deepEqual(result?.details?.["rows"], ["021", "043"]);
    assert.deepEqual(
      {
        width: result?.details?.["width"],
        height: result?.details?.["height"],
        transparentColor: result?.details?.["transparentColor"],
      },
      { width: 3, height: 2, transparentColor: 0 },
    );
    assert.equal(typeof result?.details?.["revision"], "string");
    assert.equal(result?.images?.length, 1);
    const png = result?.images?.[0]!.png;
    assert.ok(png);
    const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
    assert.equal(header.getUint32(16), 6);
    assert.equal(header.getUint32(20), 2);
    assert.ok(png.length < 10_000);
  });

  it("pages every row of a maximum-height cel without hiding the remainder", () => {
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

    const middle = executeSpriteTool(state, "read_view_cel", {
      num: 3,
      loop: 0,
      cel: 0,
      rowOffset: 64,
      rowLimit: 64,
    })!;
    assert.equal(middle.success, true);
    assert.deepEqual(middle.details?.["rows"], new Array(64).fill(row));
    assert.equal(middle.details?.["totalRows"], 168);
    assert.equal(middle.details?.["rowOffset"], 64);
    assert.equal(middle.details?.["nextRowOffset"], 128);
    assert.doesNotMatch(middle.message ?? "", new RegExp(`\\n${row}`));

    const last = executeSpriteTool(state, "read_view_cel", {
      num: 3,
      loop: 0,
      cel: 0,
      rowOffset: 128,
      rowLimit: null,
    })!;
    assert.deepEqual(last.details?.["rows"], new Array(40).fill(row));
    assert.equal(last.details?.["nextRowOffset"], null);
  });

  it("rejects a stale revision atomically", () => {
    const state = createAgentSessionState();
    executeSpriteTool(state, "write_actor", ACTOR);
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
    const read = executeSpriteTool(state, "read_view_cel", {
      num: 7,
      loop: 1,
      cel: 0,
      rowOffset: null,
      rowLimit: null,
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
      executeSpriteTool(state, "read_view_cel", {
        num: 7,
        loop: 0,
        cel: 0,
        rowOffset: null,
        rowLimit: null,
      })!.details?.["revision"],
    );
    const result = executeSpriteTool(state, "patch_view_cels", {
      num: 7,
      expectedRevision: revision,
      patches: [{ loop: 0, cel: 0, rows: null, recolor: [{ from: 4, to: 12 }] }],
    });
    assert.equal(result?.success, true, result?.error);
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
      executeSpriteTool(state, "read_view_cel", {
        num: 7,
        loop: 0,
        cel: 0,
        rowOffset: null,
        rowLimit: null,
      })!.details?.["revision"],
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
