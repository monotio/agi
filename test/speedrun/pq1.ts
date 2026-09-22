import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

const ITEM = {
  patrolKeys: 1,
  corvetteKeys: 2,
  cadillacKeys: 3,
  extender: 4,
  revolver: 5,
  ammunition: 6,
  briefcase: 7,
  notebook: 8,
  pen: 9,
  ticketBook: 10,
  newspaper: 11,
  wallet: 12,
  nightstick: 13,
  loadedRevolver: 14,
  hoffmanFile: 15,
  wantedPoster: 16,
  whiteSuit: 17,
  cane: 18,
  bleach: 19,
  markedMoney: 20,
  transmitter: 21,
  roomKey: 22,
  warrant: 23,
  handcuffs: 24,
} as const;

function score(run: Speedrun, expected: number, label: string): void {
  assert.equal(run.state().score, expected, label);
}

type Box = { x0: number; x1: number; y0: number; y1: number };

/**
 * Walk to a position box. Colleagues and timed remarks open message windows
 * mid-walk; a player dismisses them and keeps walking, so the helper does too.
 */
function go(run: Speedrun, target: Box, room?: number): void {
  const from = run.state().room;
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = run.traverse({
      passage: { kind: "position", planned: true, target },
      ...(room === undefined ? {} : { expectedRoom: room }),
      passageOptions: { avoidTriggers: false, geometry: "current" },
      landing: {
        label: room === undefined ? "arrive" : `enter ${room}`,
        test: (e) => (room === undefined ? e.vars[0] === from : e.vars[0] === room),
      },
    });
    if (result.status === "needs_input" || result.status === "movement_control_unavailable") {
      run.dismiss();
      run.wait(() => run.engine.movementControlEnabled, "control returns", 3000);
      if (room !== undefined && run.state().room === room) return;
      continue;
    }
    if (result.status === "unreachable_under_current_model" || result.status === "blocked") {
      // Someone is standing in the way; give them a moment to move on.
      assert.ok(attempt < 39, JSON.stringify(result));
      run.advance(30);
      continue;
    }
    assert.equal(result.status, "reached", JSON.stringify(result));
    return;
  }
  assert.fail(`too many interruptions walking in room ${from}`);
}

/**
 * Hold one heading until the room changes. Station doors sit behind
 * conditional barriers that the room logic lifts as ego touches them, which the
 * static route planner cannot see.
 */
function push(run: Speedrun, dir: "N" | "E" | "S" | "W", room: number): void {
  run.walkDirection(dir, () => run.state().room === room, `push ${dir} into ${room}`, 1500);
}

/** Title screen: any key starts the shift in the station hallway. */
function startShift(run: Speedrun): void {
  run.advance(30);
  run.checkpoint("Title screen", { room: 1, score: 0 });
  run.key(AGI_KEY.ENTER);
  run.wait(() => run.state().room === 6 && run.engine.inputEnabled, "station hallway", 600);
}

function gearUp(run: Speedrun): void {
  go(run, { x0: 143, x1: 145, y0: 140, y1: 150 }, 5);
  go(run, { x0: 84, x1: 97, y0: 132, y1: 140 });
  run.command("open locker");
  run.waitForRoom(47, "locker opens");
  run.command("get all");
  run.assertCarried(ITEM.revolver);
  run.assertCarried(ITEM.handcuffs);
  run.assertCarried(ITEM.ammunition);
  run.assertCarried(ITEM.briefcase);
  run.command("close locker");
  run.waitForRoom(5, "locker closes");
  score(run, 4, "locker opened and duty gear collected");
}

/** Turn in place: one step is enough to change the loop. */
function face(run: Speedrun, dir: "N" | "E" | "S" | "W"): void {
  const loop = { E: 0, W: 1, S: 2, N: 3 }[dir];
  const ego = run.engine.screenObjects[0]!;
  for (let n = 0; ego.loop !== loop && n < 40; n++) {
    run.direction(dir);
    run.advance();
  }
  run.direction(0);
  assert.equal(ego.loop, loop, `facing ${dir}`);
}

/**
 * The 1300 briefing. Arriving after 13:05 on the game clock ends the game, so
 * this comes straight after the locker. The pigeonhole note and the newspaper
 * are only available before Dooley calls the room to order; closing the paper
 * shortens his arrival timer to three seconds.
 */
function firstBriefing(run: Speedrun): void {
  go(run, { x0: 0, x1: 19, y0: 124, y1: 131 }, 6);
  assert.ok(run.engine.vars[12]! < 5, "on time for the briefing");
  go(run, { x0: 123, x1: 127, y0: 109, y1: 117 }, 4);
  go(run, { x0: 123, x1: 140, y0: 119, y1: 126 });
  run.command("look in box");
  score(run, 6, "Steve's note read");
  go(run, { x0: 92, x1: 106, y0: 152, y1: 156 });
  run.command("get newspaper");
  run.waitForRoom(116, "newspaper opens");
  run.assertCarried(ITEM.newspaper);
  run.command("close newspaper");
  run.waitForRoom(4, "newspaper closes");
  score(run, 11, "newspaper taken");
  go(run, { x0: 91, x1: 103, y0: 130, y1: 134 });
  face(run, "N");
  run.wait(() => run.engine.flags[119] !== 0, "briefing ends", 20000);
  assert.notEqual(run.engine.vars[31], 255, "survived the briefing");
  score(run, 19, "attended the briefing");
  run.checkpoint("Attended the shift briefing", { room: 4, score: 19 });
}

type Heading = "N" | "E" | "S" | "W";

function alive(run: Speedrun, label: string): void {
  assert.notEqual(run.engine.vars[31], 255, `${label}: game over`);
  assert.equal(run.engine.flags[140], 0, `${label}: death pending`);
}

/**
 * Hold a heading until a condition holds, without releasing the key: the next
 * leg presses its own heading, exactly as a driver steers through a corner.
 * Radio traffic opens message windows mid-drive; they are read and dismissed.
 */
function steer(
  run: Speedrun,
  dir: Heading,
  until: () => boolean,
  label: string,
  max = 4000,
  hold?: () => boolean,
): void {
  const from = run.cycles;
  for (let n = 0; n < max; n++) {
    // Once a cycle has run, the queued speed key has landed in v55.
    if (run.cycles !== from) queuedCode.delete(run);
    if (run.engine.modalKind !== null || run.engine.continuationPending) run.dismiss();
    alive(run, label);
    assert.equal(run.engine.vars[227], 0, `${label}: collision`);
    if (until()) return;
    run.direction(hold?.() === true ? 0 : dir);
    run.advance();
  }
  assert.fail(`${label}: not reached from ${JSON.stringify(run.state())}`);
}

/** Speed key queued but not yet seen by the logic. */
const queuedCode = new WeakMap<Speedrun, number>();

/** F6, F8 and F10 select Code 1, 2 and 3: one, two or three pixels per cycle. */
function code(run: Speedrun, level: 1 | 2 | 3): void {
  if ((queuedCode.get(run) ?? run.engine.vars[55]) === level) return;
  queuedCode.set(run, level);
  // Queued only: the logic applies it in the same cycle as the next heading
  // key, so the car never takes an extra step on the old heading.
  run.key([AGI_KEY.F6, AGI_KEY.F8, AGI_KEY.F10][level - 1]!);
}

/**
 * Drive along one axis to an exact coordinate. Code 3 covers three pixels a
 * cycle, so the odd pixel or two are taken first at Code 1 and the rest at
 * speed. Easing at the far end instead would creep into signalled
 * intersections below Code 3, which the game treats as running the light.
 */
function driveTo(run: Speedrun, dir: Heading, target: number, fast: 1 | 2 | 3 = 3): void {
  const ego = run.engine.screenObjects[0]!;
  const room = run.state().room;
  const at = (): number => (dir === "N" || dir === "S" ? ego.y : ego.x);
  const sign = dir === "N" || dir === "W" ? -1 : 1;
  const left = (): number => (target - at()) * sign;
  assert.ok(left() >= 0, `drive ${dir} to ${target}: already past at ${at()}`);
  const odd = left() % fast;
  if (odd > 0) {
    const eased = at() + odd * sign;
    code(run, 1);
    steer(run, dir, () => at() === eased, `ease ${dir} toward ${target}`);
  }
  if (left() > 0) {
    code(run, fast);
    steer(run, dir, () => left() <= 0 || run.state().room !== room, `drive ${dir} to ${target}`);
  }
  assert.equal(run.state().room, room, `drive ${dir} to ${target}: left the map square`);
  assert.equal(at(), target, `drive ${dir} to ${target}`);
}

/**
 * Drive at full speed to whichever coordinate in a window the step size lands
 * on: no easing, so it is safe to start inside a signalled intersection.
 */
function driveWithin(
  run: Speedrun,
  dir: Heading,
  lo: number,
  hi: number,
  fast: 1 | 2 | 3 = 3,
  hold?: () => boolean,
): void {
  const ego = run.engine.screenObjects[0]!;
  const at = (): number => (dir === "N" || dir === "S" ? ego.y : ego.x);
  assert.ok(hi - lo + 1 >= fast, "window narrower than one step");
  code(run, fast);
  steer(run, dir, () => at() >= lo && at() <= hi, `drive ${dir} into ${lo}..${hi}`, 4000, hold);
}

/** Drive off the edge of one map square into the next. */
function driveOut(run: Speedrun, dir: Heading, room: number, fast: 1 | 2 | 3 = 3): void {
  code(run, fast);
  steer(run, dir, () => run.state().room === room, `drive ${dir} into map square ${room}`);
}

/** A lane coordinate to reach, or the neighbouring map square to enter. */
type Leg =
  | readonly [Heading, number]
  | readonly [Heading, number, number]
  | readonly [Heading, "into", number];

function drive(run: Speedrun, legs: readonly Leg[], fast: 1 | 2 | 3 = 3): void {
  for (const leg of legs) {
    if (leg[1] === "into") driveOut(run, leg[0], leg[2], fast);
    else if (leg.length === 3) driveWithin(run, leg[0], leg[1], leg[2], fast);
    else driveTo(run, leg[0], leg[1], fast);
  }
}

/** Release the wheel; the car stops where it is. */
function brake(run: Speedrun): void {
  run.direction(0);
}

/** Leave the parked car: the door must be closed again or the shift ends badly. */
function exitCar(run: Speedrun): void {
  run.command("open door");
  run.command("get out");
  run.wait(() => run.engine.flags[39] === 0, "out of the car", 200);
  run.command("close door");
  assert.equal(run.engine.flags[63], 0, "driver door closed");
}

/** Walk to the driver's door of the parked car, get in and pull away. */
function boardCar(run: Speedrun, room: number): void {
  go(run, { x0: 110, x1: 121, y0: 161, y1: 163 });
  run.command("open door");
  run.command("get in");
  run.wait(() => run.engine.flags[39] !== 0, "behind the wheel", 200);
  run.command("close door");
  run.command("drive");
  run.waitForRoom(room, "back on the street");
}

/** Keys from the board, a radio extender from the table, then out to the lot. */
function collectPatrolKit(run: Speedrun): void {
  go(run, { x0: 0, x1: 17, y0: 110, y1: 118 }, 6);
  go(run, { x0: 56, x1: 84, y0: 93, y1: 99 });
  run.take("get radio", ITEM.extender);
  go(run, { x0: 33, x1: 42, y0: 110, y1: 119 });
  run.take("get keys", ITEM.patrolKeys);
  score(run, 22, "patrol car keys and radio extender");
  go(run, { x0: 30, x1: 32, y0: 95, y1: 105 }, 52);
  go(run, { x0: 17, x1: 24, y0: 134, y1: 140 });
  push(run, "W", 7);
}

/** Walk the four corners of the patrol car: the safety check the manual demands. */
function inspectPatrolCar(run: Speedrun): void {
  go(run, { x0: 54, x1: 68, y0: 138, y1: 142 });
  go(run, { x0: 54, x1: 68, y0: 152, y1: 157 });
  go(run, { x0: 2, x1: 19, y0: 152, y1: 157 });
  go(run, { x0: 2, x1: 19, y0: 138, y1: 142 });
  run.wait(() => run.engine.flags[121] !== 0, "safety check acknowledged", 200);
  score(run, 27, "vehicle safety check");
  go(run, { x0: 30, x1: 41, y0: 150, y1: 153 });
  run.command("open door");
  run.command("enter car");
  run.wait(() => run.engine.flags[39] !== 0, "seated in the patrol car", 200);
  run.command("close door");
  run.verify("Inspected the patrol car", { room: 7, score: 27 });
  run.command("drive");
  run.waitForRoom(20, "pulling out of the station lot");
}

/**
 * Dispatch events fire only after several fresh map squares, so the first loop
 * runs south and west of the station and reaches Fig and 4th from below just
 * as the accident call comes in.
 */
function accidentCall(run: Speedrun): void {
  drive(run, [
    ["W", 18],
    ["S", "into", 24],
    ["S", 121],
    ["W", "into", 23],
    ["W", 80],
    ["N", "into", 19],
    ["N", "into", 15],
  ]);
  assert.equal(run.engine.vars[136], 0, "accident call is due");
  // Pull in behind the wreck: the stop box is the kerb lane beside it.
  drive(run, [
    ["N", 84],
    ["W", 78],
  ]);
  steer(run, "N", () => run.engine.flags[44] !== 0, "pull up behind the wreck");
  brake(run);
  run.key(AGI_KEY.F4);
  run.waitForRoom(26, "accident scene");
  score(run, 30, "responded to the accident");
}

