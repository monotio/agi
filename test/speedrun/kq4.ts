import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import { parseDirection, type DirectionInput, type Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";
import type { PlanOptions, Target } from "../../src/agent/navigation.ts";

const ITEM = {
  talisman: 12,
  rose: 44,
  goldKey: 11,
  axe: 19,
  hen: 32,
  rattle: 6,
  coins: 7,
  locket: 5,
  medal: 8,
  horse: 9,
  music: 18,
  key: 25,
  box: 26,
  eye: 24,
  scarab: 4,
  litLantern: 39,
  fruit: 13,
  ball: 1,
  pouch: 2,
  crown: 3,
  bow: 16,
  lantern: 29,
  worm: 34,
  board: 31,
  bone: 20,
  book: 17,
  shovel: 21,
  lute: 15,
  flute: 14,
  pole: 22,
  baitedPole: 42,
  fish: 23,
  feather: 30,
  whistle: 28,
  bridle: 27,
} as const;

type Segment = readonly [name: string, play: (run: Speedrun) => void];

/**
 * The manual check (logic 141-143) deals one of 79 questions with random(1,79)
 * and accepts any word whose upper-case letter sum matches the stored byte.
 * The route's seed deals question 51, whose manual word is "fear".
 */
function manualCheck(run: Speedrun): void {
  run.until(() => run.engine.flags[224] !== 0, 600, "manual question shown");
  assert.equal(run.engine.vars[115], 51, "seeded manual question");
  for (const ch of "fear\r") {
    // The logic reads one key per cycle from v19.
    const cycle = run.cycles;
    run.key(ch.charCodeAt(0));
    run.until(() => run.cycles > cycle, 200, "manual answer key read");
  }
  run.until(() => run.state().room === 96, 600, "manual check accepted");
  // Logic 0 lets X leave the opening cartoon for the first playable beach.
  run.key("x".charCodeAt(0));
  run.wait(
    () => run.state().room === 25 && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "Rosella arrives in Tamir",
  );
  // The beach logic places her on its first cycle; plan from where she stands.
  run.wait(() => run.state().x > 0, "Rosella on the beach", 60);
}

/**
 * Baseline anchors that would put Rosella wholly on water (control 3, which
 * sets f3 and starts wading), merged into at most 64 rectangles for the planner.
 */
export function water(run: Speedrun): Target[] {
  const width = run.engine.screenObjects[0]!.width;
  const priority = run.engine.surface.priority;
  const rows: Target[][] = [];
  for (let y = 0; y < 168; y++) {
    const row: Target[] = [];
    let start = -1;
    for (let x = 0; x <= 160 - width; x++) {
      let wet = true;
      for (let dx = 0; dx < width && wet; dx++) wet = priority[y * 160 + x + dx] === 3;
      if (wet && start < 0) start = x;
      if ((!wet || x === 160 - width) && start >= 0) {
        row.push({ x0: start, x1: wet ? x : x - 1, y0: y, y1: y });
        start = -1;
      }
    }
    rows.push(row);
  }
  // Rows whose shoreline differs by at most `slack` pixels share one rectangle
  // (their union), so ragged banks fit the planner's 64-rectangle limit.
  for (let slack = 0; ; slack++) {
    const merged: Target[] = [];
    for (const row of rows)
      for (const r of row) {
        const above = merged.find(
          (m) =>
            m.y1 === r.y0 - 1 && Math.abs(m.x0 - r.x0) <= slack && Math.abs(m.x1 - r.x1) <= slack,
        );
        if (above) {
          above.y1 = r.y0;
          above.x0 = Math.min(above.x0, r.x0);
          above.x1 = Math.max(above.x1, r.x1);
        } else merged.push({ ...r });
      }
    if (merged.length <= 64) return merged;
  }
}

/** new.room lands before the next room draws; let its first cycle run before planning in it. */
function settle(run: Speedrun): void {
  const cycle = run.cycles;
  run.until(() => run.cycles > cycle + 1, 600, "new room draws");
}

interface Walk extends PlanOptions {
  /** Keep the path on dry land; shallow rivers are otherwise waded through. */
  dry?: boolean;
  /** Far corner when a doorway target is a region rather than one anchor. */
  x1?: number;
  y1?: number;
}

function planOptions({ dry, x1: _x1, y1: _y1, ...plan }: Walk, run: Speedrun): PlanOptions {
  return {
    avoidTriggers: true,
    geometry: "current",
    maxSearchNodes: 241920,
    ...(dry ? { avoidRegions: water(run) } : {}),
    ...plan,
  };
}

/** Walk a planned path to a region; messages that interrupt the walk are read and dismissed. */
export function go(run: Speedrun, x0: number, y0: number, x1 = x0, y1 = y0, walk: Walk = {}): void {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { outcome } = run.navigate(
      { kind: "position", target: { x0, x1, y0, y1 }, planned: true },
      { planOptions: planOptions(walk, run) },
    );
    if (outcome.status === "needs_input" || outcome.status === "movement_control_unavailable") {
      run.dismiss();
      run.wait(() => run.engine.movementControlEnabled, "control returns", 3000);
      continue;
    }
    assert.equal(outcome.status, "reached", JSON.stringify(outcome));
    run.direction(0);
    return;
  }
  assert.fail("too many interruptions while walking");
}

/** Cross a screen edge along a planned path that keeps clear of water and signal lines. */
export function leave(
  run: Speedrun,
  direction: DirectionInput,
  room: number,
  walk: Walk = {},
): void {
  for (let attempt = 0; attempt < 8; attempt++) {
    const outcome = run.traverse(
      {
        passage: { kind: "exit", direction: parseDirection(direction), room, planned: true },
        passageOptions: planOptions(walk, run),
        landing: { label: `arrive in ${room}`, test: (e) => e.vars[0] === room },
      },
      { budgets: { hostPolls: 10000, movementUpdates: 1000 } },
    );
    // Shallow water is drawn with signal pixels; wade only where no dry route exists.
    if (
      outcome.status === "unreachable_under_current_model" &&
      outcome.counters.movementUpdates === 0 &&
      walk.avoidTriggers === undefined
    ) {
      walk = { ...walk, avoidTriggers: false };
      continue;
    }
    if (outcome.status === "needs_input" || outcome.status === "movement_control_unavailable") {
      run.dismiss();
      run.wait(() => run.engine.movementControlEnabled, "control returns", 3000);
      if (run.state().room === room) return settle(run);
      continue;
    }
    assert.equal(outcome.status, "reached", JSON.stringify(outcome));
    return settle(run);
  }
  assert.fail("too many interruptions while leaving");
}

/** Walk onto a doorway or stair trigger whose script changes the room. */
export function enter(run: Speedrun, x: number, y: number, room: number, walk: Walk = {}): void {
  for (let attempt = 0; attempt < 8; attempt++) {
    const outcome = run.traverse(
      {
        passage: {
          kind: "position",
          planned: true,
          target: { x0: x, x1: walk.x1 ?? x, y0: y, y1: walk.y1 ?? y },
        },
        expectedRoom: room,
        passageOptions: { ...planOptions(walk, run), avoidTriggers: walk.avoidTriggers ?? false },
        landing: { label: `enter ${room}`, test: (e) => e.vars[0] === room },
      },
      { budgets: { hostPolls: 10000, movementUpdates: 1000 } },
    );
    if (outcome.status === "needs_input" || outcome.status === "movement_control_unavailable") {
      run.dismiss();
      run.wait(() => run.engine.movementControlEnabled, "control returns", 3000);
      if (run.state().room === room) return settle(run);
      continue;
    }
    assert.equal(outcome.status, "reached", JSON.stringify(outcome));
    return settle(run);
  }
  assert.fail("too many interruptions at a doorway");
}

/** Hold one direction from a spot in front of a doorway until its signal line changes the room. */
function through(run: Speedrun, direction: DirectionInput, room: number): void {
  run.walkDirection(
    direction,
    () => run.state().room === room,
    `through the doorway to ${room}`,
    400,
  );
  settle(run);
}

/** Tamir is a 6 by 5 grid of rooms 1..30 that wraps north to south; the west edge is ocean. */
function neighbor(room: number, direction: "N" | "E" | "S" | "W"): number | null {
  if (direction === "N") return room <= 6 ? room + 24 : room - 6;
  if (direction === "S") return room > 24 ? room - 24 : room + 6;
  if (direction === "E") return room % 6 === 0 ? null : room + 1;
  return room % 6 === 1 ? null : room - 1;
}

/** The ogre's yard and the grasping trees are no place for a stroll. */
const HAZARD_ROOMS: readonly number[] = [4, 5, 6, 11, 12];

/** Walk across the grid by the shortest chain of screen edges that avoids the given rooms. */
function travel(run: Speedrun, to: number, avoid: readonly number[] = HAZARD_ROOMS): void {
  const from = run.state().room;
  const previous = new Map<number, [number, "N" | "E" | "S" | "W"]>();
  const queue = [from];
  while (queue.length > 0 && !previous.has(to)) {
    const room = queue.shift()!;
    for (const direction of ["N", "E", "S", "W"] as const) {
      const next = neighbor(room, direction);
      if (next === null || next === from || previous.has(next)) continue;
      if (next !== to && avoid.includes(next)) continue;
      previous.set(next, [room, direction]);
      queue.push(next);
    }
  }
  const steps: [number, "N" | "E" | "S" | "W"][] = [];
  for (let room = to; room !== from; room = previous.get(room)![0])
    steps.unshift([room, previous.get(room)![1]]);
  for (const [room, direction] of steps) leave(run, direction, room);
}

/** The distance() the room logics test: baseline centres, Manhattan metric. */
function distanceTo(run: Speedrun, object: number): number {
  const ego = run.engine.screenObjects[0]!;
  const other = run.engine.screenObjects[object]!;
  if (!other.active) return 255;
  return (
    Math.abs(ego.x + Math.floor(ego.width / 2) - other.x - Math.floor(other.width / 2)) +
    Math.abs(ego.y - other.y)
  );
}

/** Walk up to a (possibly wandering) character until the logic's distance test would pass. */
function approach(run: Speedrun, object: number, within: number, walk: Walk = {}): void {
  const other = run.engine.screenObjects[object]!;
  for (let attempt = 0; attempt < 12 && distanceTo(run, object) >= within; attempt++) {
    const reach = Math.max(2, Math.floor(within / 2) - 1);
    const cx = other.x + Math.floor(other.width / 2) - 3;
    go(
      run,
      Math.max(0, cx - reach),
      Math.max(0, other.y - reach + 1),
      Math.min(150, cx + reach),
      Math.min(167, other.y + reach - 1),
      walk,
    );
  }
  assert.ok(distanceTo(run, object) < within, `within ${within} of object ${object}`);
}

/** Tour a ring of rooms until the wandering character's presence flag is dealt on entry. */
function hunt(
  run: Speedrun,
  rooms: readonly number[],
  present: () => boolean,
  label: string,
): void {
  let index = Math.max(0, rooms.indexOf(run.state().room));
  run.repeatUntil(
    () => {
      if (rooms.includes(run.state().room) && present()) return;
      index = rooms.includes(run.state().room) ? (index + 1) % rooms.length : 0;
      travel(run, rooms[index]!);
    },
    () => rooms.includes(run.state().room) && present(),
    label,
    60,
  );
}

