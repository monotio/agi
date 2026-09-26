import type { BuildCelInput, BuildViewInput } from "../../src/view/view.ts";

/**
 * The tutorial's characters as native AGI cels, drawn as pixel grids: one
 * character per pixel, displayed at AGI's 2:1 width. The light comes from
 * the upper left, as in the rooms: left edges catch it, right edges shade.
 */

/** The transparent index: light magenta, which no character uses. */
const TRANSPARENT = 13;

const PALETTE: Record<string, number> = {
  ".": TRANSPARENT,
  K: 0, // black
  B: 1, // blue
  G: 2, // green
  C: 3, // cyan
  R: 4, // red
  M: 5, // magenta
  N: 6, // brown
  l: 7, // light grey
  D: 8, // dark grey
  b: 9, // light blue
  g: 10, // light green
  c: 11, // light cyan
  r: 12, // light red
  Y: 14, // yellow
  W: 15, // white
};

/** A cel from equal-length rows of palette characters. */
function cel(rows: readonly string[], swap: Record<string, string> = {}): BuildCelInput {
  const width = rows[0]!.length;
  if (rows.some((row) => row.length !== width)) {
    throw new Error(`cel rows must all be ${width} wide`);
  }
  return {
    width,
    height: rows.length,
    transparentColor: TRANSPARENT,
    pixels: rows.flatMap((row) =>
      [...row].map((symbol) => {
        const colour = PALETTE[swap[symbol] ?? symbol];
        if (colour === undefined) throw new Error(`unknown cel colour '${symbol}'`);
        return colour;
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// The apprentice (VIEW 0): 10x32, brown hair, light cyan tunic, blue trousers.
// Skin is S; the tunic's near arm is C, so it reads over the tunic.

const SKIN = "r";

const SIDE_HEAD = [
  "...NNNN...",
  "..NNNNNN..",
  ".NNNNNNNN.",
  ".NNNNNNNN.",
  ".NNNNNSKS.",
  ".NNNNSSSSS",
  "..NNNSSSS.",
  "...NNSSR..",
  "....SSS...",
  "....SS....",
];

type ArmSwing = "down" | "back" | "front";

/**
 * Side torso rows 10..20: the tunic, belt and hips, and the near arm (a
 * darker sleeve ending in a hand) hanging, swung back or swung forward.
 */
function sideTorso(swing: ArmSwing): string[] {
  const rows = [
    "...ccccc..",
    "..ccccccc.",
    "..ccccccc.",
    "...ccccc..",
    "...ccccc..",
    "...ccccc..",
    "...ccccc..",
    "...ccccc..",
    "...ccccc..",
    "...CCCCC..",
    "...BBBBB..",
  ];
  const put = (x: number, y: number, c: string) => {
    rows[y] = rows[y]!.slice(0, x) + c + rows[y]!.slice(x + 1);
  };
  // [first sleeve column per row 1..7], then the hand's columns at row 8.
  const path: Record<ArmSwing, readonly number[]> = {
    down: [5, 5, 5, 5, 5, 5, 5, 5],
    back: [4, 4, 3, 3, 2, 2, 1, 1],
    front: [5, 5, 6, 6, 7, 7, 8, 8],
  };
  path[swing].forEach((x, i) => {
    const c = i === 7 ? "S" : "C";
    put(x, 1 + i, c);
    put(x + 1, 1 + i, c);
  });
  return rows;
}

/** Side legs rows 21..31. */
const SIDE_LEGS: Record<"stride" | "pass", readonly string[]> = {
  stride: [
    "..BBBBBB..",
    "..BBB.BBB.",
    ".BBB...BB.",
    ".BB....BB.",
    ".BB.....BB",
    "BB......BB",
    "BB......BB",
    "BB......BB",
    "KK......BB",
    "KKK....KKK",
    "KK.....KKK",
  ],
  pass: [
    "...BBBBB..",
    "...BBBBB..",
    "..BBBBB...",
    "..BB.BB...",
    ".BB..BB...",
    ".BB..BB...",
    "KK...BB...",
    "KK...BB...",
    ".....BB...",
    ".....KKKK.",
    ".....KKKK.",
  ],
};

function side(arms: ArmSwing, legs: keyof typeof SIDE_LEGS): BuildCelInput {
  return cel([...SIDE_HEAD, ...sideTorso(arms), ...SIDE_LEGS[legs]], { S: SKIN });
}

const FRONT_HEAD = [
  "...NNNN...",
  "..NNNNNN..",
  ".NNNNNNNN.",
  ".NNSSSSNN.",
  ".NSKSSKSN.",
  ".NSSSSSSN.",
  "..SSRRSS..",
  "..SSSSSS..",
  "...SSSS...",
  "....SS....",
];

const BACK_HEAD = [
  "...NNNN...",
  "..NNNNNN..",
  ".NNNNNNNN.",
  ".NNNNNNNN.",
  ".NNNNNNNN.",
  ".SNNNNNNS.",
  "..NNNNNN..",
  "..NNNNNN..",
  "...SSSS...",
  "....SS....",
];

/** Front and back torso rows 10..20; `swing` shortens the left (-1) or right (1) arm. */
function frontTorso(swing: -1 | 0 | 1): string[] {
  const rows = ["..cccccc..", ...Array.from({ length: 7 }, () => ".CccccccC."), ".SccccccS."];
  const hand = (x: number) => {
    rows[7] = rows[7]!.slice(0, x) + "S" + rows[7]!.slice(x + 1);
    rows[8] = rows[8]!.slice(0, x) + "." + rows[8]!.slice(x + 1);
  };
  if (swing === -1) hand(1);
  if (swing === 1) hand(8);
  return [...rows, "..CCCCCC..", "..BBBBBB.."];
}

/** Front and back legs rows 21..31; `lift` raises the left (-1) or right (1) foot. */
function frontLegs(lift: -1 | 0 | 1): string[] {
  const legs = [
    "..BBBBBB..",
    "..BB..BB..",
    "..BB..BB..",
    "..BB..BB..",
    "..BB..BB..",
    "..BB..BB..",
    "..BB..BB..",
    "..BB..BB..",
    "..BB..BB..",
    ".KKK..KKK.",
    ".KKK..KKK.",
  ];
  if (lift === -1) {
    legs[8] = "..KK..BB..";
    legs[9] = ".KKK..KKK.";
    legs[10] = "......KKK.";
  }
  if (lift === 1) {
    legs[8] = "..BB..KK..";
    legs[9] = ".KKK..KKK.";
    legs[10] = ".KKK......";
  }
  return legs;
}

const rightWalk = [
  side("back", "stride"),
  side("down", "pass"),
  side("front", "stride"),
  side("down", "pass"),
];
const frontWalk = (
  [
    [-1, 1],
    [0, 0],
    [1, -1],
    [0, 0],
  ] as const
).map(([swing, lift]) =>
  cel([...FRONT_HEAD, ...frontTorso(swing), ...frontLegs(lift)], { S: SKIN }),
);
const backWalk = (
  [
    [-1, 1],
    [0, 0],
    [1, -1],
    [0, 0],
  ] as const
).map(([swing, lift]) =>
  cel([...BACK_HEAD, ...frontTorso(swing), ...frontLegs(lift)], { S: SKIN }),
);

// ---------------------------------------------------------------------------
// The teaching robot (VIEWs 1 and 2): 14x32, copper, three-quarter view facing
// right, so its mirrored loop visibly faces left. Its right-hand arm waves.

const ROBOT_HEAD = [
  "........A.....",
  ".......DA.....",
  ".......D......",
  "....NNNNNN....",
  "...NYYNNNNN...",
  "..NYNNNNNNNN..",
  "..NNNKKKKKKN..",
  "..NNNKKKEEKN..",
  "..NNNKKKKKKN..",
  "..NYNNNNNNNN..",
  "...NNNNNNNN...",
  ".....DDDD.....",
];

const ROBOT_BODY = [
  "...NNNNNNNN...",
  "..NYNNNNNNNN..",
  "..NYNllllllN..",
  "..NYNlHHlllN..",
  "..NYNlHHlllN..",
  "..NYNllllllN..",
  "..NYNNNNNNNN..",
  "..NNNNNNNNNN..",
  "...DDDDDDDD...",
  "....NN..NN....",
  "....NN..NN....",
  "....DD..DD....",
  "....NN..NN....",
  "...NNNN.NNNN..",
  "...NNNNNNNNNN.",
  "..KKKKKKKKKKK.",
];

type ArmPose = "down" | "raise" | "up" | "wave";

/**
 * The still arm on the left and the waving arm on the right (two columns
 * wide, a grey hand at the end). Only the waving arm changes between cels.
 */
function robotArms(rows: string[], pose: ArmPose): void {
  const put = (x: number, y: number, c: string) => {
    rows[y] = rows[y]!.slice(0, x) + c + rows[y]!.slice(x + 1);
  };
  const arm = (x: number, y: number, c = "N") => {
    put(x, y, c);
    put(x + 1, y, c);
  };
  for (let y = 13; y <= 19; y++) arm(0, y, y === 13 ? "D" : "N");
  arm(0, 20, "l");
  arm(12, 13, "D");
  const wave: Record<ArmPose, readonly (readonly [number, number, string?])[]> = {
    down: [
      [12, 14],
      [12, 15],
      [12, 16],
      [12, 17],
      [12, 18],
      [12, 19],
      [12, 20, "l"],
    ],
    raise: [
      [12, 12],
      [12, 11],
      [12, 10, "l"],
    ],
    up: [
      [12, 12],
      [12, 11],
      [12, 10],
      [12, 9],
      [12, 8],
      [12, 7],
      [12, 6, "l"],
      [12, 5, "l"],
    ],
    wave: [
      [12, 12],
      [12, 11],
      [12, 10],
      [12, 9],
      [11, 8],
      [11, 7],
      [11, 6, "l"],
      [10, 5, "l"],
    ],
  };
  for (const [x, y, c] of wave[pose]) arm(x, y, c);
}

function robot(pose: ArmPose, awake: boolean): BuildCelInput {
  const rows = [...ROBOT_HEAD, ...ROBOT_BODY];
  robotArms(rows, pose);
  if (!awake) {
    // Asleep: a dark visor and antenna, and a little "z" drifting off.
    rows[0] = "..........WWW.";
    rows[1] = ".......D....W.";
    rows[2] = ".......D...WWW";
  }
  return cel(rows, awake ? { A: "r", E: "Y", H: "r" } : { A: "D", E: "D", H: "D" });
}

const robotAsleep = robot("down", false);
const robotWave = (["down", "raise", "up", "wave"] as const).map((pose) => robot(pose, true));

// ---------------------------------------------------------------------------
// Felix (VIEW 3): 14x32, a ferret clerk in a green eyeshade and blue waistcoat.
// Rows 0..15 are his head and collar, the part the counter leaves in view.

const FELIX_OPEN = [
  "..NN......NN..",
  ".NWNN....NNWN.",
  ".NNGGGGGGGGNN.",
  "..gggggggggg..",
  ".gggggggggggg.",
  "..NNNNNNNNNN..",
  "..NKKKNNKKKN..",
  "..NKWKNNKWKN..",
  "..NNKWWWWKNN..",
  "...NWWKKWWN...",
  "....WWWWWW....",
  ".....WWWW.....",
  "......WW......",
  "...WW.RR.WW...",
  "..BBWWRRWWBB..",
  ".BBBBWWWWBBBB.",
  ".BBBBBWWBBBBB.",
  ".NBBBBWWBBBBN.",
  ".NBBBBYWBBBBN.",
  ".NBBBBWWBBBBN.",
  ".NBBBBYWBBBBN.",
  "..WBBBWWBBBW..",
  "..WBBBBBBBBW..",
  "...NNNNNNNN...",
  "...NNNNNNNN...",
  "...NNN..NNN...",
  "...NNN..NNN..N",
  "...NNN..NNN.NN",
  "...NNN..NNNNN.",
  "..NNNN..NNNN..",
  "..WWWN..NWWW..",
  "..KKKK..KKKK..",
];

const FELIX_BLINK = FELIX_OPEN.map((row, y) => (y === 7 ? "..NKKKNNKKKN.." : row));

export const CHARACTER_VIEWS: Readonly<Record<number, BuildViewInput>> = {
  0: {
    description: "The apprentice",
    loops: [{ cels: rightWalk }, { mirrorLoop: 0 }, { cels: frontWalk }, { cels: backWalk }],
  },
  1: { description: "Teaching robot, asleep", loops: [{ cels: [robotAsleep] }] },
  2: {
    description: "Teaching robot, waving: loop 1 mirrors loop 0",
    loops: [{ cels: robotWave }, { mirrorLoop: 0 }],
  },
  3: {
    description: "Felix, archive clerk",
    loops: [{ cels: [cel(FELIX_OPEN), cel(FELIX_BLINK)] }],
  },
};