function investigateAccident(run: Speedrun): void {
  exitCar(run);
  go(run, { x0: 42, x1: 50, y0: 141, y1: 148 });
  run.command("look at man");
  run.command("look at man");
  run.command("radio");
  assert.notEqual(run.engine.flags[224], 0, "homicide reported");
  go(run, { x0: 72, x1: 100, y0: 128, y1: 140 });
  run.command("talk to people");
  run.wait(() => run.engine.flags[232] !== 0 && run.engine.inputEnabled, "witness statement", 3000);
  run.command("talk to people");
  assert.notEqual(run.engine.flags[225], 0, "partial plate obtained");
  run.command("radio");
  assert.notEqual(run.engine.flags[226], 0, "suspect vehicle broadcast");
  run.wait(() => run.engine.vars[92] === 199, "Dooley relieves you", 6000);
  score(run, 35, "accident investigated");
  run.checkpoint("Investigated the fatal crash", { room: 26, score: 35 });
  boardCar(run, 15);
}

function leaveCarols(run: Speedrun): void {
  go(run, { x0: 70, x1: 84, y0: 158, y1: 162 });
  push(run, "S", 35);
}

/** Pull into the lay-by on the north side of 1st Street at Carol's. */
function parkAtCarols(run: Speedrun): void {
  drive(run, [
    ["E", 55],
    ["N", 116],
  ]);
  brake(run);
  run.key(AGI_KEY.F4);
  run.waitForRoom(35, "parked outside Carol's");
}

/**
 * Each call comes only after three to six fresh map squares, so the beat is a
 * block circuit past Carol's: round again until the radio has spoken.
 */
function patrolToCarols(run: Speedrun): void {
  drive(run, [
    ["N", 36],
    ["E", 80],
    ["N", "into", 11],
    ["N", 128],
    ["E", "into", 12],
  ]);
  for (let lap = 0; run.engine.vars[136]! > 0; lap++) {
    assert.ok(lap < 4, "dispatch call overdue");
    drive(run, [
      ["E", 80],
      ["S", "into", 16],
      ["S", 29],
      ["W", "into", 15],
      ["W", 80],
      ["N", "into", 11],
      ["N", 128],
      ["E", "into", 12],
    ]);
  }
}

function coffeeBreak(run: Speedrun): void {
  patrolToCarols(run);
  assert.equal(run.engine.vars[67], 1, "Steve's coffee call is the current event");
  parkAtCarols(run);
  score(run, 38, "first visit to Carol's");
  exitCar(run);
  go(run, { x0: 35, x1: 41, y0: 125, y1: 125 }, 36);
  // Steve's booth. Carol needs most of a minute to bring the coffee, then the
  // phone rings for Sonny: Detective Hamilton with the victim's identity.
  go(run, { x0: 51, x1: 59, y0: 153, y1: 154 });
  run.command("sit");
  assert.notEqual(run.engine.flags[226], 0, "seated with Steve");
  run.wait(() => run.engine.vars[93] === 2, "Carol calls Sonny to the phone", 12000);
  run.command("stand");
  assert.equal(run.engine.flags[226], 0, "left the booth");
  go(run, { x0: 42, x1: 47, y0: 125, y1: 129 });
  run.command("answer phone");
  assert.equal(run.engine.vars[93], 3, "spoke to Hamilton");
  score(run, 40, "took Hamilton's call");
  run.checkpoint("Took Hamilton's call at Carol's", { room: 36, score: 40 });
  leaveCarols(run);
  boardCar(run, 12);
}

/**
 * Wait on Peach Street below 1st, where the red sports car comes north through
 * a red light. The dispatch countdown (three to six fresh squares) decides
 * whether the beat is the short block west of here or the long one through
 * the squares to the south-east; either way the last square before this one is
 * never one where the car could appear early.
 */
function patrolForSpeeder(run: Speedrun): void {
  const ego = run.engine.screenObjects[0]!;
  drive(run, [
    ["S", 121],
    ["W", "into", 11],
  ]);
  if (run.engine.vars[136]! >= 5)
    drive(run, [
      ["W", "into", 10],
      ["W", 22],
      ["S", "into", 14],
      ["S", 36],
      ["E", "into", 15],
      ["E", "into", 16],
      ["E", 80],
      ["N", "into", 12],
      ["N", 121],
      ["W", "into", 11],
    ]);
  else
    drive(run, [
      ["W", 80],
      ["S", "into", 15],
      ["S", 29],
      ["W", "into", 14],
      ["W", 22],
      ["N", "into", 10],
      ["N", 128],
      ["E", "into", 11],
    ]);
  assert.equal(run.engine.vars[136], 0, "traffic violator is due");
  assert.equal(run.engine.vars[67], 3, "traffic violator is the current event");
  drive(run, [
    [ego.x > 80 ? "W" : "E", 80],
    ["S", 148, 152],
  ]);
  brake(run);
}

/**
 * Tail the violator: within ten pixels behind it, on its heading, inside the
 * mid-block stretch, the game pulls both cars over by itself. It picks its
 * turn at the 1st Street junction at random, so wait for it to commit.
 */
function pullOverSpeeder(run: Speedrun): void {
  const car = run.engine.screenObjects[19]!;
  run.wait(
    () =>
      car.active &&
      run.engine.vars[220] === 1 &&
      (car.direction === 3 || car.direction === 7 || car.y < 114),
    "sports car runs the light and picks a street",
    8000,
  );
  const stopped = (): boolean => run.engine.vars[220]! >= 7 || run.engine.flags[44] !== 0;
  if (car.direction === 3) {
    drive(run, [["N", 128, 130]]);
    steer(run, "E", stopped, "tail the sports car east");
  } else if (car.direction === 7) {
    drive(run, [["N", 119, 121]]);
    steer(run, "W", stopped, "tail the sports car west");
  } else steer(run, "N", stopped, "tail the sports car north");
  run.wait(() => run.engine.vars[220] === 9, "both cars at the kerb", 2000);
  run.key(AGI_KEY.F4);
  run.waitForRoom(30, "traffic stop");
  score(run, 44, "made the traffic stop");
}

/** In the car: run the plate, unpack the briefcase, note the call sign. */
function prepareCitation(run: Speedrun): void {
  run.command("radio");
  score(run, 45, "ran the plate");
  run.command("open briefcase");
  run.waitForRoom(38, "briefcase open");
  run.command("get all");
  run.command("close briefcase");
  run.waitForRoom(30, "briefcase closed");
  run.assertCarried(ITEM.ticketBook);
  run.assertCarried(ITEM.pen);
  run.assertCarried(ITEM.notebook);
  score(run, 49, "ticket book, pen and notebook");
  run.answer("83-32");
  run.answer("LOP1238");
  run.answer("L964");
  run.command("write note");
  score(run, 50, "notebook used");
}

function citeHelenHots(run: Speedrun): void {
  prepareCitation(run);
  exitCar(run);
  run.command("load gun");
  run.assertCarried(ITEM.loadedRevolver);
  score(run, 54, "revolver loaded");
  go(run, { x0: 22, x1: 38, y0: 154, y1: 165 });
  run.command("look at woman");
  run.waitForRoom(3, "at the driver's window");
  run.command("sonny bonds");
  run.command("no");
  score(run, 56, "declined her offer");
  run.command("write ticket");
  run.command("write ticket");
  assert.equal(run.engine.vars[38], 2, "citation written");
  run.command("return license");
  run.command("get signature");
  assert.equal(run.engine.vars[38], 3, "citation signed");
  run.command("give ticket");
  run.waitForRoom(30, "back at the roadside");
  score(run, 61, "citation issued");
  run.verify("Ticketed the red sports car", { room: 30, score: 61 });
  boardCar(run, 11);
}

/**
 * Carol's complaint becomes the current event two map squares after the
 * traffic stop, so loop through the square south of hers and come back.
 */
function returnToCarols(run: Speedrun): void {
  // Swing out to the far lane first: the sports car is still at the kerb ahead.
  drive(run, [
    ["N", 119, 121],
    ["E", "into", 12],
    ["E", 80],
    ["S", "into", 16],
    ["N", "into", 12],
    ["N", 128, 130],
    ["W", 55],
    ["N", 116],
  ]);
  assert.equal(run.engine.vars[67], 4, "complaint at Carol's is the current event");
  brake(run);
  run.key(AGI_KEY.F4);
  run.waitForRoom(35, "parked outside Carol's");
  run.take("get nightstick", ITEM.nightstick);
  score(run, 64, "took the nightstick");
  exitCar(run);
  go(run, { x0: 35, x1: 41, y0: 125, y1: 125 }, 36);
  go(run, { x0: 60, x1: 100, y0: 138, y1: 144 });
  run.command("talk to carol");
  score(run, 67, "heard Carol's complaint");
  leaveCarols(run);
}

/**
 * Wino Willy's. The bikers surround you and ask what you want; once told to
 * move the bikes they give five seconds before swinging, and F10 with the
 * nightstick in hand ends the argument. Keep clear of the dart lane.
 */
function clearBikers(run: Speedrun): void {
  go(run, { x0: 125, x1: 127, y0: 118, y1: 118 }, 37);
  go(run, { x0: 80, x1: 100, y0: 150, y1: 154 });
  run.wait(() => run.engine.vars[94] === 2 && run.engine.inputEnabled, "biker leader speaks", 3000);
  run.command("move bikes");
  assert.equal(run.engine.vars[94], 3, "bikers challenged");
  run.wait(() => run.engine.vars[220] === 50, "bikers close in", 3000);
  run.key(AGI_KEY.F10);
  run.wait(() => run.engine.vars[94] === 4 && run.engine.inputEnabled, "bikers leave", 6000);
  alive(run, "biker bar");
  score(run, 72, "bikers moved on");
  run.command("information");
  score(run, 75, "Sweet Cheeks' tip about the Death Angel");
  run.checkpoint("Cleared the bikers from Wino Willy's", { room: 37, score: 75 });
  run.command("bye");
  go(run, { x0: 70, x1: 80, y0: 160, y1: 164 });
  push(run, "S", 35);
  boardCar(run, 12);
}

/**
 * Lytton's street grid, one entry per map square (10..25, four to a row).
 * Every square has three avenues (x about 22, 80, 138) and two cross streets
 * (y about 32 and 124). Avenue digits mark the stretch above, between and
 * below the streets; street digits mark the four stretches from the west edge
 * to the east edge. 1 means the centre line is drivable there: kerbs, the
 * river, city limits and the freeway embankment (passable only through its
 * underpasses, never over a ramp) are 0. Derived from the picture control
 * lines with scripts outside the repository.
 */
const CITY: Record<number, { avenues: readonly string[]; streets: readonly string[] }> = {
  10: { avenues: ["011", "011", "011"], streets: ["0111", "0111"] },
  11: { avenues: ["011", "011", "011"], streets: ["1111", "1111"] },
  12: { avenues: ["011", "011", "011"], streets: ["1111", "1110"] },
  13: { avenues: ["011", "011", "001"], streets: ["1100", "0010"] },
  14: { avenues: ["111", "111", "111"], streets: ["0111", "0111"] },
  15: { avenues: ["111", "111", "111"], streets: ["1111", "1110"] },
  16: { avenues: ["111", "111", "111"], streets: ["1100", "0011"] },
  17: { avenues: ["111", "111", "111"], streets: ["0110", "1110"] },
  18: { avenues: ["111", "111", "111"], streets: ["0111", "0111"] },
  19: { avenues: ["111", "111", "111"], streets: ["1100", "0011"] },
  20: { avenues: ["111", "111", "111"], streets: ["0111", "1111"] },
  21: { avenues: ["111", "111", "111"], streets: ["1110", "1110"] },
  22: { avenues: ["100", "110", "110"], streets: ["0100", "0011"] },
  23: { avenues: ["110", "110", "110"], streets: ["0111", "1111"] },
  24: { avenues: ["110", "110", "110"], streets: ["1111", "1111"] },
  25: { avenues: ["110", "110", "110"], streets: ["1110", "1110"] },
};

interface Junction {
  room: number;
  avenue: number;
  street: number;
}

const junctionKey = (j: Junction): number => j.room * 6 + j.avenue * 2 + j.street;

function adjacentJunctions(j: Junction): Junction[] {
  const here = CITY[j.room]!;
  const out: Junction[] = [];
  const { room, avenue, street } = j;
  if (here.avenues[avenue]![1] === "1") out.push({ room, avenue, street: 1 - street });
  if (
    street === 0 &&
    here.avenues[avenue]![0] === "1" &&
    CITY[room - 4]?.avenues[avenue]![2] === "1"
  )
    out.push({ room: room - 4, avenue, street: 1 });
  if (
    street === 1 &&
    here.avenues[avenue]![2] === "1" &&
    CITY[room + 4]?.avenues[avenue]![0] === "1"
  )
    out.push({ room: room + 4, avenue, street: 0 });
  const blocks = here.streets[street]!;
  if (avenue > 0 && blocks[avenue] === "1") out.push({ room, avenue: avenue - 1, street });
  if (avenue < 2 && blocks[avenue + 1] === "1") out.push({ room, avenue: avenue + 1, street });
  const column = (room - 10) % 4;
  if (
    avenue === 0 &&
    column > 0 &&
    blocks[0] === "1" &&
    CITY[room - 1]!.streets[street]![3] === "1"
  )
    out.push({ room: room - 1, avenue: 2, street });
  if (
    avenue === 2 &&
    column < 3 &&
    blocks[3] === "1" &&
    CITY[room + 1]!.streets[street]![0] === "1"
  )
    out.push({ room: room + 1, avenue: 0, street });
  return out;
}