function opening(run: Speedrun): void {
  // "fastest" is the game's own speed command (logic 0): one logic cycle per host poll.
  run.command("fastest");
  assert.equal(run.engine.vars[10], 0);
  leave(run, "E", 26);
  leave(run, "E", 27);
  leave(run, "S", 3);
}

/**
 * Room 3 deals Cupid with random(1,3) on entry. He must be left alone while he
 * flies in (v236 = 1) and startled only once he bathes (v236 = 3), so he
 * abandons the bow beside the pool.
 */
function cupid(run: Speedrun): void {
  run.repeatUntil(
    () => {
      if (run.engine.flags[238] !== 0) return;
      leave(run, "N", 27);
      leave(run, "S", 3);
    },
    () => run.engine.flags[238] !== 0,
    "Cupid visits the pool",
    40,
  );
  run.wait(() => run.engine.vars[236] === 3, "Cupid bathes", 5000);
  go(run, 120, 125, 128, 130);
  run.wait(() => run.engine.flags[237] !== 0, "Cupid flees", 500);
  go(run, 106, 113, 118, 118);
  run.command("get bow");
  run.assertCarried(ITEM.bow);
  run.checkpoint("Cupid's bow and two golden arrows", { room: 3, score: 2 });
}

function frogPrince(run: Speedrun): void {
  leave(run, "S", 9);
  leave(run, "S", 15);
  leave(run, "S", 21, { dry: true });
  go(run, 67, 116, 74, 119);
  run.command("look under bridge");
  run.wait(() => run.carried(ITEM.ball) && run.engine.movementControlEnabled, "golden ball found");
  assert.equal(run.state().score, 4);
  leave(run, "N", 15);
  go(run, 134, 116, 146, 121, { dry: true });
  run.command("throw ball in pond");
  run.wait(() => run.engine.flags[235] !== 0, "frog fetches the ball", 3000);
  run.command("get frog");
  run.wait(() => run.engine.flags[229] !== 0 && run.engine.inputEnabled, "frog in hand", 2000);
  run.command("kiss frog");
  run.wait(
    () => run.carried(ITEM.crown) && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "the prince leaves his crown",
    5000,
  );
  run.checkpoint("A frog prince's crown", { room: 15, score: 9 });
}

/** Scripted scenes (the dwarfs' housework, Lolotte's audiences) reset the speed to normal. */
function fastest(run: Speedrun): void {
  if (run.engine.vars[10] !== 0) run.command("fastest");
  assert.equal(run.engine.vars[10], 0);
}

function dwarfs(run: Speedrun): void {
  leave(run, "E", 16);
  leave(run, "S", 22);
  go(run, 89, 104, 91, 106);
  run.command("open door");
  run.wait(() => run.engine.flags[222] !== 0, "door opens", 3000);
  run.walkDirection("N", () => run.state().room === 54, "into the tree house", 200);
  run.wait(() => run.engine.inputEnabled, "inside the tree house");
  run.verify("Inside the seven dwarfs' untidy house", { room: 54, score: 9 });
  run.command("clean house");
  run.wait(
    () =>
      run.engine.flags[39] !== 0 &&
      run.engine.flags[232] === 0 &&
      run.engine.movementControlEnabled,
    "dwarfs share their soup and return to the mine",
    60000,
  );
  assert.equal(run.state().score, 14);
  fastest(run);
  go(run, 106, 126, 116, 142);
  run.command("get pouch");
  run.assertCarried(ITEM.pouch);
  run.checkpoint("Housework for the seven dwarfs", { room: 54, score: 16 });
  enter(run, 75, 161, 22);
}

function mine(run: Speedrun): void {
  leave(run, "S", 28);
  // The hillside below the shaft is a slide (signal pixels); approach along the ledge.
  go(run, 136, 121, 142, 123);
  enter(run, 146, 118, 55);
  enter(run, 136, 105, 56, { x1: 140, y1: 130 });
  go(run, 91, 108, 114, 115);
  run.command("give pouch to dwarf");
  run.assertCarried(ITEM.lantern);
  run.assertCarried(ITEM.pouch);
  run.verify("An honest return earns a lantern", { room: 56, score: 19 });
  enter(run, 8, 105, 55, { x1: 12, y1: 130 });
  // The ramp back up starts at the foot of the wall, where logic 55 lifts the block lines;
  // its edges are signal pixels that tumble Rosella back to the mine floor.
  go(run, 54, 140, 58, 146);
  go(run, 49, 140, 51, 146);
  assert.ok(!run.engine.screenObjects[0]!.observeBlocks, "on the mine ramp");
  enter(run, 28, 70, 28, { x1: 36, y1: 72, avoidTriggers: true });
}

/**
 * Rooms 23 and 29 deal the robin with random(1,3) on entry. Approaching within
 * twenty pixels makes it drop the earthworm, which stays for twenty-five seconds.
 */
function robin(run: Speedrun): void {
  leave(run, "E", 29);
  run.repeatUntil(
    () => {
      if (run.engine.flags[238] !== 0) return;
      if (run.state().room === 29) leave(run, "N", 23);
      else leave(run, "S", 29);
    },
    () => run.engine.flags[238] !== 0,
    "a robin tugs at a worm",
    40,
  );
  const bird = run.engine.screenObjects[10]!;
  go(run, bird.x - 12, bird.y - 4, bird.x + 12, bird.y + 8);
  const worm = run.engine.screenObjects[13]!;
  run.wait(() => worm.active && run.engine.vars[153]! >= 2, "robin drops the worm", 2000);
  go(run, worm.x - 8, worm.y - 3, worm.x + 8, worm.y + 5);
  run.command("get worm");
  run.assertCarried(ITEM.worm);
  run.verify("The early bird loses its worm", { score: 21 });
  if (run.state().room === 29) leave(run, "N", 23);
}

/** Wearing the frog's crown in room 24 scripts the swim under the falls into the hidden cave. */
function waterfallCave(run: Speedrun): void {
  leave(run, "E", 24);
  run.command("wear crown");
  run.wait(
    () => run.state().room === 70 && run.engine.movementControlEnabled,
    "frog swims under the falls",
    6000,
  );
  assert.equal(run.state().score, 26);
  go(run, 84, 97, 98, 100);
  run.command("get board");
  run.assertCarried(ITEM.board);
  enter(run, 122, 99, 71, { x1: 126, y1: 101 });
  go(run, 43, 96, 60, 99);
  run.command("get bone");
  run.assertCarried(ITEM.bone);
  run.verify("A board and a bone from the troll's cave", { room: 71, score: 30 });
  enter(run, 22, 96, 70, { x1: 27, y1: 100 });
  // Deep water carries Rosella back out through the falls.
  run.walkDirection("W", () => run.state().room === 24, "swept out through the falls", 600);
  run.wait(() => run.engine.movementControlEnabled, "afloat in the pool", 3000);
}

function manorDoor(run: Speedrun): void {
  go(run, 74, 127, 80, 131);
  run.command("open door");
  run.wait(() => run.engine.flags[235] !== 0, "manor door swings open", 3000);
  enter(run, 76, 125, 68, { x1: 80, y1: 125 });
}

function parlor(run: Speedrun): void {
  leave(run, "N", 18, { avoidTriggers: false });
  leave(run, "W", 17);
  go(run, 72, 126, 82, 132);
  manorDoor(run);
  enter(run, 12, 143, 67, { x1: 15, y1: 147 });
  go(run, 106, 106, 110, 111);
  run.command("get book");
  run.assertCarried(ITEM.book);
  run.command("look at picture");
  go(run, 39, 107, 44, 112);
  run.command("flip latch");
  run.wait(
    () => run.engine.flags[165] !== 0 && run.engine.movementControlEnabled,
    "secret door opens",
    3000,
  );
  assert.equal(run.state().score, 36);
  enter(run, 24, 106, 66, { x1: 30, y1: 108 });
  go(run, 73, 96, 92, 110);
  run.command("get shovel");
  run.assertCarried(ITEM.shovel);
  run.checkpoint("Shakespeare and a gravedigger's shovel", { room: 66, score: 38 });
  enter(run, 126, 109, 67, { x1: 126, y1: 110 });
  go(run, 126, 112, 130, 120);
  through(run, "E", 68);
  leave(run, "S", 17, { avoidTriggers: false });
}

/**
 * Stepping onto the mountain path (room 79) hands Rosella to the goons. The flight,
 * Lolotte's audience and the return to room 30 are scripted; v112 counts her errands.
 */
function audience(run: Speedrun, errand: number): void {
  const { outcome } = run.navigate(
    { kind: "exit", direction: parseDirection("E"), room: 79, planned: true },
    { planOptions: planOptions({}, run) },
  );
  assert.ok(
    ["reached", "needs_input", "movement_control_unavailable"].includes(outcome.status),
    JSON.stringify(outcome),
  );
  run.wait(
    () =>
      run.state().room === 30 &&
      run.engine.vars[112] === errand &&
      run.engine.movementControlEnabled &&
      run.engine.inputEnabled,
    "Lolotte names her errand",
    120000,
  );
  fastest(run);
}

function captured(run: Speedrun): void {
  leave(run, "E", 18);
  leave(run, "S", 24);
  leave(run, "S", 30);
  audience(run, 1);
  run.checkpoint("Lolotte demands a unicorn", { room: 30, score: 38 });
}

/**
 * The unicorn grazes in room 20, 26 or 27 on a random(1,3) roll per entry and stays
 * in the room where Cupid's arrow tames it (v111).
 */
function unicorn(run: Speedrun): void {
  travel(run, 27);
  run.repeatUntil(
    () => {
      if (run.engine.flags[237] !== 0) return;
      travel(run, run.state().room === 27 ? 26 : 27);
    },
    () => run.engine.flags[237] !== 0,
    "the unicorn grazes",
    40,
  );
  run.command("shoot arrow at unicorn");
  assert.notEqual(run.engine.flags[187], 0, "unicorn tamed");
  run.verify("Cupid's arrow tames the unicorn", { score: 42 });
}

/** The minstrel (rooms 13, 14, 19) and Pan (rooms 2, 8, 9) are each dealt with random(1,3). */
function musicians(run: Speedrun): void {
  hunt(run, [19, 13, 14], () => run.engine.flags[238] !== 0, "the minstrel strums");
  approach(run, 10, 16);
  run.command("give book to minstrel");
  run.assertCarried(ITEM.lute);
  run.verify("Shakespeare for a lute", { score: 45 });
  hunt(run, [8, 2, 9], () => run.engine.flags[238] !== 0, "Pan pipes in the meadow");
  run.command("play lute");
  run.wait(() => run.engine.inputEnabled, "Pan listens", 3000);
  approach(run, 1, 15);
  run.command("give lute to pan");
  run.assertCarried(ITEM.flute);
  run.checkpoint("A lute for Pan's flute", { score: 48 });
}

