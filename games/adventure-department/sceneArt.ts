/**
 * Original native AGI pictures for Adventure Department: the three exhibit
 * rooms and the gallery mural.
 *
 * Every room shares one architecture in one-point perspective toward an eye
 * level at y 47: a back wall from x 24 to 135 whose base is the walk horizon
 * (y 112), side walls whose floor contacts run to the screen edges at y 140,
 * and a rail and a baseboard that recede with them. A room that leads on has
 * an open doorway at the near end of that side wall, showing a slice of the
 * next room. Light falls from the upper left: top and left edges catch
 * highlights and furniture throws its shadow down and to the right. The top
 * 16 rows sit under the game's two text lines, so they are a black band.
 *
 * Each source is a Room Studio document: every drawing command sits in a
 * named `# @item`. Outlines come first, then the colour fills, then the
 * details drawn over them, and last the depth (priority) and walk (control)
 * items, so scrubbing the draw order replays the room like a recipe.
 */

/** The eye level: every receding line meets this vanishing point. */
const VP_X = 80;
const VP_Y = 47;
/** The back wall's floor line, which is also the walk horizon. */
export const FLOOR_Y = 112;
const BACK_LEFT = 24;
const BACK_RIGHT = 135;
const RAIL_Y = 88;
const BASEBOARD_Y = 106;

type Side = "west" | "east";

/** y at `x` on the receding line through the vanishing point and (x0, y0). */
function recede(x0: number, y0: number, x: number): number {
  return Math.round(VP_Y + ((y0 - VP_Y) * (x - VP_X)) / (x0 - VP_X));
}

/** One Room Studio item: `lines` between `# @item` and `# @end` (comments; no bytes). */
function item(id: string, label: string, kind: "art" | "depth" | "walk", ...lines: string[]) {
  return [`# @item ${id} "${label}" ${kind}`, ...lines, "# @end"].join("\n");
}

/** Explicit horizontal rows: a solid block over colours already drawn. */
function rows(x1: number, x2: number, y1: number, y2: number): string[] {
  return Array.from(
    { length: y2 - y1 + 1 },
    (_, row) => `line ${x1},${y1 + row} ${x2},${y1 + row}`,
  );
}

/**
 * A solid shape painted row by row, for small props whose silhouette matters
 * more than a fill: each row gets the body colour, its left end the light and
 * its right end the shade, since the light comes from the left.
 */
function sculpt(
  spans: readonly (readonly [number, number, number])[],
  c: { body: number; light: number; shade: number },
): string[] {
  return [
    `vis ${c.body}`,
    ...spans.map(([y, x1, x2]) => `line ${x1},${y} ${x2},${y}`),
    `vis ${c.light}`,
    ...spans.map(([y, x1]) => `line ${x1},${y}`),
    `vis ${c.shade}`,
    ...spans.map(([y, , x2]) => `line ${x2},${y}`),
  ];
}

const back = (side: Side) => (side === "west" ? BACK_LEFT : BACK_RIGHT);
const edge = (side: Side) => (side === "west" ? 0 : 159);
/** The doorway's far jamb, the only one in view. */
const jamb = (side: Side) => (side === "west" ? 12 : 147);
const DOOR_TOP = 68;
/** Where the floor meets the far jamb: the doorway's sill row. */
const DOOR_SILL = 126;

/** Row `y` of the back wall carried along a side wall to x `to`. */
function along(side: Side, y: number, to: number = edge(side)): string {
  return `line ${back(side)},${y} ${to},${recede(back(side), y, to)}`;
}

export interface ShellColours {
  readonly wall: number;
  readonly wainscot: number;
  readonly floor: number;
}

/**
 * The black band under the text lines, the back wall's corners and floor
 * line, and its rail and baseboard lines. Furniture standing against the
 * back wall lists its x ranges in `behind`: the rail or baseboard stops at
 * its edges instead of crossing regions it fills itself.
 */
function shellOutline(
  behind: {
    rail?: readonly (readonly [number, number])[];
    baseboard?: readonly (readonly [number, number])[];
  } = {},
): string[] {
  const segments = (y: number, gaps: readonly (readonly [number, number])[] = []) => {
    const out: string[] = [];
    let from = BACK_LEFT;
    for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
      if (a - 1 >= from) out.push(`line ${from},${y} ${a - 1},${y}`);
      from = Math.max(from, b + 1);
    }
    if (from <= BACK_RIGHT) out.push(`line ${from},${y} ${BACK_RIGHT},${y}`);
    return out;
  };
  return [
    item("band", "Text band", "art", "vis 0", "rect 0,0 159,15", "fill 1,1"),
    item(
      "corners",
      "Corners & floor line",
      "art",
      `line ${BACK_LEFT},16 ${BACK_LEFT},${FLOOR_Y} ${BACK_RIGHT},${FLOOR_Y} ${BACK_RIGHT},16`,
      ...segments(RAIL_Y, behind.rail),
      ...segments(BASEBOARD_Y, behind.baseboard),
    ),
  ];
}

/** A plain side wall: floor contact, rail and baseboard to the screen edge. */
function solidSide(side: Side, lowStop: number = edge(side)): string {
  const name = side === "west" ? "West" : "East";
  return item(
    `${side}-wall`,
    `${name} wall`,
    "art",
    along(side, FLOOR_Y, lowStop),
    along(side, RAIL_Y),
    along(side, BASEBOARD_Y, lowStop),
  );
}

/**
 * A side wall with an open doorway at its near end: its lines stop at the
 * far jamb, the opening shows `beyond` (the next room's wall colour) above
 * the floor, which runs on through it, and a wooden casing frames it.
 */