const inAvenue = (x: number): number => AVENUE_X.findIndex((v) => Math.abs(x - v) <= 4);
const inStreet = (y: number): number => (y >= 27 && y <= 38 ? 0 : y >= 119 && y <= 130 ? 1 : -1);

/** Junctions the car can reach first from where it stands on a street or avenue. */
function firstJunctions(run: Speedrun): Junction[] {
  const ego = run.engine.screenObjects[0]!;
  const room = run.state().room;
  const avenue = inAvenue(ego.x);
  const street = inStreet(ego.y);
  if (avenue >= 0 && street >= 0) return [{ room, avenue, street }];
  if (avenue >= 0) {
    if (ego.y < 27) return [{ room, avenue, street: 0 }];
    if (ego.y > 130) return [{ room, avenue, street: 1 }];
    return [
      { room, avenue, street: 0 },
      { room, avenue, street: 1 },
    ];
  }
  assert.ok(street >= 0, `car is off the street grid at (${ego.x},${ego.y})`);
  return [0, 1, 2]
    .filter((a) =>
      AVENUE_X[a]! < ego.x
        ? a === 2 || AVENUE_X[a + 1]! > ego.x
        : a === 0 || AVENUE_X[a - 1]! < ego.x,
    )
    .map((a) => ({ room, avenue: a, street }));
}

/** Signalled junctions: only a patrol car running Code 3 may ignore them. */
function signalled(j: Junction): boolean {
  if (j.avenue === 1 && j.street === 0) return [13, 16, 18, 19, 20, 22, 24].includes(j.room);
  if (j.avenue === 0 && j.street === 1) return j.room === 15 || j.room === 17;
  if (j.avenue === 1 && j.street === 1) return j.room === 11 || j.room === 21;
  return false;
}

function planStreets(run: Speedrun, goal: Junction): Junction[] {
  // Private and unmarked cars route around every traffic light.
  const obeyLights = run.engine.vars[44] !== 99;
  const came = new Map<number, Junction | null>();
  const queue: Junction[] = [];
  for (const start of firstJunctions(run)) {
    if (obeyLights && signalled(start)) continue;
    came.set(junctionKey(start), null);
    queue.push(start);
  }
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    if (junctionKey(at) === junctionKey(goal)) {
      const path: Junction[] = [];
      for (let j: Junction | null = at; j; j = came.get(junctionKey(j)) ?? null) path.unshift(j);
      return path;
    }
    for (const next of adjacentJunctions(at))
      if (!came.has(junctionKey(next)) && !(obeyLights && signalled(next))) {
        came.set(junctionKey(next), at);
        queue.push(next);
      }
  }
  assert.fail(`no street route to square ${goal.room}`);
}

/**
 * A car already inside a junction turns across whatever arrives beside it.
 * True while a driven car (motionMode set) sits in the junction box and ego is
 * approaching its mouth — hold there rather than share the turn. Once inside
 * the box, or still well clear of it, drive on.
 */
function junctionBusy(run: Speedrun, x: number, y: number): boolean {
  const ego = run.engine.screenObjects[0]!;
  const dx = Math.abs(ego.x - x);
  const dy = Math.abs(ego.y - y);
  if (dx <= 12 && dy <= 10) return false;
  if (dx > 30 || dy > 26) return false;
  return run.engine
    .readObjects()
    .some(
      (o) =>
        o.num !== 0 && o.motionMode !== 0 && Math.abs(o.x - x) <= 12 && Math.abs(o.y - y) <= 10,
    );
}

/**
 * Drive junction to junction along street centre lines. The centre windows
 * are three pixels wide, so Code 3 always lands inside one without easing,
 * and they stay two pixels clear of every traffic lane.
 */
function driveToJunction(run: Speedrun, goal: Junction): void {
  const ego = run.engine.screenObjects[0]!;
  // Pull out from the kerb to the centre line first: whatever was stopped
  // there (a violator's car, Steve's cruiser) is still parked ahead.
  const avenue = inAvenue(ego.x);
  const street = inStreet(ego.y);
  if (avenue >= 0 && street < 0) {
    const x = AVENUE_X[avenue]!;
    if (Math.abs(ego.x - x) > 1) driveWithin(run, ego.x > x ? "W" : "E", x - 1, x + 1);
  } else if (street >= 0 && avenue < 0) {
    const y = street === 0 ? 32 : 124;
    if (Math.abs(ego.y - y) > 1) driveWithin(run, ego.y > y ? "N" : "S", y - 1, y + 1);
  }
  for (const hop of planStreets(run, goal)) {
    const room = run.state().room;
    const x = AVENUE_X[hop.avenue]!;
    const y = hop.street === 0 ? 32 : 124;
    const yieldToTraffic = (): boolean => junctionBusy(run, x, y);
    const vertical =
      inAvenue(ego.x) === hop.avenue &&
      (hop.room !== room ? Math.abs(hop.room - room) === 4 : inStreet(ego.y) !== hop.street);
    if (hop.room !== room) {
      const delta = hop.room - room;
      driveOut(run, delta === -4 ? "N" : delta === 4 ? "S" : delta === 1 ? "E" : "W", hop.room);
    }
    if (vertical) {
      if (ego.y < y - 1 || ego.y > y + 1)
        driveWithin(run, ego.y > y ? "N" : "S", y - 1, y + 1, 3, yieldToTraffic);
    } else if (ego.x < x - 1 || ego.x > x + 1)
      driveWithin(run, ego.x > x ? "W" : "E", x - 1, x + 1, 3, yieldToTraffic);
  }
}

/** The three signalled junction boxes and the map squares where each is live. */
const SIGNALS: readonly { box: Box; rooms: readonly number[] }[] = [
  { box: { x0: 75, x1: 85, y0: 25, y1: 39 }, rooms: [13, 16, 18, 19, 20, 22, 24] },
  { box: { x0: 17, x1: 27, y0: 117, y1: 131 }, rooms: [15, 17] },
  { box: { x0: 75, x1: 85, y0: 117, y1: 131 }, rooms: [11, 21] },
];

/**
 * Below Code 3 the game checks the light the moment a car is found inside a
 * signalled junction, and a red for the street it arrived by (v50 against the
 * light phase v234) ends the game.
 */
function redLightHere(run: Speedrun): boolean {
  const e = run.engine;
  const ego = e.screenObjects[0]!;
  const room = e.vars[0]!;
  const inside = SIGNALS.some(
    ({ box, rooms }) =>
      rooms.includes(room) &&
      ego.x >= box.x0 - 3 &&
      ego.x <= box.x1 + 3 &&
      ego.y >= box.y0 - 3 &&
      ego.y <= box.y1 + 3,
  );
  const phase = e.vars[234]!;
  return inside && (phase === 1 || phase === 4) && e.vars[50] === phase;
}

/** Street centre lines: two pixels clear of both traffic lanes either side. */
const AVENUE_X = [22, 80, 138] as const;
/** Kerb lanes on the two cross streets, clear of traffic and inside the stop bands. */
const WESTBOUND_Y = [27, 119] as const;
const EASTBOUND_Y = [38, 130] as const;

/**
 * Pursue the wanted car (object 19) wherever it turns. Each cycle: work out
 * its street and heading from its scripted destination, get onto that street
 * through the nearest junction, fall in behind it and close up. Inside ten
 * pixels, mid-block and on the same heading, the game pulls both cars over.
 * If it is coming towards us we hold still and let it pass first.
 */
function pursue(run: Speedrun, label: string, maxCycles = 4000): void {
  const e = run.engine;
  const ego = e.screenObjects[0]!;
  const car = e.screenObjects[19]!;
  const avenue = (x: number): number => AVENUE_X.findIndex((v) => Math.abs(x - v) <= 4);
  const nearestAvenue = (x: number): number =>
    [...AVENUE_X].sort((a, b) => Math.abs(a - x) - Math.abs(b - x))[0]!;
  for (let n = 0; n < maxCycles; n++) {
    if (e.modalKind !== null || e.continuationPending) run.dismiss();
    alive(run, label);
    assert.equal(e.vars[227], 0, `${label}: collision at (${ego.x},${ego.y})`);
    if (e.vars[220]! >= 7 || e.flags[44] !== 0) return;
    let want = 0;
    let to: number | null = null;
    let along: "x" | "y" = "x";
    if (e.flags[47] !== 0) {
      const destX = e.vars[81]!;
      const destY = e.vars[82]!;
      const heading = !car.active
        ? e.vars[83]!
        : destY === 0
          ? 1
          : destY === 167
            ? 5
            : destX === 0
              ? 7
              : 3;
      const carX = car.active ? car.x : destX;
      const carY = car.active ? car.y : destY;
      if (heading === 1 || heading === 5) {
        const lane = AVENUE_X[Math.max(0, avenue(carX))]!;
        if (ego.x === lane) {
          const behind = heading === 1 ? ego.y > carY : ego.y < carY;
          if (behind || !car.active) want = heading;
          along = "y";
        } else {
          const street = Math.abs(ego.y - 32) < Math.abs(ego.y - 124) ? 0 : 1;
          const kerb = ego.x < lane ? EASTBOUND_Y[street]! : WESTBOUND_Y[street]!;
          if (ego.y === kerb) {
            want = ego.x < lane ? 3 : 7;
            to = lane;
          } else {
            want = ego.y < kerb ? 5 : 1;
            to = kerb;
            along = "y";
          }
        }
      } else {
        const street = carY < 80 ? 0 : 1;
        const kerb = heading === 3 ? EASTBOUND_Y[street]! : WESTBOUND_Y[street]!;
        if (ego.y === kerb) {
          const behind = heading === 3 ? ego.x < carX : ego.x > carX;
          if (behind || !car.active) want = heading;
        } else if (AVENUE_X.some((v) => v === ego.x)) {
          want = ego.y < kerb ? 5 : 1;
          to = kerb;
          along = "y";
        } else {
          const lane = nearestAvenue(ego.x);
          want = ego.x < lane ? 3 : 7;
          to = lane;
        }
      }
    }
    if (want !== 0) {
      const left = to === null ? 0 : Math.abs(to - (along === "x" ? ego.x : ego.y));
      // Closing up outside a stop band (it has just left a junction) must not
      // become a rear-end collision: shadow it at its own speed, then hold.
      const gap = car.active ? Math.abs(car.x - ego.x) + Math.abs(car.y - ego.y) : 99;
      const slow = to === null ? gap < 8 : left % 3 !== 0;
      // The Cadillac bolts at two pixels a cycle once it notices the tail.
      const shadow = to === null && car.stepSize === 2 ? 2 : 1;
      if (to === null && gap < 5) want = 0;
      else if (slow && redLightHere(run)) want = 0;
      else code(run, slow ? shadow : 3);
    }
    run.direction(want);
    const from = run.cycles;
    while (run.cycles === from && e.modalKind === null) run.advance();
  }
  assert.fail(`${label}: suspect not stopped`);
}

/**
 * Circle the north-west blocks until the weaving pink car shows up, then run
 * it down. It appears on a random street once the dispatch countdown expires.
 */
function stopDrunkDriver(run: Speedrun): void {
  const spotted = (): boolean => run.engine.flags[47] !== 0;
  drive(run, [
    ["S", 119],
    ["W", "into", 11],
    ["W", "into", 10],
    ["W", 22],
    ["S", "into", 14],
  ]);
  const beat: readonly (readonly Leg[])[] = [
    [
      ["S", 38],
      ["E", "into", 15],
    ],
    [
      ["E", 80],
      ["N", "into", 11],
    ],
    [
      ["N", 119],
      ["W", "into", 10],
    ],
    [
      ["W", 22],
      ["S", "into", 14],
    ],
  ];
  for (let square = 0; !spotted(); square++) {
    assert.ok(square < 24, "drunk driver never appeared");
    assert.equal(run.engine.vars[67], 137, "drunk driver is the current event");
    drive(run, beat[square % beat.length]!);
  }
  pursue(run, "drunk driver");
  run.wait(() => run.engine.vars[220] === 9, "both cars at the kerb", 2000);
  run.key(AGI_KEY.F4);
  run.waitForRoom(31, "drunk driver stop");
  score(run, 78, "stopped the drunk driver");
}

/**
 * By the book: run the plate, order him out and stand clear of his door,
 * sobriety test, handcuffs behind the back (in front he attacks), then walk
 * him to the rear door and stand aside so he can get in.
 */
function arrestDrunkDriver(run: Speedrun): void {
  const e = run.engine;
  run.command("radio");
  score(run, 79, "ran the drunk's plate");
  exitCar(run);
  go(run, { x0: 30, x1: 44, y0: 159, y1: 164 });
  run.command("get out");
  assert.ok(e.vars[250]! > 0, "driver told to step out");
  go(run, { x0: 50, x1: 60, y0: 166, y1: 167 });
  run.wait(() => e.vars[86] === 5 && e.movementControlEnabled, "driver out of his car", 3000);
  run.command("administer fst");
  score(run, 82, "field sobriety test");
  run.command("cuff man");
  run.command("no");
  assert.equal(e.vars[255], 2, "cuffed behind the back");
  run.command("go to car");
  run.wait(() => e.flags[46] !== 0 && e.vars[221] === 5, "prisoner at the patrol car", 4000);
  score(run, 85, "drunk driver in custody");
  seatPrisoner(run);
  run.checkpoint("Arrested the drunk driver", { room: 31, score: 85 });
  boardCar(run, run.engine.vars[74]!);
}