/**
 * The fisherman sits on the pier (room 95) until Rosella has watched him for five
 * seconds, then walks home (v137 = 2, then f172 once indoors). His wife trades the
 * pole for the pouch; a baited cast lands a fish on a random(1,3) roll.
 */
/** Logic 7 lifts the pier's block lines only while Rosella walks the deck (x 0..55, y 120..132). */
function pier(run: Speedrun): void {
  go(run, 48, 123, 54, 128);
  assert.ok(!run.engine.screenObjects[0]!.observeBlocks, "on the pier deck");
  leave(run, "W", 95);
}

function fisherman(run: Speedrun): void {
  travel(run, 7);
  pier(run);
  run.wait(() => run.engine.vars[137] === 2, "fisherman heads home", 3000);
  leave(run, "E", 7, { dry: true });
  run.wait(() => run.engine.flags[172] !== 0, "fisherman goes indoors", 3000);
  go(run, 98, 124, 103, 128);
  run.command("open door");
  run.wait(
    () => run.engine.flags[231] !== 0 && run.engine.movementControlEnabled,
    "shanty door opens",
    3000,
  );
  through(run, "E", 42);
  go(run, 85, 102, 106, 106);
  run.command("give pouch to fisherman");
  run.wait(() => run.carried(ITEM.pole) && run.engine.movementControlEnabled, "pole traded", 5000);
  assert.equal(run.state().score, 51);
  go(run, 24, 107, 30, 110);
  through(run, "W", 7);
  pier(run);
  run.command("bait hook with worm");
  run.assertCarried(ITEM.baitedPole);
  run.repeatUntil(
    () => {
      run.command("fish");
      run.wait(() => run.engine.flags[36] !== 0, "line cast", 600);
      run.wait(
        () =>
          run.engine.flags[36] === 0 &&
          run.engine.movementControlEnabled &&
          run.engine.inputEnabled,
        "line reeled in",
        5000,
      );
    },
    () => run.carried(ITEM.fish),
    "a fish bites",
    30,
  );
  run.checkpoint("A fish from the pier", { room: 95, score: 55 });
}

/** Where each island beach keeps the moulted peacock feather once v54 names that room. */
const FEATHER_SPOTS: Record<number, readonly [number, number, number, number]> = {
  33: [120, 118, 135, 128],
  34: [68, 111, 80, 121],
  35: [22, 116, 37, 126],
  39: [120, 92, 135, 102],
  40: [118, 93, 133, 103],
  41: [27, 90, 42, 100],
};

/**
 * Every ocean screen (room 31) rolls a shark with random(1,5): it surfaces after
 * eighteen cycles and swims twice as fast as Rosella, so the only answer is to turn
 * back across the edge she came in by and try again.
 */
function sharkDealt(run: Speedrun): boolean {
  return run.engine.flags[234] !== 0 && run.engine.flags[242] === 0;
}

function swimToIsland(run: Speedrun): void {
  go(run, 100, 126, 110, 129);
  run.repeatUntil(
    () => {
      if (run.state().room === 31) {
        run.walkDirection("E", () => run.state().room === 95, "back onto the pier side", 400);
        settle(run);
      }
      run.walkDirection("W", () => run.state().room === 31, "off the end of the pier", 600);
      settle(run);
    },
    () => run.state().room === 31 && !sharkDealt(run),
    "open water without a shark",
    20,
  );
  run.walkDirection("W", () => run.state().room !== 31, "swim to the island", 600);
  settle(run);
  // Each beach entry may name itself the feather's room (v54) with random(1,2).
  run.repeatUntil(
    () => {
      if (run.engine.vars[54] === run.state().room) return;
      if (run.state().room === 41) leave(run, "N", 35, { avoidTriggers: false });
      else leave(run, "S", 41, { avoidTriggers: false });
    },
    () => run.engine.vars[54] === run.state().room,
    "the peacock moults",
    30,
  );
  const [x0, y0, x1, y1] = FEATHER_SPOTS[run.state().room]!;
  go(run, x0, y0, x1, y1, { avoidTriggers: false });
  run.command("get feather");
  run.wait(
    () => run.carried(ITEM.feather) && run.engine.movementControlEnabled,
    "feather picked up",
  );
  run.verify("A peacock feather on Genesta's island", { score: 57 });
}

/**
 * With an errand running, each ocean screen also rolls the whale with random(1,3);
 * it surfaces four seconds later (v58) and swallows Rosella whole.
 */
function whale(run: Speedrun): void {
  const beach = run.state().room;
  run.repeatUntil(
    () => {
      if (run.state().room === 31) {
        run.walkDirection("W", () => run.state().room === beach, "back to the beach", 400);
        settle(run);
      }
      leave(run, "E", 31, { avoidTriggers: false });
    },
    () => run.state().room === 31 && run.engine.vars[58]! > 0 && !sharkDealt(run),
    "the whale is on its way",
    40,
  );
  run.wait(
    () => run.state().room === 44 && run.engine.movementControlEnabled,
    "swallowed by the whale",
    3000,
  );
  // The tongue's slippery edges are signal pixels; the planner keeps off them.
  go(run, 65, 62, 86, 74);
  run.command("tickle whale with feather");
  run.wait(
    () => run.state().room === 31 && run.engine.movementControlEnabled,
    "sneezed out to sea",
    6000,
  );
  assert.equal(run.state().score, 62);
  run.verify("Tickled out of the whale", { room: 31, score: 62 });
}

/** The whale leaves Rosella one screen south of the wrecked-ship island (room 43). */
function desertIsland(run: Speedrun): void {
  run.wait(() => run.engine.screenObjects[0]!.active, "afloat again", 600);
  run.walkDirection("N", () => run.state().room === 43, "swim to the desert island", 600);
  settle(run);
  // The pelican takes a thrown fish from anywhere on the island and drops a whistle.
  run.command("throw fish to pelican");
  assert.equal(run.state().score, 66);
  run.wait(
    () => run.engine.flags[153] !== 0 && run.engine.screenObjects[5]!.active,
    "pelican drops a whistle",
    6000,
  );
  go(run, 52, 93, 62, 99, { avoidTriggers: false });
  run.command("get whistle");
  run.assertCarried(ITEM.whistle);
  go(run, 108, 96, 119, 100, { avoidTriggers: false });
  run.command("look at ground");
  run.assertCarried(ITEM.bridle);
  run.command("blow whistle");
  assert.equal(run.state().score, 73);
  run.checkpoint("A whistle, a bridle and a dolphin's help", { room: 43, score: 73 });
  go(run, 105, 149, 114, 157, { avoidTriggers: false });
  run.command("ride dolphin");
  run.wait(
    () => run.state().room === 1 && run.engine.movementControlEnabled && run.engine.inputEnabled,
    "dolphin ride to Tamir",
    20000,
  );
  assert.equal(run.state().score, 75);
}

/** The tamed unicorn waits in the room recorded in v111; riding it is a scripted trip to Lolotte. */
function unicornRide(run: Speedrun): void {
  leave(run, "N", 25, { avoidTriggers: false });
  travel(run, run.engine.vars[111]!);
  const steed = run.engine.screenObjects[10]!;
  assert.ok(steed.active, "unicorn waits where it was tamed");
  // Logic 220 wants Rosella within fifteen pixels and standing below the unicorn's baseline.
  const cx = steed.x + Math.floor(steed.width / 2) - 3;
  go(run, cx - 5, steed.y + 1, cx + 5, steed.y + 6);
  run.command("bridle unicorn");
  assert.notEqual(run.engine.flags[186], 0, "unicorn bridled");
  assert.equal(run.state().score, 78);
  run.wait(
    () => run.engine.inputEnabled && run.engine.movementControlEnabled,
    "bridle fitted",
    3000,
  );
  run.command("ride unicorn");
  run.wait(
    () =>
      run.state().room === 30 &&
      run.engine.vars[112] === 2 &&
      run.engine.movementControlEnabled &&
      run.engine.inputEnabled,
    "Lolotte takes the unicorn and asks for the hen",
    200000,
  );
  fastest(run);
  run.checkpoint("The unicorn delivered to Lolotte", { room: 30, score: 85 });
}

/**
 * The ogres' front yard (room 4) plays the wife's homecoming on the first visit
 * of the hen errand: anyone standing in posn(1,104,117,167) is spotted, so
 * Rosella waits by the north edge until the door shuts behind her (f174).
 * Opening the door swings it wide (f235) and its threshold is a signal line.
 */
function ogreYard(run: Speedrun): void {
  travel(run, 28);
  leave(run, "S", 4);
  run.wait(() => run.engine.flags[174] !== 0, "the ogress carries dinner indoors", 6000);
  go(run, 76, 130, 90, 134);
  run.command("open door");
  run.wait(() => run.engine.flags[235] !== 0, "the front door swings open", 600);
  // The bulldog charges as soon as she is inside; the bone is typed ahead.
  run.type("throw bone to dog");
  run.walkToUntil(96, 131, () => run.state().room === 49, "through the ogres' door", 300);
  run.submit();
  run.wait(
    () => run.engine.inputEnabled && run.engine.movementControlEnabled,
    "the dog settles",
    3000,
  );
  assert.ok(!run.carried(ITEM.bone), "bone thrown");
  run.verify("A bone for the ogres' bulldog", { room: 49, score: 89 });
}

/**
 * Logic 49 observes block lines only inside x 1..97, y 10..108, where the
 * staircase is a diagonal channel between rails; the foot of the stairs is
 * reached east of the wall stub at x 42..54.
 */
function upstairs(run: Speedrun): void {
  run.walkTo(40, 118);
  run.walkTo(44, 110);
  run.walkDirection("NE", () => run.state().y <= 104, "stair foot", 100);
  run.walkDirection("E", () => run.state().x >= 54, "round the newel", 100);
  run.walkDirection("NE", () => run.state().y <= 63, "up the stairs", 400);
  run.walkDirection("E", () => run.state().room === 48, "onto the landing", 300);
  settle(run);
}

function downstairs(run: Speedrun): void {
  // The landing's signal line is the column at x 53..58 above y 111.
  go(run, 62, 108, 66, 110);
  run.walkDirection("W", () => run.state().room === 49, "back down", 300);
  settle(run);
  run.walkDirection("SW", () => run.state().y >= 104, "down the stairs", 400);
  run.walkDirection("W", () => run.state().x <= 48, "stair foot", 100);
  run.walkDirection("S", () => run.state().y >= 110, "off the stairs", 100);
}

function ogreAxe(run: Speedrun): void {
  upstairs(run);
  go(run, 111, 111, 120, 117);
  run.command("take axe");
  run.assertCarried(ITEM.axe);
  run.verify("The ogre's axe from the bedroom", { room: 48, score: 91 });
  downstairs(run);
}

/**
 * From the closet (room 51) Rosella hears the ogre come home (v127 = 49 after
 * twenty seconds) and watches through the keyhole (room 52) until he falls
 * asleep (f149). The sleeping ogre wakes as soon as she nears the front door
 * (x < 30), so the door is opened from x 31 first and the dash is short.
 */
