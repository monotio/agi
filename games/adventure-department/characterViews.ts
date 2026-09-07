import type { BuildCelInput, BuildViewInput } from "../../src/view/view.ts";

const BLACK = 0;
const LIGHT_CYAN = 11;
const DARK_RED = 4;
const BROWN = 6;
const LIGHT_GRAY = 7;
const DARK_GRAY = 8;
const YELLOW = 14;
const WHITE = 15;
const TRANSPARENT = 13;

interface MutableCel {
  readonly width: number;
  readonly height: number;
  readonly pixels: number[];
}

function blankCel(width: number, height: number): MutableCel {
  return { width, height, pixels: new Array<number>(width * height).fill(TRANSPARENT) };
}

function pixel(cel: MutableCel, x: number, y: number, color: number): void {
  if (x < 0 || x >= cel.width || y < 0 || y >= cel.height)
    throw new RangeError(`sprite pixel ${x},${y} outside ${cel.width}x${cel.height}`);
  cel.pixels[y * cel.width + x] = color;
}

function rectangle(
  cel: MutableCel,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: number,
): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) pixel(cel, x, y, color);
}

function points(
  cel: MutableCel,
  color: number,
  coordinates: readonly (readonly [number, number])[],
): void {
  for (const [x, y] of coordinates) pixel(cel, x, y, color);
}

function finish(cel: MutableCel): BuildCelInput {
  if (cel.pixels.length !== cel.width * cel.height)
    throw new Error("invalid native cel dimensions");
  return {
    width: cel.width,
    height: cel.height,
    transparentColor: TRANSPARENT,
    pixels: cel.pixels,
  };
}

type RobotArmPose = "down" | "half-up" | "up" | "half-down";

/** A broad copper teaching robot. Every pose shares the same head, torso, hips, and feet. */
function robotCel(eyeColor: number, leftArm: RobotArmPose): BuildCelInput {
  const cel = blankCel(14, 32);

  rectangle(cel, 3, 0, 10, 0, BROWN);
  rectangle(cel, 2, 1, 11, 3, BROWN);
  rectangle(cel, 2, 4, 11, 8, BROWN);
  rectangle(cel, 3, 4, 10, 7, BLACK);
  rectangle(cel, 4, 5, 5, 6, eyeColor);
  rectangle(cel, 8, 5, 9, 6, eyeColor);
  rectangle(cel, 4, 9, 9, 10, DARK_GRAY);

  rectangle(cel, 3, 11, 10, 18, BROWN);
  rectangle(cel, 2, 12, 2, 16, DARK_GRAY);
  rectangle(cel, 11, 12, 11, 16, DARK_GRAY);
  points(cel, YELLOW, [
    [4, 12],
    [5, 12],
    [4, 13],
    [5, 13],
    [4, 14],
    [5, 14],
    [6, 14],
    [5, 15],
    [6, 15],
  ]);
  rectangle(cel, 3, 19, 10, 19, BLACK);

  rectangle(cel, 3, 20, 5, 27, DARK_GRAY);
  rectangle(cel, 8, 20, 10, 27, DARK_GRAY);
  rectangle(cel, 4, 24, 5, 25, LIGHT_GRAY);
  rectangle(cel, 8, 24, 9, 25, LIGHT_GRAY);
  rectangle(cel, 2, 28, 5, 30, BROWN);
  rectangle(cel, 8, 28, 11, 30, BROWN);
  rectangle(cel, 1, 31, 5, 31, BLACK);
  rectangle(cel, 8, 31, 12, 31, BLACK);

  // The right arm stays relaxed, giving the moving arm a stable visual reference.
  rectangle(cel, 12, 13, 13, 18, BROWN);
  rectangle(cel, 12, 19, 13, 21, LIGHT_GRAY);

  if (leftArm === "down") {
    rectangle(cel, 0, 13, 1, 18, BROWN);
    rectangle(cel, 0, 19, 1, 21, LIGHT_GRAY);
  } else if (leftArm === "half-up") {
    rectangle(cel, 0, 10, 1, 12, LIGHT_GRAY);
    rectangle(cel, 0, 13, 1, 16, BROWN);
    rectangle(cel, 1, 16, 2, 18, BROWN);
  } else if (leftArm === "up") {
    rectangle(cel, 0, 6, 1, 8, LIGHT_GRAY);
    rectangle(cel, 0, 9, 1, 13, BROWN);
    rectangle(cel, 1, 13, 1, 16, DARK_GRAY);
    rectangle(cel, 1, 16, 2, 18, BROWN);
  } else {
    rectangle(cel, 0, 9, 1, 11, LIGHT_GRAY);
    rectangle(cel, 0, 12, 1, 15, BROWN);
    rectangle(cel, 1, 15, 2, 18, BROWN);
  }

  return finish(cel);
}