/** Open the rear door, step clear while the prisoner gets in, close it. */
function seatPrisoner(run: Speedrun): void {
  const e = run.engine;
  go(run, { x0: 124, x1: 134, y0: 161, y1: 163 });
  run.command("open door");
  assert.notEqual(e.flags[64], 0, "rear door open");
  go(run, { x0: 140, x1: 150, y0: 163, y1: 166 });
  run.wait(() => e.vars[87] === 1, "prisoner seated", 3000);
  go(run, { x0: 124, x1: 134, y0: 161, y1: 163 });
  run.command("close door");
  assert.equal(e.flags[64], 0, "rear door closed");
}

/** The jail yard is off Rose Avenue, just below 7th Street. */
function driveToJail(run: Speedrun): void {
  driveToJunction(run, { room: 24, avenue: 1, street: 0 });
  drive(run, [
    ["S", 99, 101],
    ["E", 90, 92],
  ]);
  brake(run);
  run.key(AGI_KEY.F4);
  run.waitForRoom(41, "jail yard");
}

function leaveJailYard(run: Speedrun): void {
  drive(run, [["W", 79, 81]]);
}

/** Let the prisoner out of the back seat, then shut the door behind him. */
function unloadPrisoner(run: Speedrun): void {
  const e = run.engine;
  exitCar(run);
  go(run, { x0: 124, x1: 134, y0: 161, y1: 163 });
  run.command("open door");
  assert.notEqual(e.flags[64], 0, "rear door open");
  go(run, { x0: 100, x1: 112, y0: 164, y1: 166 });
  run.wait(() => e.vars[87] === 4 && e.vars[221]! > 0, "prisoner out of the car", 3000);
  go(run, { x0: 124, x1: 134, y0: 161, y1: 163 });
  run.command("close door");
  assert.equal(e.flags[64], 0, "rear door closed");
}

/** Weapons stay outside: locker left of the door, buzzer right of it. */
function enterJail(run: Speedrun): void {
  const e = run.engine;
  go(run, { x0: 71, x1: 80, y0: 107, y1: 108 });
  run.command("open locker");
  run.wait(() => e.flags[60] !== 0 && e.inputEnabled, "gun locker open", 600);
  run.command("put gun in locker");
  assert.notEqual(e.flags[42], 0, "revolver locked away");
  run.command("close locker");
  run.wait(() => e.flags[60] === 0 && e.inputEnabled, "gun locker shut", 600);
  go(run, { x0: 102, x1: 112, y0: 107, y1: 108 });
  run.command("push button");
  run.wait(() => e.flags[226] !== 0, "jailer releases the door", 600);
  go(run, { x0: 86, x1: 96, y0: 103, y1: 104 }, 40);
}

/** Collect the revolver again; leaving the locker open is fatal next visit. */
function leaveJail(run: Speedrun): void {
  const e = run.engine;
  // The jailer opens the inner door as you approach it.
  go(run, { x0: 126, x1: 132, y0: 118, y1: 122 });
  push(run, "E", 41);
  run.wait(() => e.movementControlEnabled, "outside the jail door", 600);
  go(run, { x0: 71, x1: 80, y0: 107, y1: 108 });
  run.command("open locker");
  run.wait(() => e.flags[60] !== 0 && e.inputEnabled, "gun locker open", 600);
  run.command("get gun");
  assert.equal(e.flags[42], 0, "revolver holstered");
  run.command("close locker");
  run.wait(() => e.flags[60] === 0 && e.inputEnabled, "gun locker shut", 600);
}

function bookDrunkDriver(run: Speedrun): void {
  const e = run.engine;
  driveToJail(run);
  unloadPrisoner(run);
  enterJail(run);
  score(run, 87, "gun locked away before entering the jail");
  run.wait(() => e.vars[220] === 5 && e.inputEnabled, "jailer asks your business", 3000);
  run.command("drunk driving");
  assert.equal(e.vars[220], 7, "charge accepted");
  run.command("remove cuffs");
  run.assertCarried(ITEM.handcuffs);
  score(run, 89, "drunk driver booked");
  run.wait(() => e.vars[220] === 40 && e.movementControlEnabled, "prisoner in his cell", 6000);
  // Laura catches you on the way out with news of an opening in Narcotics,
  // then the jailer passes on Dooley's summons.
  go(run, { x0: 100, x1: 120, y0: 112, y1: 114 });
  run.wait(() => e.vars[96] === 1, "ordered back to the station", 8000);
  run.checkpoint("Booked the drunk driver", { room: 40, score: 89 });
  leaveJail(run);
  boardCar(run, 24);
  leaveJailYard(run);
}

/** The station lot opens off Rose Avenue's western neighbour, just below 5th. */
function parkAtStation(run: Speedrun): void {
  driveToJunction(run, { room: 20, avenue: 0, street: 0 });
  drive(run, [
    ["S", 49, 51],
    ["E", 29, 31],
  ]);
  brake(run);
  run.key(AGI_KEY.F4);
  run.waitForRoom(7, "station lot");
}

/** From the lot into the back hallway. */
function enterStation(run: Speedrun): void {
  go(run, { x0: 56, x1: 120, y0: 90, y1: 92 }, 52);
}

/**
 * Laura's tip: apply for Narcotics. The memo goes in the basket in the back
 * hall. Then look in on Dooley's office (the Gremlin's chicken) so that the
 * officers in the hall pass on the invitation to Jack's party.
 */
function transferMemoAndInvitation(run: Speedrun): void {
  const e = run.engine;
  parkAtStation(run);
  run.command("put nightstick");
  assert.ok(!run.carried(ITEM.nightstick), "nightstick back in its holder");
  exitCar(run);
  enterStation(run);
  go(run, { x0: 72, x1: 112, y0: 122, y1: 127 });
  run.command("write memo");
  run.command("put memo in basket");
  score(run, 91, "transfer request submitted");
  push(run, "E", 6);
  go(run, { x0: 22, x1: 29, y0: 131, y1: 141 });
  run.command("open door");
  run.wait(() => e.flags[238] !== 0, "Dooley's door open", 600);
  push(run, "W", 42);
  run.wait(() => e.vars[32] === 3, "colleagues crowd in behind you", 600);
  run.command("open door");
  run.wait(() => e.flags[229] !== 0, "office door open again", 600);
  push(run, "E", 6);
  // The officers hang back a few steps; walk up to them to be spoken to.
  const officer = e.screenObjects[3]!;
  run.walkToUntil(officer.x, officer.y, () => e.vars[98] === 1, "invited to the Blue Room", 600);
  run.verify("Invited to Jack's birthday party", { room: 6, score: 91 });
}

/** Hang the patrol keys and extender back: neither may leave in plain clothes. */
function returnPatrolKit(run: Speedrun): void {
  go(run, { x0: 33, x1: 42, y0: 110, y1: 119 });
  run.command("hang keys");
  go(run, { x0: 56, x1: 84, y0: 93, y1: 99 });
  run.command("put radio");
  assert.ok(!run.carried(ITEM.patrolKeys) && !run.carried(ITEM.extender), "patrol kit returned");
}

function openLocker(run: Speedrun): void {
  go(run, { x0: 143, x1: 145, y0: 140, y1: 150 }, 5);
  go(run, { x0: 84, x1: 97, y0: 132, y1: 140 });
  run.command("open locker");
  run.waitForRoom(47, "locker opens");
}

function closeLocker(run: Speedrun): void {
  run.command("close locker");
  run.waitForRoom(5, "locker closes");
}

function changeForParty(run: Speedrun): void {
  returnPatrolKit(run);
  openLocker(run);
  run.command("change clothes");
  assert.equal(run.engine.vars[39], 4, "down to a towel, kit in the locker");
  run.command("change clothes");
  assert.equal(run.engine.vars[39], 17, "street clothes");
  run.take("get keys", ITEM.corvetteKeys);
  score(run, 94, "street clothes and Corvette keys");
  closeLocker(run);
}

/** Off duty: the Corvette, with the wallet left on its seat. */
function takeCorvette(run: Speedrun): void {
  go(run, { x0: 0, x1: 17, y0: 124, y1: 131 }, 6);
  go(run, { x0: 30, x1: 32, y0: 95, y1: 105 }, 52);
  go(run, { x0: 17, x1: 24, y0: 134, y1: 140 });
  push(run, "W", 7);
  go(run, { x0: 121, x1: 132, y0: 148, y1: 152 });
  run.command("open door");
  run.command("get in");
  run.wait(() => run.engine.flags[39] !== 0, "in the Corvette", 200);
  run.command("close door");
  run.take("get wallet", ITEM.wallet);
  score(run, 97, "wallet from the Corvette's seat");
  run.command("drive");
  run.waitForRoom(20, "out of the station lot");
}

/** The Blue Room's lay-by is on the east kerb of the avenue, mid-block. */
function parkAtBlueRoom(run: Speedrun): void {
  driveToJunction(run, { room: 17, avenue: 0, street: 0 });
  drive(run, [
    ["S", 74, 76],
    ["E", 27, 29],
  ]);
  brake(run);
  run.key(AGI_KEY.F4);
  run.waitForRoom(33, "outside the Blue Room");
}

function birthdayParty(run: Speedrun): void {
  const e = run.engine;
  takeCorvette(run);
  drive(run, [["W", 21, 23]]);
  parkAtBlueRoom(run);
  score(run, 99, "found the Blue Room");
  exitCar(run);
  go(run, { x0: 54, x1: 61, y0: 122, y1: 122 }, 34);
  go(run, { x0: 88, x1: 98, y0: 131, y1: 141 });
  run.command("sit");
  assert.notEqual(e.flags[220], 0, "seated next to Jack");
  run.wait(
    () => e.vars[98] === 3 && e.inputEnabled,
    "cake, song and Hoochie Coochie Hannah",
    20000,
  );
  score(run, 101, "Jack's surprise party");
  run.checkpoint("Celebrated Jack's birthday at the Blue Room", { room: 34, score: 101 });
  run.command("stand");
  go(run, { x0: 58, x1: 68, y0: 160, y1: 164 });
  push(run, "S", 33);
  assert.equal(e.vars[98], 4, "due at the swing shift briefing");
  boardCar(run, 17);
}

/**
 * Swing shift. Back into uniform (Keith swapped shifts with you), then the
 * second briefing: stand at your desk facing the podium, and afterwards the
 * pigeonhole holds an informant's tip about gambling at the Hotel Delphoria.
 */
function swingShiftBriefing(run: Speedrun): void {
  const e = run.engine;
  drive(run, [["W", 21, 23]]);
  parkAtStation(run);
  exitCar(run);
  enterStation(run);
  push(run, "E", 6);
  openLocker(run);
  run.command("change clothes");
  assert.equal(e.vars[39], 4, "street clothes off");
  run.command("change clothes");
  assert.equal(e.vars[39], 0, "back in uniform");
  run.command("get all");
  run.assertCarried(ITEM.revolver);
  run.assertCarried(ITEM.briefcase);
  closeLocker(run);
  go(run, { x0: 0, x1: 17, y0: 124, y1: 131 }, 6);
  go(run, { x0: 123, x1: 127, y0: 109, y1: 117 }, 4);
  go(run, { x0: 91, x1: 103, y0: 130, y1: 134 });
  face(run, "N");
  run.wait(() => e.flags[120] !== 0 && e.inputEnabled, "second briefing ends", 20000);
  alive(run, "second briefing");
  score(run, 102, "attended the swing shift briefing");
  go(run, { x0: 123, x1: 140, y0: 119, y1: 126 });
  run.command("look in box");
  score(run, 105, "informant's tip about the Hotel Delphoria");
  run.checkpoint("Read the informant's tip after the second briefing", { room: 4, score: 105 });
}

/** Swing shift patrol: keys, extender, the walk-round check, and out. */
function backOnPatrol(run: Speedrun): void {
  go(run, { x0: 0, x1: 17, y0: 110, y1: 118 }, 6);
  go(run, { x0: 56, x1: 84, y0: 93, y1: 99 });
  run.take("get radio", ITEM.extender);
  go(run, { x0: 33, x1: 42, y0: 110, y1: 119 });
  run.take("get keys", ITEM.patrolKeys);
  go(run, { x0: 30, x1: 32, y0: 95, y1: 105 }, 52);
  go(run, { x0: 17, x1: 24, y0: 134, y1: 140 });
  push(run, "W", 7);
  run.command("load gun");
  run.assertCarried(ITEM.loadedRevolver);
  go(run, { x0: 54, x1: 68, y0: 138, y1: 142 });
  go(run, { x0: 54, x1: 68, y0: 152, y1: 157 });
  go(run, { x0: 2, x1: 19, y0: 152, y1: 157 });
  go(run, { x0: 2, x1: 19, y0: 138, y1: 142 });
  run.wait(() => run.engine.flags[121] !== 0, "safety check acknowledged", 200);
  go(run, { x0: 30, x1: 41, y0: 150, y1: 153 });
  run.command("open door");
  run.command("get in");
  run.wait(() => run.engine.flags[39] !== 0, "seated in the patrol car", 200);
  run.command("close door");
  run.command("drive");
  run.waitForRoom(20, "pulling out of the station lot");
  score(run, 105, "no points lost on the way out");
}