function goldenHen(run: Speedrun): void {
  run.walkTo(108, 110);
  run.command("open door");
  run.wait(
    () => run.engine.flags[223] !== 0 && run.engine.movementControlEnabled,
    "closet open",
    600,
  );
  run.walkToUntil(110, 100, () => run.state().room === 51, "into the closet", 300);
  settle(run);
  run.wait(() => run.engine.vars[127] === 49, "the ogre comes home", 6000);
  run.command("look through keyhole");
  run.wait(() => run.state().room === 52, "at the keyhole", 1200);
  run.wait(
    () =>
      run.state().room === 51 &&
      run.engine.screenObjects[0]!.active &&
      run.engine.movementControlEnabled &&
      run.engine.inputEnabled,
    "the ogre snores at the table",
    20000,
  );
  assert.notEqual(run.engine.flags[149], 0, "ogre asleep");
  run.walkTo(72, 117);
  run.command("open door");
  run.wait(
    () => run.engine.flags[221] !== 0 && run.engine.movementControlEnabled,
    "closet door open",
    600,
  );
  run.walkToUntil(74, 110, () => run.state().room === 49, "out of the closet", 300);
  settle(run);
  // The hen sits on the table beside him: posn(110,134,120,137).
  run.walkTo(115, 135);
  run.command("take hen");
  run.assertCarried(ITEM.hen);
  run.checkpoint("The hen that lays golden eggs", { room: 49, score: 95 });
  run.type("open door");
  run.walkTo(31, 118);
  run.submit();
  run.wait(
    () => run.engine.flags[241] !== 0 && run.engine.flags[224] !== 0,
    "front door open",
    300,
  );
  run.walkToUntil(8, 116, () => run.state().room === 4, "out the front door", 600);
  settle(run);
  // The ogre follows three seconds later; the yard's block lines apply east of x 75.
  run.walkWaypoints(
    [
      [90, 133],
      [105, 137],
    ],
    { continuous: true },
  );
  run.walkDirection("E", () => run.state().room === 5, "past the woodpile", 600);
  settle(run);
  // The grasping trees of room 5 are scared off for good by the axe (f194).
  run.command("swing axe");
  run.wait(
    () =>
      run.engine.flags[194] !== 0 && run.engine.movementControlEnabled && run.engine.inputEnabled,
    "the trees cower",
    1200,
  );
  run.verify("The trees learn to fear the axe", { room: 5, score: 99 });
}

function henDelivered(run: Speedrun): void {
  leave(run, "N", 29);
  leave(run, "E", 30);
  audience(run, 3);
  run.checkpoint("The hen delivered; Lolotte wants Pandora's box", { room: 30 });
}

/**
 * The three witches pass their one eye around while a fourth stalks Rosella.
 * Standing in posn(50,118,77,128) for four seconds is fatal, so the grab from
 * posn(62,118,68,126) is typed ahead. Without the eye they trade the scarab on
 * the next visit and give three points for the eye's return.
 */
function witches(run: Speedrun): void {
  leave(run, "N", 24);
  leave(run, "N", 18, { avoidTriggers: false });
  leave(run, "N", 12);
  leave(run, "N", 6);
  // The eye-passing script (v223) sends the fourth witch after Rosella at step
  // 11. Grabbing the eye then puts that witch back on a fixed walk and, with
  // two of the passers erased, the script can never reach step 11 again.
  run.type("take eye");
  enter(run, 112, 136, 57, { x1: 115, y1: 141 });
  run.walkWaypoints(
    [
      [60, 158],
      [60, 132],
      [66, 131],
    ],
    { continuous: true },
  );
  run.wait(
    () => run.engine.vars[223] === 11 || run.engine.flags[226] === 0,
    "the stalker sets off",
    600,
  );
  run.walkTo(66, 125);
  run.submit();
  run.assertCarried(ITEM.eye);
  // The blinded witch still comes groping the moment the script frees Rosella.
  run.wait(
    () => run.engine.inputEnabled && run.engine.movementControlEnabled,
    "the witches grope about",
    600,
  );
  run.verify("The witches' only eye", { room: 57, score: 109 });
  run.walkWaypoints(
    [
      [60, 132],
      [60, 160],
    ],
    { continuous: true },
  );
  run.walkDirection("S", () => run.state().room === 6, "out of the skull cave", 300);
  settle(run);
  enter(run, 112, 136, 57, { x1: 115, y1: 141 });
  run.wait(() => run.engine.flags[222] !== 0, "a scarab is offered", 600);
  run.walkWaypoints(
    [
      [60, 158],
      [52, 150],
    ],
    { continuous: true },
  );
  run.command("take scarab");
  run.assertCarried(ITEM.scarab);
  run.command("give eye to witches");
  run.wait(() => !run.carried(ITEM.eye) && run.engine.inputEnabled, "the eye returned", 3000);
  run.verify("A scarab for the witches' eye", { room: 57, score: 114 });
  leave(run, "S", 6, { avoidTriggers: false });
}

/**
 * Logic 216 rolls random(1,5) on entering most cave rooms and sends the troll
 * (f49) after Rosella on a 4 or 5. The roll is the next RNG draw, and logic 0
 * spends one draw on every "look" that no room answers, so a doomed entry is
 * scouted on a fork and the draw burned on a harmless look before entering.
 */
function trollFree(run: Speedrun, entry: (branch: Speedrun) => void): void {
  charmed(run, entry, (scout) => scout.engine.flags[49] === 0, "the troll would not stay away");
}

/**
 * Scout a chancy move on a fork; when its RNG roll goes wrong, spend the draw
 * on a harmless look (logic 0 answers "look at bridge" with random(67,69) in
 * every room without a bridge) and try again, then make the move for real.
 */
function charmed(
  run: Speedrun,
  move: (branch: Speedrun) => void,
  safe: (scout: Speedrun) => boolean,
  label: string,
): void {
  for (let attempt = 0; attempt < 12; attempt++) {
    const scout = run.fork();
    move(scout);
    if (safe(scout)) {
      move(run);
      assert.ok(safe(run), label);
      return;
    }
    run.command("look at bridge");
  }
  assert.fail(label);
}

/** Cave rooms 74 and 75 open eastward through posn(140,130,159,167). */
function caveEast(run: Speedrun, room: number): void {
  enter(run, 143, 135, room, { x1: 150, y1: 160, avoidTriggers: false });
}

function caveWest(run: Speedrun, room: number): void {
  enter(run, 3, 135, room, { x1: 12, y1: 160, avoidTriggers: false });
}

/**
 * The chasm (room 76) yawns across x 70..85; the board laid from x 65..69 stays
 * usable only while Rosella keeps within two pixels of the row she laid it on,
 * and she picks it up again on the far side (v51 counts the crossings).
 */
function crossChasm(run: Speedrun, eastward: boolean): void {
  const y = 144;
  if (eastward) go(run, 65, y, 68, y, { avoidTriggers: false });
  else go(run, 87, y, 90, y, { avoidTriggers: false });
  run.command("put board across chasm");
  run.wait(() => run.engine.flags[227] !== 0, "board laid", 300);
  run.walkDirection(eastward ? "E" : "W", () => run.carried(ITEM.board), "across the board", 300);
}

function swampFruit(run: Speedrun): void {
  leave(run, "S", 12);
  leave(run, "S", 18, { avoidTriggers: false });
  leave(run, "S", 24);
  run.command("wear crown");
  run.wait(
    () => run.state().room === 70 && run.engine.movementControlEnabled,
    "the frog swims under the falls",
    6000,
  );
  enter(run, 122, 99, 71, { x1: 126, y1: 101 });
  run.command("light lantern");
  run.assertCarried(ITEM.litLantern);
  trollFree(run, (b) => {
    b.walkDirection("S", () => b.state().room === 74, "down the tunnel", 400);
    settle(b);
  });
  trollFree(run, (b) => caveEast(b, 75));
  caveEast(run, 76);
  crossChasm(run, true);
  assert.equal(run.state().score, 116, "first crossing");
  run.checkpoint("A board across the chasm", { room: 76, score: 116 });
  // The way out climbs to a signal line sloping from (78,91) up to (119,87).
  enter(run, 94, 89, 73, { x1: 96, y1: 89, avoidTriggers: false });
  // The tunnel mouth: posn(123,140,135,150) starts the crawl into room 77.
  enter(run, 124, 141, 77, { x1: 134, y1: 149, avoidTriggers: false });
  run.wait(
    () => run.engine.inputEnabled && run.engine.movementControlEnabled,
    "on the shore",
    3000,
  );
  const hop = (times: number, room: number) => {
    for (let n = 0; n < times; n++) {
      run.command("jump");
      run.wait(
        () =>
          (run.engine.inputEnabled && run.engine.movementControlEnabled) ||
          run.state().room !== room,
        "landed",
        600,
      );
    }
  };
  go(run, 38, 142, 44, 146, { avoidTriggers: false });
  // The eighth jump, from the last tuft, lands on the island.
  hop(8, 77);
  run.waitForRoom(78, "the island of the magic tree", 600);
  settle(run);
  hop(3, 78);
  assert.equal(run.engine.vars[221], 4, "on the last tuft");
  run.command("put board down");
  run.wait(
    () => run.engine.inputEnabled && run.engine.movementControlEnabled,
    "board laid to the island",
    600,
  );
  assert.equal(run.state().score, 118, "board to the island");
  // The board keeps her afloat only inside posn(46,146,65,148); the island shore is dry from x 66.
  run.walkTo(54, 147);
  run.walkDirection("E", () => run.state().x >= 70, "across to the island", 300);
  assert.equal(run.engine.flags[0], 0, "on dry land");
  // The cobra guards posn(76,136,101,154); the flute holds it for 35 seconds (f236).
  run.command("play flute");
  run.wait(
    () =>
      run.engine.flags[236] !== 0 && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "the cobra sways",
    1200,
  );
  assert.equal(run.state().score, 122, "flute");
  go(run, 99, 141, 103, 143, { avoidTriggers: false, dry: true });
  run.command("take fruit");
  run.assertCarried(ITEM.fruit);
  run.verify("The magic fruit from the swamp island", { room: 78, score: 132 });
  // The charmed cobra still blocks the shore row; return along the tree line.
  run.walkWaypoints(
    [
      [95, 142],
      [72, 142],
      [70, 147],
    ],
    { continuous: true },
  );
  run.walkDirection("W", () => run.state().x <= 47, "back over the board", 300);
  run.command("take board");
  run.wait(
    () => run.carried(ITEM.board) && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "board picked up",
    600,
  );
  run.direction("W");
  run.direction(0);
  hop(3, 78);
  hop(1, 78);
  run.waitForRoom(77, "back across the swamp", 600);
  settle(run);
  hop(7, 77);
  assert.equal(run.engine.vars[221], 0, "back on the shore");
  run.walkToUntil(20, 144, () => run.engine.flags[234] !== 0, "back to the tunnel", 300);
  run.waitForRoom(73, "crawling back into the cave", 1200);
  settle(run);
  run.wait(
    () => run.engine.inputEnabled && run.engine.movementControlEnabled,
    "back in the cave mouth",
    3000,
  );
  // Step west off the tunnel mouth before heading for the south edge.
  run.walkTo(104, 160);
  run.walkDirection("S", () => run.state().room === 76, "back down to the chasm", 300);
  settle(run);
  crossChasm(run, false);
  assert.equal(run.state().score, 134, "second crossing");
  trollFree(run, (b) => caveWest(b, 75));
  trollFree(run, (b) => caveWest(b, 74));
  // Room 74's way up is the signal row at y 57, reached along the channel above (61,85).
  trollFree(run, (b) => enter(b, 62, 56, 71, { x1: 64, y1: 57, avoidTriggers: false }));
  run.verify("Back through the caves with the fruit", { room: 71, score: 134 });
}

