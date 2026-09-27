/**
 * Hand-built Studio assist fixtures: a river crossed by a bridge (picture)
 * and a two-loop robot whose loop 1 mirrors loop 0 (view). Every count the
 * assist tests assert is computed here from the geometry, not observed.
 */
import { buildView } from "../src/view/view.ts";

const rows = (x1: number, x2: number, y1: number, y2: number) =>
  Array.from({ length: y2 - y1 + 1 }, (_, i) => `line ${x1},${y1 + i} ${x2},${y1 + i}`);

/**
 * Sky fills the picture (priority 4, open floor). The river spans x 0..159,
 * y 120..139: water (control 3) inside barrier banks (control 0) on its
 * outline. The bridge is art only, a solid colour-6 block at x 60..99,
 * y 118..141 (40 x 24 = 960 cells) that leaves the banks under it, so
 * nothing can walk across.
 */
export const BRIDGE_SOURCE = [
  '# @item sky "Sky" art',
  "vis 11",
  "fill 0,0",
  "# @end",
  '# @item river "River" walk',
  "vis off",
  "pri 0",
  "rect 0,120 159,139",
  "pri 3",
  "fill 5,130",
  "# @end",
  '# @item bridge "Bridge" art',
  "vis 6",
  "pri off",
  ...rows(60, 99, 118, 141),
  "# @end",
  "end",
  "",
].join("\n");

/** 1-based line after the bridge's @end: where new items go. */
export const AFTER_BRIDGE = BRIDGE_SOURCE.split("\n").indexOf("end") + 1;

export const BRIDGE_AREA = { x0: 60, y0: 118, x1: 99, y1: 141, cells: 960 };
/** The river under the bridge: x 60..99, y 120..139, of which the banks are rows 120 and 139. */
export const RIVER_UNDER_BRIDGE = { x0: 60, y0: 120, x1: 99, y1: 139, cells: 800, banks: 80 };

/**
 * A one-pixel ego (view 0), so the walkable estimate counts baseline cells:
 * under the bridge all but the 80 bank cells are walkable (sky rows 118,
 * 119, 140, 141 and the water, which blocks only an actor kept on land),
 * 880 of 960, until the banks there turn to water too.
 */
export const DOT_EGO = buildView({
  loops: [{ cels: [{ width: 1, height: 1, transparentColor: 0, pixels: [5] }] }],
});

/**
 * A 4x3 robot head, transparent 0, grey 7, one red eye (12) at x 1, y 1;
 * cel 1 moves the eye to x 2. Each cel mirrored is the other.
 */
export const ROBOT_CELS = [
  { width: 4, height: 3, transparentColor: 0, pixels: [0, 7, 7, 0, 7, 12, 7, 7, 0, 7, 7, 0] },
  { width: 4, height: 3, transparentColor: 0, pixels: [0, 7, 7, 0, 7, 7, 12, 7, 0, 7, 7, 0] },
] as const;

/** The robot head; loop 1 mirrors loop 0. */
export const ROBOT_VIEW = buildView({
  description: "Test robot",
  loops: [{ cels: ROBOT_CELS }, { mirrorLoop: 0 }],
});