/** Round the four squares south-east of the station until the wanted car shows. */
function patrolUntilSpotted(run: Speedrun, event: number): void {
  const beat: readonly Junction[] = [
    { room: 20, avenue: 2, street: 1 },
    { room: 21, avenue: 0, street: 1 },
    { room: 25, avenue: 0, street: 0 },
    { room: 24, avenue: 2, street: 0 },
  ];
  for (let leg = 0; run.engine.flags[47] === 0; leg++) {
    assert.ok(leg < 40, "wanted car never appeared");
    driveToJunction(run, beat[leg % beat.length]!);
    assert.equal(run.engine.vars[67], event, "expected dispatch event");
  }
}

function stopCadillac(run: Speedrun): void {
  drive(run, [["W", 21, 23]]);
  patrolUntilSpotted(run, 38);
  pursue(run, "stolen Cadillac");
  run.wait(() => run.engine.vars[220] === 9, "Cadillac pulled over", 2000);
  run.key(AGI_KEY.F4);
  run.waitForRoom(32, "felony stop");
  score(run, 110, "stopped the light blue Cadillac");
}

/**
 * High-risk stop, by the manual. Call for backup and stay in the car until
 * Jack is covering from the passenger side. Step out but keep beside the open
 * door (leaving it, or closing it, before the suspect is prone gets you shot),
 * draw, order him out, halt him, hands up, face down. Only then approach,
 * holster, cuff, search, read him his rights and put him in the cage.
 */
function felonyStop(run: Speedrun): void {
  const e = run.engine;
  const suspect = e.screenObjects[19]!;
  const phase = (n: number, label: string, max = 4000): void => {
    run.wait(() => e.vars[119] === n && e.inputEnabled, label, max);
    alive(run, label);
  };
  run.command("radio");
  assert.equal(e.vars[119], 1, "backup requested");
  phase(4, "Jack covering from the passenger side", 6000);
  run.command("open door");
  run.command("get out");
  run.wait(() => e.flags[39] === 0, "beside the open door", 200);
  run.command("draw gun");
  assert.equal(e.screenObjects[0]!.view, e.vars[42], "revolver drawn");
  run.command("get out of the car");
  phase(6, "suspect steps out");
  run.command("halt");
  run.wait(() => e.flags[222] !== 0, "suspect halts", 600);
  score(run, 112, "suspect halted");
  run.command("hands up");
  phase(9, "hands raised");
  score(run, 114, "suspect's hands up");
  run.command("lie down");
  phase(12, "suspect prone");
  score(run, 116, "suspect face down");
  go(run, { x0: suspect.x + 8, x1: suspect.x + 12, y0: 163, y1: 165 });
  assert.equal(e.vars[119], 14, "Jack covering while you close in");
  run.command("draw gun");
  assert.equal(e.screenObjects[0]!.view, e.vars[39], "revolver holstered");
  run.command("cuff man");
  assert.equal(e.vars[119], 15, "suspect handcuffed");
  run.command("search man");
  score(run, 118, "found the suspect's pistol");
  run.command("read rights");
  score(run, 119, "Miranda warning");
  run.command("stand up");
  // Let him finish getting up: an order given mid-animation makes the
  // interpreter's shared motion/animation byte raise an unrelated flag
  // (the one that later pays for booking the park dealers).
  run.wait(() => e.vars[220] === 17 && e.inputEnabled, "suspect on his feet", 1200);
  assert.equal(e.flags[135], 0, "no stray completion flag");
  run.command("go to car");
  run.wait(() => e.flags[46] !== 0 && suspect.x >= 135, "prisoner at the patrol car", 4000);
  seatPrisoner(run);
}

/** Jack books the pistol; the Cadillac gives up its VIN, a black book and cocaine. */
function searchCadillac(run: Speedrun): void {
  const e = run.engine;
  const jack = e.screenObjects[1]!;
  const ego = e.screenObjects[0]!;
  run.wait(
    () => e.vars[119] === 19 && Math.abs(jack.x - ego.x) + Math.abs(jack.y - ego.y) < 18,
    "Jack walks over",
    3000,
  );
  run.command("get gun");
  run.waitForRoom(114, "examining the suspect's pistol");
  run.command("give gun to jack");
  run.waitForRoom(32, "pistol handed to Jack");
  score(run, 123, "pistol booked as evidence");
  go(run, { x0: 30, x1: 40, y0: 160, y1: 161 });
  run.command("open door");
  assert.notEqual(e.flags[100], 0, "Cadillac door open");
  run.command("look at door");
  score(run, 125, "VIN found on the repainted door jamb");
  run.command("open glove box");
  run.waitForRoom(8, "glove compartment");
  run.command("look at black book");
  run.waitForRoom(113, "suspect's black book");
  score(run, 127, "black book");
  run.command("close book");
  run.waitForRoom(8, "book put back");
  run.command("look at license");
  score(run, 129, "two driver's licences");
  run.key(AGI_KEY.ENTER);
  run.wait(() => e.flags[220] === 0 && e.inputEnabled, "licences put back", 600);
  run.command("close glove box");
  run.waitForRoom(32, "glove compartment closed");
  go(run, { x0: 67, x1: 72, y0: 153, y1: 159 });
  run.command("open trunk");
  run.waitForRoom(9, "Cadillac's trunk");
  score(run, 131, "drugs in the trunk");
  run.command("close trunk");
  run.waitForRoom(32, "trunk closed");
  run.checkpoint("Arrested the Cadillac driver at gunpoint", { room: 32, score: 131 });
  boardCar(run, run.engine.vars[74]!);
}

function bookCadillacDriver(run: Speedrun): void {
  const e = run.engine;
  driveToJail(run);
  unloadPrisoner(run);
  enterJail(run);
  run.wait(() => e.vars[220] === 5 && e.inputEnabled, "jailer asks the charge", 3000);
  run.command("felony");
  assert.equal(e.vars[220], 6, "charge accepted");
  run.command("remove cuffs");
  run.assertCarried(ITEM.handcuffs);
  alive(run, "booking the Cadillac driver");
  score(run, 134, "so-called Marvin Hoffman booked");
  // Jack looks in with a message: Dooley wants to see you.
  run.wait(() => e.vars[221] === 5 && e.movementControlEnabled, "Jack arrives at the jail", 8000);
  const jack = e.screenObjects[2]!;
  run.walkToUntil(
    jack.x + 9,
    jack.y,
    () => e.vars[221]! >= 6,
    "Jack passes on Dooley's summons",
    600,
  );
  run.wait(() => e.vars[96] === 2 && e.movementControlEnabled, "Jack leaves", 3000);
  run.checkpoint("Booked the Cadillac driver for felony", { room: 40, score: 134 });
  leaveJail(run);
  boardCar(run, 24);
  leaveJailYard(run);
}

/**
 * Dooley starts reading Morgan's memo aloud, but the Gremlin has sprayed it
 * with mace and he bolts for the washroom. Read it from his side of the desk:
 * temporary transfer to Narcotics.
 */
function transferToNarcotics(run: Speedrun): void {
  const e = run.engine;
  parkAtStation(run);
  exitCar(run);
  enterStation(run);
  push(run, "E", 6);
  go(run, { x0: 22, x1: 29, y0: 131, y1: 141 });
  run.command("open door");
  run.wait(() => e.flags[238] !== 0, "Dooley's door open", 600);
  push(run, "W", 42);
  run.wait(
    () => e.vars[139] === 6 && e.flags[227] === 0,
    "Dooley runs out with streaming eyes",
    8000,
  );
  go(run, { x0: 73, x1: 85, y0: 112, y1: 118 });
  run.command("read memo");
  assert.equal(e.vars[31], 4, "transferred to Narcotics");
  score(run, 136, "read the transfer memo");
  run.verify("Transferred to Narcotics", { room: 42, score: 136 });
}

/** Into the back hall from the main one, then through a side door. */
function enterOffice(run: Speedrun, room: 43 | 49): void {
  if (run.state().room === 6) go(run, { x0: 30, x1: 32, y0: 95, y1: 105 }, 52);
  if (room === 49) {
    go(run, { x0: 124, x1: 138, y0: 117, y1: 118 }, 49);
    return;
  }
  // Lieutenant Morgan keeps his door shut.
  go(run, { x0: 51, x1: 57, y0: 121, y1: 124 });
  if (run.engine.flags[222] === 0) {
    run.command("open door");
    run.wait(() => run.engine.flags[222] !== 0, "Morgan's door open", 600);
  }
  push(run, "N", 43);
}

/** Back hall to main hall: the passage is at the east end. */
function toMainHall(run: Speedrun): void {
  go(run, { x0: 138, x1: 148, y0: 136, y1: 142 });
  push(run, "E", 6);
}

function leaveOffice(run: Speedrun): void {
  go(run, { x0: 58, x1: 66, y0: 160, y1: 164 });
  push(run, "S", 52);
}

/**
 * Plain clothes from the locker, then report: Morgan welcomes you to
 * Narcotics and Laura walks you round the office before dashing to a meeting.
 */
function reportToNarcotics(run: Speedrun): void {
  const e = run.engine;
  go(run, { x0: 118, x1: 124, y0: 131, y1: 138 });
  if (e.flags[229] === 0) {
    run.command("open door");
    run.wait(() => e.flags[229] !== 0, "office door open again", 600);
  }
  push(run, "E", 6);
  returnPatrolKit(run);
  openLocker(run);
  run.command("change clothes");
  assert.equal(e.vars[39], 4, "uniform off");
  run.command("change clothes");
  assert.equal(e.vars[39], 8, "plain clothes");
  run.command("get all");
  run.assertCarried(ITEM.revolver);
  run.assertCarried(ITEM.briefcase);
  closeLocker(run);
  go(run, { x0: 0, x1: 17, y0: 124, y1: 131 }, 6);
  enterOffice(run, 43);
  go(run, { x0: 86, x1: 90, y0: 118, y1: 124 });
  run.wait(() => e.vars[35] === 1 && e.inputEnabled, "Morgan's welcome", 8000);
  score(run, 137, "reported to Lieutenant Morgan");
  leaveOffice(run);
  enterOffice(run, 49);
  // Stand clear of the doorway: Laura leaves through it when she is done.
  go(run, { x0: 96, x1: 110, y0: 146, y1: 152 });
  run.wait(() => e.vars[36] === 1 && e.inputEnabled, "Laura's tour of the office", 12000);
}

/**
 * The case for a No Bail Warrant: Hoffman's file from the cabinet and the FBI
 * flyer for Jason Taselli from the clipboard. The car keys hang above it.
 */
function gatherHoffmanEvidence(run: Speedrun): void {
  const e = run.engine;
  go(run, { x0: 69, x1: 79, y0: 111, y1: 114 });
  run.command("open drawer");
  run.waitForRoom(110, "file drawer");
  run.command("look at hoffman file");
  run.command("get hoffman file");
  run.waitForRoom(49, "drawer closed");
  run.assertCarried(ITEM.hoffmanFile);
  score(run, 139, "Hoffman's file");
  go(run, { x0: 19, x1: 25, y0: 137, y1: 147 });
  run.command("get clipboard");
  run.waitForRoom(50, "clipboard");
  for (let page = 1; page < 5; page++) {
    run.key(AGI_KEY.RIGHT);
    run.until(() => e.vars[33] === page + 1, 60, `clipboard page ${page + 1}`);
  }
  run.command("get flyer");
  run.assertCarried(ITEM.wantedPoster);
  score(run, 141, "FBI flyer on Jason Taselli");
  run.command("hang clipboard");
  run.waitForRoom(49, "clipboard back on its hook");
  go(run, { x0: 27, x1: 31, y0: 128, y1: 134 });
  run.take("get keys", ITEM.cadillacKeys);
  score(run, 144, "keys to the unmarked car");
  run.checkpoint("Gathered the evidence against Hoffman", { room: 49, score: 144 });
}

/** The unmarked car is parked by the building; it needs its own walk-round. */
function takeUnmarkedCar(run: Speedrun): void {
  if (run.state().room !== 52) go(run, { x0: 30, x1: 32, y0: 95, y1: 105 }, 52);
  go(run, { x0: 17, x1: 24, y0: 134, y1: 140 });
  push(run, "W", 7);
  go(run, { x0: 88, x1: 96, y0: 104, y1: 106 });
  go(run, { x0: 88, x1: 96, y0: 114, y1: 118 });
  go(run, { x0: 132, x1: 139, y0: 114, y1: 118 });
  go(run, { x0: 132, x1: 139, y0: 104, y1: 106 });
  run.wait(() => run.engine.flags[121] !== 0, "safety check acknowledged", 200);
  go(run, { x0: 112, x1: 121, y0: 112, y1: 115 });
  run.command("open door");
  run.command("get in");
  run.wait(() => run.engine.flags[39] !== 0, "in the unmarked car", 200);
  run.command("close door");
  run.command("drive");
  run.waitForRoom(20, "out of the station lot");
  // A parked cruiser sits between this bay and the avenue: go round it.
  drive(run, [
    ["N", 53, 55],
    ["W", 21, 23],
  ]);
}

/** The courthouse lay-by is on the west kerb of Rose, reached from 8th Street. */
function parkAtCourthouse(run: Speedrun): void {
  driveToJunction(run, { room: 24, avenue: 1, street: 1 });
  drive(run, [
    ["N", 76, 78],
    ["W", 73, 75],
  ]);
  brake(run);
  run.key(AGI_KEY.F4);
  run.waitForRoom(53, "outside the courthouse");
}