/** The manor's front door (room 17) must be opened on every visit. */
function openManorDoor(run: Speedrun): void {
  go(run, 74, 127, 80, 131);
  run.command("open door");
  run.wait(() => run.engine.flags[235] !== 0, "manor door swings open", 3000);
}

function intoManor(run: Speedrun): void {
  openManorDoor(run);
  enter(run, 76, 125, 68, { x1: 80, y1: 125 });
}

/**
 * Night comes with the fruit, the hen and the scarab in hand: logic 0 sets the
 * clock to 20:41 and the first room change after 21:00 plays the sunset
 * (room 97). The manor's ghosts only walk at night (v144 counts them).
 */
function nightfall(run: Speedrun): void {
  enter(run, 22, 97, 70, { x1: 26, y1: 100, avoidTriggers: false });
  run.walkDirection("W", () => run.state().room === 24, "swept out through the falls", 600);
  run.wait(() => run.engine.movementControlEnabled, "afloat in the pool", 3000);
  leave(run, "N", 18, { avoidTriggers: false });
  leave(run, "W", 17);
  intoManor(run);
  run.checkpoint("Waiting out the evening in the manor's hall", { room: 68, score: 134 });
  run.wait(() => run.engine.flags[83] !== 0, "nine o'clock", 30000);
  run.walkDirection("S", () => run.state().room !== 68, "out at dusk", 600);
  run.wait(
    () => run.state().room === 17 && run.engine.movementControlEnabled && run.engine.inputEnabled,
    "night falls over Tamir",
    6000,
  );
  assert.notEqual(run.engine.flags[38], 0, "night");
  run.checkpoint("Night falls over Tamir", { room: 17, score: 134 });
}

/**
 * Digging (logic 236/238) works only on a grave's signal pixels and only for
 * the ghost currently haunting the manor (v144); the fifth dig breaks the
 * shovel. Zombies rise after five seconds but the scarab keeps them off.
 */
function dig(run: Speedrun, x0: number, y0: number, x1: number, y1: number, item: number): void {
  go(run, x0, y0, x1, y1, { avoidTriggers: false });
  assert.notEqual(run.engine.flags[3], 0, "standing on the grave");
  run.command("dig");
  run.wait(
    () => run.carried(item) && run.engine.movementControlEnabled && run.engine.inputEnabled,
    "grave dug",
    1200,
  );
}

/**
 * The miser (v144 = 2) and the lord (v144 = 4) drift between the entry hall
 * (68), the dining room (64) and the parlor (67); v143 names the room they
 * are heading for. Whoever appears in the hall sets off at once for a side
 * door, so the keepsake is typed ahead and handed over the moment the ghost
 * is within 25 pixels.
 */
function appeaseGhost(run: Speedrun, gift: string, item: number, ghost: number, within = 25): void {
  assert.equal(run.engine.vars[144], ghost, "ghost awaited");
  const present = () => run.engine.screenObjects[1]!.active && run.engine.flags[237] !== 0;
  openManorDoor(run);
  run.type(gift);
  enter(run, 76, 125, 68, { x1: 80, y1: 125 });
  for (let attempt = 0; attempt < 6 && !present(); attempt++) {
    if (run.state().room === 68) {
      run.walkTo(115, 161);
      run.walkToUntil(130, 146, () => run.state().room === 64, "into the dining room", 100);
    } else {
      run.walkTo(24, 114);
      run.walkToUntil(8, 117, () => run.state().room === 68, "back to the hall", 100);
    }
    settle(run);
  }
  assert.ok(present(), "the ghost shows itself");
  const ghostly = run.engine.screenObjects[1]!;
  for (let n = 0; n < 40 && distanceTo(run, 1) >= within; n++) {
    try {
      run.walkToUntil(
        ghostly.x + 2,
        ghostly.y,
        () => distanceTo(run, 1) < within,
        "after the ghost",
        30,
      );
    } catch {
      /* the ghost drifted; take a new bearing */
    }
  }
  assert.ok(distanceTo(run, 1) < within, "close to the ghost");
  run.submit();
  run.wait(() => !run.carried(item) && run.engine.inputEnabled, "keepsake accepted", 600);
  run.wait(() => run.engine.vars[144] === ghost + 1, "ghost laid to rest", 1200);
}

/** Back downstairs from the master bedroom and out to the graveyards. */
function outToGraveyard(run: Speedrun, room: 16 | 18): void {
  if (run.state().room === 64) {
    run.walkTo(24, 114);
    run.walkToUntil(8, 117, () => run.state().room === 68, "back to the hall", 100);
    settle(run);
  }
  if (run.state().room === 59) enter(run, 134, 112, 62, { x1: 138, y1: 114, avoidTriggers: false });
  if (run.state().room === 62 || run.state().room === 60) {
    // The stairs leave each bedroom by its bottom edge: east wall in 62, west in 60.
    if (run.state().room === 62) go(run, 115, 158, 125, 162);
    else go(run, 30, 158, 36, 162, { avoidTriggers: false });
    run.walkDirection("S", () => run.state().room === 68, "down the stairs", 100);
    settle(run);
    // The landing (y 69..74) is fenced below; it opens east of x 89.
    run.walkTo(96, 74);
  }
  leave(run, "S", 17, { avoidTriggers: false });
  leave(run, room === 16 ? "W" : "E", room, { avoidTriggers: false });
}

function manorGhosts(run: Speedrun): void {
  intoManor(run);
  assert.equal(run.engine.vars[144], 1, "a baby cries upstairs");
  leave(run, "S", 17, { avoidTriggers: false });
  leave(run, "W", 16, { avoidTriggers: false });
  dig(run, 50, 84, 52, 86, ITEM.rattle);
  assert.equal(run.state().score, 137, "rattle");
  run.verify("A rattle from the baby's grave", { room: 16, score: 137 });
  leave(run, "E", 17, { avoidTriggers: false });
  intoManor(run);
  // The stairs' signal row is y 68: x 41..55 climbs to the master bedroom (62),
  // x 90..104 to the old bedroom (60). The nursery (59) lies west of 62.
  go(run, 42, 74, 45, 76);
  run.walkDirection("N", () => run.state().room === 62, "up the left stairs", 100);
  settle(run);
  enter(run, 12, 112, 59, { x1: 16, y1: 114, avoidTriggers: false });
  go(run, 63, 103, 93, 109, { avoidTriggers: false });
  run.command("give rattle to baby");
  run.wait(() => run.engine.vars[144] === 2 && run.engine.inputEnabled, "the baby sleeps", 1200);
  assert.equal(run.state().score, 139, "rattle returned");
  run.verify("The baby ghost sleeps", { room: 59, score: 139 });

  outToGraveyard(run, 16);
  dig(run, 20, 155, 24, 157, ITEM.coins);
  leave(run, "E", 17, { avoidTriggers: false });
  appeaseGhost(run, "give coins to ghost", ITEM.coins, 2);
  assert.equal(run.state().score, 144, "the miser rests");
  run.checkpoint("Gold for the miser's ghost", { score: 144 });

  outToGraveyard(run, 16);
  dig(run, 120, 155, 122, 157, ITEM.locket);
  leave(run, "E", 17, { avoidTriggers: false });
  intoManor(run);
  // The right-hand stairs (signal x 90..104 at y 68) climb to the old bedroom (60).
  go(run, 91, 74, 94, 76);
  run.walkDirection("N", () => run.state().room === 60, "up the right stairs", 100);
  settle(run);
  go(run, 22, 121, 40, 127, { avoidTriggers: false });
  run.command("give locket to ghost");
  run.wait(() => run.engine.vars[144] === 4 && run.engine.inputEnabled, "the lady rests", 1200);
  assert.equal(run.state().score, 149, "locket returned");
  run.verify("A locket for the lady who waited", { room: 60, score: 149 });

  outToGraveyard(run, 16);
  dig(run, 122, 150, 124, 151, ITEM.medal);
  leave(run, "E", 17, { avoidTriggers: false });
  appeaseGhost(run, "give medal to ghost", ITEM.medal, 4, 15);
  assert.equal(run.state().score, 154, "the lord rests");
  run.checkpoint("A medal for the lord of the manor", { score: 154 });

  outToGraveyard(run, 18);
  dig(run, 18, 98, 20, 99, ITEM.horse);
  leave(run, "W", 17, { avoidTriggers: false });
  intoManor(run);
  go(run, 91, 74, 94, 76);
  run.walkDirection("N", () => run.state().room === 60, "up the right stairs", 100);
  settle(run);
  // The attic ladder stands at posn(75,120,85,125) and only the boy's ghost lets Rosella climb.
  go(run, 76, 121, 84, 124, { avoidTriggers: false });
  run.command("climb ladder");
  run.wait(
    () => run.state().room === 63 && run.engine.movementControlEnabled && run.engine.inputEnabled,
    "up in the attic",
    3000,
  );
  go(run, 72, 113, 83, 115, { avoidTriggers: false });
  run.command("give horse to ghost");
  run.wait(() => run.engine.vars[144] === 6 && run.engine.inputEnabled, "the boy rests", 1200);
  assert.equal(run.state().score, 159, "horse returned");
  go(run, 72, 114, 83, 116, { avoidTriggers: false });
  run.command("open chest");
  run.wait(() => run.engine.flags[234] !== 0 && run.engine.inputEnabled, "chest open", 600);
  run.command("look in chest");
  run.assertCarried(ITEM.music);
  run.verify("Sheet music from the attic chest", { room: 63, score: 161 });
}

/**
 * The secret tower (66) and the steps above it (61) spiral between a wall and
 * a line of signal pixels; one touch of the outer edge (v37 = 6) tumbles
 * Rosella to the bottom. The waypoints trace the inside of each flight for
 * the night cel's ten-pixel width; the top edge of each room is the way up.
 */
