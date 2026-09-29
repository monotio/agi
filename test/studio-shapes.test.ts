import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compilePictureSource } from "../src/picture/source.ts";
import {
  polygonScanlines,
  sceneSource,
  shapeSource,
  type SceneShape,
} from "../src/studio/shapes.ts";
import { parsePictureDocument } from "../src/studio/pictureDocument.ts";

describe("studio shape compiler", () => {
  it("draws on the priority plane only when color is null", () => {
    assert.deepEqual(
      shapeSource({
        kind: "polygon",
        color: null,
        priority: 10,
        filled: false,
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 0, y: 4 },
        ],
      }),
      ["vis off", "pri 10", "polygon 0,0 4,0 0,4"],
    );
  });

  it("refuses a shape that draws on neither plane", () => {
    assert.throws(
      () =>
        shapeSource({
          kind: "rect",
          color: null,
          priority: null,
          filled: false,
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 1,
        }),
      /^Error: shape draws on neither plane$/,
    );
  });

  it("scanlines a triangle with the half-open edge rule", () => {
    // Edges (4,0)->(0,4) and (0,4)->(0,0) cross rows 0..3 at x=4-y and x=0;
    // the horizontal edge (0,0)->(4,0) never crosses; row 4 is excluded.
    assert.deepEqual(
      polygonScanlines([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 0, y: 4 },
      ]),
      ["line 0,0 4,0", "line 0,1 3,1", "line 0,2 2,2", "line 0,3 1,3"],
    );
  });

  it("lowers a filled rect to per-row lines", () => {
    assert.deepEqual(
      shapeSource({
        kind: "rect",
        color: 5,
        priority: null,
        filled: true,
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 3,
      }),
      ["vis 5", "pri off", "line 1,2 3,2", "line 1,3 3,3"],
    );
  });

  it("emits the background fill for an empty scene", () => {
    assert.equal(sceneSource(2, []), "vis 2\npri off\nfill 0,0\nend\n");
  });

  it("wraps the background and each shape in named item directives", () => {
    assert.equal(
      sceneSource(
        2,
        [
          {
            kind: "rect",
            color: 5,
            priority: null,
            filled: true,
            x1: 1,
            y1: 2,
            x2: 3,
            y2: 3,
            label: "Oak tree",
          },
          {
            kind: "line",
            color: null,
            priority: 10,
            filled: false,
            points: [
              { x: 0, y: 100 },
              { x: 159, y: 100 },
            ],
            label: "Ridge",
          },
        ],
        { annotate: true },
      ),
      [
        '# @item background "Background" art',
        "vis 2",
        "pri off",
        "fill 0,0",
        "# @end",
        '# @item oak-tree "Oak tree" art',
        "vis 5",
        "pri off",
        "line 1,2 3,2",
        "line 1,3 3,3",
        "# @end",
        '# @item ridge "Ridge" depth',
        "vis off",
        "pri 10",
        "line 0,100 159,100",
        "# @end",
        "end",
        "",
      ].join("\n"),
    );
  });

  it("derives unique ids from labels and classifies every item kind", () => {
    const rect = (extras: {
      color: number | null;
      priority: number | null;
      label?: string;
      id?: string;
    }): SceneShape => ({
      kind: "rect",
      filled: false,
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      ...extras,
    });
    const source = sceneSource(
      1,
      [
        rect({ color: 1, priority: null, label: "West Wall" }),
        rect({ color: 1, priority: null, label: "west  wall" }),
        rect({ color: null, priority: 2, label: "Gate" }),
        rect({ color: 4, priority: 10, label: 'Big "rock"' }),
        rect({ color: 1, priority: null, label: "42nd Street" }),
        rect({ color: 1, priority: null }),
        rect({ color: 1, priority: null, id: "hero_tree", label: "Tree" }),
      ],
      { annotate: true },
    );
    assert.deepEqual(
      [...source.matchAll(/^# @item (\S+) (".*?") (\S+)$/gm)].map((m) => [
        m[1],
        JSON.parse(m[2]!),
        m[3],
      ]),
      [
        ["background", "Background", "art"],
        ["west-wall", "West Wall", "art"],
        ["west-wall-2", "west  wall", "art"],
        ["gate", "Gate", "walk"],
        ["big-rock", 'Big "rock"', "mixed"],
        ["shape-42nd-street", "42nd Street", "art"],
        ["shape-6", "Shape 6", "art"],
        ["hero_tree", "Tree", "art"],
      ],
    );
    const parsed = parsePictureDocument(source);
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.document.items.length, 8);
  });

  it("rejects explicit ids that are malformed, duplicated or shadow the background", () => {
    const shape = (id: string): SceneShape => ({
      kind: "rect",
      color: 1,
      priority: null,
      filled: false,
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      id,
    });
    assert.throws(() => sceneSource(1, [shape("Bad Id")], { annotate: true }), /must match/);
    assert.throws(
      () => sceneSource(1, [shape("tree"), shape("tree")], { annotate: true }),
      /duplicate shape id 'tree'/,
    );
    assert.throws(
      () => sceneSource(1, [shape("background")], { annotate: true }),
      /duplicate shape id 'background'/,
    );
  });

  it("compiles annotated source to the same bytes as unannotated", () => {
    const shapes: SceneShape[] = [
      {
        kind: "rect",
        color: 5,
        priority: 9,
        filled: true,
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 3,
        label: "Plinth",
      },
      {
        kind: "polygon",
        color: null,
        priority: 1,
        filled: false,
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 0, y: 4 },
        ],
        label: "Hazard",
      },
    ];
    const plain = compilePictureSource(sceneSource(2, shapes));
    const annotated = compilePictureSource(sceneSource(2, shapes, { annotate: true }));
    assert.deepEqual([...annotated.bytes], [...plain.bytes]);
    assert.equal(annotated.commandCount, plain.commandCount);
  });
});