/**
 * Court is in session, so the clerk has to send the bailiff in with word of
 * an emergency. Judge Palmer wants the file, the FBI flyer, and the link
 * between Hoffman and Taselli: the tattoo.
 */
function noBailWarrant(run: Speedrun): void {
  const e = run.engine;
  leaveOffice(run);
  toMainHall(run);
  go(run, { x0: 56, x1: 84, y0: 93, y1: 99 });
  run.take("get radio", ITEM.extender);
  takeUnmarkedCar(run);
  parkAtCourthouse(run);
  score(run, 145, "found the courthouse");
  exitCar(run);
  go(run, { x0: 76, x1: 87, y0: 85, y1: 87 });
  run.command("open door");
  run.waitForRoom(54, "courthouse lobby");
  go(run, { x0: 129, x1: 142, y0: 126, y1: 141 });
  run.wait(() => e.vars[220] === 4 && e.inputEnabled, "court clerk comes to the window", 1200);
  run.command("emergency");
  score(run, 148, "emergency message sent in to the judge");
  run.wait(() => e.vars[95] === 20 && e.vars[220] === 4, "judge agrees to see you", 4000);
  go(run, { x0: 78, x1: 89, y0: 119, y1: 122 });
  run.command("open door");
  run.wait(() => e.flags[224] !== 0, "courtroom doors open", 600);
  push(run, "N", 55);
  run.wait(() => e.vars[220] === 12 && e.inputEnabled, "Judge Palmer asks what you want", 6000);
  run.command("hoffman");
  run.command("show file");
  run.command("show flyer");
  assert.equal(e.vars[95], 30, "evidence handed up");
  run.wait(
    () => e.vars[95] === 40 && e.vars[220] === 2 && e.inputEnabled,
    "judge reads the evidence",
    6000,
  );
  run.command("tattoo");
  run.waitForItem(ITEM.warrant, "No Bail Warrant issued", 8000);
  score(run, 155, "No Bail Warrant");
  run.checkpoint("Won a No Bail Warrant from Judge Palmer", { room: 55, score: 155 });
  run.waitForRoom(54, "escorted out of the courtroom", 3000);
  run.wait(() => e.movementControlEnabled, "back in the lobby", 600);
  go(run, { x0: 70, x1: 82, y0: 160, y1: 164 });
  push(run, "S", 53);
  boardCar(run, 24);
}

/** Just across 7th: hand the jailer the warrant before Hoffman's lawyer posts bail. */
function serveWarrant(run: Speedrun): void {
  const e = run.engine;
  drive(run, [
    ["E", 79, 81],
    ["S", 99, 101],
    ["E", 90, 92],
  ]);
  brake(run);
  run.key(AGI_KEY.F4);
  run.waitForRoom(41, "jail yard");
  exitCar(run);
  enterJail(run);
  run.wait(() => e.movementControlEnabled && e.inputEnabled, "inside the jail", 1200);
  go(run, { x0: 100, x1: 120, y0: 108, y1: 113 });
  run.command("give warrant");
  assert.equal(e.vars[96], 4, "warrant served");
  score(run, 157, "Taselli held without bail");
  run.wait(() => e.flags[228] !== 0 && e.movementControlEnabled, "jailer returns laughing", 8000);
  run.verify("Served the warrant in the nick of time", { room: 40, score: 157 });
  leaveJail(run);
  boardCar(run, 24);
  leaveJailYard(run);
}

/**
 * Laura is waiting in the station lot with a tip: a deal is going down in
 * Lytton City Park. She rides along; the park's lay-by is on the west kerb.
 */
function driveToStakeout(run: Speedrun): void {
  const e = run.engine;
  parkAtStation(run);
  run.wait(() => e.flags[101] !== 0 && e.vars[221]! >= 7 && e.inputEnabled, "Laura gets in", 4000);
  run.command("drive");
  run.waitForRoom(20, "heading for the park");
  drive(run, [
    ["N", 53, 55],
    ["W", 21, 23],
  ]);
  // The park's service lane runs beside the avenue and opens off 3rd Street.
  driveToJunction(run, { room: 14, avenue: 0, street: 0 });
  drive(run, [
    ["S", 36, 38],
    ["W", 10, 12],
    ["S", 76, 78],
  ]);
  brake(run);
  run.key(AGI_KEY.F4);
  run.waitForRoom(56, "Lytton City Park");
  score(run, 158, "reached the park with Laura");
}

/**
 * Hide in the bushes on the left, report in, and keep still while buyer and
 * dealer arrive. Once money and drugs have changed hands: draw, tell Laura
 * you are moving in, and challenge them. The dealer runs into Laura's arms;
 * the boy gives up.
 */
function parkStakeout(run: Speedrun): void {
  const e = run.engine;
  exitCar(run);
  go(run, { x0: 60, x1: 90, y0: 116, y1: 118 });
  push(run, "N", 57);
  go(run, { x0: 5, x1: 9, y0: 120, y1: 127 });
  run.wait(() => e.vars[63] === 2, "out of sight", 600);
  run.command("radio");
  assert.notEqual(e.flags[227], 0, "Laura knows you are in position");
  run.wait(() => e.vars[63] === 7 && e.inputEnabled, "money and drugs change hands", 20000);
  alive(run, "stakeout");
  run.command("draw gun");
  assert.equal(e.screenObjects[0]!.view, e.vars[42], "revolver drawn");
  run.command("radio");
  assert.notEqual(e.flags[228], 0, "Laura told you are moving in");
  run.command("halt");
  run.wait(() => e.vars[139] === 152 && e.inputEnabled, "dealer bolts, buyer surrenders", 3000);
  alive(run, "stakeout arrest");
  score(run, 163, "stakeout sprung by the book");
  const buyer = e.screenObjects[1]!;
  go(run, { x0: buyer.x + 9, x1: buyer.x + 14, y0: buyer.y, y1: buyer.y + 3 });
  run.command("draw gun");
  assert.equal(e.screenObjects[0]!.view, e.vars[39], "revolver holstered");
  run.command("cuff man");
  assert.equal(e.vars[63], 9, "buyer handcuffed");
  run.command("read rights");
  score(run, 165, "Simms cuffed and cautioned");
  run.command("come with me");
  run.waitForRoom(56, "walking Simms to the car", 3000);
  run.checkpoint("Sprang the park stakeout", { room: 56, score: 165 });
}

/** Both suspects at the car: search them and get names while they are shaking. */
function questionDealers(run: Speedrun): void {
  const e = run.engine;
  run.wait(() => e.vars[63] === 200 && e.inputEnabled, "Laura brings Colby over", 4000);
  run.command("search man");
  score(run, 171, "cocaine on Simms, a gun and cash on Colby");
  run.command("ask name");
  score(run, 176, "Simms names his dealer");
  run.command("question colby");
  run.command("question colby");
  score(run, 179, "Colby gives up his supplier's number");
  // The scene has already walked you to the rear door.
  run.command("open door");
  run.command("open door");
  run.wait(() => e.vars[63] === 210, "suspects in the back seat", 3000);
  run.command("close door");
  run.wait(() => e.movementControlEnabled && e.vars[221] === 228, "Laura ready to go", 3000);
  go(run, { x0: 110, x1: 119, y0: 161, y1: 163 });
  run.command("open door");
  run.wait(() => e.vars[63] === 220, "Laura gets in", 3000);
  run.command("get in");
  run.wait(() => e.flags[39] !== 0, "behind the wheel", 200);
  run.command("close door");
  run.command("drive");
  run.waitForRoom(14, "leaving the park");
  run.command("radio");
  score(run, 180, "Code 4 and two in custody called in");
}

/**
 * Laura minds the prisoners at the jail steps while you lock your revolver
 * away and buzz the door; everyone files in together.
 */
function bookDealers(run: Speedrun): void {
  const e = run.engine;
  drive(run, [
    ["N", 36, 38],
    ["E", 21, 23],
  ]);
  driveToJunction(run, { room: 24, avenue: 1, street: 1 });
  drive(run, [
    ["N", 99, 101],
    ["E", 90, 92],
  ]);
  brake(run);
  run.key(AGI_KEY.F4);
  run.waitForRoom(41, "jail yard");
  exitCar(run);
  go(run, { x0: 124, x1: 134, y0: 161, y1: 163 });
  run.wait(() => e.vars[220] === 1 && e.inputEnabled, "Laura steps out", 1200);
  run.command("open door");
  go(run, { x0: 100, x1: 112, y0: 164, y1: 166 });
  run.wait(
    () => e.vars[221]! >= 4 && e.movementControlEnabled,
    "Laura and the prisoners at the steps",
    6000,
  );
  go(run, { x0: 124, x1: 134, y0: 161, y1: 163 });
  run.command("close door");
  go(run, { x0: 71, x1: 80, y0: 107, y1: 108 });
  run.command("open locker");
  run.wait(() => e.flags[60] !== 0 && e.inputEnabled, "gun locker open", 600);
  run.command("put gun in locker");
  assert.notEqual(e.flags[42], 0, "revolver locked away");
  run.command("close locker");
  run.wait(() => e.flags[60] === 0 && e.inputEnabled, "gun locker shut", 600);
  go(run, { x0: 102, x1: 112, y0: 107, y1: 108 });
  run.command("push button");
  run.waitForRoom(40, "everyone inside", 6000);
  run.wait(() => e.vars[220] === 9 && e.inputEnabled, "jailer asks the charge", 4000);
  run.command("drugs");
  assert.equal(e.vars[220], 12, "charge accepted");
  run.wait(() => e.vars[166]! < 60 && e.inputEnabled, "booking slip handed over", 1200);
  run.command("remove cuffs");
  run.assertCarried(ITEM.handcuffs);
  alive(run, "booking the dealers");
  score(run, 182, "Simms and Colby booked");
  run.wait(
    () => e.vars[220] === 200 && e.movementControlEnabled,
    "Laura heads back to the car",
    8000,
  );
  run.checkpoint("Booked the park dealers", { room: 40, score: 182 });
  leaveJail(run);
  boardCar(run, 24);
  leaveJailYard(run);
}

/**
 * Laura goes in to write up the arrest and suggests telling Jack the Jefferson
 * High pusher is off the street. Jack is drinking alone: his daughter is in a
 * coma. Then Keith arrives with worse news, Taselli has escaped.
 */
function tellJack(run: Speedrun): void {
  const e = run.engine;
  parkAtStation(run);
  run.wait(
    () => (e.vars[98] === 10 && e.vars[63] === 255) || e.vars[220]! >= 6,
    "Laura heads inside",
    4000,
  );
  assert.equal(e.vars[98], 10, "Laura suggests finding Jack");
  run.command("drive");
  run.waitForRoom(20, "off to the Blue Room");
  drive(run, [
    ["N", 53, 55],
    ["W", 21, 23],
  ]);
  parkAtBlueRoom(run);
  exitCar(run);
  go(run, { x0: 54, x1: 61, y0: 122, y1: 122 }, 34);
  go(run, { x0: 88, x1: 98, y0: 131, y1: 141 });
  run.command("sit");
  assert.notEqual(e.flags[220], 0, "seated with Jack");
  run.command("talk to jack");
  run.wait(
    () => e.vars[98] === 11 && e.inputEnabled,
    "Keith brings word of Taselli's escape",
    20000,
  );
  run.command("stand");
  go(run, { x0: 58, x1: 68, y0: 160, y1: 164 });
  push(run, "S", 33);
  score(run, 183, "heard Jack out");
  run.checkpoint("Learned that Taselli has escaped", { room: 33, score: 183 });
  boardCar(run, 17);
  drive(run, [["W", 21, 23]]);
}

/** Dial from a desk phone: the number prompt is answered like any other line. */
function dial(run: Speedrun, number: string, connected: number): void {
  const e = run.engine;
  run.answer(number);
  run.command("use phone");
  run.wait(() => e.vars[255] === connected && e.inputEnabled, `call to ${number} answered`, 1200);
}

/** Stand in front of Morgan's desk and hear him out. */
function seeMorgan(run: Speedrun, stage: number, label: string): void {
  const e = run.engine;
  enterOffice(run, 43);
  // He starts talking as soon as you are near the desk, wherever that is.
  const approach = run.traverse({
    passage: {
      kind: "position",
      planned: true,
      target: { x0: 86, x1: 90, y0: 118, y1: 124 },
    },
    passageOptions: { avoidTriggers: false, geometry: "current" },
    landing: { label: "Morgan's desk", test: () => true },
  });
  assert.ok(
    ["reached", "needs_input", "movement_control_unavailable"].includes(approach.status),
    JSON.stringify(approach),
  );
  run.wait(() => e.vars[35] === stage && e.vars[139] === 255 && e.inputEnabled, label, 12000);
}

/**
 * Morgan wants Taselli's trail followed. Laura's note on your desk has the
 * Chicago lead; Detective Taber there ties Taselli to a card shark called
 * Jessie Bains, and the crime lab confirms the prints on the .45.
 */