function doorSide(side: Side, beyond: number): string {
  const name = side === "west" ? "West" : "East";
  const j = jamb(side);
  const e = edge(side);
  const inward = side === "west" ? 1 : -1;
  const casing = j + 2 * inward;
  const casingTop = DOOR_TOP - 3;
  return [
    item(
      `${side}-wall`,
      `${name} wall`,
      "art",
      along(side, FLOOR_Y, j),
      along(side, RAIL_Y, casing),
      along(side, BASEBOARD_Y, casing),
    ),
    item(
      `${side}-door`,
      `${name} doorway`,
      "art",
      `line ${j},${DOOR_TOP} ${j},${DOOR_SILL} ${e},${DOOR_SILL}`,
      `line ${j},${DOOR_TOP} ${e},${recede(j, DOOR_TOP, e)}`,
      `vis ${beyond}`,
      `fill ${e + 3 * inward},${DOOR_TOP + 20}`,
      "vis 0",
      `line ${e + inward},${DOOR_SILL - 1} ${j - inward},${DOOR_SILL - 1}`,
      `line ${j - inward},${DOOR_TOP + 2} ${j - inward},${DOOR_SILL - 2}`,
    ),
    item(
      `${side}-casing`,
      `${name} door casing`,
      "art",
      "vis 6",
      `line ${casing},${recede(j, casingTop, casing)} ${casing},${recede(back(side), FLOOR_Y, casing) - 1}`,
      `line ${casing},${recede(j, casingTop, casing)} ${e},${recede(j, casingTop, e)}`,
      `fill ${j + inward},${DOOR_TOP + 10}`,
      "vis 14",
      `line ${casing},${recede(j, casingTop, casing)} ${e},${recede(j, casingTop, e)}`,
      ...(side === "east"
        ? [
            `line ${casing},${recede(j, casingTop, casing)} ${casing},${recede(back(side), FLOOR_Y, casing) - 1}`,
          ]
        : []),
    ),
  ].join("\n");
}

/** Extra fill seeds for regions a room's furniture closes off. */
interface ExtraSeeds {
  readonly wall?: string;
  readonly wainscot?: string;
  readonly baseboard?: string;
  readonly floor?: string;
  /** Where the back wall's wainscot and baseboard seeds go, clear of furniture. */
  readonly backX?: number;
}

/** Upper wall, wainscot, baseboard and floor fills for the shell. */
function shellFills(c: ShellColours, extra: ExtraSeeds = {}): string[] {
  const seeds = (base: string, more: string | undefined) => `fill ${base}${more ? ` ${more}` : ""}`;
  const low = (y: number) =>
    `${extra.backX ?? 80},${y} 18,${recede(BACK_LEFT, y, 18)} 141,${recede(BACK_RIGHT, y, 141)}`;
  return [
    item(
      "walls",
      "Upper walls",
      "art",
      `vis ${c.wall}`,
      seeds("8,25 150,25", extra.wall ?? "26,30"),
    ),
    item(
      "wainscot",
      "Wainscot",
      "art",
      `vis ${c.wainscot}`,
      seeds(low(RAIL_Y + 8), extra.wainscot),
    ),
    item("baseboard", "Baseboard", "art", "vis 0", seeds(low(BASEBOARD_Y + 3), extra.baseboard)),
    ...(c.floor === 15
      ? []
      : [item("floor", "Floor", "art", `vis ${c.floor}`, seeds("80,150", extra.floor))]),
  ];
}

/** Floor rows at equal steps of depth, from the back wall to the screen's bottom edge. */
const TILE_ROWS = [112, 117, 122, 128, 135, 144, 154, 167] as const;

/** The walkable floor's left and right edge at row y: side-wall contacts, then the screen. */
function floorEdges(y: number): [number, number] {
  const inset = ((y - FLOOR_Y) * (BACK_LEFT - 0)) / (140 - FLOOR_Y);
  return [Math.max(0, BACK_LEFT - inset), Math.min(159, BACK_RIGHT + inset)];
}

/** x at row y on the floor line through the vanishing point and (x0, FLOOR_Y), unrounded. */
function columnAt(x0: number, y: number): number {
  return VP_X + ((x0 - VP_X) * (y - VP_Y)) / (FLOOR_Y - VP_Y);
}

/**
 * Receding floor lines through (x0, FLOOR_Y) for every x0 in `columns`,
 * clipped to the floor (a column starting behind a side wall appears where
 * it leaves the wall's floor contact) and to the screen and `clip` box.
 */
function floorColumns(columns: readonly number[], left = 0, right = 159): string[] {
  const out: string[] = [];
  for (const x0 of columns) {
    let start: [number, number] | null = null;
    let end: [number, number] | null = null;
    for (let y = FLOOR_Y + 1; y <= 167; y++) {
      const x = Math.round(columnAt(x0, y));
      const [l, r] = floorEdges(y);
      const inside = x > l && x < r && x >= left && x <= right;
      if (inside && start === null) start = [x, y];
      if (inside) end = [x, y];
    }
    if (start && end && end[1] - start[1] >= 2)
      out.push(`line ${start[0]},${start[1]} ${end[0]},${end[1]}`);
  }
  return out;
}

/** Horizontal floor rows between the side-wall contacts, clipped to [left, right]. */
function floorRows(ys: readonly number[], left = 0, right = 159): string[] {
  return ys.map((y) => {
    const [l, r] = floorEdges(y);
    return `line ${Math.max(left, Math.ceil(l) + 1)},${y} ${Math.min(right, Math.floor(r) - 1)},${y}`;
  });
}

/**
 * One fill seed inside every other tile of the floor grid: the tile row's
 * middle, at the middle of the stretch of that row inside both the tile's
 * columns and the floor.
 */
function checkerSeeds(columns: readonly number[], parity: 0 | 1): string {
  const seeds: string[] = [];
  for (let r = 0; r + 1 < TILE_ROWS.length; r++) {
    const y = Math.round((TILE_ROWS[r]! + TILE_ROWS[r + 1]!) / 2);
    const [l, rEdge] = floorEdges(y);
    for (let c = 0; c + 1 < columns.length; c++) {
      if ((r + c) % 2 !== parity) continue;
      const a = Math.max(Math.ceil(columnAt(columns[c]!, y)) + 1, Math.ceil(l) + 1, 1);
      const b = Math.min(Math.floor(columnAt(columns[c + 1]!, y)) - 1, Math.floor(rEdge) - 1, 158);
      if (b - a >= 0) seeds.push(`${Math.round((a + b) / 2)},${y}`);
    }
  }
  return seeds.join(" ");
}

