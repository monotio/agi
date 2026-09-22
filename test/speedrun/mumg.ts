import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import type { Target } from "../../src/agent/navigation.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

/**
 * Mixed-Up Mother Goose keeps its whole state in variables (logic 0):
 * v31 is the carried thing, v(50 + room) the thing lying in a room, and the
 * room logic publishes that thing's spot in v34/v35. Things 11..17 are the
 * characters that follow the child, 18..30 the objects. Touching a thing picks
 * it up (or swaps it for the carried one); carrying the right thing to its
 * owner sets f42 and plays the rhyme, and the first step after the rhyme
 * (f44) banks the point.
 */
const THING = {
  wife: 11,
  muffet: 12,
  mouse: 13,
  fiddlers: 14,
  sheep: 15,
  dog: 16,
  lamb: 17,
  fiddle: 18,
  pie: 19,
  knife: 20,
  meat: 21,
  pipe: 22,
  bowl: 23,
  broth: 24,
  candlestick: 25,
  pail: 26,
  wateringCan: 27,
  sixpence: 28,
  ladder: 29,
  horse: 30,
} as const;

const N = 1;
const E = 3;
const S = 5;
const W = 7;

/**
 * Owners who still miss their thing stop the child for an eleven-second
 * "help me" bubble when approached empty-handed: a distance() test against
 * one of the room's objects, or a posn() box. Walks steer around both.
 */
const OWNER_OBJECT: Record<number, { object: number; within: number }> = {
  3: { object: 4, within: 28 },
  5: { object: 4, within: 20 },
  7: { object: 6, within: 20 },
  12: { object: 4, within: 20 },
  13: { object: 8, within: 20 },
  23: { object: 4, within: 20 },
  27: { object: 4, within: 20 },
  31: { object: 4, within: 20 },
  33: { object: 4, within: 20 },
  43: { object: 4, within: 20 },
};
const OWNER_BOX: Record<number, Target> = {
  1: { x0: 50, y0: 114, x1: 85, y1: 138 },
  15: { x0: 128, y0: 130, x1: 153, y1: 157 },
  21: { x0: 105, y0: 134, x1: 125, y1: 150 },
  37: { x0: 57, y0: 96, x1: 97, y1: 118 },
  41: { x0: 55, y0: 118, x1: 80, y1: 135 },
};

/** Each owner's "rhyme done" flag, as tested by the room logic before it asks for help. */
const OWNER_DONE: Record<number, number> = {
  1: 53,
  3: 60,
  5: 55,
  7: 66,
  12: 62,
  13: 54,
  15: 61,
  21: 63,
  23: 57,
  27: 58,
  31: 59,
  33: 64,
  37: 65,
  41: 52,
  43: 56,
};

function ownerZones(run: Speedrun): Target[] {
  const room = run.state().room;
  const zones: Target[] = [];
  const done = OWNER_DONE[room];
  const waiting = done === undefined || run.engine.flags[done] === 0;
  const box = OWNER_BOX[room];
  if (box && waiting) zones.push(box);
  const owner = OWNER_OBJECT[room];
  if (owner && waiting) {
    const ego = run.engine.screenObjects[0]!;
    const object = run.engine.screenObjects[owner.object]!;
    const x = object.x + Math.floor(object.width / 2) - Math.floor(ego.width / 2);
    zones.push({
      x0: Math.max(0, x - owner.within),
      x1: Math.min(159, x + owner.within),
      y0: Math.max(0, object.y - owner.within),
      y1: Math.min(167, object.y + owner.within),
    });
  }
  // A thing lying here would be swapped for the carried one on touch (logic 0, f106).
  const lying = run.engine.vars[50 + room]!;
  if (carrying(run) !== 0 && lying !== 0 && lying !== 255) {
    const x = run.engine.vars[34]!;
    const y = run.engine.vars[35]!;
    // Touch range per logic 0: 13 by default, wider for the fiddlers (21), the wife,
    // Miss Muffet and the horse (17), and a flat 24 at most indoors.
    const reach = room > 35 ? 24 : lying === 14 ? 21 : [11, 12, 30].includes(lying) ? 17 : 13;
    zones.push({
      x0: Math.max(0, x - reach - 1),
      x1: Math.min(159, x + reach + 5),
      y0: Math.max(0, y - reach - 1),
      y1: Math.min(167, y + reach + 1),
    });
  }
  // Standing inside a zone means its owner has already spoken on this visit.
  const { x, y } = run.state();
  return zones.filter((zone) => x < zone.x0 || x > zone.x1 || y < zone.y0 || y > zone.y1);
}