function followTaselliTrail(run: Speedrun): void {
  const e = run.engine;
  parkAtStation(run);
  exitCar(run);
  enterStation(run);
  seeMorgan(run, 3, "Morgan on Taselli's escape");
  score(run, 184, "briefed on the escape");
  leaveOffice(run);
  enterOffice(run, 49);
  go(run, { x0: 82, x1: 90, y0: 123, y1: 138 });
  run.command("read note");
  assert.equal(e.vars[36], 3, "Laura's note read");
  score(run, 186, "Laura's note about Chicago");
  go(run, { x0: 93, x1: 104, y0: 123, y1: 139 });
  dial(run, "312 555-3382", 91);
  run.command("taselli");
  score(run, 191, "Chicago PD links Taselli to Jessie Bains");
  run.wait(() => e.vars[255] === 0 && e.inputEnabled, "Taber hangs up", 1200);
  dial(run, "555-4522", 51);
  run.command("sonny bonds");
  assert.equal(e.vars[255], 52, "crime lab knows who is calling");
  run.command("hoffman");
  score(run, 196, "crime lab confirms Taselli's prints");
  run.wait(() => e.vars[255] === 0 && e.inputEnabled, "crime lab hangs up", 1200);
  run.checkpoint("Traced Taselli to Jessie Bains by telephone", { room: 49, score: 196 });
}

/**
 * Sweet Cheeks Marie was swept up in Operation Trick Trap and is asking for
 * you at the jail. Laura passes that on; Morgan sees a way into the Hotel
 * Delphoria. At her cell the magic words are an offer she can accept.
 */
function recruitSweetCheeks(run: Speedrun): void {
  const e = run.engine;
  leaveOffice(run);
  enterOffice(run, 49);
  go(run, { x0: 96, x1: 110, y0: 146, y1: 152 });
  run.wait(() => e.vars[36] === 4 && e.inputEnabled, "Laura: Marie is asking for you", 3000);
  leaveOffice(run);
  seeMorgan(run, 5, "Morgan's plan for Sweet Cheeks");
  leaveOffice(run);
  takeUnmarkedCar(run);
  driveToJunction(run, { room: 24, avenue: 1, street: 1 });
  drive(run, [
    ["N", 99, 101],
    ["E", 90, 92],
  ]);
  brake(run);
  run.key(AGI_KEY.F4);
  run.waitForRoom(41, "jail yard");
  exitCar(run);
  enterJail(run);
  run.wait(() => e.vars[139] === 50 && e.inputEnabled, "Marie pleads to be let out", 12000);
  run.command("help hotel");
  run.wait(() => e.vars[35] === 6 && e.movementControlEnabled, "Marie agrees to help", 6000);
  score(run, 201, "Sweet Cheeks recruited");
  go(run, { x0: 100, x1: 120, y0: 112, y1: 114 });
  run.wait(() => e.vars[96] === 199, "jailer teases you about the lipstick", 1200);
  run.checkpoint("Recruited Sweet Cheeks Marie", { room: 40, score: 201 });
  leaveJail(run);
  boardCar(run, 24);
  leaveJailYard(run);
}

/** Dispatch wants a body identified at Cotton Cove: the flower tattoo settles it. */
function identifyTaselli(run: Speedrun): void {
  const e = run.engine;
  driveToJunction(run, { room: 25, avenue: 2, street: 1 });
  drive(run, [["S", 139, 141]]);
  brake(run);
  run.key(AGI_KEY.F4);
  run.waitForRoom(60, "Cotton Cove");
  score(run, 203, "answered the call to Cotton Cove");
  exitCar(run);
  const body = e.screenObjects[1]!;
  go(run, { x0: body.x + 9, x1: body.x + 14, y0: body.y + 3, y1: body.y + 8 });
  run.command("move blanket");
  run.command("look at tattoo");
  score(run, 205, "the dead man is Jason Taselli");
  run.command("radio");
  assert.equal(e.vars[91], 20, "identification called in");
  score(run, 208, "identification called in");
  run.verify("Identified Taselli's body at Cotton Cove", { room: 60, score: 208 });
  boardCar(run, 25);
  drive(run, [["N", 123, 125]]);
}

/**
 * Morgan's plan: go into the Hotel Delphoria as a high-rolling pimp known as
 * Whitey, with Marie to vouch for you. He hands over a white suit, a cane and
 * a bottle of bleach. While Morgan has his mind on other things, ring the
 * Cobbs from your desk.
 */
function undercoverBriefing(run: Speedrun): void {
  parkAtStation(run);
  exitCar(run);
  enterStation(run);
  seeMorgan(run, 7, "the undercover plan");
  run.assertCarried(ITEM.whiteSuit);
  run.assertCarried(ITEM.bleach);
  score(run, 210, "briefed for the hotel operation");
  leaveOffice(run);
  enterOffice(run, 49);
  go(run, { x0: 93, x1: 104, y0: 123, y1: 139 });
  dial(run, "555-2622", 0);
  score(run, 213, "called the Cobb house");
  leaveOffice(run);
  toMainHall(run);
  go(run, { x0: 56, x1: 84, y0: 93, y1: 99 });
  run.command("put radio");
  assert.ok(!run.carried(ITEM.extender), "extender returned: it would spoil the suit");
}

/** Bleach needs the shower running; rinsing it out finishes the blond look. */
function becomeWhitey(run: Speedrun): void {
  const e = run.engine;
  openLocker(run);
  run.command("change clothes");
  assert.equal(e.vars[39], 4, "down to a towel");
  closeLocker(run);
  go(run, { x0: 92, x1: 104, y0: 91, y1: 95 });
  run.command("turn on");
  run.wait(() => e.flags[70] !== 0, "shower running", 120);
  run.command("bleach hair");
  assert.equal(e.vars[224], 2, "bleach worked in");
  run.command("rinse hair");
  run.wait(
    () => e.vars[35] === 8 && e.movementControlEnabled,
    "a blond stranger in the mirror",
    1200,
  );
  score(run, 216, "hair bleached");
  run.command("turn off");
  run.wait(() => e.flags[70] === 0, "shower off", 120);
  go(run, { x0: 84, x1: 97, y0: 132, y1: 140 });
  run.command("open locker");
  run.waitForRoom(47, "locker opens");
  run.command("change clothes");
  assert.equal(e.vars[39], 13, "white suit on");
  run.assertCarried(ITEM.cane);
  closeLocker(run);
  go(run, { x0: 0, x1: 17, y0: 124, y1: 131 }, 6);
  seeMorgan(run, 9, "marked money and last instructions");
  run.assertCarried(ITEM.markedMoney);
  score(run, 217, "marked bills issued");
  run.command("ask for phone number");
  score(run, 219, "Morgan's contact number");
  run.checkpoint("Became Whitey the high roller", { room: 43, score: 219 });
  leaveOffice(run);
}

/** The Delphoria's forecourt lane leaves the avenue just above the entrance. */
function arriveAtHotel(run: Speedrun): void {
  takeUnmarkedCar(run);
  driveToJunction(run, { room: 11, avenue: 0, street: 0 });
  drive(run, [
    ["S", 63, 65],
    ["E", 33],
    ["S", 75, 77],
  ]);
  brake(run);
  run.key(AGI_KEY.F4);
  run.waitForRoom(63, "Hotel Delphoria");
  score(run, 220, "arrived at the Hotel Delphoria");
  exitCar(run);
  // The doorman holds you on the carpet while he swings the door open. The
  // doorway is the open span x68..80 of the y120 wall line; the closed-door
  // prop painted over the line to its right keeps that line's block value.
  go(run, { x0: 70, x1: 73, y0: 142, y1: 146 });
  push(run, "N", 64);
}

/** Ring for the clerk, register as Jimmy Lee Banksten and pay from the marked roll. */
function checkIn(run: Speedrun): void {
  const e = run.engine;
  go(run, { x0: 100, x1: 112, y0: 123, y1: 142 });
  run.command("ring bell");
  run.wait(() => e.vars[221] === 3 && e.inputEnabled, "desk clerk arrives", 1200);
  run.command("check in");
  assert.equal(e.vars[221], 4, "room offered");
  run.command("pay clerk");
  run.assertCarried(ITEM.roomKey);
  score(run, 223, "checked in to room 204");
  run.verify("Checked in as Jimmy Lee Banksten", { room: 64, score: 223 });
}

/**
 * The lounge. Order at the bar and Marie "recognises" Whitey; the scene seats
 * you both, brings the drink, and lets the bartender, Woody, size you up. He
 * only opens up about the back room when he sees a roll of bills.
 */
function meetWoody(run: Speedrun): void {
  const e = run.engine;
  go(run, { x0: 8, x1: 18, y0: 96, y1: 104 }, 68);
  go(run, { x0: 90, x1: 108, y0: 120, y1: 129 });
  run.wait(() => e.vars[220] === 2 && e.inputEnabled, "Woody asks what you will have", 1200);
  run.command("beer");
  run.wait(() => e.vars[220] === 54 && e.inputEnabled, "drink served at Marie's table", 6000);
  alive(run, "ordering a drink");
  run.command("pay");
  run.wait(
    () => e.vars[31] === 102 && e.inputEnabled,
    "Woody introduced, Marie back from the powder room",
    12000,
  );
  run.command("stand up");
  assert.equal(e.flags[230], 0, "up from the table");
  go(run, { x0: 90, x1: 108, y0: 120, y1: 129 });
  run.wait(() => e.vars[220] === 2 && e.inputEnabled, "Woody comes over", 1200);
  run.command("show money");
  assert.equal(e.vars[31], 103, "Woody mentions the back-room game");
  score(run, 226, "Woody takes the bait");
  run.checkpoint("Hooked Woody the bartender", { room: 68, score: 226 });
}

/** Lobby lift to the second floor; room 204 is at the east end. */
function goToRoom(run: Speedrun): void {
  const e = run.engine;
  if (run.state().room === 68) go(run, { x0: 126, x1: 150, y0: 78, y1: 86 }, 64);
  go(run, { x0: 64, x1: 72, y0: 83, y1: 85 });
  run.command("two");
  run.wait(
    () => run.state().room === 66 && e.movementControlEnabled && e.inputEnabled,
    "second floor",
    3000,
  );
  go(run, { x0: 138, x1: 148, y0: 132, y1: 140 });
  push(run, "E", 65);
  go(run, { x0: 87, x1: 93, y0: 122, y1: 125 });
  run.command("unlock door");
  run.waitForRoom(67, "room 204", 1200);
}

/**
 * From the room: report to Morgan as Whitey, get the cab company's number
 * from information, and send Marie back to the station out of harm's way.
 */
function phoneFromRoom(run: Speedrun): void {
  const e = run.engine;
  score(run, 227, "unlocked room 204");
  go(run, { x0: 41, x1: 46, y0: 110, y1: 118 });
  dial(run, "555-6674", 71);
  run.command("whitey");
  score(run, 230, "reported in to Morgan");
  run.wait(() => e.vars[255] === 0 && e.inputEnabled, "Morgan hangs up", 1200);
  run.answer("411");
  run.answer("cab");
  run.command("use phone");
  run.wait(
    () => e.vars[255] === 0 && run.textPrompts.length >= 2 && e.inputEnabled,
    "information gives the number",
    3000,
  );
  dial(run, "555-9222", 101);
  run.command("hotel delphoria");
  run.wait(() => e.vars[31] === 104 && e.inputEnabled, "Marie leaves for her cab", 6000);
  score(run, 233, "Marie sent to safety");
  run.verify("Sent Marie away in a cab", { room: 67, score: 233 });
}

/** Five-card draw hand class (0 nothing .. 8 straight flush), its ranking key and the cards worth keeping. */
function pokerHand(cards: readonly number[]): { strength: number; keep: number[]; made: number } {
  // Cards are 1..52 in four suits of thirteen, deuce low, ace high.
  const ranks = cards.map((c) => (c - 1) % 13);
  const suits = cards.map((c) => Math.floor((c - 1) / 13));
  const all = [0, 1, 2, 3, 4];
  const groups = [...new Set(ranks)]
    .map((rank) => ({ rank, at: all.filter((i) => ranks[i] === rank) }))
    .sort((a, b) => b.at.length - a.at.length || b.rank - a.rank);
  const sorted = [...ranks].sort((a, b) => b - a);
  const flush = suits.every((suit) => suit === suits[0]);
  const straight =
    groups.length === 5 && (sorted[0]! - sorted[4]! === 4 || (sorted[0] === 12 && sorted[1] === 3));
  const first = groups[0]!;
  const second = groups[1]!;
  let made = 0;
  let keep = all;
  if (straight && flush) made = 8;
  else if (first.at.length === 4) [made, keep] = [7, first.at];
  else if (first.at.length === 3 && second.at.length === 2) made = 6;
  else if (flush) made = 5;
  else if (straight) made = 4;
  else if (first.at.length === 3) [made, keep] = [3, first.at];
  else if (first.at.length === 2 && second.at.length === 2)
    [made, keep] = [2, [...first.at, ...second.at]];
  else if (first.at.length === 2) [made, keep] = [1, first.at];
  else {
    const fourFlush = [0, 1, 2, 3]
      .map((suit) => all.filter((i) => suits[i] === suit))
      .find((at) => at.length === 4);
    keep = fourFlush ?? all.filter((i) => ranks[i] === sorted[0] || ranks[i] === sorted[1]);
  }
  const strength = made * 1e6 + first.rank * 1e4 + sorted[0]! * 100 + sorted[1]!;
  return { strength, keep, made };
}

/**
 * Play one session of Frank's five-card draw (logic 75) until the house ends
 * it. The table only lets a winner move on, and the bankroll is the marked
 * money, so the decisions read the whole table from the game's own variables:
 * stay in cheaply before the draw with the best hand, press every bet after
 * the draw when it is still best, and get out of everything else. Every
 * input is an ordinary answer to the game's chip and discard prompts, or a
 * function key to ante; prompts are blocking, so each answer is queued when
 * the turn is about to come round.
 */