/**
 * The room's walk barriers: the back wall's base and each side wall's floor
 * contact, or, at a doorway, the contact up to the far jamb and the sill, so
 * the floor runs out of the screen through the opening.
 */
function wallBase(o: { west: "door" | "wall"; east: "door" | "wall" }): string {
  const side = (s: Side) =>
    o[s] === "door"
      ? `line ${back(s)},${FLOOR_Y} ${jamb(s)},${DOOR_SILL} ${edge(s)},${DOOR_SILL}`
      : `line ${back(s)},${FLOOR_Y} ${edge(s)},${recede(back(s), FLOOR_Y, edge(s))}`;
  return item(
    "wall-base",
    "Wall base barrier",
    "walk",
    "vis off",
    "pri 0",
    `line ${BACK_LEFT},${FLOOR_Y} ${BACK_RIGHT},${FLOOR_Y}`,
    side("west"),
    side("east"),
  );
}

// ---------------------------------------------------------------------------
// Picture Gallery

const GALLERY_PICTURE = [
  "# Picture Gallery: a gilded frame waits behind a velvet rope for its painting.",
  "# The west corner is closed by a marble bust; the east doorway shows the Sprite Lab.",
  ...shellOutline(),
  solidSide("west"),
  doorSide("east", 1),
  "# The mural overlay (picture 4) paints the canvas inside the frame.",
  item(
    "frame",
    "Mural frame",
    "art",
    "vis 0",
    "rect 47,24 112,79",
    "vis 6",
    "rect 48,25 111,78",
    "rect 52,28 107,75",
    "vis 0",
    "rect 53,29 106,74",
    "vis 14",
    "fill 50,50",
  ),
  item("canvas", "Blank canvas", "art", "vis 7", "fill 80,50"),
  item(
    "sketch",
    "Pencil sketch",
    "art",
    "vis 8",
    "line 54,58 62,50 70,55 79,44 88,52 96,49 105,56",
    "line 84,73 86,66 90,62 88,58",
    "line 62,40 63,38 65,37 67,38 68,40",
  ),
  item(
    "still-life",
    "Still life",
    "art",
    "vis 6",
    "rect 28,38 43,58",
    "vis 0",
    "rect 30,40 41,56",
    "vis 14",
    "fill 29,48",
    "vis 12",
    "polygon 33,50 38,50 39,53 37,55 34,55 32,53",
    "fill 35,52",
    "vis 10",
    "line 35,49 35,44",
    "line 35,46 33,44",
    "line 36,47 38,45",
    "vis 14",
    "line 34,43 35,42 36,43",
    "vis 1",
    "fill 31,41",
  ),
  item(
    "seascape",
    "Seascape",
    "art",
    "vis 6",
    "rect 116,38 131,58",
    "vis 0",
    "rect 118,40 129,56",
    "vis 14",
    "fill 117,48",
    "vis 1",
    "line 119,49 128,49",
    "fill 123,53",
    "vis 7",
    "polygon 123,42 123,47 126,47",
    "vis 6",
    "line 121,48 127,48",
    "vis 11",
    "fill 120,42 127,43",
  ),
  item(
    "picture-light",
    "Picture light",
    "art",
    "vis 6",
    "rect 63,19 96,21",
    "line 79,22 80,23",
    "vis 14",
    "fill 64,20",
    "vis 15",
    "line 64,20 70,20",
  ),
  item(
    "plaque",
    "Brass plaque",
    "art",
    "vis 6",
    "rect 72,81 87,84",
    "vis 14",
    "fill 73,82",
    "vis 6",
    "line 74,82 78,82",
    "line 80,82 85,82",
    "line 74,83 83,83",
  ),
  item(
    "portrait",
    "Small portrait",
    "art",
    "vis 6",
    `polygon 17,38 17,70 5,${recede(17, 70, 5)} 5,${recede(17, 38, 5)}`,
    "vis 0",
    `polygon 15,41 15,67 7,${recede(15, 67, 7)} 7,${recede(15, 41, 7)}`,
    "vis 14",
    "fill 16,55",
    "vis 12",
    "polygon 10,47 12,47 12,53 10,53",
    "vis 4",
    "polygon 9,56 13,55 14,65 8,66",
    "fill 11,60",
    "vis 12",
    "fill 11,50",
    "vis 1",
    "fill 9,44 14,48",
  ),
  item(
    "cart",
    "Restoration cart",
    "art",
    "vis 0",
    "rect 114,96 133,99",
    "line 116,100 116,111",
    "line 131,100 131,111",
    "line 115,107 132,107",
    "vis 6",
    "fill 115,97",
    "vis 12",
    "rect 117,92 120,95",
    "vis 14",
    "rect 122,93 125,95",
    "vis 9",
    "rect 127,92 130,95",
    "vis 7",
    "line 132,95 132,88",
    "vis 8",
    "line 133,95 134,89",
  ),
  ...shellFills(
    { wall: 4, wainscot: 6, floor: 7 },
    { wainscot: "115,103 123,103 134,103", baseboard: "123,109 133,109" },
  ),
  item(
    "floor-joints",
    "Stone joints",
    "art",
    "vis 8",
    ...floorRows(TILE_ROWS.slice(1, -1)),
    ...floorColumns([10, 24, 38, 52, 66, 80, 94, 108, 122, 136, 150]),
  ),
  item(
    "trim-light",
    "Rail & frame light",
    "art",
    "vis 14",
    `line ${BACK_LEFT + 1},${RAIL_Y} ${BACK_RIGHT - 1},${RAIL_Y}`,
    along("west", RAIL_Y, 1),
    `line ${BACK_RIGHT + 1},${recede(BACK_RIGHT, RAIL_Y, BACK_RIGHT + 1)} 144,${recede(BACK_RIGHT, RAIL_Y, 144)}`,
    "vis 15",
    "line 49,26 110,26",
    "line 49,26 49,77",
    "vis 6",
    "line 50,77 110,77",
    "line 110,27 110,77",
  ),
  item(
    "shadows",
    "Floor shadows",
    "art",
    "vis 8",
    `line ${BACK_LEFT + 1},${FLOOR_Y + 1} ${BACK_RIGHT - 1},${FLOOR_Y + 1}`,
    "line 15,160 19,160 16,167",
    "line 117,113 134,113",
  ),
  "# Foreground props are painted row by row over the finished room.",
  item(
    "plinth",
    "Plinth",
    "art",
    "vis 15",
    ...rows(0, 14, 127, 127),
    ...rows(0, 13, 128, 128),
    ...rows(0, 12, 129, 130),
    "vis 7",
    ...rows(0, 10, 131, 167),
    "vis 8",
    ...rows(11, 14, 131, 161),
    "line 13,129 14,128",
    "line 11,131 12,130",
    "line 11,162 13,162",
    "line 11,163 12,163",
    "line 11,164 11,167",
    "line 0,134 10,134",
    "line 0,162 10,162",
    "vis 15",
    "line 0,132 10,132",
  ),
  item(
    "bust",
    "Marble bust",
    "art",
    ...sculpt(
      [
        [102, 6, 9],
        [103, 5, 10],
        [104, 4, 11],
        [105, 4, 11],
        [106, 4, 11],
        [107, 4, 12],
        [108, 4, 12],
        [109, 5, 13],
        [110, 5, 12],
        [111, 5, 11],
        [112, 6, 10],
        [113, 7, 9],
        [114, 7, 9],
        [115, 6, 10],
        [116, 3, 12],
        [117, 2, 13],
        [118, 1, 13],
        [119, 1, 13],
        [120, 1, 13],
        [121, 2, 12],
        [122, 3, 11],
        [123, 5, 9],
        [124, 5, 9],
        [125, 4, 10],
        [126, 3, 11],
      ],
      { body: 7, light: 15, shade: 8 },
    ),
    "vis 8",
    "line 6,103 7,104",
    "line 9,103 9,104",
    "line 5,105 6,106",
    "line 7,108",
    "line 9,107 11,107",
    "line 11,108",
    "line 10,111 11,111",
    "line 4,118 6,120",
    "line 9,117 10,119",
    "line 5,123 9,123",
    "vis 15",
    "line 8,109",
    "line 3,116 4,116",
  ),
  item(
    "rope",
    "Velvet rope",
    "art",
    "vis 6",
    "line 50,104 50,120",
    "line 109,104 109,120",
    "vis 14",
    "line 49,104 49,120",
    "line 108,104 108,120",
    "rect 48,101 50,103",
    "rect 107,101 109,103",
    "vis 8",
    "rect 47,120 51,121",
    "rect 106,120 110,121",
    "vis 4",
    "line 51,105 58,108 68,110 80,111 92,110 102,108 107,105",
    "vis 12",
    "line 51,104 58,107 68,109 80,110 92,109 102,107 107,104",
  ),
  item(
    "rope-depth",
    "Rope depth",
    "depth",
    "vis off",
    "pri 11",
    "rect 48,101 50,121",
    "rect 107,101 109,121",
    "line 51,104 58,107 68,109 80,110 92,109 102,107 107,104",
    "line 51,105 58,108 68,110 80,111 92,110 102,108 107,105",
  ),
  item(
    "bust-depth",
    "Bust & plinth depth",
    "depth",
    "pri 14",
    "polygon 0,102 14,102 14,167 0,167",
    "fill 5,140",
  ),
  wallBase({ west: "wall", east: "door" }),
  item("rope-barrier", "Rope barrier", "walk", "pri 0", "line 47,112 47,121 110,121 110,112"),
  item("bust-barrier", "Bust barrier", "walk", "line 15,126 15,167"),
].join("\n");

