/**
 * The studio harness's demo picture: a small room whose `@item` annotations
 * give every lens something to show. Art: floor, wall, bench, lamp. Depth: a
 * bench occluder at priority 10. Walk: a barrier (0), a conditional gate (1),
 * a signal exit (2) and a pond that is both art and water (3). Shapes come
 * from src/studio/shapes.ts; tests hand-check the geometry below.
 */

import { shapeSource } from "../../../src/studio/shapes.ts";

/** The bench occluder's filled rectangle on the priority plane. */
export const DEMO_OCCLUDER = { x1: 40, y1: 90, x2: 119, y2: 105 } as const;

const item = (id: string, label: string, kind: string, lines: readonly string[]): string[] => [
  `# @item ${id} ${JSON.stringify(label)} ${kind}`,
  ...lines,
  "# @end",
];

export const DEMO_PICTURE_SOURCE = `${[
  "# Studio demo: a gallery corner with depth and walk marks.",
  ...item("floor", "Floor", "art", [
    ...shapeSource({
      kind: "rect",
      color: 8,
      priority: null,
      filled: false,
      x1: 0,
      y1: 112,
      x2: 159,
      y2: 167,
    }),
    "fill 80,140",
  ]),
  ...item("wall", "Wall", "art locked", ["vis 7", "fill 80,40"]),
  ...item("bench", "Bench", "art", [
    ...shapeSource({
      kind: "polygon",
      color: 6,
      priority: null,
      filled: true,
      points: [
        { x: 42, y: 90 },
        { x: 117, y: 90 },
        { x: 121, y: 96 },
        { x: 117, y: 105 },
        { x: 42, y: 105 },
        { x: 38, y: 96 },
      ],
    }),
  ]),
  ...item("lamp", "Lamp", "art", [
    ...shapeSource({
      kind: "polygon",
      color: 14,
      priority: null,
      filled: true,
      points: [
        { x: 26, y: 40 },
        { x: 34, y: 40 },
        { x: 37, y: 47 },
        { x: 23, y: 47 },
      ],
    }),
  ]),
  ...item("bench-occluder", "Bench occluder", "depth", [
    ...shapeSource({ kind: "rect", color: null, priority: 10, filled: true, ...DEMO_OCCLUDER }),
  ]),
  ...item("floor-edge", "Floor edge", "walk", [
    ...shapeSource({
      kind: "line",
      color: null,
      priority: 0,
      filled: false,
      points: [
        { x: 8, y: 132 },
        { x: 30, y: 114 },
        { x: 129, y: 114 },
        { x: 151, y: 132 },
      ],
    }),
  ]),
  ...item("gate", "Side gate", "walk", [
    ...shapeSource({
      kind: "line",
      color: null,
      priority: 1,
      filled: false,
      points: [
        { x: 18, y: 60 },
        { x: 18, y: 108 },
      ],
    }),
  ]),
  ...item("south-exit", "South exit", "walk", [
    ...shapeSource({
      kind: "line",
      color: null,
      priority: 2,
      filled: false,
      points: [
        { x: 40, y: 166 },
        { x: 119, y: 166 },
      ],
    }),
  ]),
  ...item("pond", "Pond", "mixed", [
    ...shapeSource({
      kind: "polygon",
      color: 9,
      priority: 3,
      filled: true,
      points: [
        { x: 124, y: 140 },
        { x: 148, y: 140 },
        { x: 154, y: 150 },
        { x: 128, y: 156 },
      ],
    }),
  ]),
  "end",
].join("\n")}\n`;