function playPoker(run: Speedrun, label: string, midway?: string): void {
  const e = run.engine;
  const v = e.vars;
  const handOf = (seat: number): number[] => [0, 1, 2, 3, 4].map((i) => v[208 + seat * 5 + i]!);
  let answeredTurn = "";
  let antedHand = -1;
  const started = run.ticks;
  let marked = midway === undefined;
  while (v[0] === 75) {
    assert.ok(run.ticks - started < 120000, `${label}: session overran`);
    const stage = v[239]!;
    // A long session needs a story marker between hands so the timeline stays navigable.
    if (!marked && stage === 8 && run.ticks - started >= 30000) {
      marked = true;
      run.checkpoint(midway!, { room: 75 });
    }
    const bets = [v[228]!, v[229]!, v[230]!, v[231]!];
    const myTurn = v[235] === 3;
    const dealing = v[203] === 3;
    let turn = "";
    if (bets[3] !== 255) {
      if ((stage === 2 || stage === 5) && myTurn) turn = `${v[172]}:${stage}:${v[234]}`;
      // The dealer's left acts in the same pass that opens a betting round.
      else if ((stage === 1 || stage === 4) && dealing) turn = `${v[172]}:${stage}`;
      else if (stage === 3 && myTurn) turn = `${v[172]}:draw`;
    }
    if (turn !== "" && turn !== answeredTurn) {
      answeredTurn = turn;
      const mine = pokerHand(handOf(3));
      if (stage === 3) {
        const discard = [0, 1, 2, 3, 4].filter((i) => !mine.keep.includes(i)).slice(0, 3);
        run.answerNumber(discard.length);
        for (const card of discard) run.answerNumber(card + 1);
      } else {
        const rivals = [0, 1, 2].filter((seat) => bets[seat] !== 255);
        const opening = stage === 1 || stage === 4;
        const toCall = opening ? 0 : Math.max(...bets.filter((bet) => bet !== 255)) - bets[3]!;
        const best = rivals.every((seat) => pokerHand(handOf(seat)).strength < mine.strength);
        const afterDraw = stage >= 4;
        run.answerNumber(!best ? 0 : afterDraw ? toCall + 3 : Math.max(toCall, 1));
      }
    }
    // Between hands any function key antes up for the next one.
    if (stage === 8 && e.inputEnabled && antedHand !== v[172]) {
      antedHand = v[172]!;
      run.key(AGI_KEY.F6);
    }
    run.advance();
  }
  alive(run, label);
}

/** Down to the lobby and back into the lounge. */
function returnToLounge(run: Speedrun): void {
  const e = run.engine;
  go(run, { x0: 70, x1: 84, y0: 162, y1: 165 });
  push(run, "S", 65);
  push(run, "W", 66);
  go(run, { x0: 82, x1: 100, y0: 121, y1: 125 });
  run.command("one");
  run.wait(
    () => run.state().room === 64 && e.movementControlEnabled && e.inputEnabled,
    "lobby",
    3000,
  );
  go(run, { x0: 8, x1: 18, y0: 96, y1: 104 }, 68);
  go(run, { x0: 90, x1: 108, y0: 120, y1: 129 });
  run.wait(() => e.vars[220] === 2 && e.inputEnabled, "Woody comes over", 1200);
}

/** Through the storeroom behind Woody: a knock, a frisk, and the card room. */
function followWoody(run: Speedrun, label: string): void {
  const e = run.engine;
  run.wait(() => e.vars[220]! >= 204, `${label}: Woody heads for the storeroom`, 3000);
  go(run, { x0: 3, x1: 12, y0: 152, y1: 158 });
  push(run, "W", 69);
  run.wait(
    () => e.flags[221] !== 0 && e.movementControlEnabled,
    `${label}: Woody waits to frisk you`,
    6000,
  );
  // Stepping up to him starts the frisk, which takes over from there.
  const frisk = run.navigate({
    kind: "position",
    planned: true,
    target: { x0: 78, x1: 85, y0: 108, y1: 111 },
  });
  assert.ok(
    ["reached", "needs_input", "movement_control_unavailable"].includes(frisk.outcome.status),
    JSON.stringify(frisk.outcome),
  );
}

/**
 * Read the table talk until the cards come out. The game paces itself with
 * clock pauses that are not message windows, so only real windows are
 * dismissed here.
 */
function toCardTable(run: Speedrun): void {
  for (let n = 0; run.state().room !== 75; n++) {
    assert.ok(n < 20000, "the poker game never started");
    if (run.engine.modalKind !== null) run.dismiss();
    else run.advance();
  }
}

function buyIntoGame(run: Speedrun): void {
  const e = run.engine;
  returnToLounge(run);
  run.command("show money");
  alive(run, "buying in");
  score(run, 234, "two hundred dollars buys a seat");
  followWoody(run, "first game");
  run.waitForRoom(70, "the card room", 6000);
  run.wait(() => e.movementControlEnabled && e.inputEnabled, "inside the card room", 600);
  go(run, { x0: 61, x1: 72, y0: 112, y1: 124 });
  // Hands are paced by whole-second pauses that grow with the speed setting.
  run.command("fastest");
  run.command("sit");
  toCardTable(run);
}

function firstPokerGame(run: Speedrun): void {
  const e = run.engine;
  playPoker(run, "first game", "Still in the game after an hour at Frank's table");
  assert.equal(e.vars[31], 170, "left the table a winner");
  assert.ok(e.vars[170]! > 60, "bankroll large enough for the big game");
  run.wait(
    () => run.state().score === 237 && e.inputEnabled,
    "Frank invites you to the private game",
    1200,
  );
  run.command("normal");
  run.checkpoint("Won at Frank's poker table", { room: 70, score: 237 });
}

/** Out through the storeroom and lounge, up to room 204 to meet the backup team. */
function collectTransmitter(run: Speedrun): void {
  const e = run.engine;
  go(run, { x0: 70, x1: 84, y0: 160, y1: 164 });
  push(run, "S", 69);
  go(run, { x0: 142, x1: 148, y0: 132, y1: 142 }, 68);
  goToRoom(run);
  run.wait(() => e.vars[31] === 175 && e.inputEnabled, "backup detectives let themselves in", 6000);
  const detective = e.screenObjects[4]!;
  go(run, { x0: detective.x + 8, x1: detective.x + 12, y0: detective.y - 2, y1: detective.y + 2 });
  run.take("get transmitter", ITEM.transmitter);
  score(run, 242, "wired for sound");
  run.verify("Collected the pen transmitter from the backup team", { room: 67, score: 242 });
}

/** The password gets Whitey into the private game, where Frank turns out to be Jessie Bains. */
function privateGame(run: Speedrun): void {
  const e = run.engine;
  returnToLounge(run);
  run.command("frank sent me");
  followWoody(run, "private game");
  run.waitForRoom(71, "escorted through to the private room", 12000);
  run.wait(() => e.movementControlEnabled && e.inputEnabled, "inside the private room", 1200);
  go(run, { x0: 88, x1: 95, y0: 131, y1: 136 });
  run.command("fastest");
  run.command("sit");
  toCardTable(run);
  playPoker(run, "private game");
  assert.equal(e.vars[31], 190, "impressed the Death Angel");
  run.wait(
    () => run.state().score === 245 && e.inputEnabled,
    "Bains sounds you out about a job",
    1200,
  );
  run.command("normal");
  run.checkpoint("Beat Jessie Bains at his own table", { room: 71, score: 245 });
}

/** Walk a fixed staircase line; the overlapping flights defeat the static planner. */
function climb(run: Speedrun, room: number, steps: readonly (readonly [number, number])[]): void {
  for (const [x, y] of steps) {
    if (run.state().room !== room) return;
    run.walkTo(x, y, 900);
  }
}

/**
 * Bains offers a job and leads the way up the back stairs to the fourth
 * floor. The stair lines are the ones he walks himself. When he unlocks room
 * 404, whisper the number into the pen before going in.
 */
function followBains(run: Speedrun): void {
  const e = run.engine;
  run.command("yes");
  run.wait(() => e.vars[139] === 5 && e.inputEnabled, "invited up for a drink", 3000);
  run.command("yes");
  run.wait(() => e.vars[139]! >= 11 && e.inputEnabled, "Bains waits at the door", 3000);
  run.command("stand up");
  assert.notEqual(e.flags[94], 0, "following Bains");
  run.wait(() => e.vars[139] === 13, "Bains starts up the stairs", 3000);
  go(run, { x0: 112, x1: 120, y0: 137, y1: 141 });
  push(run, "E", 78);
  climb(run, 78, [
    [110, 154],
    [110, 163],
    [107, 163],
    [48, 104],
    [38, 104],
    [38, 95],
    [46, 95],
    [100, 41],
    [111, 41],
    [111, 45],
    [103, 45],
    [91, 33],
  ]);
  run.waitForRoom(77, "third-floor landing", 300);
  climb(run, 77, [
    [54, 161],
    [48, 157],
    [38, 157],
    [38, 149],
    [46, 147],
    [48, 146],
    [106, 88],
    [111, 88],
    [111, 95],
    [106, 95],
    [47, 36],
    [39, 36],
    [39, 33],
    [47, 33],
    [48, 32],
  ]);
  run.waitForRoom(76, "fourth-floor landing", 300);
  alive(run, "stairwell");
}

function takeDownBains(run: Speedrun): void {
  const e = run.engine;
  run.wait(() => e.flags[222] !== 0, "Bains goes through the fourth-floor door", 3000);
  go(run, { x0: 100, x1: 112, y0: 131, y1: 134 });
  push(run, "E", 66);
  run.wait(() => e.movementControlEnabled, "fourth-floor corridor", 600);
  go(run, { x0: 138, x1: 148, y0: 134, y1: 140 });
  push(run, "E", 65);
  run.wait(() => e.flags[221] !== 0 && e.inputEnabled, "Bains unlocks room 404", 3000);
  run.command("use pen");
  assert.equal(e.vars[60], 65, "backup knows the room number");
  score(run, 250, "backup sent to room 404");
  go(run, { x0: 86, x1: 94, y0: 120, y1: 120 }, 79);
  run.waitForRoom(103, "backup bursts in and Bains goes down", 12000);
  run.checkpoint("Took down the Death Angel", { room: 103, score: 250 });
  run.waitForRoom(104, "the trial of Jessie Bains", 30000);
  score(run, 254, "Bains convicted");
  run.verify("Saw Jessie Bains convicted", { room: 104, score: 254 });
  run.wait(() => e.vars[139] === 18 && e.inputEnabled, "key to the city", 12000);
  run.checkpoint("Received the key to the City of Lytton", { room: 104, score: 254 });
}

export const PQ1_SEGMENTS: readonly ((run: Speedrun) => void)[] = [
  startShift,
  gearUp,
  firstBriefing,
  collectPatrolKit,
  inspectPatrolCar,
  accidentCall,
  investigateAccident,
  coffeeBreak,
  patrolForSpeeder,
  pullOverSpeeder,
  citeHelenHots,
  returnToCarols,
  clearBikers,
  stopDrunkDriver,
  arrestDrunkDriver,
  bookDrunkDriver,
  transferMemoAndInvitation,
  changeForParty,
  birthdayParty,
  swingShiftBriefing,
  backOnPatrol,
  stopCadillac,
  felonyStop,
  searchCadillac,
  bookCadillacDriver,
  transferToNarcotics,
  reportToNarcotics,
  gatherHoffmanEvidence,
  noBailWarrant,
  serveWarrant,
  driveToStakeout,
  parkStakeout,
  questionDealers,
  bookDealers,
  tellJack,
  followTaselliTrail,
  recruitSweetCheeks,
  identifyTaselli,
  undercoverBriefing,
  becomeWhitey,
  arriveAtHotel,
  checkIn,
  meetWoody,
  goToRoom,
  phoneFromRoom,
  buyIntoGame,
  firstPokerGame,
  collectTransmitter,
  privateGame,
  followBains,
  takeDownBains,
];

export function pq1Complete(run: Speedrun): void {
  for (const segment of PQ1_SEGMENTS) segment(run);
}

/**
 * Police Quest complete-game route. The status line promises 245 points; the
 * logic awards 254 on this route (every scored action that is not mutually
 * exclusive with a better one), so the claim is the observed ending state,
 * not the advertised maximum. Seed 1: the dispatch countdowns, the wanted
 * cars' turns and both poker sessions are all played reactively, so the seed
 * only has to be fixed, not lucky; both the dwelling and the plain replay
 * clocks finish with it.
 */
export const pq1Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.PQ1,
  alias: "pq1",
  label: "arrested Jessie Bains and received the key to the city with 254 points",
  coverage: "complete-game",
  seed: 1,
  route: pq1Complete,
  expected: {
    room: 104,
    score: 254,
    // Ending logic 104 step 18 (key to the city), Bains beaten at poker
    // (v31 190), backup radioed from the corridor (f97), warrant served (f125).
    vars: { 139: 18, 31: 190 },
    flags: { 97: 1, 118: 1, 125: 1 },
    carriedExactly: [
      ITEM.cadillacKeys,
      ITEM.newspaper,
      ITEM.wallet,
      ITEM.cane,
      ITEM.markedMoney,
      ITEM.transmitter,
      ITEM.roomKey,
    ],
    inputEnabled: true,
    egoView: 0,
  },
  requiresAnswer: true,
};