interface HopOptions {
  avoid?: readonly Target[];
  /** Walk up to the room's owner instead of around. */
  meetOwner?: boolean;
  /** Permitted span along the exit edge (x for N/S, y for E/W); several rooms fork by it. */
  edge?: readonly [number, number];
  /** The owner lives right behind this passage: the rhyme starts on arrival. */
  delivers?: boolean;
  /** Cross signal lines (building doors lie on them). */
  triggers?: boolean;
}

function carrying(run: Speedrun): number {
  return run.engine.vars[31]!;
}

/** Logic 0 holds the child for three cycles after every room change (v127/f117). */
function settle(run: Speedrun, label: string): void {
  run.wait(
    () => run.engine.movementControlEnabled && run.engine.flags[117] === 0,
    `${label}: control returns`,
    4000,
  );
}

/**
 * The Speed menu is the game's own pacing control (logic 101, controllers
 * 14..17 write v10). "Fastest" runs one logic cycle per host poll, which
 * shortens every walk sixfold; rhymes still last as long as their tunes.
 */
function chooseFastestSpeed(run: Speedrun): void {
  run.key(AGI_KEY.ESCAPE);
  run.until(() => run.engine.textRow(0).includes("Speed"), 120, "menu bar opens");
  for (let n = 0; !run.state().text.includes("Fastest"); n++) {
    assert.ok(n < 4, "Speed menu reachable");
    run.key(AGI_KEY.RIGHT);
    run.advance(2);
  }
  run.key(AGI_KEY.ENTER);
  run.until(() => run.engine.vars[10] === 0, 120, "Fastest speed selected");
}

/** Forbid the exit edge outside the permitted span; only the edge line itself, so walks can start on it. */
function edgeLimits(
  run: Speedrun,
  direction: number,
  edge: readonly [number, number] | undefined,
): Target[] {
  if (!edge) return [];
  const [lo, hi] = edge;
  const limits: Target[] = [];
  if (direction === N || direction === S) {
    const band = direction === N ? { y0: 0, y1: run.engine.horizon + 1 } : { y0: 167, y1: 167 };
    if (lo > 0) limits.push({ x0: 0, x1: lo - 1, ...band });
    if (hi < 159) limits.push({ x0: hi + 1, x1: 159, ...band });
  } else {
    const band = direction === W ? { x0: 0, x1: 0 } : { x0: 150, x1: 159 };
    if (lo > 0) limits.push({ ...band, y0: 0, y1: lo - 1 });
    if (hi < 167) limits.push({ ...band, y0: hi + 1, y1: 167 });
  }
  return limits;
}

/** Walk off one screen edge into the neighbouring room. */
function hop(run: Speedrun, direction: number, room: number, options: HopOptions = {}): void {
  const held = carrying(run);
  options = {
    ...options,
    avoid: [...(options.avoid ?? []), ...edgeLimits(run, direction, options.edge)],
  };
  const { outcome } = run.navigate(
    { kind: "exit", direction, room, planned: true },
    {
      planOptions: {
        avoidTriggers: !(options.triggers ?? false),
        avoidRegions: [...(options.avoid ?? []), ...(options.meetOwner ? [] : ownerZones(run))],
      },
      budgets: { hostPolls: 4000 },
    },
  );
  assert.equal(outcome.status, "reached", `hop to ${room}: ${JSON.stringify(outcome)}`);
  assert.equal(run.state().room, room);
  if (options.delivers) return;
  settle(run, `hop to ${room}`);
  assert.equal(carrying(run), held, "nothing was swapped on the way");
}