function towerStairs(run: Speedrun): void {
  const flights: Record<number, readonly (readonly [number, number])[]> = {
    66: [
      [104, 110],
      [100, 142],
      [70, 142],
      [60, 130],
      [46, 104],
      [36, 84],
    ],
    61: [
      [48, 157],
      [85, 120],
      [86, 120],
      [87, 119],
      [88, 119],
      [89, 118],
      [90, 118],
      [91, 117],
      [93, 117],
      [94, 116],
      [96, 116],
      [97, 115],
      [99, 115],
      [100, 114],
      [101, 114],
      [103, 112],
      [105, 112],
      [106, 111],
      [106, 110],
      [107, 109],
      [107, 73],
      [96, 62],
      [96, 61],
      [92, 57],
      [92, 56],
      [88, 52],
      [88, 51],
      [84, 47],
      [84, 46],
      [80, 42],
      [80, 41],
      [76, 37],
    ],
  };
  for (const [room, next] of [
    [66, 61],
    [61, 58],
  ] as const) {
    assert.equal(run.state().room, room, "on the tower stairs");
    for (const [x, y] of flights[room]!) {
      if (run.state().room !== room) break;
      try {
        run.walkTo(x, y);
      } catch (error) {
        // The last step may already cross the top edge.
        if (run.state().room !== next) throw error;
      }
    }
    assert.equal(run.engine.vars[37], 0, "no tumble");
    if (run.state().room === room)
      run.walkDirection("N", () => run.state().room === next, `up to room ${next}`, 200);
    settle(run);
  }
}

/** Back down both flights: room 58 hands Rosella to the steps at their top. */
function towerStairsDown(run: Speedrun): void {
  enter(run, 62, 141, 61, { x1: 66, y1: 145, avoidTriggers: false });
  const down: readonly (readonly [number, number])[] = [
    [88, 51],
    [88, 52],
    [92, 56],
    [92, 57],
    [96, 61],
    [96, 62],
    [107, 73],
    [107, 109],
    [106, 110],
    [106, 111],
    [105, 112],
    [103, 112],
    [101, 114],
    [100, 114],
    [99, 115],
    [97, 115],
    [96, 116],
    [94, 116],
    [93, 117],
    [91, 117],
    [90, 118],
    [89, 118],
    [88, 119],
    [87, 119],
    [86, 120],
    [85, 120],
    [48, 157],
    [48, 164],
  ];
  for (const [x, y] of down) run.walkTo(x, y);
  assert.equal(run.engine.vars[37], 0, "no tumble");
  run.walkDirection("S", () => run.state().room === 66, "down to the secret tower", 100);
  settle(run);
  for (const [x, y] of [
    [36, 84],
    [46, 104],
    [60, 130],
    [70, 142],
    [100, 142],
    [104, 110],
  ] as const)
    run.walkTo(x, y);
  assert.equal(run.engine.vars[37], 0, "no tumble");
  run.walkToUntil(130, 110, () => run.state().room === 67, "through the secret door", 100);
  settle(run);
}

function organAndCrypt(run: Speedrun): void {
  run.command("climb down ladder");
  run.wait(
    () => run.state().room === 60 && run.engine.movementControlEnabled && run.engine.inputEnabled,
    "down from the attic",
    3000,
  );
  outToGraveyard(run, 18);
  leave(run, "W", 17, { avoidTriggers: false });
  intoManor(run);
  // The parlor door's signal is the column at x 15..19, y 137..148, then the
  // secret stair (f165 already flipped) is the parlor's west signal.
  run.walkTo(30, 145);
  run.walkToUntil(10, 143, () => run.state().room === 67, "into the parlor", 100);
  settle(run);
  go(run, 39, 107, 44, 112);
  run.walkToUntil(20, 108, () => run.state().room === 66, "through the secret door", 100);
  settle(run);
  towerStairs(run);
  // The bench takes her when her centre is within x 69..85 on y 109..110.
  go(run, 66, 109, 76, 110);
  run.command("sit");
  run.wait(
    () => run.engine.flags[238] !== 0 && run.engine.inputEnabled,
    "seated at the organ",
    1200,
  );
  run.command("play sheet music");
  run.wait(
    () => run.engine.flags[237] !== 0 && run.engine.inputEnabled,
    "a drawer springs open",
    6000,
  );
  assert.equal(run.state().score, 165, "the organ's secret");
  run.command("stand");
  run.wait(
    () => run.engine.flags[238] === 0 && run.engine.movementControlEnabled,
    "up from the bench",
    1200,
  );
  go(run, 64, 106, 76, 111);
  run.command("take key");
  run.assertCarried(ITEM.key);
  run.checkpoint("The key from the organ's drawer", { room: 58, score: 167 });
  towerStairsDown(run);
  go(run, 126, 112, 130, 120);
  through(run, "E", 68);
  leave(run, "S", 17, { avoidTriggers: false });
  leave(run, "E", 18, { avoidTriggers: false });
  go(run, 123, 132, 132, 137, { avoidTriggers: false });
  run.command("unlock door with key");
  run.wait(() => run.engine.flags[145] !== 0 && run.engine.inputEnabled, "crypt unlocked", 600);
  assert.equal(run.state().score, 170, "crypt unlocked");
  run.command("open door");
  run.wait(
    () => run.engine.flags[146] !== 0 && run.engine.movementControlEnabled,
    "the crypt door swings",
    1200,
  );
  run.walkToUntil(140, 134, () => run.state().room === 69, "into the crypt", 100);
  settle(run);
  // The rope hangs east of the entry ledge (x > 30); the ledge's lip is a fall.
  run.walkDirection("E", () => run.state().x >= 36, "along the ledge", 60);
  run.command("take rope");
  run.wait(
    () =>
      run.engine.flags[161] !== 0 && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "a rope ladder unrolls",
    3000,
  );
  assert.equal(run.state().score, 172, "rope ladder");
  run.command("climb down ladder");
  run.wait(
    () =>
      run.engine.flags[238] !== 0 && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "down in the tomb",
    3000,
  );
  const box = run.engine.screenObjects[1]!;
  run.walkToUntil(box.x, box.y + 2, () => run.engine.vars[221]! < 12, "up to the box", 300);
  run.command("take box");
  run.assertCarried(ITEM.box);
  run.verify("Pandora's box from the crypt", { room: 69, score: 176 });
  run.walkTo(52, 143);
  run.command("climb up ladder");
  run.wait(
    () =>
      run.engine.flags[238] === 0 && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "back up the ladder",
    3000,
  );
  // Straight west along the ledge; its lip below is a fall.
  run.walkDirection("W", () => run.state().room === 18, "out of the crypt", 200);
  settle(run);
}

/**
 * The mountain path (79) hands Rosella to the goons whenever she steps onto it;
 * with the box delivered (v112 = 4) Lolotte plans a wedding and has her locked
 * in Edgar's tower room (81), her belongings shut in the kitchen cabinet.
 */
function boxDelivered(run: Speedrun): void {
  leave(run, "S", 24, { avoidTriggers: false });
  leave(run, "S", 30, { avoidTriggers: false });
  const { outcome } = run.navigate(
    { kind: "exit", direction: parseDirection("E"), room: 79, planned: true },
    { planOptions: planOptions({}, run) },
  );
  assert.ok(
    ["reached", "needs_input", "movement_control_unavailable"].includes(outcome.status),
    JSON.stringify(outcome),
  );
  run.wait(
    () =>
      run.state().room === 81 &&
      run.engine.vars[112] === 4 &&
      run.engine.movementControlEnabled &&
      run.engine.inputEnabled,
    "locked in Edgar's room",
    120000,
  );
  fastest(run);
  assert.equal(run.state().score, 183, "box delivered");
  run.checkpoint("Pandora's box delivered; a wedding is announced", { room: 81, score: 183 });
}

/** Edgar slides a rose under the door half a minute later; its gold key opens the door. */
function edgarsRose(run: Speedrun): void {
  // Standing at the door, posn(27,131,40,147), picks the rose up as it arrives.
  go(run, 28, 132, 38, 146, { avoidTriggers: false });
  run.wait(() => run.carried(ITEM.rose), "a rose under the door", 6000);
  run.command("take key");
  run.assertCarried(ITEM.goldKey);
  run.command("unlock door");
  assert.notEqual(run.engine.flags[60], 0, "door unlocked");
  run.command("open door");
  run.wait(
    () => run.engine.flags[221] !== 0 && run.engine.movementControlEnabled,
    "door open",
    3000,
  );
  run.verify("Edgar's rose and its gold key", { room: 81, score: 187 });
  leave(run, "S", 85, { avoidTriggers: false });
}

/**
 * The west tower steps (85) spiral down between a wall and a line of signal
 * pixels that drop Rosella to the bottom; the sleeping guard in room 90 only
 * wakes if spoken to, and its exit is the signal line of the east door.
 */
const WEST_TOWER_DOWN: readonly (readonly [number, number])[] = [
  [88, 65],
  [105, 82],
  [105, 83],
  [106, 84],
  [106, 85],
  [107, 86],
  [107, 87],
  [108, 88],
  [108, 89],
  [109, 90],
  [109, 91],
  [110, 92],
  [110, 93],
  [111, 94],
  [111, 96],
  [95, 112],
  [95, 114],
  [94, 115],
  [94, 116],
  [92, 118],
  [92, 119],
  [91, 120],
  [91, 121],
  [89, 123],
  [89, 124],
  [86, 127],
  [86, 128],
  [83, 131],
  [83, 132],
  [64, 151],
];

function downWestTower(run: Speedrun): void {
  for (const [x, y] of WEST_TOWER_DOWN) {
    if (run.state().room !== 85) break;
    try {
      run.walkTo(x, y);
    } catch (error) {
      if (run.state().room !== 90) throw error;
    }
  }
  run.waitForRoom(90, "bottom of the west tower", 600);
  assert.equal(run.engine.vars[37], 0, "no tumble");
  settle(run);
  for (const [x, y] of [
    [36, 84],
    [96, 144],
    [120, 120],
    [122, 120],
  ] as const)
    run.walkTo(x, y);
  run.walkToUntil(126, 116, () => run.state().room === 91, "into the dining room", 100);
  settle(run);
}

/**
 * The dining room's goon (91) rolls random(1,2) once Rosella enters
 * posn(86,100,150,111), where the kitchen door is; a 1 wakes him.
 */
const DINING_TO_KITCHEN: readonly (readonly [number, number])[] = [
  [17, 143],
  [23, 143],
  [50, 116],
  [59, 116],
  [64, 111],
  [85, 111],
  [90, 116],
  [101, 116],
  [107, 122],
  [119, 110],
  [128, 110],
];

function pastTheDiningGoon(run: Speedrun): void {
  charmed(
    run,
    (b) => {
      for (const [x, y] of DINING_TO_KITCHEN) {
        if (b.state().room !== 91) break;
        try {
          b.walkTo(x, y);
        } catch (error) {
          if (b.state().room !== 89) throw error;
        }
      }
      b.waitForRoom(89, "into the kitchen", 300);
      settle(b);
    },
    (b) => b.engine.flags[224] === 0 && b.engine.vars[37] !== 23,
    "the dining room goon stirs",
  );
}

function kitchenCabinet(run: Speedrun): void {
  downWestTower(run);
  pastTheDiningGoon(run);
  // The cabinet: posn(99,108,117,115).
  go(run, 100, 109, 116, 114, { avoidTriggers: false });
  run.command("open cabinet");
  run.wait(() => run.engine.flags[221] !== 0 && run.engine.inputEnabled, "cabinet open", 600);
  run.command("take all");
  run.wait(() => run.carried(ITEM.bridle) && run.engine.inputEnabled, "belongings recovered", 600);
  assert.equal(run.state().score, 191, "belongings");
  run.checkpoint("Her belongings back from the kitchen cabinet", { room: 89, score: 191 });
}