/** Felix is staged behind the archive counter: rows 0..15 are the complete readable head. */
function felixCel(blinking: boolean): BuildCelInput {
  const cel = blankCel(14, 32);

  // Rounded ears and one broad head mass preserve the ferret silhouette at 2:1 pixels.
  rectangle(cel, 3, 0, 4, 2, BROWN);
  rectangle(cel, 9, 0, 10, 2, BROWN);
  rectangle(cel, 2, 2, 11, 4, BROWN);
  rectangle(cel, 1, 4, 12, 8, BROWN);
  rectangle(cel, 2, 5, 11, 8, BLACK);
  if (!blinking) {
    rectangle(cel, 4, 6, 5, 6, WHITE);
    rectangle(cel, 8, 6, 9, 6, WHITE);
  }

  // The pale muzzle projects left from the mask; the black nose is deliberately blunt.
  rectangle(cel, 2, 8, 9, 11, LIGHT_GRAY);
  rectangle(cel, 1, 9, 2, 10, BLACK);
  rectangle(cel, 3, 11, 8, 12, LIGHT_GRAY);
  rectangle(cel, 5, 13, 8, 15, LIGHT_GRAY);

  // Everything below row 15 is covered once the counter receives priority 11.
  rectangle(cel, 3, 16, 10, 24, DARK_RED);
  rectangle(cel, 5, 16, 8, 19, LIGHT_GRAY);
  rectangle(cel, 2, 17, 2, 22, BROWN);
  rectangle(cel, 11, 17, 11, 22, BROWN);
  rectangle(cel, 2, 22, 3, 23, LIGHT_GRAY);
  rectangle(cel, 10, 22, 11, 23, LIGHT_GRAY);
  rectangle(cel, 3, 25, 10, 27, BROWN);
  rectangle(cel, 2, 27, 5, 30, BROWN);
  rectangle(cel, 8, 27, 11, 30, BROWN);
  rectangle(cel, 2, 31, 5, 31, BLACK);
  rectangle(cel, 8, 31, 11, 31, BLACK);
  points(cel, BROWN, [
    [11, 25],
    [12, 25],
    [12, 26],
    [13, 26],
    [12, 27],
    [13, 27],
    [11, 28],
    [12, 28],
  ]);

  return finish(cel);
}

function egoHead(cel: MutableCel, facing: "right" | "front" | "back"): void {
  rectangle(cel, 3, 0, 6, 0, BROWN);
  rectangle(cel, 2, 1, 7, 3, BROWN);
  if (facing === "right") {
    rectangle(cel, 3, 3, 7, 6, YELLOW);
    rectangle(cel, 2, 3, 3, 6, BROWN);
    pixel(cel, 7, 4, BLACK);
    pixel(cel, 7, 6, YELLOW);
  } else if (facing === "front") {
    rectangle(cel, 3, 3, 6, 7, YELLOW);
    rectangle(cel, 2, 3, 2, 6, BROWN);
    rectangle(cel, 7, 3, 7, 6, BROWN);
    pixel(cel, 3, 5, BLACK);
    pixel(cel, 6, 5, BLACK);
  } else {
    rectangle(cel, 2, 3, 7, 7, BROWN);
  }
  rectangle(cel, 4, 8, 5, 8, YELLOW);
}