/** Walk to a spot; stops early when `done` holds. */
function walk(
  run: Speedrun,
  target: Target,
  done: () => boolean = () => false,
  options: HopOptions = {},
): void {
  const { outcome } = run.navigate(
    { kind: "position", target, planned: true },
    {
      planOptions: {
        avoidTriggers: !(options.triggers ?? false),
        avoidRegions: [...(options.avoid ?? []), ...(options.meetOwner ? [] : ownerZones(run))],
      },
      budgets: { hostPolls: 4000 },
      cancelled: done,
    },
  );
  if (done()) return;
  assert.equal(outcome.status, "reached", `walk: ${JSON.stringify(outcome)}`);
}

/** Step onto a door's signal line; logic 0 swings it open (f45/f49) and the room changes. */
function door(run: Speedrun, target: Target, room: number, options: HopOptions = {}): void {
  const held = carrying(run);
  walk(run, target, () => run.engine.flags[45] !== 0 || run.state().room === room, {
    ...options,
    triggers: true,
  });
  run.wait(() => run.state().room === room, `door to ${room}`, 4000);
  if (options.delivers) return;
  settle(run, `door to ${room}`);
  assert.equal(carrying(run), held, "nothing was swapped at the door");
}

/**
 * Touch the thing lying in this room. The wife, Miss Muffet and the fiddlers
 * speak first (logic 95, f134) and only then let the child move again.
 */
function pickUp(run: Speedrun, thing: number): void {
  const room = run.state().room;
  assert.equal(run.engine.vars[50 + room], thing, `thing ${thing} lies here`);
  const x = run.engine.vars[34]!;
  const y = run.engine.vars[35]!;
  walk(
    run,
    { x0: Math.max(0, x - 10), x1: Math.min(159, x + 10), y0: y, y1: Math.min(167, y + 10) },
    () => carrying(run) === thing,
  );
  run.wait(() => carrying(run) === thing, `picked up thing ${thing}`, 600);
  run.wait(() => run.engine.flags[134] === 0 && run.engine.flags[107] === 0, "request heard", 4000);
  settle(run, "pickup");
}

/** The rhyme is running (f42); sit through it, then take the step that banks the point. */
function rhyme(run: Speedrun, label: string, score: number): void {
  run.wait(() => run.engine.flags[42] !== 0 || run.engine.flags[44] !== 0, `${label} begins`, 2000);
  run.wait(() => run.engine.flags[44] !== 0, `${label} rhyme ends`, 12000);
  assert.equal(carrying(run), 0, "the thing stays with its owner");
  // Step away from the bottom edge so the banking step never leaves the room.
  run.key(run.state().y > 140 ? AGI_KEY.UP : AGI_KEY.DOWN);
  run.wait(() => run.state().score === score, `${label} scores`, 600);
  if (score < 18) {
    run.direction(0);
    settle(run, label);
  }
  run.checkpoint(label, { score });
}

/**
 * Old King Cole (logic 37) wants his pipe, then his bowl, then his fiddlers
 * three; v108 counts what he already holds. Pipe and bowl are handed over in
 * front of the throne without a rhyme; the fiddlers start it at the door.
 */
function giveToKing(run: Speedrun, holds: number): void {
  walk(run, { x0: 70, x1: 84, y0: 112, y1: 117 }, () => carrying(run) === 0, { meetOwner: true });
  run.wait(() => carrying(run) === 0, "the king takes it", 600);
  assert.equal(run.engine.vars[108], holds, "King Cole's tally");
  settle(run, "the king is served");
}

/**
 * Complete game on the 2.917 interpreter. Nothing in Mother Goose Land can
 * hurt the child, so there is no death state to guard; every hop instead
 * asserts that the carried thing was not swapped away on the road.
 */