// ---------------------------------------------------------------------------
// Sprite Lab

/** One film-strip window: the robot's wave, cel by cel. `arm` is the raised arm's hand. */
function filmFrame(k: number, arm: readonly [number, number]): string[] {
  const x = 43 + 18 * k;
  const c = x + 6;
  return [
    "vis 8",
    `rect ${x},28 ${x + 14},38`,
    "vis 6",
    `rect ${c - 1},29 ${c + 1},31`,
    `rect ${c - 2},32 ${c + 2},36`,
    `line ${c - 1},37 ${c - 1},37`,
    `line ${c + 1},37 ${c + 1},37`,
    `line ${c - 3},33 ${c - 3},36`,
    `line ${c + 3},33 ${arm[0] + c},${arm[1]}`,
    "vis 14",
    `line ${c},30`,
  ];
}

const LAB_PICTURE = [
  "# Sprite Lab: the WAKE lever, a sprite-editing console under a flipbook film",
  "# strip, and the sleeping robot in its glowing charging bay. Doorways lead back",
  "# to the red gallery and on to the green archive.",
  ...shellOutline({
    rail: [
      [26, 51],
      [59, 83],
      [90, 119],
    ],
    baseboard: [
      [26, 51],
      [57, 85],
    ],
  }),
  doorSide("west", 4),
  doorSide("east", 2),
  item("strip-light", "Strip light", "art", "vis 7", "rect 36,17 123,19", "vis 15", "fill 37,18"),
  item(
    "film-strip",
    "Flipbook film strip",
    "art",
    "vis 0",
    "rect 40,24 115,42",
    ...filmFrame(0, [4, 37]),
    ...filmFrame(1, [5, 33]),
    ...filmFrame(2, [4, 28]),
    ...filmFrame(3, [5, 31]),
    "vis 0",
    "fill 41,25",
  ),
  item(
    "wake-plate",
    "Lever plate",
    "art",
    "vis 0",
    "rect 26,72 51,108",
    "rect 30,65 47,69",
    "vis 7",
    "fill 30,90",
    "vis 14",
    "fill 31,67",
    "vis 0",
    "line 32,67 34,67",
    "line 36,67 38,67",
    "line 40,67 41,67",
    "line 43,67 45,67",
    "vis 15",
    "line 27,73 50,73",
    "line 27,73 27,107",
    "vis 8",
    "line 28,107 50,107",
    "line 50,74 50,107",
    "line 29,76 29,76",
    "line 48,76 48,76",
    "line 29,104 29,104",
    "line 48,104 48,104",
  ),
  item(
    "monitor",
    "Sprite monitor",
    "art",
    "vis 0",
    "rect 59,74 83,94",
    "rect 62,77 80,91",
    "vis 7",
    "fill 60,80",
    "vis 2",
    "fill 70,84",
    "vis 10",
    "rect 68,79 73,82",
    "rect 67,83 74,88",
    "line 66,84 66,87",
    "line 75,84 76,81",
    "line 69,89 69,90",
    "line 72,89 72,90",
    "vis 15",
    "line 60,75 82,75",
    "line 60,75 60,93",
    "vis 8",
    "line 61,93 82,93",
    "line 82,76 82,93",
  ),
  item(
    "console",
    "Console desk",
    "art",
    "vis 0",
    "rect 55,95 87,99",
    "rect 57,100 85,111",
    "vis 7",
    "fill 56,97",
    "vis 8",
    "fill 60,105",
    "vis 12",
    "rect 60,102 61,103",
    "vis 10",
    "rect 64,102 65,103",
    "vis 14",
    "rect 68,102 69,103",
    "vis 9",
    "line 74,102 82,102",
    "line 74,105 82,105",
    "vis 15",
    "line 56,96 86,96",
  ),
  item(
    "bay",
    "Charging bay",
    "art",
    "vis 0",
    "line 90,106 90,62 92,57 96,53 101,51 108,51 113,53 117,57 119,62 119,106",
    "vis 9",
    "fill 104,70",
    "vis 11",
    "line 101,52 108,52",
    "line 97,54 112,54",
    "vis 1",
    "line 91,62 91,105",
    "line 92,58 92,105",
    "vis 14",
    "rect 102,55 107,56",
  ),
  item(
    "dock",
    "Robot dock",
    "art",
    "vis 0",
    "polygon 89,107 120,107 121,109 121,111 88,111 88,109",
    "line 88,109 121,109",
    "vis 7",
    "fill 104,108",
    "vis 8",
    "fill 104,110",
    "vis 12",
    "line 94,110 95,110",
  ),
  ...shellFills(
    { wall: 1, wainscot: 8, floor: 15 },
    { backX: 53, wainscot: "25,96 88,96 127,96", baseboard: "25,109 86,109 128,109" },
  ),
  item(
    "tiles",
    "Floor tiles",
    "art",
    "vis 7",
    ...floorRows(TILE_ROWS.slice(1, -1)),
    ...floorColumns([
      -60, -48, -36, -24, -12, 0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132, 144, 156, 168, 180,
      192, 204, 216,
    ]),
    `fill ${checkerSeeds([-60, -48, -36, -24, -12, 0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132, 144, 156, 168, 180, 192, 204, 216], 0)}`,
  ),
  item(
    "trim-light",
    "Rail light & rivets",
    "art",
    "vis 7",
    `line 25,${RAIL_Y} 25,${RAIL_Y}`,
    `line 52,${RAIL_Y} 58,${RAIL_Y}`,
    `line 84,${RAIL_Y} 89,${RAIL_Y}`,
    `line 120,${RAIL_Y} 134,${RAIL_Y}`,
    `line ${BACK_LEFT - 1},${recede(BACK_LEFT, RAIL_Y, BACK_LEFT - 1)} 14,${recede(BACK_LEFT, RAIL_Y, 14)}`,
    `line ${BACK_RIGHT + 1},${recede(BACK_RIGHT, RAIL_Y, BACK_RIGHT + 1)} 144,${recede(BACK_RIGHT, RAIL_Y, 144)}`,
    "vis 0",
    ...[52, 88, 124].flatMap((x) => [`line ${x},91 ${x},104`]),
  ),
  item(
    "shadows",
    "Floor shadows",
    "art",
    "vis 8",
    `line ${BACK_LEFT + 1},${FLOOR_Y + 1} ${BACK_RIGHT - 1},${FLOOR_Y + 1}`,
  ),
  wallBase({ west: "door", east: "door" }),
].join("\n");

