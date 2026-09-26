import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentSessionState } from "../src/agent/tools.ts";
import { executePictureTool, PICTURE_TOOLS } from "../src/agent/pictureTools.ts";
import { normalizeToolArguments, validateToolArguments } from "../src/agent/schemaValidate.ts";
import { renderPicture } from "../src/picture/renderer.ts";
import { createPictureSurface } from "../src/types.ts";

const rect = {
  kind: "rect",
  color: 3,
  priority: 7,
  filled: true,
  x1: 2,
  y1: 2,
  x2: 5,
  y2: 5,
  points: null,
};

describe("accessible picture authoring", () => {
  it("advertises one strict, bounded shape tool", () => {
    assert.deepEqual(
      PICTURE_TOOLS.map((tool) => tool.name),
      ["write_scene"],
    );
    const tool = PICTURE_TOOLS[0]!;
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(
      Object.keys(tool.parameters.properties).sort(),
      [...tool.parameters.required].sort(),
    );
  });

  it("renders ordered filled rectangles, polygons, and lines into exact visual and priority pixels", () => {
    const state = createAgentSessionState();
    const result = executePictureTool(state, "write_scene", {
      room: 4,
      backgroundColor: 1,
      shapes: [
        rect,
        {
          kind: "polygon",
          color: 5,
          priority: 9,
          filled: true,
          x1: null,
          y1: null,
          x2: null,
          y2: null,
          points: [
            { x: 10, y: 10 },
            { x: 14, y: 10 },
            { x: 12, y: 14 },
          ],
        },
        {
          kind: "line",
          color: 4,
          priority: null,
          filled: false,
          x1: null,
          y1: null,
          x2: null,
          y2: null,
          points: [
            { x: 2, y: 3 },
            { x: 5, y: 3 },
          ],
        },
      ],
    });
    assert.equal(result?.success, true);
    const payload = state.container.getResource("picture", 4)!;
    const surface = createPictureSurface();
    renderPicture(payload, surface, { profile: state.profile });
    const at = (x: number, y: number) => y * 160 + x;
    assert.deepEqual(
      [
        [surface.visual[at(0, 0)], surface.priority[at(0, 0)]],
        [surface.visual[at(3, 2)], surface.priority[at(3, 2)]],
        [surface.visual[at(3, 3)], surface.priority[at(3, 3)]],
        [surface.visual[at(12, 12)], surface.priority[at(12, 12)]],
        [surface.visual[at(10, 14)], surface.priority[at(10, 14)]],
      ],
      [
        [1, 4],
        [3, 7],
        [4, 7],
        [5, 9],
        [1, 4],
      ],
    );
    assert.deepEqual(result?.details?.["writtenResources"], [{ kind: "picture", num: 4 }]);
    assert.equal(typeof result?.details?.["revision"], "string");
    assert.equal(result?.images?.length, 1);
    const png = result?.images?.[0]!.png;
    assert.ok(png);
    const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
    assert.deepEqual([header.getUint32(16), header.getUint32(20)], [960, 168]);
    assert.match(result?.images?.[0]!.caption ?? "", /Left: clean visual.*Middle: raw priority/);
    assert.match(result?.message ?? "", /Display geometry: 160x168 logical -> 320x168/);
    assert.match(result?.message ?? "", /priority\/control map/i);
    const source = state.sources.pictures.get(4)!;
    assert.match(source, /line 2,2 5,2/);
    assert.match(source, /polygon 10,10 14,10 12,14/);
    assert.doesNotMatch(source.replace("fill 0,0", ""), /\bfill\b/);
  });

  it("rejects invalid geometry and self-intersecting polygons before mutation", () => {
    const badShapes = [
      { ...rect, x2: 160 },
      {
        kind: "polygon",
        color: 2,
        priority: null,
        filled: true,
        x1: null,
        y1: null,
        x2: null,
        y2: null,
        points: [
          { x: 1, y: 1 },
          { x: 5, y: 5 },
          { x: 1, y: 5 },
          { x: 5, y: 1 },
        ],
      },
      {
        kind: "line",
        color: 2,
        priority: null,
        filled: true,
        x1: null,
        y1: null,
        x2: null,
        y2: null,
        points: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ],
      },
    ];
    for (const shape of badShapes) {
      const state = createAgentSessionState();
      const result = executePictureTool(state, "write_scene", {
        room: 9,
        backgroundColor: 0,
        shapes: [shape],
      });
      assert.equal(result?.success, false);
      assert.equal(state.container.getResource("picture", 9), null);
      assert.equal(state.sources.pictures.has(9), false);
    }
  });

  it("rejects an expanded scene beyond the bounded payload before mutation", () => {
    const state = createAgentSessionState();
    const shapes = Array.from({ length: 128 }, (_, index) => ({
      ...rect,
      color: index & 15,
      x1: 0,
      y1: 0,
      x2: 159,
      y2: 167,
    }));
    const result = executePictureTool(state, "write_scene", {
      room: 10,
      backgroundColor: 1,
      shapes,
    });
    assert.equal(result?.success, false);
    assert.match(result?.error ?? "", /payload|limit/i);
    assert.equal(state.container.getResource("picture", 10), null);
  });

  it("treats shape name as required-but-nullable, so calls predating it still validate", () => {
    const tool = PICTURE_TOOLS[0]!;
    const shape = (tool.parameters.properties["shapes"] as { items: Record<string, unknown> })
      .items;
    const props = shape["properties"] as Record<string, unknown>;
    assert.deepEqual(props["name"], { type: ["string", "null"], maxLength: 48 });
    assert.ok((shape["required"] as readonly string[]).includes("name"));
    const args = normalizeToolArguments(tool.parameters, {
      room: 6,
      backgroundColor: 1,
      shapes: [rect],
    });
    assert.deepEqual(validateToolArguments(tool.parameters, args), []);
    assert.equal((args["shapes"] as { name?: unknown }[])[0]!.name, null);
  });

  it("annotates the stored scene with Studio items and compiles the pinned bytes", () => {
    const state = createAgentSessionState();
    const result = executePictureTool(state, "write_scene", {
      room: 6,
      backgroundColor: 1,
      shapes: [
        {
          kind: "rect",
          color: 3,
          priority: 7,
          filled: true,
          x1: 2,
          y1: 2,
          x2: 3,
          y2: 3,
          points: null,
          name: "Pillar",
        },
        {
          kind: "line",
          color: 4,
          priority: null,
          filled: false,
          x1: null,
          y1: null,
          x2: null,
          y2: null,
          points: [
            { x: 2, y: 3 },
            { x: 5, y: 3 },
          ],
          name: null,
        },
      ],
    });
    assert.equal(result?.success, true, result?.error ?? "");
    const source = state.sources.pictures.get(6)!;
    assert.equal(
      source,
      [
        '# @item background "Background" art',
        "vis 1",
        "pri off",
        "fill 0,0",
        "# @end",
        '# @item pillar "Pillar" mixed',
        "vis 3",
        "pri 7",
        "line 2,2 3,2",
        "line 2,3 3,3",
        "# @end",
        '# @item shape-2 "Shape 2" art',
        "vis 4",
        "pri off",
        "line 2,3 5,3",
        "# @end",
        "end",
        "",
      ].join("\n"),
    );
    // Directives are `#` comments, so the payload is the same command stream
    // the unannotated scene produced: vis/pri selects, two fill seed bytes,
    // one line strip per emitted line, end.
    assert.deepEqual(
      [...state.container.getResource("picture", 6)!],
      [
        0xf0, 1, 0xf3, 0xf8, 0, 0, 0xf0, 3, 0xf2, 7, 0xf6, 2, 2, 3, 2, 0xf6, 2, 3, 3, 3, 0xf0, 4,
        0xf3, 0xf6, 2, 3, 5, 3, 0xff,
      ],
    );
  });

  it("rejects an overlong or blank shape name before mutation", () => {
    for (const name of ["x".repeat(49), "   ", 7]) {
      const state = createAgentSessionState();
      const result = executePictureTool(state, "write_scene", {
        room: 8,
        backgroundColor: 1,
        shapes: [{ ...rect, name }],
      });
      assert.equal(result?.success, false);
      assert.match(result?.error ?? "", /name/);
      assert.equal(state.container.getResource("picture", 8), null);
    }
  });

  it("returns undefined for tools outside its registry", () => {
    assert.equal(executePictureTool(createAgentSessionState(), "read_logic", {}), undefined);
  });
});