export function mumgComplete(run: Speedrun): void {
  run.answer("PLAYER");
  run.until(() => run.state().room === 96, 600, "title screen");
  run.advance(60); // let the title picture show before leaving it
  run.checkpoint("Title", { room: 96, score: 0 });
  // Any key leaves the title; logic 200 asks for a name (get.string), then
  // Enter accepts the first child on the selection screen (f222).
  run.key(AGI_KEY.SPACE);
  run.wait(() => run.state().room === 200 && run.engine.flags[222] !== 0, "choose a child", 600);
  assert.deepEqual(run.textPrompts.length, 1, "one name prompt");
  run.key(AGI_KEY.ENTER);
  run.wait(() => run.state().room === 32, "goose flight lands");
  run.wait(() => run.engine.flags[115] === 0 && run.engine.flags[117] === 0, "arrival complete");
  run.checkpoint("Arrived in Mother Goose Land", { room: 32, score: 0 });
  chooseFastestSpeed(run);

  hop(run, E, 33);
  hop(run, E, 34);
  pickUp(run, THING.wateringCan);
  hop(run, W, 33);
  hop(run, W, 32);
  hop(run, W, 31);
  walk(run, { x0: 60, x1: 76, y0: 130, y1: 140 }, () => run.engine.flags[42] !== 0, {
    meetOwner: true,
  });
  rhyme(run, "Watered Mary's contrary garden", 1);

  hop(run, W, 30);
  pickUp(run, THING.mouse);
  hop(run, N, 23);
  hop(run, E, 24, { edge: [137, 167] });
  hop(run, E, 25);
  hop(run, W, 24, { edge: [90, 150] });
  door(run, { x0: 80, x1: 84, y0: 108, y1: 114 }, 41, { delivers: true });
  rhyme(run, "The mouse ran up the clock", 2);

  pickUp(run, THING.ladder);
  door(run, { x0: 150, x1: 158, y0: 147, y1: 163 }, 24);
  hop(run, E, 25);
  hop(run, N, 18, { edge: [41, 117] });
  hop(run, N, 11);
  hop(run, N, 5, { edge: [120, 159] });
  walk(run, { x0: 50, x1: 70, y0: 95, y1: 105 }, () => run.engine.flags[42] !== 0, {
    meetOwner: true,
  });
  rhyme(run, "Humpty Dumpty climbed back up", 3);

  hop(run, W, 4);
  door(run, { x0: 74, x1: 86, y0: 106, y1: 108 }, 37);
  pickUp(run, THING.meat);
  hop(run, S, 4);
  hop(run, S, 11);
  hop(run, S, 18);
  hop(run, W, 17);
  hop(run, N, 10);
  door(run, { x0: 47, x1: 52, y0: 118, y1: 120 }, 36);
  walk(run, { x0: 60, x1: 90, y0: 125, y1: 134 }, () => run.engine.flags[42] !== 0, {
    meetOwner: true,
  });
  rhyme(run, "Jack Sprat and his wife licked the platter clean", 4);

  pickUp(run, THING.horse);
  hop(run, S, 10);
  hop(run, S, 17);
  hop(run, E, 18, { delivers: true });
  rhyme(run, "Rode a cock-horse to Banbury Cross", 5);

  hop(run, S, 25);
  hop(run, W, 24, { edge: [90, 150] });
  hop(run, N, 17);
  pickUp(run, THING.sheep);
  hop(run, S, 24);
  hop(run, E, 25);
  hop(run, W, 24, { edge: [159, 167] });
  hop(run, W, 23, { delivers: true });
  rhyme(run, "Bo-Peep found her sheep", 6);

  hop(run, N, 16);
  pickUp(run, THING.wife);
  hop(run, E, 17);
  hop(run, E, 18);
  hop(run, E, 19);
  hop(run, N, 12, { delivers: true });
  rhyme(run, "Peter kept his wife in a pumpkin shell", 7);

  hop(run, S, 19);
  hop(run, E, 20);
  hop(run, N, 13);
  hop(run, N, 6);
  pickUp(run, THING.dog);
  hop(run, S, 13);
  hop(run, S, 20);
  hop(run, S, 27, { delivers: true });
  rhyme(run, "The little dog came home", 8);

  hop(run, E, 28);
  pickUp(run, THING.candlestick);
  hop(run, W, 27);
  hop(run, S, 34);
  hop(run, W, 33);
  walk(run, { x0: 100, x1: 120, y0: 120, y1: 130 }, () => run.engine.flags[42] !== 0, {
    meetOwner: true,
  });
  rhyme(run, "Jack jumped over the candlestick", 9);

  hop(run, E, 34);
  hop(run, E, 35);
  pickUp(run, THING.lamb);
  hop(run, N, 28);
  hop(run, W, 27);
  hop(run, N, 20);
  hop(run, N, 13, { delivers: true });
  rhyme(run, "Mary's lamb followed her to school", 10);

  door(run, { x0: 86, x1: 92, y0: 109, y1: 111 }, 39);
  pickUp(run, THING.pie);
  hop(run, S, 13);
  hop(run, S, 20);
  hop(run, W, 19);
  hop(run, W, 18);
  hop(run, S, 25);
  hop(run, E, 26, { edge: [90, 150] });
  door(run, { x0: 48, x1: 52, y0: 103, y1: 108 }, 43);
  walk(run, { x0: 105, x1: 125, y0: 131, y1: 138 }, () => run.engine.flags[42] !== 0, {
    meetOwner: true,
  });
  rhyme(run, "Little Jack Horner pulled out a plum", 11);

  pickUp(run, THING.sixpence);
  door(run, { x0: 14, x1: 18, y0: 124, y1: 130 }, 26);
  hop(run, W, 25);
  hop(run, N, 18, { edge: [41, 117] });
  hop(run, W, 17);
  hop(run, W, 16);
  hop(run, W, 15);
  walk(run, { x0: 130, x1: 150, y0: 132, y1: 155 }, () => run.engine.flags[42] !== 0, {
    meetOwner: true,
  });
  rhyme(run, "The crooked man found his crooked sixpence", 12);

  door(run, { x0: 84, x1: 86, y0: 99, y1: 99 }, 40);
  pickUp(run, THING.knife);
  door(run, { x0: 136, x1: 140, y0: 131, y1: 135 }, 15);
  hop(run, E, 16);
  hop(run, E, 17);
  hop(run, E, 18);
  hop(run, N, 11);
  hop(run, N, 3, { edge: [0, 38] });
  walk(run, { x0: 60, x1: 90, y0: 100, y1: 110 }, () => run.engine.flags[42] !== 0, {
    meetOwner: true,
  });
  rhyme(run, "Tommy Tucker cut his bread", 13);

  hop(run, S, 11);
  hop(run, S, 18);
  hop(run, W, 17);
  hop(run, W, 16);
  hop(run, N, 9);
  hop(run, W, 8);
  pickUp(run, THING.pail);
  hop(run, N, 1);
  walk(run, { x0: 55, x1: 80, y0: 125, y1: 136 }, () => run.engine.flags[42] !== 0, {
    meetOwner: true,
  });
  rhyme(run, "Jack and Jill fetched their pail of water", 14);

  hop(run, S, 8);
  hop(run, S, 15);
  hop(run, S, 22);
  pickUp(run, THING.muffet);
  hop(run, N, 15);
  hop(run, N, 8);
  hop(run, E, 9, { delivers: true });
  rhyme(run, "Miss Muffet sat on her tuffet", 15);

  hop(run, N, 2);
  pickUp(run, THING.broth);
  hop(run, S, 9);
  hop(run, S, 16);
  hop(run, E, 17);
  hop(run, E, 18);
  hop(run, E, 19);
  hop(run, E, 20);
  hop(run, S, 27);
  hop(run, E, 28);
  hop(run, N, 21, { delivers: true });
  rhyme(run, "The old woman in the shoe fed her children broth", 16);

  door(run, { x0: 136, x1: 146, y0: 124, y1: 124 }, 44);
  pickUp(run, THING.fiddle);
  hop(run, S, 21, { triggers: true });
  hop(run, S, 28);
  hop(run, W, 27);
  hop(run, N, 20);
  hop(run, N, 13);
  hop(run, N, 6);
  hop(run, E, 7, { delivers: true });
  rhyme(run, "The cat played the fiddle and the cow jumped over the moon", 17);

  hop(run, S, 14);
  pickUp(run, THING.pipe);
  hop(run, W, 13);
  hop(run, S, 20);
  hop(run, W, 19);
  hop(run, W, 18);
  hop(run, N, 11);
  hop(run, N, 4, { edge: [41, 117] });
  door(run, { x0: 74, x1: 86, y0: 106, y1: 108 }, 37);
  giveToKing(run, 1);
  run.checkpoint("Old King Cole got his pipe", { room: 37, score: 17 });

  hop(run, S, 4);
  hop(run, S, 11);
  pickUp(run, THING.bowl);
  hop(run, N, 4, { edge: [41, 117] });
  door(run, { x0: 74, x1: 86, y0: 106, y1: 108 }, 37);
  giveToKing(run, 2);
  run.verify("Old King Cole got his bowl", { room: 37, score: 17 });

  hop(run, S, 4);
  hop(run, S, 11);
  hop(run, S, 18);
  hop(run, S, 25);
  hop(run, E, 26, { edge: [90, 150] });
  hop(run, N, 19);
  pickUp(run, THING.fiddlers);
  hop(run, S, 26);
  hop(run, W, 25);
  hop(run, N, 18, { edge: [41, 117] });
  hop(run, N, 11);
  hop(run, N, 4, { edge: [41, 117] });
  door(run, { x0: 74, x1: 86, y0: 106, y1: 108 }, 37, { delivers: true });
  rhyme(run, "Old King Cole called for his fiddlers three", 18);

  run.until(() => run.state().room === 102, 20000, "the goose carries the child away");
  run.checkpoint("Mother Goose Land said goodbye", { room: 102, score: 18 });
  run.until(() => run.engine.vars[240] === 25, 20000, "morning comes");
  assert.match(run.messages.at(-1) ?? "", /Congratulations on a job well done/);
  run.dismiss();
  run.checkpoint("Woke up at home to Mother Goose's congratulations", { room: 102, score: 18 });
}