// ---------------------------------------------------------------------------
// Priority Archive

/** Book spines on one shelf, as [x, height, colour], standing on row `base`. */
function books(base: number, spines: readonly (readonly [number, number, number])[]): string[] {
  const out: string[] = [];
  let colour = -1;
  for (const [x, height, c] of spines) {
    if (c !== colour) {
      out.push(`vis ${c}`);
      colour = c;
    }
    out.push(`line ${x},${base} ${x},${base - height + 1}`);
  }
  return out;
}

/** Filled horizontal spans [y, x1, x2] in one colour. */
function spans(colour: number, list: readonly (readonly [number, number, number])[]): string[] {
  return [`vis ${colour}`, ...list.map(([y, a, b]) => `line ${a},${y} ${b},${y}`)];
}

/**
 * The globe in the east corner: an ocean sphere lit from the left in a brass
 * meridian, on a wooden tripod whose feet stand on the carpet well inside the
 * frame.
 */
function globe(): string[] {
  const cx = 147;
  const cy = 129;
  const sphere: [number, number, number][] = [];
  for (let dy = -9; dy <= 9; dy++) {
    const half = Math.round(5.6 * Math.sqrt(1 - (dy / 9.6) ** 2));
    sphere.push([cy + dy, cx - half, cx + half]);
  }
  return [
    "vis 6",
    "line 147,139 147,147",
    "line 148,139 148,147",
    ...rows(144, 151, 148, 149),
    "line 144,150 142,155",
    "line 151,150 153,155",
    "line 147,150 147,154",
    ...spans(1, sphere),
    ...spans(
      9,
      sphere.map(([y, a, b]) => [y, a, Math.round((a + b) / 2) - 1] as const),
    ),
    "vis 10",
    "line 143,125 145,122 148,123 147,127 144,129",
    "line 144,126 146,126",
    "line 149,132 151,131 151,135 149,136",
    "line 150,133 150,134",
    "vis 2",
    "line 146,123 148,124",
    "line 151,132 151,134",
    "vis 14",
    "line 147,118 150,119 152,121 153,124 154,129 153,134 152,137 150,139 147,140",
    "line 147,117 147,118",
    "vis 15",
    "line 143,123 144,122",
    "vis 0",
    "line 143,156 155,156",
  ];
}

