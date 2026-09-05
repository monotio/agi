import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentSessionState } from "../src/agent/tools.ts";
import { executePictureTool, PICTURE_TOOLS } from "../src/agent/pictureTools.ts";
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

  it("returns undefined for tools outside its registry", () => {
    assert.equal(executePictureTool(createAgentSessionState(), "read_logic", {}), undefined);
  });
});
