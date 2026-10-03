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
// The apprentice (VIEW 0): 10x32, brown hair, light cyan tunic with a dark
// cyan belt, blue trousers and black shoes. Each loop holds four cels: 0
// stands, 1 strides with the near leg forward, 2 passes, 3 strides with the
// far leg forward. On a stride the legs spread and the body drops a row.

/** Stack parts top to bottom over a clear top margin, 32 rows in all. */
function figure(...parts: (readonly string[])[]): BuildCelInput {
  const rows = parts.flat();
  return cel([...Array.from({ length: 32 - rows.length }, () => ".".repeat(10)), ...rows]);
}

// Side view, facing right; loop 1 mirrors it. Head rows 0..9.
const SIDE_HEAD = [
  "....NNN...",
  "...NNNNN..",
  "..NNNNNNN.",
  "..NNNNNr..",
  "..NNNNrK..",
  "..NNNrrrr.",
  "...NNrrr..",
  "....rrrr..",
  "....rrr...",
  "....rr....",
];

/** Side torso rows 10..19: the near arm hangs, swings forward or swings back. */
const SIDE_TORSO = {
  down: [
    "...cccc...",
    "...cCCcc..",
    "...ccCcc..",
    "...ccCcc..",
    "...ccCcc..",
    "...ccCcc..",
    "...ccCcc..",
    "...ccrcc..",
    "...CCrCC..",
    "...BBBB...",
  ],
  front: [
    "...cccc...",
    "...cCCcc..",
    "...ccCcc..",
    "...ccCcc..",
    "...cccCc..",
    "...cccCc..",
    "...ccccCr.",
    "...cccccr.",
    "...CCCCC..",
    "...BBBB...",
  ],
  back: [
    "...cccc...",
    "...cCCcc..",
    "...cCccc..",
    "...cCccc..",
    "...Ccccc..",
    "...Ccccc..",
    "..rCcccc..",
    "..rccccc..",
    "...CCCCC..",
    "...BBBB...",
  ],
};

/** Side legs from the hips down: 12 rows standing or passing, 11 striding. */
const SIDE_LEGS = {
  stand: [
    "...BBBB...",
    "...BBBB...",
    "...BBB....",
    "...BBB....",
    "...BBB....",
    "...BBB....",
    "...BBB....",
    "...BBB....",
    "...BBB....",
    "...BBB....",
    "...KKK....",
    "...KKKK...",
  ],
  stride: [
    "...BBBB...",
    "...BBBB...",
    "..BB.BB...",
    "..BB..BB..",
    "..BB..BB..",
    ".BB...BB..",
    ".BB....BB.",
    ".BB....BB.",
    ".BB....BB.",
    "KKK....KKK",
    "..KK...KK.",
  ],
  pass: [
    "...BBBB...",
    "...BBBB...",
    "...BBBB...",
    "...BBBB...",
    "...BBB....",
    "..BBBB....",
    "..BBBB....",
    ".BB.BB....",
    ".KK.BB....",
    "..K.BB....",
    "....KKK...",
    "....KKKK..",
  ],
};

const rightWalk = [
  figure(SIDE_HEAD, SIDE_TORSO.down, SIDE_LEGS.stand),
  figure(SIDE_HEAD, SIDE_TORSO.back, SIDE_LEGS.stride),
  figure(SIDE_HEAD, SIDE_TORSO.down, SIDE_LEGS.pass),
  figure(SIDE_HEAD, SIDE_TORSO.front, SIDE_LEGS.stride),
];

// Front and back views: the figure centres on column 4. Head rows 0..9.
const FRONT_HEAD = [
  "...NNN....",
  "..NNNNN...",
  ".NNNNNNN..",
  ".NNrrrNN..",
  ".NrKrKrN..",
  "..rrrrr...",
  "..rrRrr...",
  "...rrr....",
  "....r.....",
  "...rrr....",
];

const BACK_HEAD = [
  "...NNN....",
  "..NNNNN...",
  ".NNNNNNN..",
  ".NNNNNNN..",
  ".rNNNNNr..",
  "..NNNNN...",
  "..NNNNN...",
  "...NNN....",
  "....r.....",
  "...rrr....",
];

/** Front and back torso rows 10..19; `raise` lifts the left (-1) or right (1) hand a row. */
function frontTorso(raise: -1 | 0 | 1): string[] {
  const rows = [
    "..ccccc...",
    ".CcccccC..",
    ".CcccccC..",
    ".CcccccC..",
    ".CcccccC..",
    ".CcccccC..",
    ".CcccccC..",
    ".rcccccr..",
    ".rCCCCCr..",
    "..BBBBB...",
  ];
  const lift = (x: number) => {
    rows[6] = rows[6]!.slice(0, x) + "r" + rows[6]!.slice(x + 1);
    rows[8] = rows[8]!.slice(0, x) + "." + rows[8]!.slice(x + 1);
  };
  if (raise === -1) lift(1);
  if (raise === 1) lift(7);
  return rows;
}