const ARCHIVE_PICTURE = [
  "# Priority Archive: Felix's counter under the depth chart, a bookcase with its",
  "# tall ledger stand, a card catalog under the clock, and a globe closing the",
  "# east corner. The west doorway shows the blue Sprite Lab.",
  ...shellOutline({
    rail: [
      [26, 54],
      [104, 133],
    ],
    baseboard: [
      [26, 54],
      [104, 133],
    ],
  }),
  doorSide("west", 1),
  solidSide("east"),
  item(
    "depth-chart",
    "Depth chart",
    "art",
    "vis 6",
    "rect 67,22 92,51",
    "vis 0",
    "rect 69,24 90,49",
    ...Array.from({ length: 12 }, (_, band) => [
      `vis ${band + 4}`,
      ...rows(70, 89, 25 + 2 * band, 26 + 2 * band),
    ]).flat(),
    "vis 14",
    "fill 68,30",
  ),
  item(
    "clock",
    "Wall clock",
    "art",
    "vis 6",
    "polygon 116,28 122,28 125,31 126,35 125,39 122,42 116,42 113,39 112,35 113,31",
    "vis 14",
    "fill 119,29",
    "vis 0",
    "polygon 117,30 121,30 123,32 124,35 123,38 121,40 117,40 115,38 114,35 115,32",
    "line 119,35 119,31",
    "line 119,35 122,36",
  ),
  item(
    "floor-plan",
    "Department map",
    "art",
    "vis 6",
    `polygon 141,34 141,64 154,${recede(141, 64, 154)} 154,${recede(141, 34, 154)}`,
    "vis 0",
    `polygon 143,37 143,61 152,${recede(143, 61, 152)} 152,${recede(143, 37, 152)}`,
    "vis 14",
    "fill 142,50",
    "vis 4",
    "rect 145,40 150,44",
    "vis 1",
    "rect 145,47 150,51",
    "vis 2",
    "rect 145,54 150,58",
    "vis 12",
    "line 147,56 148,56",
  ),
  item(
    "bookcase",
    "Bookcase",
    "art",
    "vis 0",
    "rect 26,22 54,111",
    "rect 28,25 52,108",
    "line 28,40 52,40",
    "line 28,56 52,56",
    "line 28,72 52,72",
    "line 28,88 52,88",
    "vis 6",
    "fill 27,60",
    "vis 8",
    "fill 40,30 40,45 40,62 40,78 40,95",
    ...books(39, [
      [29, 11, 4],
      [30, 11, 4],
      [31, 12, 1],
      [32, 12, 1],
      [34, 10, 14],
      [35, 10, 14],
      [36, 13, 5],
      [37, 13, 5],
      [40, 9, 2],
      [41, 11, 12],
      [42, 11, 12],
      [44, 12, 3],
      [45, 12, 3],
      [47, 10, 4],
      [48, 10, 4],
      [50, 12, 9],
      [51, 12, 9],
    ]),
    ...books(55, [
      [29, 12, 1],
      [30, 12, 1],
      [31, 10, 6],
      [33, 13, 14],
      [34, 13, 14],
      [36, 11, 4],
      [37, 11, 4],
      [38, 11, 4],
      [41, 12, 10],
      [42, 12, 10],
      [44, 9, 5],
      [45, 9, 5],
      [47, 13, 1],
      [48, 13, 1],
      [50, 11, 12],
      [51, 11, 12],
    ]),
    ...books(71, [
      [29, 10, 14],
      [30, 10, 14],
      [32, 13, 4],
      [33, 13, 4],
      [35, 12, 9],
      [36, 12, 9],
      [38, 11, 5],
      [39, 11, 5],
      [42, 13, 2],
      [43, 13, 2],
      [45, 10, 12],
      [46, 10, 12],
      [48, 12, 3],
      [49, 12, 3],
      [51, 9, 14],
    ]),
    ...books(87, [
      [29, 13, 5],
      [30, 13, 5],
      [32, 11, 1],
      [33, 11, 1],
      [35, 12, 12],
      [36, 12, 12],
      [37, 12, 12],
      [40, 10, 14],
      [41, 10, 14],
      [43, 13, 4],
      [44, 13, 4],
      [47, 11, 10],
      [48, 11, 10],
      [50, 12, 1],
      [51, 12, 1],
    ]),
    ...books(107, [
      [29, 14, 4],
      [30, 14, 4],
      [31, 14, 4],
      [33, 12, 3],
      [34, 12, 3],
      [36, 15, 1],
      [37, 15, 1],
      [47, 13, 14],
      [48, 13, 14],
      [50, 12, 5],
      [51, 12, 5],
    ]),
    "vis 14",
    "line 27,23 53,23",
    "line 29,41 51,41",
    "line 29,57 51,57",
    "line 29,73 51,73",
    "line 29,89 51,89",
  ),
  item(
    "catalog",
    "Card catalog",
    "art",
    "vis 0",
    "rect 104,60 133,111",
    "line 104,63 133,63",
    ...[111, 118, 126].map((x) => `line ${x},63 ${x},108`),
    ...[70, 77, 84, 91, 98, 105].map((y) => `line 104,${y} 133,${y}`),
    "line 104,108 133,108",
    "vis 6",
    "fill 105,61",
    ...[66, 73, 80, 87, 94, 101].map((y) => `fill 106,${y} 113,${y} 120,${y} 128,${y}`),
    "vis 8",
    "fill 106,110",
    "vis 14",
    "line 105,61 132,61",
    ...[66, 73, 80, 87, 94, 101].map((y) => `line 107,${y} 108,${y}`),
    ...[66, 73, 80, 87, 94, 101].map((y) => `line 114,${y} 115,${y}`),
    ...[66, 73, 80, 87, 94, 101].map((y) => `line 121,${y} 122,${y}`),
    ...[66, 73, 80, 87, 94, 101].map((y) => `line 129,${y} 130,${y}`),
  ),
  ...shellFills({ wall: 2, wainscot: 6, floor: 4 }, { wall: "60,30" }),
  item(
    "carpet",
    "Carpet border",
    "art",
    "vis 12",
    ...floorRows([116]),
    ...floorColumns([6, 153]),
    "vis 14",
    ...floorRows([118]),
    ...floorColumns([8, 151]),
  ),
  item(
    "trim-light",
    "Rail light",
    "art",
    "vis 14",
    `line 25,${RAIL_Y} 25,${RAIL_Y}`,
    `line 55,${RAIL_Y} 103,${RAIL_Y}`,
    `line 134,${RAIL_Y} 134,${RAIL_Y}`,
    `line ${BACK_LEFT - 1},${recede(BACK_LEFT, RAIL_Y, BACK_LEFT - 1)} 14,${recede(BACK_LEFT, RAIL_Y, 14)}`,
    `line ${BACK_RIGHT + 1},${recede(BACK_RIGHT, RAIL_Y, BACK_RIGHT + 1)} 159,${recede(BACK_RIGHT, RAIL_Y, 159)}`,
  ),
  "# The counter, its fittings and the ledger stand are painted over the room.",
  item(
    "ledger-stand",
    "Ledger stand",
    "art",
    ...spans(6, [
      [88, 49, 53],
      [89, 44, 53],
      [90, 39, 53],
      [91, 38, 52],
      ...Array.from({ length: 29 }, (_, i) => [92 + i, 40, 51] as const),
    ]),
    ...spans(15, [
      [84, 49, 52],
      [85, 44, 52],
      [86, 39, 51],
      [87, 39, 46],
    ]),
    "vis 7",
    "line 45,84 45,86",
    "line 41,86 43,86",
    "line 47,85 50,84",
    "vis 8",
    "line 46,85 46,87",
    "line 51,92 51,121",
    "line 40,121 51,121",
    "rect 42,95 49,117",
    "vis 14",
    "line 40,92 40,120",
    "line 43,96 48,96",
    "line 43,96 43,116",
  ),
  "# Felix's tag on the stand: its depth is still to come (LOOK TAG).",
  item(
    "ledger-tag",
    "Depth pending tag",
    "art",
    "vis 0",
    "line 46,93 46,97",
    "vis 15",
    ...rows(44, 48, 98, 102),
    "vis 12",
    "line 45,99 47,99",
    "line 45,101 46,101",
    "vis 7",
    "line 48,98 48,102",
    "line 44,102 47,102",
  ),
  item(
    "counter",
    "Counter",
    "art",
    ...spans(
      6,
      Array.from({ length: 32 }, (_, i) => [86 + i, 56, 118] as const),
    ),
    ...spans(
      8,
      Array.from({ length: 4 }, (_, i) => [118 + i, 56, 118] as const),
    ),
    "vis 14",
    "line 56,85 118,85",
    "vis 0",
    "line 57,89 117,89",
    "line 56,86 56,121",
    "line 118,86 118,121",
    "rect 60,92 76,114",
    "rect 79,92 95,114",
    "rect 98,92 114,114",
    "rect 81,98 93,101",
    ...spans(14, [
      [99, 82, 92],
      [100, 82, 92],
    ]),
    "line 61,93 75,93",
    "line 61,93 61,113",
    "line 80,93 94,93",
    "line 80,93 80,97",
    "line 80,102 80,113",
    "line 99,93 113,93",
    "line 99,93 99,113",
    "vis 6",
    "line 83,99 85,99",
    "line 87,100 91,100",
  ),
  item(
    "desk-lamp",
    "Banker's lamp",
    "art",
    ...spans(10, [
      [77, 63, 68],
      [78, 62, 69],
      [79, 61, 70],
    ]),
    ...spans(2, [[80, 61, 70]]),
    "vis 15",
    "line 63,78 64,78",
    ...spans(14, [
      [81, 65, 65],
      [82, 65, 65],
      [83, 65, 65],
      [84, 62, 68],
    ]),
  ),
  item(
    "bell",
    "Service bell",
    "art",
    ...spans(14, [
      [82, 101, 103],
      [83, 100, 104],
    ]),
    ...spans(6, [[84, 99, 105]]),
    "vis 0",
    "line 102,81",
    "vis 15",
    "line 101,82",
  ),
  item(
    "lamp-stalk",
    "Signal lamp stalk",
    "art",
    "vis 6",
    "line 113,75 113,84",
    "line 111,84 115,84",
    "vis 14",
    "line 112,76 112,83",
  ),
  item("globe", "Globe", "art", ...globe()),
  item(
    "shadows",
    "Floor shadows",
    "art",
    "vis 0",
    "line 57,122 118,122",
    "line 41,122 52,122",
    "vis 6",
    "line 55,113 55,113",
  ),
  "# The counter is the priority lesson: 11, one step closer than Felix's 10.",
  "# The ledger stand has no depth of its own yet: that is the Studio challenge.",
  item(
    "counter-depth",
    "Counter depth",
    "depth",
    "vis off",
    "pri 11",
    "rect 56,85 118,121",
    "fill 57,86",
  ),
  item("globe-depth", "Globe depth", "depth", "pri 14", "rect 141,117 155,156", "fill 147,130"),
  wallBase({ west: "door", east: "wall" }),
  item("counter-barrier", "Counter barrier", "walk", "pri 0", "line 56,112 56,122 118,122 118,112"),
  item("stand-barrier", "Ledger stand barrier", "walk", "line 40,121 51,121"),
  item("globe-barrier", "Globe barrier", "walk", "line 143,123 143,157 159,157"),
].join("\n");