/**
 * The status line's maximum is 18 (v7, logic 0): seventeen rhymes score on
 * delivery and Old King Cole's needs all three of his things. Logic 0 starts
 * the ending when v3 reaches 18; logic 102 closes it at v240 = 25 with the
 * congratulation. Flags 50..67 are the eighteen "rhyme done" flags.
 *
 * Seed 201: logic 0 scatters the twenty things with random() on arrival. A
 * scan of seeds 1..400 with a grid-distance tour estimate put this roll among
 * the shortest: several things lie where the previous one is owed — the ladder
 * in the clock, the horse with the Sprats, the sixpence at Jack Horner's, the
 * knife in the crooked house, the fiddle in the shoe.
 */
export const mumgWalkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.MUMG,
  alias: "mumg",
  label: "fixed all eighteen rhymes and woke up at home with the maximum score",
  coverage: "complete-game",
  seed: 201,
  route: mumgComplete,
  expected: {
    room: 102,
    score: 18,
    vars: { 7: 18, 31: 0, 108: 2, 240: 25 },
    flags: {
      50: 1,
      51: 1,
      52: 1,
      53: 1,
      54: 1,
      55: 1,
      56: 1,
      57: 1,
      58: 1,
      59: 1,
      60: 1,
      61: 1,
      62: 1,
      63: 1,
      64: 1,
      65: 1,
      66: 1,
      67: 1,
      118: 1,
      120: 1,
    },
    inputEnabled: false,
    egoView: 19,
  },
  requiresAnswer: true,
};