function egoTorso(cel: MutableCel): void {
  rectangle(cel, 3, 9, 6, 18, LIGHT_CYAN);
  rectangle(cel, 2, 10, 7, 13, LIGHT_CYAN);
  rectangle(cel, 3, 18, 6, 19, DARK_GRAY);
}

function egoLeg(
  cel: MutableCel,
  path: readonly (readonly [number, number])[],
  foot: readonly (readonly [number, number])[],
): void {
  for (const [x, y] of path) {
    pixel(cel, x, y, DARK_GRAY);
    if (x + 1 < cel.width) pixel(cel, x + 1, y, DARK_GRAY);
  }
  points(cel, BROWN, foot);
}

function egoSideCel(phase: number): BuildCelInput {
  const cel = blankCel(10, 32);
  egoHead(cel, "right");
  egoTorso(cel);

  const arms = [
    {
      back: [
        [2, 12],
        [1, 14],
        [1, 16],
      ] as const,
      front: [
        [7, 12],
        [8, 14],
        [8, 16],
      ] as const,
    },
    {
      back: [
        [2, 12],
        [2, 14],
        [3, 16],
      ] as const,
      front: [
        [7, 12],
        [7, 14],
        [6, 16],
      ] as const,
    },
    {
      back: [
        [2, 12],
        [1, 14],
        [1, 16],
      ] as const,
      front: [
        [7, 12],
        [8, 14],
        [8, 16],
      ] as const,
    },
    {
      back: [
        [2, 12],
        [3, 14],
        [3, 16],
      ] as const,
      front: [
        [7, 12],
        [6, 14],
        [6, 16],
      ] as const,
    },
  ][phase]!;
  points(cel, LIGHT_CYAN, arms.back);
  points(cel, LIGHT_CYAN, arms.front);
  const backHand = arms.back.at(-1)!;
  const frontHand = arms.front.at(-1)!;
  pixel(cel, backHand[0], backHand[1] + 1, YELLOW);
  pixel(cel, frontHand[0], frontHand[1] + 1, YELLOW);

  if (phase === 0) {
    egoLeg(
      cel,
      [
        [3, 20],
        [3, 21],
        [2, 22],
        [2, 23],
        [1, 24],
        [1, 25],
        [1, 26],
      ],
      [
        [1, 27],
        [2, 27],
        [1, 28],
        [2, 28],
        [3, 28],
      ],
    );
    egoLeg(
      cel,
      [
        [5, 20],
        [5, 21],
        [6, 22],
        [6, 23],
        [7, 24],
        [7, 25],
        [7, 26],
        [7, 27],
        [7, 28],
      ],
      [
        [7, 29],
        [8, 29],
        [7, 30],
        [8, 30],
        [9, 30],
        [7, 31],
        [8, 31],
        [9, 31],
      ],
    );
  } else if (phase === 1) {
    egoLeg(
      cel,
      [
        [3, 20],
        [3, 21],
        [3, 22],
        [3, 23],
        [3, 24],
        [3, 25],
        [3, 26],
        [3, 27],
        [3, 28],
      ],
      [
        [2, 29],
        [3, 29],
        [2, 30],
        [3, 30],
        [4, 30],
        [2, 31],
        [3, 31],
        [4, 31],
      ],
    );
    egoLeg(
      cel,
      [
        [5, 20],
        [5, 21],
        [5, 22],
        [5, 23],
        [5, 24],
        [5, 25],
        [5, 26],
        [5, 27],
      ],
      [
        [5, 28],
        [6, 28],
        [6, 29],
        [7, 29],
      ],
    );
  } else if (phase === 2) {
    egoLeg(
      cel,
      [
        [3, 20],
        [3, 21],
        [4, 22],
        [4, 23],
        [5, 24],
        [5, 25],
        [5, 26],
        [5, 27],
      ],
      [
        [5, 28],
        [6, 28],
        [6, 29],
        [7, 29],
      ],
    );
    egoLeg(
      cel,
      [
        [5, 20],
        [5, 21],
        [4, 22],
        [3, 23],
        [3, 24],
        [2, 25],
        [2, 26],
        [2, 27],
        [2, 28],
      ],
      [
        [1, 29],
        [2, 29],
        [1, 30],
        [2, 30],
        [3, 30],
        [1, 31],
        [2, 31],
        [3, 31],
      ],
    );
  } else {
    egoLeg(
      cel,
      [
        [3, 20],
        [3, 21],
        [3, 22],
        [3, 23],
        [3, 24],
        [3, 25],
        [3, 26],
        [3, 27],
      ],
      [
        [2, 28],
        [3, 28],
        [2, 29],
        [3, 29],
        [4, 29],
      ],
    );
    egoLeg(
      cel,
      [
        [5, 20],
        [5, 21],
        [5, 22],
        [5, 23],
        [5, 24],
        [5, 25],
        [5, 26],
        [5, 27],
        [5, 28],
      ],
      [
        [5, 29],
        [6, 29],
        [5, 30],
        [6, 30],
        [7, 30],
        [5, 31],
        [6, 31],
        [7, 31],
      ],
    );
  }
  return finish(cel);
}