// ---------------------------------------------------------------------------
// The mural: picture 4, overlaid on the gallery by PAINT MURAL.

/**
 * A landscape recipe for the gallery canvas (x 54..105, y 30..73). Each
 * object is one item, so scrubbing the draw order shows the recipe: the sun
 * (drawn and filled on the empty canvas), clouds, far mountains with snow,
 * green hills, a winding river and a cottage, then the fills that pour colour
 * into the white left between the lines, and last a tree painted over the
 * finished view. Fills only flood white, which is why the sky comes last.
 */
export const MURAL_PICTURE = [
  "# The canvas is primed white first: the overlay lands on the gallery's grey canvas.",
  item("primer", "Canvas primer", "art", "vis 15", ...rows(54, 105, 30, 73)),
  item("edge", "Canvas edge", "art", "vis 0", "rect 53,29 106,74"),
  item(
    "sun",
    "Sun",
    "art",
    "vis 14",
    "polygon 60,32 62,32 63,33 64,35 64,37 63,39 62,40 60,40 59,39 58,37 58,35 59,33",
    "fill 61,36",
  ),
  item(
    "clouds",
    "Clouds",
    "art",
    "vis 7",
    "polygon 70,36 71,34 74,33 76,34 78,33 81,34 82,36 80,37 72,37",
    "polygon 88,40 90,38 93,38 95,39 97,39 98,41 96,42 89,42",
  ),
  item(
    "mountains",
    "Far mountains",
    "art",
    "vis 9",
    "line 54,50 58,47 62,48 66,44 70,39 73,41 76,44 79,42 83,46 87,44 91,48 96,46 101,49 105,48",
    "line 67,43 69,44 71,43 72,42",
    "line 85,45 87,46 88,45",
  ),
  item(
    "hills",
    "Green hills",
    "art",
    "vis 2",
    "line 54,56 58,54 63,53 68,55 73,54 78,53 84,55 90,54 96,56 101,55 105,56",
  ),
  item(
    "meadow-line",
    "Meadow edge",
    "art",
    "vis 2",
    "line 54,63 60,61 67,62 76,61 86,62 95,61 105,63",
  ),
  item(
    "river",
    "River",
    "art",
    "vis 1",
    "line 76,54 74,56 75,58 73,61 70,64 69,67 66,70 64,73",
    "line 78,54 77,56 78,58 77,61 76,64 78,67 81,70 85,73",
  ),
  item(
    "cottage",
    "Cottage",
    "art",
    "vis 8",
    "rect 89,52 93,55",
    "vis 4",
    "polygon 88,52 91,49 94,52",
    "fill 91,51",
    "vis 6",
    "line 91,54 91,55",
  ),
  item("mountain-paint", "Mountain colour", "art", "vis 9", "fill 60,49 80,46 100,51"),
  item("hill-paint", "Hill colour", "art", "vis 2", "fill 60,58 95,58"),
  item("meadow-paint", "Meadow colour", "art", "vis 10", "fill 58,68 95,68"),
  item("river-paint", "River colour", "art", "vis 1", "fill 76,56 76,66"),
  item("sky", "Sky", "art", "vis 11", "fill 100,32"),
  item(
    "ripples",
    "River light",
    "art",
    "vis 9",
    "line 74,69 76,69",
    "line 73,65 74,65",
    "line 70,72 72,72",
    "vis 15",
    "line 77,71 79,71",
  ),
  item(
    "tree",
    "Tree",
    "art",
    ...spans(6, [
      [62, 100, 101],
      [63, 100, 101],
      [64, 100, 101],
      [65, 100, 101],
      [66, 100, 101],
      [67, 100, 101],
      [68, 100, 101],
      [69, 99, 102],
      [70, 99, 102],
    ]),
    ...spans(2, [
      [42, 99, 102],
      [43, 97, 104],
      [44, 96, 105],
      [45, 95, 105],
      [46, 95, 105],
      [47, 94, 105],
      [48, 94, 105],
      [49, 94, 105],
      [50, 94, 105],
      [51, 94, 105],
      [52, 95, 105],
      [53, 95, 105],
      [54, 96, 105],
      [55, 97, 104],
      [56, 96, 105],
      [57, 95, 105],
      [58, 95, 105],
      [59, 96, 104],
      [60, 97, 103],
      [61, 99, 102],
    ]),
    ...spans(10, [
      [43, 98, 99],
      [44, 97, 98],
      [45, 96, 97],
      [46, 96, 96],
      [47, 95, 96],
      [48, 95, 95],
      [49, 95, 95],
      [50, 95, 96],
      [57, 96, 97],
      [58, 96, 96],
    ]),
  ),
  item(
    "grass",
    "Grass tufts",
    "art",
    "vis 2",
    "line 57,70 58,69 59,70",
    "line 88,66 89,65 90,66",
    "line 62,66 63,65",
  ),
].join("\n");

export const ORIGINAL_SCENE_PICTURES: Readonly<Record<number, string>> = {
  1: `${GALLERY_PICTURE}\nend\n`,
  2: `${LAB_PICTURE}\nend\n`,
  3: `${ARCHIVE_PICTURE}\nend\n`,
};

/** Every picture the tutorial ships: the three rooms and the mural overlay. */
export const TUTORIAL_PICTURES: Readonly<Record<number, string>> = {
  ...ORIGINAL_SCENE_PICTURES,
  4: `${MURAL_PICTURE}\nend\n`,
};