/**
 * The throne room's goon (92) wakes if Rosella enters posn(40,122,113,150) or
 * posn(75,80,107,95); the row just above the first box leads past him to the
 * east tower door (the signal line at x 148). The east tower (93) is climbed
 * from x 58, where the block lines lift, then the steps of room 88 wind up
 * between two rails: the pocket at their foot leads west along y 124 to the
 * post at x 49 (f221), and only from there does the lower flight open.
 */
const THRONE_TO_EAST_TOWER: readonly (readonly [number, number])[] = [
  [29, 121],
  [113, 121],
  [119, 127],
  [127, 119],
  [139, 119],
];
const EAST_TOWER_UP: readonly (readonly [number, number])[] = [
  [69, 127],
  [83, 113],
  [83, 112],
  [84, 111],
  [84, 110],
  [85, 109],
  [85, 108],
  [86, 107],
  [86, 106],
  [87, 105],
  [87, 104],
  [88, 103],
  [88, 102],
  [90, 100],
  [90, 99],
  [91, 98],
  [91, 97],
  [92, 96],
  [92, 95],
  [93, 94],
  [93, 93],
  [94, 92],
  [94, 91],
  [96, 89],
  [96, 88],
  [97, 87],
  [97, 86],
  [98, 85],
  [98, 84],
  [99, 83],
  [99, 82],
  [100, 81],
  [100, 80],
  [102, 78],
  [102, 77],
  [103, 76],
  [103, 75],
  [104, 74],
  [104, 73],
  [105, 72],
  [105, 71],
  [106, 70],
  [106, 69],
  [107, 68],
  [107, 67],
  [108, 66],
  [108, 64],
  [109, 63],
  [109, 60],
  [110, 59],
  [110, 39],
  [108, 37],
];
const EAST_TOWER_DOWN: readonly (readonly [number, number])[] = [
  [118, 75],
  [116, 78],
  [110, 85],
  [105, 91],
  [99, 98],
  [93, 105],
  [58, 140],
  [57, 140],
];
const EAST_STEPS_UP: readonly (readonly [number, number])[] = [
  [84, 134],
  [80, 130],
  [77, 128],
  [75, 126],
  [74, 124],
  [49, 124],
  [52, 120],
  [54, 117],
  [55, 115],
  [55, 112],
  [58, 109],
  [58, 108],
  [63, 103],
  [63, 102],
  [67, 98],
  [67, 97],
  [71, 93],
  [71, 92],
  [77, 86],
  [77, 85],
  [80, 82],
  [80, 81],
  [84, 77],
  [84, 76],
  [88, 72],
  [88, 71],
  [93, 66],
  [93, 65],
  [97, 61],
  [97, 60],
];

function climb(
  run: Speedrun,
  room: number,
  next: number,
  points: readonly (readonly [number, number])[],
): void {
  for (const [x, y] of points) {
    if (run.state().room !== room) break;
    try {
      run.walkTo(x, y);
    } catch (error) {
      if (run.state().room !== next) throw error;
    }
  }
  assert.equal(run.engine.vars[37], 0, "no tumble");
  if (run.state().room === room)
    run.walkDirection("N", () => run.state().room === next, `up into room ${next}`, 200);
  run.waitForRoom(next, `room ${next}`, 60);
  settle(run);
}

function upToLolotte(run: Speedrun): void {
  charmed(
    run,
    (b) => {
      leave(b, "W", 91, { avoidTriggers: false });
      b.advance(6);
    },
    (b) => b.engine.flags[222] !== 0 && b.engine.flags[36] === 0 && b.engine.inputEnabled,
    "the dining room goon stirs",
  );
  leave(run, "E", 92, { avoidTriggers: false });
  for (const [x, y] of THRONE_TO_EAST_TOWER) {
    if (run.state().room !== 92) break;
    try {
      run.walkTo(x, y);
    } catch (error) {
      if (run.state().room !== 93) throw error;
    }
  }
  run.waitForRoom(93, "bottom of the east tower", 60);
  settle(run);
  assert.equal(run.engine.flags[241], 0, "the throne room goon sleeps on");
  run.walkTo(58, 140);
  run.walkTo(68, 126);
  climb(run, 93, 88, EAST_TOWER_UP);
  climb(run, 88, 82, EAST_STEPS_UP);
  run.verify("Up the east tower to Lolotte's door", { room: 82, score: 191 });
}

function lolotte(run: Speedrun): void {
  // Her door: posn(107,134,127,145); the gold key fits (f89) and opening it scores (f88).
  go(run, 108, 135, 126, 144, { avoidTriggers: false });
  run.command("unlock door with gold key");
  assert.notEqual(run.engine.flags[89], 0, "her door unlocked");
  run.command("open door");
  run.wait(
    () => run.engine.flags[227] !== 0 && run.engine.movementControlEnabled,
    "door open",
    3000,
  );
  assert.equal(run.state().score, 193, "her door opened");
  run.verify("Into Lolotte's bed chamber", { room: 82, score: 193 });
  // Cupid's remaining arrow finishes her (f86); Edgar comes running.
  go(run, 60, 118, 90, 125, { avoidTriggers: false });
  run.command("shoot arrow at lolotte");
  run.wait(
    () =>
      run.engine.flags[86] !== 0 && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "Lolotte is dead",
    12000,
  );
  assert.equal(run.state().score, 201, "the wicked fairy slain");
  run.checkpoint("Lolotte slain by Cupid's arrow", { room: 82, score: 201 });
  // Genesta's talisman hangs at her neck: posn(45,100,108,113).
  run.walkTo(50, 122);
  run.walkTo(50, 110);
  run.command("take talisman");
  run.assertCarried(ITEM.talisman);
  run.verify("Genesta's talisman recovered", { room: 82, score: 206 });
}

/** Down the east steps from Lolotte's door to the hallway (x < 29) or the pocket above room 93. */
function downEastSteps(run: Speedrun, to: 87 | 93, fromTop = true): void {
  if (fromTop) {
    const down = [...EAST_STEPS_UP].reverse().filter(([, y]) => y >= 61);
    const stop = to === 87 ? down.findIndex(([x, y]) => x === 49 && y === 124) + 1 : down.length;
    for (const [x, y] of down.slice(0, stop)) run.walkTo(x, y);
    assert.equal(run.engine.vars[37], 0, "no tumble");
  }
  if (to === 87) {
    // The hallway passage is the slot at y 117..119 west of the landing.
    run.walkTo(40, 118);
    run.walkDirection("W", () => run.state().room === 87, "into the east hallway", 100);
  } else {
    run.walkTo(92, 143);
    run.walkDirection("S", () => run.state().room === 93, "down to the tower foot", 100);
  }
  settle(run);
}

function storageRoom(run: Speedrun): void {
  leave(run, "S", 88, { avoidTriggers: false });
  downEastSteps(run, 87);
  // With Lolotte dead the goons only bow. The storeroom door: posn(47,104,60,108).
  go(run, 48, 105, 58, 107, { avoidTriggers: false });
  run.command("open door");
  run.wait(
    () => run.engine.flags[235] !== 0 && run.engine.movementControlEnabled,
    "storeroom open",
    3000,
  );
  leave(run, "N", 84, { avoidTriggers: false });
  // Pandora's box waits inside posn(66,110,90,118); the hen must be within ten pixels.
  go(run, 67, 111, 88, 117, { avoidTriggers: false });
  run.command("take box");
  run.assertCarried(ITEM.box);
  const hen = run.engine.screenObjects[1]!;
  run.walkToUntil(hen.x + 2, hen.y + 3, () => distanceTo(run, 1) < 10, "up to the hen", 300);
  run.command("take hen");
  run.assertCarried(ITEM.hen);
  assert.equal(run.state().score, 210, "hen and box");
  run.verify("The hen and the box from Lolotte's storeroom", { room: 84, score: 210 });
  leave(run, "S", 87, { avoidTriggers: false });
}

function freeTheUnicorn(run: Speedrun): void {
  // Back through the hallway signal to the steps, down past room 93 to the throne room.
  run.walkToUntil(150, 118, () => run.state().room === 88, "back to the steps", 300);
  settle(run);
  // Touching x 48 clears the stair post (f221) so the landing's rail can be crossed eastward.
  run.walkTo(48, 120);
  for (const [x, y] of [
    [66, 120],
    [74, 124],
    [75, 126],
    [77, 128],
    [80, 130],
    [84, 134],
  ] as const)
    run.walkTo(x, y);
  downEastSteps(run, 93, false);
  // Room 93 places her at (118,52) on the top step with blocks ignored (f221); the inner
  // rail is a signal line that tumbles her while x > 50, so the descent hugs the outer wall
  // until the release zone posn(56,131,57,157) restores observe.blocks.
  for (const [x, y] of EAST_TOWER_DOWN) run.walkTo(x, y);
  assert.equal(run.engine.vars[37], 0, "no tumble");
  assert.equal(run.engine.flags[221], 0, "off the stairs");
  run.walkToUntil(20, 115, () => run.state().room === 92, "into the throne room", 300);
  settle(run);
  leave(run, "S", 80, { avoidTriggers: false });
  // The stable door: posn(75,112,78,120); the gate opens from posn(73,129,78,133).
  enter(run, 75, 113, 94, { x1: 78, y1: 119, avoidTriggers: false });
  go(run, 73, 129, 78, 133, { avoidTriggers: false });
  run.command("open gate");
  run.wait(
    () => run.engine.flags[70] !== 0 && run.engine.movementControlEnabled,
    "the unicorn runs free",
    6000,
  );
  assert.equal(run.state().score, 214, "unicorn freed");
  run.verify("The unicorn set free", { room: 94, score: 214 });
}

/**
 * Room 80's south wall is a cliff whose signal line is a fall; the way out is the
 * strip east of it, past the hay bales (control 0) to the bottom edge.
 */
const COURTYARD_OUT: readonly (readonly [number, number])[] = [
  [92, 119],
  [92, 126],
  [80, 128],
  [78, 140],
  [88, 140],
  [96, 148],
];
/**
 * Logic 79 seats her at (113,75) on the mountain path; every edge of the track is a
 * signal line that tumbles her down the slope, so the descent follows the track's
 * centre to the bottom edge.
 */
const MOUNTAIN_PATH_DOWN: readonly (readonly [number, number])[] = [
  [100, 89],
  [97, 89],
  [93, 93],
  [89, 93],
  [88, 94],
  [87, 94],
  [86, 95],
  [85, 95],
  [84, 96],
  [80, 96],
  [78, 98],
  [74, 98],
  [73, 99],
  [66, 99],
  [65, 100],
  [64, 100],
  [63, 101],
  [60, 101],
  [59, 102],
  [58, 102],
  [56, 104],
  [55, 104],
  [54, 105],
  [52, 105],
  [51, 106],
  [50, 106],
  [49, 107],
  [49, 108],
  [48, 109],
  [48, 112],
  [47, 113],
  [47, 124],
  [55, 132],
  [55, 135],
  [56, 136],
  [56, 157],
  [51, 162],
  [51, 164],
  [50, 165],
  [50, 166],
];
/**
 * Room 30 seats her at (151,84) between the cliff's signal line and the rock wall;
 * the foothill corridor runs south-west, then the fenced field opens north of x 46..88.
 */