/** Front and back legs: standing, or one knee bent and its shoe raised two rows. */
const FRONT_LEGS = {
  stand: [
    "..BBBBB...",
    "..BBBBB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.BB...",
    ".KKK.KKK..",
    ".KKK.KKK..",
  ],
  liftLeft: [
    "..BBBBB...",
    "..BBBBB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.BB...",
    ".KKK.BB...",
    ".KKK.BB...",
    ".....KKK..",
    ".....KKK..",
  ],
  liftRight: [
    "..BBBBB...",
    "..BBBBB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.BB...",
    "..BB.KKK..",
    "..BB.KKK..",
    ".KKK......",
    ".KKK......",
  ],
};

/** Stand, step on one foot, stand, step on the other; the opposite hand swings up. */
function frontLoop(head: readonly string[]): BuildCelInput[] {
  return [
    figure(head, frontTorso(0), FRONT_LEGS.stand),
    figure(head, frontTorso(-1), FRONT_LEGS.liftRight),
    figure(head, frontTorso(0), FRONT_LEGS.stand),
    figure(head, frontTorso(1), FRONT_LEGS.liftLeft),
  ];
}

const frontWalk = frontLoop(FRONT_HEAD);
const backWalk = frontLoop(BACK_HEAD);

// ---------------------------------------------------------------------------
// The teaching robot (VIEWs 1 and 2): 14x28, copper, three-quarter view facing
// right, so its mirrored loop visibly faces left. A clear column parts each
// arm from the body; the right-hand arm waves. A, E and H are the antenna
// light, the eyes and the chest light, lit when awake.

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
  "DDDNYNNNNNNDDD",
  "NN.NYNNNNNN.NN",
  "NN.NYlllllN.NN",
  "NN.NYlHHllN.NN",
  "DD.NYlHHllN.DD",
  "NN.NYlllllN.NN",
  "NN.NYNNNNNN.NN",
  "ll.NNNNNNNN.ll",
  "...DDDDDDDD...",
  "....NN..NN....",
  "....NN..NN....",
  "....DD..DD....",
  "....NN..NN....",
  "...NNN..NNN...",
  "...KKK..KKK...",
];

type ArmPose = "down" | "raise" | "up" | "wave";

/**
 * Raise the right-hand arm: clear its hanging pose below the shoulder, then
 * draw it upward, two columns wide, with an elbow joint and a grey hand.
 */
function robotArm(rows: string[], pose: ArmPose): void {
  const put = (x: number, y: number, c: string) => {
    rows[y] = rows[y]!.slice(0, x) + c + rows[y]!.slice(x + 1);
  };
  if (pose === "down") return;
  for (let y = 14; y <= 20; y++) {
    put(12, y, ".");
    put(13, y, ".");
  }
  const up: Record<Exclude<ArmPose, "down">, readonly (readonly [number, number, string])[]> = {
    raise: [
      [12, 12, "N"],
      [12, 11, "D"],
      [12, 10, "N"],
      [12, 9, "l"],
    ],
    up: [
      [12, 12, "N"],
      [12, 11, "N"],
      [12, 10, "D"],
      [12, 9, "N"],
      [12, 8, "N"],
      [12, 7, "N"],
      [12, 6, "l"],
      [12, 5, "l"],
    ],
    wave: [
      [12, 12, "N"],
      [12, 11, "N"],
      [12, 10, "D"],
      [12, 9, "N"],
      [11, 8, "N"],
      [11, 7, "N"],
      [10, 6, "l"],
      [10, 5, "l"],
    ],
  };
  for (const [x, y, c] of up[pose]) {
    put(x, y, c);
    put(x + 1, y, c);
  }
}

function robot(pose: ArmPose, awake: boolean): BuildCelInput {
  const rows = [...ROBOT_HEAD, ...ROBOT_BODY];
  robotArm(rows, pose);
  if (!awake) {
    // Asleep: a dark visor and antenna, and a "z" drifting off.
    rows[0] = "..........WWWW";
    rows[1] = ".......D....W.";
    rows[2] = ".......D...W..";
    rows[3] = "....NNNNNNWWWW";
  }
  return cel(rows, awake ? { A: "r", E: "Y", H: "r" } : { A: "D", E: "D", H: "D" });
}

const robotAsleep = robot("down", false);
const robotWave = (["down", "raise", "up", "wave"] as const).map((pose) => robot(pose, true));

// ---------------------------------------------------------------------------
// Felix (VIEW 3): 14x32, a sable ferret clerk in a green eyeshade and blue
// waistcoat, with the dark legs and tail of his kind.
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
  "..DBBBWWBBBD..",
  "..DBBBBBBBBD..",
  "...DDDDDDDD...",
  "...DDDDDDDD...",
  "...DDD..DDD...",
  "...DDD..DDD..D",
  "...DDD..DDD.DD",
  "...DDD..DDDDD.",
  "...DDD..DDD...",
  "..DDDD..DDDD..",
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
    description: "Teaching robot, waving",
    loops: [{ cels: robotWave }, { mirrorLoop: 0 }],
  },
  3: {
    description: "Felix, archive clerk",
    loops: [{ cels: [cel(FELIX_OPEN), cel(FELIX_BLINK)] }],
  },
};