function egoVerticalCel(facing: "front" | "back", phase: number): BuildCelInput {
  const cel = blankCel(10, 32);
  egoHead(cel, facing);
  egoTorso(cel);

  const leftForward = phase === 0 || phase === 3;
  const armShift = phase === 0 ? -1 : phase === 2 ? 1 : 0;
  points(cel, LIGHT_CYAN, [
    [2 + armShift, 14],
    [2 + armShift, 15],
    [2 + armShift, 16],
    [7 - armShift, 14],
    [7 - armShift, 15],
    [7 - armShift, 16],
  ]);
  pixel(cel, 2 + armShift, 17, YELLOW);
  pixel(cel, 7 - armShift, 17, YELLOW);

  const leftX = leftForward ? 2 : 3;
  const rightX = leftForward ? 5 : 6;
  egoLeg(
    cel,
    [
      [3, 20],
      [3, 21],
      [leftX, 22],
      [leftX, 23],
      [leftX, 24],
      [leftX, 25],
      [leftX, 26],
      [leftX, 27],
      [leftX, 28],
    ],
    [
      [leftX, 29],
      [leftX + 1, 29],
      [leftX, 30],
      [leftX + 1, 30],
      [leftX, 31],
      [leftX + 1, 31],
    ],
  );
  egoLeg(
    cel,
    [
      [5, 20],
      [5, 21],
      [rightX, 22],
      [rightX, 23],
      [rightX, 24],
      [rightX, 25],
      [rightX, 26],
      [rightX, 27],
      [rightX, 28],
    ],
    [
      [rightX, 29],
      [rightX + 1, 29],
      [rightX, 30],
      [rightX + 1, 30],
      [rightX, 31],
      [rightX + 1, 31],
    ],
  );
  return finish(cel);
}

const rightWalk = [0, 1, 2, 3].map(egoSideCel);
const frontWalk = [0, 1, 2, 3].map((phase) => egoVerticalCel("front", phase));
const backWalk = [0, 1, 2, 3].map((phase) => egoVerticalCel("back", phase));
const robotOff = robotCel(DARK_GRAY, "down");
const robotWave = [
  robotCel(YELLOW, "down"),
  robotCel(YELLOW, "half-up"),
  robotCel(YELLOW, "up"),
  robotCel(YELLOW, "half-down"),
];

export const CHARACTER_VIEWS: Readonly<Record<number, BuildViewInput>> = {
  0: {
    description: "Apprentice, cyan tunic",
    loops: [{ cels: rightWalk }, { mirrorLoop: 0 }, { cels: frontWalk }, { cels: backWalk }],
  },
  1: { description: "Teaching robot, resting", loops: [{ cels: [robotOff] }] },
  2: { description: "Teaching robot, demonstrating", loops: [{ cels: robotWave }] },
  3: {
    description: "Felix, archive clerk",
    loops: [{ cels: [felixCel(false), felixCel(true)] }],
  },
};