const FOOTHILL_TO_ROAD: readonly (readonly [number, number])[] = [
  [135, 96],
  [118, 106],
  [110, 110],
  [78, 110],
  [51, 83],
  [48, 80],
];

/** With Lolotte dead the goons no longer patrol the mountain path (logic 240 checks f86). */
function downTheMountain(run: Speedrun): void {
  leave(run, "S", 80, { avoidTriggers: false });
  for (const [x, y] of COURTYARD_OUT) run.walkTo(x, y);
  run.walkDirection("S", () => run.state().room === 79, "onto the mountain path", 100);
  settle(run);
  assert.equal(run.engine.vars[112], 4, "the goons stay home");
  for (const [x, y] of MOUNTAIN_PATH_DOWN) run.walkTo(x, y);
  run.walkDirection("S", () => run.state().room === 30, "down to the foothills", 100);
  settle(run);
  assert.equal(run.state().score, 214);
  run.verify("Down the mountain from Lolotte's castle", { room: 30, score: 214 });
  for (const [x, y] of FOOTHILL_TO_ROAD) run.walkTo(x, y);
  run.walkDirection("N", () => run.state().room === 24, "up to the graveyard road", 200);
  settle(run);
  leave(run, "N", 18, { avoidTriggers: false });
}

/**
 * Pandora's box goes back where it lay (posn(80,138,155,167) in the tomb) for two
 * points now that Lolotte is dead (f86), and the crypt is latched from outside with the
 * organ's key (v112 = 4, box out of hand) for two more; the key is slipped under the door.
 */
function boxReturned(run: Speedrun): void {
  assert.equal(run.engine.flags[146], 1, "the crypt door still stands open");
  go(run, 123, 132, 132, 137, { avoidTriggers: false });
  run.walkToUntil(140, 134, () => run.state().room === 69, "into the crypt", 100);
  settle(run);
  run.walkDirection("E", () => run.state().x >= 36, "along the ledge", 60);
  run.command("climb down ladder");
  run.wait(
    () =>
      run.engine.flags[238] !== 0 && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "down in the tomb",
    3000,
  );
  go(run, 82, 140, 150, 165, { avoidTriggers: false });
  run.command("put down box");
  run.wait(() => !run.carried(ITEM.box), "the box set down", 300);
  assert.equal(run.state().score, 216, "box returned");
  run.verify("Pandora's box back in its tomb", { room: 69, score: 216 });
  run.walkTo(52, 143);
  run.command("climb up ladder");
  run.wait(
    () =>
      run.engine.flags[238] === 0 && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "back up the ladder",
    3000,
  );
  run.walkDirection("W", () => run.state().room === 18, "out of the crypt", 200);
  settle(run);
  go(run, 123, 132, 132, 137, { avoidTriggers: false });
  run.command("lock door");
  run.wait(() => !run.carried(ITEM.key), "the key slides under the door", 300);
  assert.equal(run.state().score, 218, "crypt locked");
  run.verify("The crypt locked, its key slipped under the door", { room: 18, score: 218 });
}

/**
 * Genesta's island lies two ocean screens west of the pier: 95 is sea square (1,3),
 * the next screen (2,3), and the third edge lands on the island's east shore, 35 or
 * 41 by her depth (v36 < 110). Each ocean screen still rolls the shark with random(1,5).
 */
function swimToGenesta(run: Speedrun): void {
  // The forest north of the ogre's house (room 10) rolls a hound with random(1,2).
  travel(run, 7, [...HAZARD_ROOMS, 10]);
  pier(run);
  go(run, 100, 126, 110, 129);
  charmed(
    run,
    (b) => {
      b.walkDirection("W", () => b.state().room === 31, "off the end of the pier", 600);
      b.advance(30);
    },
    (b) => !sharkDealt(b),
    "a shark in the first ocean screen",
  );
  charmed(
    run,
    (b) => {
      b.walkDirection("W", () => b.state().room !== 31, "swim to the island", 600);
      b.advance(30);
    },
    (b) => b.state().room !== 31 && [35, 41].includes(b.state().room),
    "a shark in the second ocean screen",
  );
  settle(run);
  run.checkpoint("Ashore on Genesta's island", { room: run.state().room, score: 218 });
  // The palace (37) sits at the island's centre; its door is posn(67,86,81,92).
  if (run.state().room === 35) {
    leave(run, "S", 38, { avoidTriggers: false });
    leave(run, "W", 37, { avoidTriggers: false });
  } else {
    leave(run, "W", 40, { avoidTriggers: false });
    leave(run, "N", 37, { avoidTriggers: false });
  }
  go(run, 68, 87, 80, 91, { avoidTriggers: false });
  run.command("open door");
  run.wait(
    () => run.engine.flags[230] !== 0 && run.engine.movementControlEnabled,
    "the palace door opens",
    1200,
  );
  run.walkDirection("N", () => run.state().room === 47, "into the palace", 200);
  settle(run);
  // The hall's west doorway is a diagonal frame whose signal runs x 23..30, y 113..125;
  // it is entered from below its right jamb.
  go(run, 40, 125, 46, 128, { avoidTriggers: false });
  run.walkTo(32, 125);
  run.walkDirection("W", () => run.state().room === 46, "through the west door", 200);
  settle(run);
  // Logic 46: walking west in posn(97,122,120,150) climbs the first flight three pixels a
  // step; the landing at x 35, y 88..94 sets f221, after which walking east in
  // posn(34,50,70,93) climbs the second flight and y < 52 heading east enters room 45.
  run.walkDirection(
    "W",
    () => run.state().y <= 122 && run.state().x <= 90,
    "up the first flight",
    100,
  );
  for (const [x, y] of PALACE_LANDING) run.walkTo(x, y);
  assert.equal(run.engine.flags[221], 1, "on the landing");
  run.walkDirection("E", () => run.state().room === 45, "up the second flight", 100);
  settle(run);
  run.verify("Up the palace stairs to Genesta's bedside", { room: 45, score: 218 });
}
/** Between the flights the hall is walked with blocks ignored (f221 clear): behind the stair to the landing. */
const PALACE_LANDING: readonly (readonly [number, number])[] = [
  [90, 98],
  [79, 87],
  [39, 87],
  [35, 91],
];

/**
 * Logic 45: "give talisman to genesta" at her bedside, posn(46,102,108,117), scores the
 * last ten points and starts the ending (134 → 135, where the hen scores two more →
 * 139 → 135 → 136 → 138 → 137 → 138). The finale's windows are timed (f15), so the
 * ending is watched rather than dismissed. Logic 138 halts on the secret code with
 * v221 = 11 once the fruit has healed King Graham.
 */
function genestaRestored(run: Speedrun): void {
  go(run, 60, 104, 100, 116, { avoidTriggers: false });
  run.command("give talisman to genesta");
  run.wait(
    () => !run.carried(ITEM.talisman) && run.state().room === 134,
    "the talisman given",
    300,
  );
  assert.equal(run.state().score, 228, "talisman returned");
  run.verify("Genesta's talisman returned", { room: 134, score: 228 });
  run.until(
    () => run.state().room === 135 && !run.carried(ITEM.hen),
    6000,
    "the golden hen given back",
  );
  assert.equal(run.state().score, 230, "maximum score");
  run.checkpoint("The golden hen restored to Genesta", { room: 135, score: 230 });
  run.until(() => run.state().room === 139, 6000, "Edgar restored to his true form");
  run.verify("Edgar, no longer Lolotte's son, offers his heart", { room: 139, score: 230 });
  run.until(() => run.state().room === 138, 12000, "home to Daventry");
  run.verify("Rosella returns to Daventry", { room: 138, score: 230 });
  run.until(
    () => run.state().room === 138 && run.engine.flags[65] !== 0 && run.engine.vars[221] === 11,
    12000,
    "the king healed and the secret code shown",
  );
  assert.equal(run.state().score, 230);
  assert.equal(run.engine.inputEnabled, false);
  assert.equal(run.engine.modalKind, null);
  assert.ok(run.carried(ITEM.fruit), "the healing fruit reached the king");
  run.checkpoint("King Graham healed by the magic fruit", { room: 138, score: 230 });
}

export const KQ4_SEGMENTS: readonly Segment[] = [
  ["manual", manualCheck],
  ["opening", opening],
  ["cupid", cupid],
  ["frog", frogPrince],
  ["dwarfs", dwarfs],
  ["mine", mine],
  ["robin", robin],
  ["waterfallCave", waterfallCave],
  ["parlor", parlor],
  ["captured", captured],
  ["unicorn", unicorn],
  ["musicians", musicians],
  ["fisherman", fisherman],
  ["swimToIsland", swimToIsland],
  ["whale", whale],
  ["desertIsland", desertIsland],
  ["unicornRide", unicornRide],
  ["ogreYard", ogreYard],
  ["ogreAxe", ogreAxe],
  ["goldenHen", goldenHen],
  ["henDelivered", henDelivered],
  ["witches", witches],
  ["swampFruit", swampFruit],
  ["nightfall", nightfall],
  ["manorGhosts", manorGhosts],
  ["organAndCrypt", organAndCrypt],
  ["boxDelivered", boxDelivered],
  ["edgarsRose", edgarsRose],
  ["kitchenCabinet", kitchenCabinet],
  ["upToLolotte", upToLolotte],
  ["lolotte", lolotte],
  ["storageRoom", storageRoom],
  ["freeTheUnicorn", freeTheUnicorn],
  ["downTheMountain", downTheMountain],
  ["boxReturned", boxReturned],
  ["swimToGenesta", swimToGenesta],
  ["genestaRestored", genestaRestored],
];

/** Player-input route through Tamir. */
export function kq4Complete(run: Speedrun): void {
  for (const [, play] of KQ4_SEGMENTS) play(run);
}

export const kq4Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.KQ4,
  alias: "kq4",
  label: "returned Genesta's talisman and healed King Graham with the maximum score",
  coverage: "complete-game",
  // Seed 1: the peacock moults, the whale surfaces and the goons, troll and sharks
  // roll kindly enough that every remaining bad roll can be spent on a fork.
  seed: 1,
  route: kq4Complete,
  // Logic 138 halts on the secret code once the fruit has healed the king (f65, v221 = 11);
  // the hen, the box, the talisman and the crypt key have all been handed over.
  expected: {
    room: 138,
    score: 230,
    vars: { 3: 230, 112: 4, 221: 11 },
    flags: { 65: 1, 86: 1 },
    carriedExactly: [3, 4, 10, 11, 13, 14, 18, 19, 22, 27, 28, 30, 31, 33, 38, 39],
    inputEnabled: false,
    egoView: 1,
  },
};
