import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";
import type { TraversalOutcome } from "../../src/agent/navigationTraversal.ts";
import type { Target } from "../../src/agent/navigation.ts";

function boot(run: Speedrun): void {
  run.until(() => run.state().room === 73, 600, "speed calibration finishes");
  run.checkpoint("Title", { room: 73, score: 0 });
  run.advance(10);
  run.key(AGI_KEY.ENTER);
  run.until(() => run.state().room === 1 && run.engine.inputEnabled, 600, "Brooklyn bridge");
  run.command("fastest");
  assert.equal(run.engine.vars[10], 0);
}

const DEAD = 155;
const CTRL_N = 14;

/** Ego is drawn and updating: scripted scenes hide or freeze him meanwhile. */
function egoOnScreen(run: Speedrun): boolean {
  return run.engine.readObjects().some((o) => o.num === 0 && o.update);
}

function alive(run: Speedrun): void {
  assert.equal(run.engine.flags[DEAD], 0, `Jerrod died: ${run.messages.at(-1) ?? ""}`);
}

function control(run: Speedrun, label: string, max = 3000): void {
  run.wait(() => run.engine.movementControlEnabled && run.engine.inputEnabled, label, max);
  alive(run);
}

/** Planned walk that rides out scripted freezes (doors stop ego while they swing). */
function walk(run: Speedrun, x: number, y: number, until?: () => boolean): void {
  walkInto(run, { x0: x, x1: x, y0: y, y1: y }, until);
}

/** As walk(), into any anchor of a region (the posn() box a command checks). */
function walkInto(
  run: Speedrun,
  target: Target,
  until?: () => boolean,
  avoidTriggers = false,
): void {
  const { x0: x, y0: y } = target;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (until?.()) return;
    const { outcome } = run.navigate(
      { kind: "position", target, planned: true },
      { planOptions: { geometry: "current", avoidTriggers } },
    );
    if (outcome.status === "reached") {
      run.direction(0);
      return;
    }
    if (until?.()) return;
    if (outcome.status === "needs_input") {
      run.dismiss();
      continue;
    }
    assert.ok(
      outcome.status === "movement_control_unavailable" ||
        outcome.status === "blocked" ||
        outcome.status === "budget_exhausted" ||
        outcome.status === "unreachable_under_current_model",
      JSON.stringify(outcome),
    );
    run.direction(0);
    run.advance(3);
    run.wait(() => egoOnScreen(run), `moving again toward (${x},${y})`, 600);
  }
  assert.fail(`too many interruptions walking to (${x},${y})`);
}

/** Wait until an animated prop (a door, mostly) shows the last cel of its loop. */
function lastCel(run: Speedrun, object: number, label: string): void {
  const prop = run.engine.screenObjects[object]!;
  run.wait(
    () => prop.cel === run.engine.getView(prop.view)!.loops[prop.loop]!.cels.length - 1,
    label,
    600,
  );
}

/** Pedestrians and swinging doors interrupt a walk; a player just tries again. */
function retry(run: Speedrun, label: string, attempt: () => TraversalOutcome): void {
  let stuck = 0;
  for (let n = 0; n < 12; n++) {
    const before = run.state();
    const outcome = attempt();
    const after = run.state();
    stuck =
      before.x === after.x && before.y === after.y && before.room === after.room ? stuck + 1 : 0;
    assert.ok(stuck < 3, `${label}: no progress (${JSON.stringify(outcome)})`);
    alive(run);
    if (outcome.status === "reached") return;
    if (outcome.status === "needs_input") {
      run.dismiss();
      continue;
    }
    assert.ok(
      outcome.status === "blocked" ||
        outcome.status === "budget_exhausted" ||
        outcome.status === "movement_control_unavailable",
      `${label}: ${JSON.stringify(outcome)}`,
    );
    run.direction(0);
    run.advance(6);
    run.wait(() => egoOnScreen(run), `${label}: moving again`, 600);
  }
  assert.fail(`${label}: too many interruptions`);
}

/** Planned walk onto a spot whose room logic switches rooms (doors, stairs). */
function enter(run: Speedrun, x: number, y: number, room: number): void {
  enterInto(run, { x0: x, x1: x, y0: y, y1: y }, room);
}

/** As enter(), onto any anchor of the switching box (two-pixel strides miss odd spots). */
function enterInto(run: Speedrun, target: Target, room: number): void {
  retry(run, `enter room ${room}`, () =>
    run.state().room === room
      ? ({ status: "reached" } as TraversalOutcome)
      : run.traverse({
          passage: { kind: "position", planned: true, target },
          expectedRoom: room,
          passageOptions: { avoidTriggers: false, geometry: "current" },
          landing: { label: `enter room ${room}`, test: (e) => e.vars[0] === room },
        }),
  );
}

/** Planned walk off one screen edge into the expected neighbour. */
function leave(
  run: Speedrun,
  direction: "N" | "E" | "S" | "W",
  room: number,
  avoidTriggers = false,
): void {
  const dir = { N: 1, E: 3, S: 5, W: 7 }[direction];
  retry(run, `leave for room ${room}`, () =>
    run.state().room === room
      ? ({ status: "reached" } as TraversalOutcome)
      : run.traverse(
          {
            passage: { kind: "exit", direction: dir, room, planned: true },
            passageOptions: { avoidTriggers, geometry: "current", maxSearchNodes: 241920 },
            landing: { label: `room ${room}`, test: (e) => e.vars[0] === room },
          },
          { budgets: { hostPolls: 10000, movementUpdates: 1000 } },
        ),
  );
}

/** Bank corner south to Front Street, then east past the park lawns to the house. */
function frontStreetToHouse(run: Speedrun): void {
  leave(run, "S", 9);
  // Front Street runs along the bottom of these screens; the lawns above it
  // cost points, so get down to the street before crossing each screen.
  walk(run, 150, 150);
  leave(run, "E", 5);
  walk(run, 150, 150);
  leave(run, "E", 4);
}

/** One screen west along Front Street, below the wagon lane and the lawns. */
function frontStreetWest(run: Speedrun, room: number): void {
  walk(run, 8, 156);
  leave(run, "W", room);
}

/** Steer toward a moving animal, re-aiming every cycle, until `close` holds. */
function chase(run: Speedrun, object: number, close: () => boolean, max: number): boolean {
  const ego = run.engine.screenObjects[0]!;
  const target = run.engine.screenObjects[object]!;
  for (let n = 0; n < max && !close(); n++) {
    if (run.engine.modalKind !== null) run.dismiss();
    const dx = Math.sign(target.x + (target.width >> 1) - (ego.x + (ego.width >> 1)));
    const dy = Math.sign(target.y - ego.y);
    const dir = [
      [8, 1, 2],
      [7, 0, 3],
      [6, 5, 4],
    ][dy + 1]![dx + 1]!;
    if (dir === 0) break;
    run.direction(dir);
    run.advance(1);
  }
  run.direction(0);
  return close();
}

/** Walk up to a strayed mule until it is back within rope's length (v123 < 17). */
function catchMule(run: Speedrun): void {
  const mule = run.engine.screenObjects[22]!;
  const near = (): boolean => run.engine.vars[123]! < 17;
  for (let n = 0; !near(); n++) {
    assert.ok(n < 12, "mule caught");
    // Plan round rocks and trees to wherever it has wandered, then close in.
    const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
    walkInto(
      run,
      {
        x0: clamp(mule.x - 12, 0, 150),
        x1: clamp(mule.x + 26, 0, 150),
        y0: clamp(mule.y - 8, 84, 165),
        y1: clamp(mule.y + 8, 84, 165),
      },
      near,
    );
    chase(run, 22, near, 40);
  }
}

/** From the fort's north yard (room 77) round to the trading store counter. */
function yardToStore(run: Speedrun): void {
  enter(run, 42, 88, 86);
  enter(run, 1, 110, 87);
  enter(run, 152, 91, 86);
}

/** Out of the store's side door and back through the passage to the north yard. */
function storeToYard(run: Speedrun): void {
  run.walkDirection("W", () => run.state().room === 87, "out of the trading store", 600);
  enter(run, 152, 110, 86);
  walk(run, 132, 87);
  lastCel(run, 3, "passage door open");
  enter(run, 152, 75, 77);
}

/**
 * Swing the pick at a likely spot and pocket the nugget. The room logic wants
 * Jerrod on the vein's trigger pixels, inside a small box, facing the vein
 * (loop 0 east, loop 1 west): approach the last few pixels from the far side.
 */
function dig(
  run: Speedrun,
  x: number,
  y: number,
  facing: "E" | "W",
  nugget: number,
  label: string,
  approach = 4,
): void {
  const from = facing === "E" ? x - approach : x + approach;
  walk(run, from, y);
  run.walkTo(x, y);
  assert.equal(run.engine.flags[3], 1, `${label}: standing on the vein`);
  const found = run.engine.vars[126]!;
  const score = run.state().score;
  run.command("use pick");
  run.wait(() => run.engine.vars[223] === 0 && run.engine.movementControlEnabled, label, 300);
  assert.equal(run.engine.vars[nugget], 1, `${label}: nugget uncovered`);
  run.command("get gold");
  assert.equal(run.engine.vars[nugget], 2, `${label}: nugget pocketed`);
  assert.equal(run.engine.vars[126], found + 1, `${label}: counted as a find`);
  assert.equal(run.state().score, score + 2, `${label}: two points`);
  alive(run);
}

/** Pocket a loose nugget lying in reach: one find, one point. */
function pocket(run: Speedrun, flag: number, label: string): void {
  const score = run.state().score;
  run.command("get gold");
  assert.equal(run.engine.flags[flag], 1, label);
  assert.equal(run.state().score, score + 1, label);
  alive(run);
}

const MILES_EAST = 111;

/**
 * Walk off a screen edge by planning to the edge strip and pushing through.
 * Wilderness screens wrap onto their own room number, which an exit goal
 * cannot express, so arrival is observed through `arrived`. With a mule in
 * tow, wait for it first: leaving a screen more than 30 units ahead of the
 * animal lets go of its rope for good.
 */
function offEdge(
  run: Speedrun,
  direction: "N" | "E" | "S" | "W",
  arrived: () => boolean,
  label: string,
  lane: readonly [number, number] = [84, 165],
  tow = true,
): void {
  const ego = run.engine.screenObjects[0]!;
  const [x0, x1] = [0, 160 - ego.width];
  const [y0, y1] = lane;
  const target: Target =
    direction === "E"
      ? { x0: 158 - ego.width, x1: 158 - ego.width, y0, y1 }
      : direction === "W"
        ? { x0: 2, x1: 2, y0, y1 }
        : direction === "S"
          ? { x0, x1, y0: 165, y1: 165 }
          : { x0, x1, y0: 84, y1: 84 };
  const mule = tow && (run.carried(48) || run.carried(52));
  for (let n = 0; ; n++) {
    assert.ok(n < 8, `${label}: mule keeps straying`);
    walkInto(run, target, arrived);
    if (!mule || arrived() || run.engine.vars[123]! < 28) break;
    // It fell behind (a rock, a tree) and started to wander: fetch it.
    catchMule(run);
  }
  run.walkDirection(direction, arrived, label, 80);
  alive(run);
}

/** One wilderness mile east or west along the river (same logic, new mile). */
function nextMile(run: Speedrun, direction: "E" | "W"): void {
  const from = run.engine.vars[MILES_EAST]!;
  // Keep wading while panning; otherwise keep to the south bank.
  const lane = run.state().y < 92 ? ([83, 88] as const) : ([95, 160] as const);
  offEdge(run, direction, () => run.engine.vars[MILES_EAST] !== from, `a mile ${direction}`, lane);
}

/**
 * Pan the American River. Each screen yields at most v236 finds per visit
 * (four in the richest stretch, miles 15-23), so step back and forth across
 * the edge between miles 15 and 16. Never pan within 60 units of another
 * miner: claim jumpers hang.
 */
function panForGold(run: Speedrun, finds: number): void {
  const found = (): number => run.engine.vars[126]!;
  for (let visit = 0; found() < finds; visit++) {
    assert.ok(visit < 60, "too many panning visits");
    const e = run.engine;
    const ego = e.screenObjects[0]!;
    const miner = e.readObjects().find((o) => o.num === 1);
    const crowded =
      miner !== undefined && Math.abs(miner.x - ego.x) + Math.abs(miner.y - ego.y) < 90;
    assert.equal(e.vars[236], 4, "richest stretch of river");
    while (!crowded && found() < finds && e.vars[237]! < e.vars[236]!) {
      run.command("pan");
      run.wait(() => e.vars[238] === 0 && e.movementControlEnabled, "pan swirled", 300);
      run.dismiss();
      alive(run);
    }
    if (found() < finds) nextMile(run, e.vars[MILES_EAST] === 15 ? "E" : "W");
  }
}

/** Route under construction: gr1 (3.002.149 profile). */
export function gr1Complete(run: Speedrun): void {
  boot(run);
  // The bridge planks are trigger lines that slide Jerrod diagonally; hold east.
  run.walkDirection("E", () => run.engine.flags[3] === 0 && run.state().x > 40, "off the bridge");
  leave(run, "S", 4);
  run.command("sell house");
  run.walkPath(103, 116);
  // The open gate lifts its conditional barrier only while Jerrod stays on
  // the trigger columns, so walk straight through.
  run.command("unlock gate");
  run.walkTo(103, 111);
  run.walkPath(86, 76);
  run.command("unlock door");
  run.walkDirection("N", () => run.state().room === 25, "into the house", 200);
  run.walkPath({ x0: 78, x1: 94, y0: 145, y1: 163 });
  run.command("look album");
  // The page-turning script shares its done-flag with the photo pickup.
  run.wait(() => run.engine.vars[222] === 12, "album closed", 2000);
  run.take("get photo", 19);
  control(run, "album closed again");
  run.walkPath({ x0: 96, x1: 140, y0: 115, y1: 127 });
  // The statement is wedged in the slats, reachable only with the top rolled shut.
  run.command("close desk");
  run.take("get statement", 15);
  // The statement shows this game's randomly drawn account number.
  run.type("read statement");
  run.key(AGI_KEY.ENTER);
  run.until(() => run.engine.modalKind !== null, 200, "statement shown");
  const account = Number(
    /account number (\d+)/.exec(
      run
        .state()
        .text.replace(/[^\w$ ]+/g, " ")
        .replace(/ +/g, " "),
    )?.[1],
  );
  assert.equal(account, run.engine.vars[48], "account number read off the statement");
  run.dismiss();
  run.checkpoint("Packed the family photo and bank statement", { room: 25, score: 10 });
  enter(run, 40, 165, 4);
  run.walkPath(101, 110);
  run.walkTo(101, 119);
  leave(run, "W", 5);
  // Keep to the street and the footpath: the lawns cost a point per trespass.
  run.walkTo(22, 138);
  run.walkTo(25, 126);
  run.walkDirection("N", () => run.state().y <= 100, "up the gazebo steps", 400);
  run.take("get coin", 20);
  run.take("pick flowers", 21);
  run.checkpoint("Found the gold coin under the gazebo", { room: 5, score: 16 });
  run.walkDirection("S", () => run.state().y >= 127, "down the gazebo steps", 400);
  run.walkTo(20, 138);
  leave(run, "W", 9);
  leave(run, "S", 17);
  // Brooklyn Evening Star: the door swings open from its trigger mat.
  // The room change fires when the door finishes closing behind Jerrod, so
  // he follows the trigger column and leaves it only at the inner doorway.
  walk(run, 53, 100);
  lastCel(run, 1, "office door open");
  run.walkDirection("N", () => run.state().y <= 88, "through the office door", 300);
  run.waitForRoom(27, "newspaper office", 300);
  // The stairwell swallows Jerrod at its foot and walks him out upstairs.
  const stairs = (x: number, y: number, floorY: number): void => {
    const result = run.traverse({
      passage: { kind: "position", planned: true, target: { x0: x, x1: x, y0: y, y1: y } },
      passageOptions: { avoidTriggers: false, geometry: "current" },
      landing: {
        label: "other floor",
        test: (e) => e.vars[220] === 0 && e.screenObjects[0]!.y === floorY,
      },
    });
    assert.equal(result.status, "reached", JSON.stringify(result));
  };
  stairs(90, 93, 47);
  run.walkPath({ x0: 122, x1: 152, y0: 73, y1: 86 });
  run.command("read clippings");
  assert.equal(run.state().score, 19);
  stairs(90, 48, 91);
  run.walkPath({ x0: 1, x1: 31, y0: 138, y1: 166 });
  run.command("quit job");
  run.checkpoint("Quit the Brooklyn Evening Star", { room: 27, score: 21 });
  leave(run, "S", 17);
  enter(run, 120, 94, 9);
  enter(run, 120, 75, 8);
  enter(run, 36, 107, 22);
  walk(run, 96, 137);
  run.wait(() => run.messages.at(-1)?.includes("How may I help you") === true, "teller", 3000);
  run.answerNumber(account);
  run.command("withdraw money");
  run.waitForFlag(33, "savings withdrawn", 2000);
  control(run, "teller done");
  run.checkpoint("Withdrew the savings from Brooklyn Bank", { room: 22, score: 24 });
  enter(run, 142, 125, 8);
  frontStreetToHouse(run);
  // The buyer paces the pavement and makes his offer at exactly 13 units;
  // standing still in his lane lets the distance close one unit at a time.
  assert.equal(run.engine.vars[49], 2, "buyer is waiting");
  walk(run, 110, 146, () => run.engine.vars[49] === 3);
  run.wait(() => run.engine.vars[49] === 3, "the buyer's offer", 3000);
  run.command("yes");
  assert.equal(run.engine.vars[49], 20, "house sold");
  run.checkpoint("Sold the family house at top price", { room: 4, score: 33 });
  frontStreetWest(run, 5);
  frontStreetWest(run, 9);
  // Post office: same closing-door handover as the newspaper building. The
  // mail only arrives after the fourth minute.
  assert.ok(run.engine.vars[153]! >= 4, "letter has arrived");
  walk(run, 51, 121);
  lastCel(run, 2, "post office door open");
  run.walkDirection("N", () => run.state().y <= 109, "through the post office door", 300);
  run.waitForRoom(24, "post office", 300);
  walk(run, 66, 135);
  run.command("ring bell");
  run.wait(() => run.engine.vars[223] === 3, "postmaster at the counter", 2000);
  run.command("check mail");
  run.wait(() => run.engine.vars[224] === 3, "letter on the counter", 3000);
  run.take("get letter", 25);
  run.command("look at postmark");
  run.command("lift stamp");
  run.assertCarried(16, "gold flake");
  run.command("open letter");
  run.command("read letter");
  run.checkpoint("Collected Jake's letter and its gold flake", { room: 24, score: 40 });
  run.walkToUntil(115, 152, () => run.state().room === 9, "out of the post office", 400);
  enter(run, 120, 75, 8);
  enter(run, 128, 73, 7);
  enter(run, 5, 96, 23);
  run.walkPath({ x0: 108, x1: 128, y0: 146, y1: 160 });
  run.command("read poster");
  // The close-up stays until any key is pressed.
  run.advance(10);
  run.key(AGI_KEY.ENTER);
  run.wait(() => run.engine.inputEnabled, "poster put away", 300);
  assert.equal(run.engine.flags[49], 1, "knows where tickets are sold");
  run.checkpoint("Read the ticket poster in the warehouse", { room: 23, score: 42 });
  leave(run, "E", 7);
  leave(run, "S", 8);
  frontStreetToHouse(run);
  // Stay below the wagon's lane (y 148) on the way to Leonard's corner.
  walk(run, 150, 156);
  leave(run, "E", 3);
  // Leonard only comes out to his gate while Jerrod waits on his pavement.
  walk(run, 12, 138);
  run.wait(() => run.engine.vars[221] === 11, "Leonard at his gate", 6000);
  run.command("buy ticket");
  run.command("yes");
  run.command("panama");
  run.command("yes");
  run.command("pay");
  run.assertCarried(23, "Panama ticket");
  run.checkpoint("Bought passage to California by way of Panama", { room: 3, score: 51 });
  frontStreetWest(run, 4);
  frontStreetWest(run, 5);
  frontStreetWest(run, 9);
  leave(run, "S", 17);
  leave(run, "S", 18);
  leave(run, "E", 19);
  run.walkPath({ x0: 98, x1: 108, y0: 76, y1: 81 });
  run.command("read grave");
  run.walkPath({ x0: 117, x1: 126, y0: 76, y1: 81 });
  run.command("read grave");
  run.command("put flowers on grave");
  run.checkpoint("Laid flowers on the family graves", { room: 19, score: 56 });
  leave(run, "W", 18);
  enter(run, 40, 99, 17);
  leave(run, "W", 16);
  leave(run, "W", 15);
  enter(run, 100, 92, 13);
  enter(run, 110, 80, 28);
  // The shopkeeper serves whoever stands at the counter rail within reach.
  walk(run, 84, 97);
  run.wait(() => run.engine.vars[225] === 1, "shopkeeper's attention", 3000);
  run.take("buy mosquito net", 39);
  run.checkpoint("Bought a mosquito net for the jungle", { room: 28, score: 60 });
  enter(run, 76, 143, 13);
  leave(run, "E", 10);
  leave(run, "E", 8);
  enter(run, 128, 73, 7);
  // Up the gangplank; the Sea Farer sails at the eighteenth minute.
  walk(run, 72, 75);
  assert.equal(run.engine.flags[42], 1, "aboard the Sea Farer");
  run.checkpoint("Boarded the Sea Farer with every Brooklyn point", { room: 7, score: 60 });
  run.wait(() => run.state().room === 53, "the ship leaves Brooklyn", 12000);
  run.checkpoint("Sailed from Brooklyn as the gold rush news broke", { room: 53, score: 60 });
  // The voyage is a chain of narrated scenes. F8 (the game's own toggle)
  // suppresses the travelogue pop-ups; Ctrl-N is its "next scene" key.
  run.waitForRoom(35, "first travel notes", 600);
  run.key(AGI_KEY.F8);
  run.wait(() => run.engine.flags[66] === 1, "travel notes suppressed", 60);
  run.waitForRoom(34, "approaching the isthmus", 3000);
  run.key(CTRL_N);
  run.waitForRoom(51, "up the Chagres by canoe", 600);
  run.waitForRoom(52, "natives on the river bank", 6000);
  run.wait(() => run.engine.vars[225] === 1, "the natives' demand", 3000);
  run.command("yes");
  run.checkpoint("Bought safe passage from the river natives", { room: 52, score: 64 });
  run.waitForRoom(92, "further up the Chagres", 6000);
  run.waitForRoom(93, "the old Spanish road", 6000);
  // Jerrod is drawn only after the mule train has gone ahead.
  run.wait(() => egoOnScreen(run), "on foot in the jungle", 1500);
  run.walkPath({ x0: 90, x1: 112, y0: 96, y1: 110 });
  run.command("talk to man");
  run.assertCarried(26, "Bible");
  run.checkpoint("Given a Bible by the traveller under the tree", { room: 93, score: 71 });
  // Crossing x=111 on the lower road releases the jungle ants and fences
  // Jerrod in; the hanging vine is a few steps further on.
  for (const [x, y] of [
    [32, 129],
    [52, 143],
    [106, 157],
  ] as const)
    walk(run, x, y);
  run.walkToUntil(125, 157, () => run.state().x >= 124, "under the vine", 200);
  assert.ok(run.engine.vars[224]! > 0, "ants are out");
  run.command("jump on vine");
  run.waitForFlag(119, "swinging on the vine", 300);
  run.wait(() => run.engine.vars[221] === 24, "the last ants march off", 3000);
  run.command("let go");
  run.wait(() => run.engine.vars[221] === 0, "back on the road", 300);
  control(run, "down from the vine");
  run.checkpoint("Hung from a vine while the jungle ants passed", { room: 93, score: 75 });
  enter(run, 152, 160, 94);
  // Four overgrown trails cross this screen; the two lower ones hide a
  // sword plant and a boa. The topmost passes the lost Spanish gold disk.
  run.walkPath({ x0: 73, x1: 80, y0: 96, y1: 97 }, { geometry: "current" });
  run.take("get disk", 34);
  run.checkpoint("Picked up the Spanish gold disk on the hidden trail", { room: 94, score: 85 });
  leave(run, "E", 95);
  assert.equal(run.state().score, 90, "fourth-trail bonus");
  // The swamp: every trigger pixel outside the stepping stones is quicksand,
  // so plan around all of them. A crocodile strikes one crossing in five.
  // Only three marked fords may cross a trigger outline, walking due east/west.
  run.walkToUntil(30, 129, () => run.state().x >= 28, "across the west ford", 300);
  alive(run);
  run.walkPath(
    { x0: 130, x1: 132, y0: 134, y1: 136 },
    { avoidTriggers: true, geometry: "current" },
  );
  alive(run);
  run.walkDirection("E", () => run.state().room !== 95, "across the east ford and out", 400);
  alive(run);
  run.checkpoint("Crossed the Panama swamp alive", { score: 100 });
  run.waitForRoom(96, "Panama City harbour", 6000);
  run.key(CTRL_N);
  run.waitForRoom(41, "through the Golden Gate", 6000);
  run.waitForRoom(72, "Sacramento", 6000);
  control(run, "ashore in Sacramento");
  assert.ok(
    run.messages.some((m) => m.includes("100 out of 100")),
    "the game confirms every point so far",
  );
  run.checkpoint("Landed in Sacramento with 100 out of 100", { room: 72, score: 100 });
  // The only stage to Sutter's Fort leaves about a minute after landing.
  run.wait(() => egoOnScreen(run), "on the quay", 600);
  enter(run, 118, 104, 75);
  run.waitForRoom(76, "the stage pulls into the fort", 3000);
  run.wait(() => egoOnScreen(run), "off the stage", 600);
  run.checkpoint("Caught the stage to Sutter's Fort", { room: 76, score: 101 });
  // New Helvetia cemetery: Pa's stone is a template for Jake's punched letter.
  enter(run, 158, 119, 75);
  enter(run, 97, 88, 90);
  run.walkPath({ x0: 78, x1: 90, y0: 60, y1: 67 });
  run.command("read grave");
  run.waitForRoom(91, "close-up of the Wilson stone", 300);
  assert.equal(run.state().score, 103);
  run.command("use letter");
  run.walkTo(41, 111);
  run.wait(() => run.engine.flags[56] === 1, "letter lined up over the stone", 300);
  run.dismiss();
  run.key(AGI_KEY.F8);
  run.waitForRoom(90, "back in the cemetery", 300);
  run.command("read psalm");
  assert.equal(run.engine.flags[112], 1, "Psalm 23 read");
  run.checkpoint("Decoded the tombstone and Psalm clues at Pa's grave", {
    room: 90,
    score: 113,
  });
  leave(run, "W", 75);
  enter(run, 84, 84, 77);
  yardToStore(run);
  walkInto(run, { x0: 4, x1: 20, y0: 80, y1: 90 });
  run.command("buy gold pan");
  run.take("give coin", 47);
  run.checkpoint("Traded the gold coin for a gold pan", { room: 86, score: 114 });
  // Out through the store's side door, around the yard and out of the gate.
  storeToYard(run);
  enter(run, 158, 99, 75);
  // Every wall of the little fort on this map screen is a doorway: go round it.
  run.walkTo(70, 108);
  run.walkTo(120, 108);
  enter(run, 158, 108, 124);
  while (run.engine.vars[MILES_EAST]! < 15) nextMile(run, "E");
  run.checkpoint("Followed the American River fifteen miles upstream", { room: 124, score: 114 });
  walkInto(run, { x0: 120, x1: 150, y0: 84, y1: 88 });
  panForGold(run, 25);
  run.checkpoint("Panned the first twenty-five finds", { room: 124, score: 139 });
  panForGold(run, 50);
  run.checkpoint("Panned out the river: fifty finds", { room: 124, score: 164 });
  // Back down the river with the gold; bandits only work the country south of it.
  walkInto(run, { x0: 100, x1: 150, y0: 100, y1: 125 });
  while (run.state().room === 124) nextMile(run, "W");
  assert.equal(run.state().room, 75);
  enter(run, 87, 102, 76);
  enter(run, 87, 112, 78);
  enter(run, 153, 120, 79);
  // The blacksmith holds Jake's parcel for whoever can prove he is family.
  // The smithy's V-shaped sill only blocks outside the doorway strip.
  walk(run, 102, 104);
  run.walkTo(102, 90);
  run.command("talk to blacksmith");
  run.wait(() => run.engine.vars[221] === 1, "the blacksmith comes over", 1500);
  for (const reply of ["yes", "yes", "wilson", "jerrod", "jake"]) run.command(reply);
  run.waitForItem(49, "branding iron", 300);
  run.dismiss();
  run.checkpoint("Proved the family name and got Jake's branding iron", { room: 79, score: 166 });
  run.walkTo(102, 104);
  enter(run, 152, 130, 80);
  enter(run, 153, 130, 81);
  walkInto(run, { x0: 66, x1: 72, y0: 106, y1: 110 });
  run.command("buy mule");
  run.command("pay gold");
  run.wait(() => run.engine.vars[224] === 4, "a mule is led out of the corral", 3000);
  walkInto(run, { x0: 104, x1: 112, y0: 140, y1: 143 });
  assert.ok(run.engine.vars[123]! <= 15, "within reach of the mule's rope");
  run.take("get mule", 48);
  run.checkpoint("Bought a mule with river gold", { room: 81, score: 169 });
  // Lead the mule back to the forge; it trails a few paces behind.
  enter(run, 1, 130, 80);
  enter(run, 1, 140, 79);
  walk(run, 102, 104);
  run.walkTo(102, 86);
  run.command("heat iron");
  assert.equal(run.engine.flags[226], 1, "iron glowing");
  const mule = run.engine.screenObjects[22]!;
  run.walkToUntil(mule.x + 6, mule.y, () => run.engine.vars[123]! < 15, "next to the mule", 300);
  run.command("brand mule");
  assert.equal(run.engine.flags[74], 1, "mule carries Jake's brand");
  run.checkpoint("Branded the mule with Jake's mark", { room: 79, score: 172 });
  // The mule parks across the doorway. Out of rope's reach it wanders off;
  // step aside until the sill is clear, then go and take its rope again.
  run.walkTo(72, 90);
  run.wait(() => mule.y > 112 || mule.x > 118 || mule.x < 70, "mule wanders off the sill", 1500);
  run.walkTo(100, 93);
  run.walkTo(102, 104);
  catchMule(run);
  enter(run, 1, 130, 78);
  enter(run, 64, 71, 76);
  enter(run, 114, 113, 88);
  run.wait(
    () => run.messages.at(-1)?.includes("take it on in") === true && run.engine.vars[220] === 0,
    "the mule man notes the brand",
    900,
  );
  assert.equal(run.engine.flags[148], 1, "mule registered at the gate");
  enter(run, 80, 166, 89);
  // Stable the branded mule while shopping: the store will not have animals in.
  run.command("leave mule");
  assert.ok(!run.carried(48), "mule left in the corral");
  run.walkToUntil(71, 167, () => run.state().room === 88, "out of the stalls", 400);
  enter(run, 12, 132, 76);
  enter(run, 4, 110, 77);
  yardToStore(run);
  walkInto(run, { x0: 4, x1: 20, y0: 80, y1: 90 });
  run.command("buy shovel");
  run.take("pay gold", 5);
  run.command("buy lantern");
  run.take("pay gold", 40);
  run.checkpoint("Bought a shovel and a lantern with gold", { room: 86, score: 174 });
  storeToYard(run);
  enter(run, 8, 83, 76);
  enter(run, 114, 113, 88);
  run.wait(
    () => run.messages.at(-1)?.includes("look around") === true && run.engine.vars[220] === 0,
    "waved into the corral again",
    900,
  );
  enter(run, 80, 166, 89);
  // Jake left his own mule here: the one wearing the horseshoe-and-key brand
  // (object 1). Take its rope while no other mule is within reach.
  const e = run.engine;
  const dist = (n: number): number => {
    const a = e.screenObjects[0]!;
    const b = e.screenObjects[n]!;
    return Math.abs(a.x + (a.width >> 1) - (b.x + (b.width >> 1))) + Math.abs(a.y - b.y);
  };
  for (let attempt = 0; !run.carried(52); attempt++) {
    assert.ok(attempt < 40, "caught James' mule");
    chase(run, 1, () => dist(1) < 14, 200);
    if (dist(1) < 14 && [2, 3, 4, 5, 6].every((n) => dist(n) > 16)) run.command("get mule");
    else run.advance(10);
  }
  // Leaving the stalls more than 30 units ahead of the mule lets go of it.
  walk(run, 71, 158);
  run.wait(() => dist(1) < 28, "mule catches up at the gate", 600);
  run.walkToUntil(71, 167, () => run.state().room === 88, "out of the stalls", 100);
  assert.ok(run.carried(52), "James' mule in tow");
  enter(run, 12, 132, 76);
  run.checkpoint("Led Jake's own mule out of the fort corral", { room: 76, score: 181 });
  // East again with the mule, past the diggings to the sawmill town of Coloma.
  enter(run, 153, 119, 75);
  enter(run, 158, 100, 124);
  while (run.state().room === 124) nextMile(run, "E");
  assert.equal(run.state().room, 181);
  assert.ok(run.carried(52), "mule still in tow");
  const town = (
    direction: "N" | "E" | "S" | "W",
    room: number,
    lane?: readonly [number, number],
  ): void =>
    offEdge(run, direction, () => run.state().room === room, `Coloma: on to room ${room}`, lane);
  town("E", 182);
  town("E", 183);
  town("E", 184);
  town("S", 187);
  // The mule follows in a straight line, so lead it clear of the hotel fence
  // before turning east along Back Street.
  walk(run, 10, 140);
  town("E", 136, [134, 160]);
  assert.ok(run.carried(52), "mule reached the hotel");
  run.checkpoint("Reached the Green Pastures Hotel in Coloma", { room: 136, score: 181 });
  // Hitch the mule: it must stand inside the post's box when the rope is tied.
  // It follows only within rope's length (logic 61: 17..30 units) and wanders
  // beyond that, so fetch it back whenever a blocked follow lets it stray.
  const hitched = (): boolean => {
    const m = run.engine.screenObjects[22]!;
    return m.x >= 17 && m.x <= 62 && m.y >= 146 && m.y <= 162;
  };
  // The post is a small block at x33..36, y143..148 and a fence line runs
  // along y154..157 from x28 east, so lead the mule straight south past the
  // fence's end, then east along the yard below it, in short legs that let
  // it close up each time; the post's box reaches down to y162.
  const closeUp = (): void => {
    for (let t = 0; t < 400 && run.engine.vars[123]! >= 17 && !hitched(); t++) run.advance();
    if (run.engine.vars[123]! > 30) catchMule(run);
  };
  for (const [x, y] of [
    [6, 163],
    [24, 164],
    [44, 163],
  ] as const) {
    walk(run, x, y);
    closeUp();
  }
  for (let attempt = 0; !hitched(); attempt++) {
    assert.ok(attempt < 6, "mule led to the hitching post");
    catchMule(run);
    walk(run, 44, 163);
    closeUp();
  }
  run.command("tie mule");
  assert.equal(run.engine.flags[105], 1, "James' mule hitched");
  enter(run, 76, 122, 137);
  walkInto(run, { x0: 40, x1: 80, y0: 120, y1: 138 });
  run.command("check message");
  run.take("yes", 18);
  control(run, "clerk hands over the note");
  // The staircase rail is a trigger line that carries a westward walk upstairs.
  walkInto(run, { x0: 96, x1: 100, y0: 84, y1: 86 });
  run.walkDirection("W", () => run.state().room === 139, "up the hotel stairs", 600);
  enterInto(run, { x0: 1, x1: 2, y0: 68, y1: 86 }, 138);
  walkInto(run, { x0: 110, x1: 114, y0: 69, y1: 71 });
  run.command("knock on door");
  run.wait(() => run.engine.vars[223] === 4, "the lodger answers the door", 900);
  run.command("give message");
  assert.equal(run.state().score, 184);
  // He storms out along the hallway: stand clear, then slip in behind him.
  walkInto(run, { x0: 80, x1: 96, y0: 78, y1: 84 });
  run.wait(
    () => run.engine.vars[223] === 0 && run.engine.flags[31] === 1,
    "the lodger leaves",
    900,
  );
  run.checkpoint("Lured the lodger out of the room next door", { room: 138, score: 184 });
  enterInto(run, { x0: 114, x1: 118, y0: 64, y1: 65 }, 11);
  // The mantel cannon from Pa's tombstone: its wheel winches up the fireback.
  walkInto(run, { x0: 100, x1: 104, y0: 124, y1: 133 });
  run.command("turn wheel");
  assert.equal(run.state().score, 189);
  run.command("enter fireplace");
  run.waitForRoom(12, "through the fireplace", 100);
  run.checkpoint("Crawled through the fireplace into the walled-up room", {
    room: 12,
    score: 189,
  });
  walkInto(run, { x0: 72, x1: 100, y0: 126, y1: 142 });
  run.take("get note", 55);
  run.take("get magnet", 53);
  walkInto(run, { x0: 45, x1: 55, y0: 152, y1: 164 });
  run.take("get string", 28);
  walkInto(run, { x0: 72, x1: 83, y0: 97, y1: 101 });
  run.command("unlatch window");
  run.command("open window");
  assert.equal(run.engine.flags[73], 1, "window open for the pigeon");
  run.checkpoint("Found Jake's note, magnet and string in the secret room", {
    room: 12,
    score: 192,
  });
  // The carrier pigeon comes by about every hundred seconds and perches in
  // its cage only if the window is open (v222 5/6 = perched).
  const perched = (): boolean => run.engine.vars[222] === 5 || run.engine.vars[222] === 6;
  walkInto(run, { x0: 54, x1: 64, y0: 104, y1: 104 });
  run.wait(perched, "pigeon settles in the cage", 3000);
  run.command("put photo in capsule");
  assert.equal(run.engine.vars[144], 1, "photo on its way to Jake");
  run.checkpoint("Sent the family photo off by carrier pigeon", { room: 12, score: 195 });
  run.wait(() => run.engine.vars[144] === 2 && perched(), "pigeon returns with an answer", 6000);
  run.take("get aerogram", 58);
  run.command("read aerogram");
  run.checkpoint("Read Jake's aerogram: follow the stubborn mule", { room: 12, score: 196 });
  // The lodger is back next door, so leave along the window ledge instead.
  walkInto(run, { x0: 72, x1: 83, y0: 97, y1: 101 });
  run.command("climb through window");
  run.waitForRoom(242, "out on the ledge", 100);
  // A lodger keeps leaning out of the next window and shoves anyone he
  // catches in front of it. Sidle up, wait until he has just ducked back in
  // with a long pause ahead (v225), then cross his sill in one go.
  run.walkTo(58, 95);
  run.wait(() => run.engine.vars[224] === 0 && run.engine.vars[225]! >= 24, "window clear", 900);
  run.walkTo(30, 95);
  alive(run);
  run.walkToUntil(4, 95, () => run.state().room === 136, "along the ledge to the balcony", 200);
  alive(run);
  run.checkpoint("Sidled along the hotel ledge to the balcony", { room: 136, score: 196 });
  enterInto(run, { x0: 33, x1: 46, y0: 81, y1: 82 }, 139);
  enterInto(run, { x0: 54, x1: 62, y0: 65, y1: 66 }, 137);
  run.walkDirection("SE", () => run.state().y >= 90, "down the hotel stairs", 600);
  enterInto(run, { x0: 60, x1: 120, y0: 165, y1: 166 }, 136);
  walkInto(run, { x0: 24, x1: 34, y0: 151, y1: 154 });
  run.command("untie mule");
  assert.ok(run.carried(52), "mule untied");
  // "Follow that mule" only works clear of town: three screens south.
  const MILES_SOUTH = 112;
  for (const miles of [2, 3, 4]) {
    offEdge(
      run,
      "S",
      () => run.engine.vars[MILES_SOUTH] === miles,
      `south to mile ${miles}`,
      [100, 160],
    );
    assert.ok(run.carried(52), "mule still in tow");
  }
  assert.equal(run.state().room, 123);
  // Jake's aerogram: his stubborn mule knows the way home. Let it lead, and
  // leave each screen by the same edge it did (v142) before it gets away.
  run.command("follow mule");
  assert.ok(run.engine.vars[143]! > 0, "mule let loose to lead");
  const EDGE: Record<number, "N" | "E" | "S" | "W"> = { 1: "N", 2: "E", 3: "S", 4: "W" };
  for (let screens = 0; run.state().room !== 244; screens++) {
    assert.ok(screens < 20, "mule leads somewhere");
    // It walks the screen's centre lines (x 79-98, y 114); keep out of its way.
    if (run.engine.vars[142] === 0) walkInto(run, { x0: 112, x1: 124, y0: 134, y1: 146 });
    run.wait(() => run.engine.vars[142] !== 0, "mule picks its way off the screen", 3000);
    const east = run.engine.vars[MILES_EAST]!;
    const south = run.engine.vars[MILES_SOUTH]!;
    offEdge(
      run,
      EDGE[run.engine.vars[142]!]!,
      () =>
        run.state().room === 244 ||
        run.engine.vars[MILES_EAST] !== east ||
        run.engine.vars[MILES_SOUTH] !== south,
      "after the mule",
      [84, 165],
      false,
    );
    if (run.state().room !== 244) assert.ok(run.carried(52), "still on the mule's tail");
    if (screens === 0) assert.equal(run.state().score, 203, "trusting the mule pays");
  }
  run.checkpoint("Followed Jake's mule to his hidden cabin", { room: 244, score: 203 });
  enterInto(run, { x0: 58, x1: 61, y0: 108, y1: 108 }, 145);
  walkInto(run, { x0: 86, x1: 116, y0: 144, y1: 162 });
  run.take("get matches", 57);
  enterInto(run, { x0: 60, x1: 90, y0: 165, y1: 166 }, 244);
  // The outhouse path starts at the bottom-left of the clearing.
  // Leaving the cabin arms a rule that bounces Jerrod off the yard's trigger
  // fence; the gap at the fence's west end disarms it.
  // West of x=92 Jerrod is drawn large and strides two pixels, so line up
  // on the gap's row (y 145) beforehand.
  walkInto(run, { x0: 100, x1: 100, y0: 145, y1: 145 }, undefined, true);
  run.walkDirection("W", () => run.engine.flags[220] === 0, "through the gap in the fence", 100);
  for (const [x, y] of [
    [69, 147],
    [43, 147],
    [29, 149],
    [25, 151],
  ] as const)
    walk(run, x, y);
  assert.equal(run.engine.flags[221], 1, "on the outhouse path");
  enterInto(run, { x0: 134, x1: 135, y0: 117, y1: 120 }, 146);
  run.command("go down hole");
  run.wait(() => run.engine.vars[222] === 3, "second thoughts on the seat", 600);
  run.command("yes");
  run.waitForRoom(147, "down the outhouse shaft", 600);
  run.checkpoint("Climbed down the shaft under Jake's outhouse", { room: 147, score: 207 });
  run.command("light lantern");
  assert.equal(run.engine.flags[111], 1, "lantern lit");
  enterInto(run, { x0: 1, x1: 1, y0: 120, y1: 167 }, 148);
  // A double-locked door with a branding-iron-shaped hole: fish the key out
  // from the far side with Jake's magnet on its string.
  walkInto(run, { x0: 2, x1: 7, y0: 112, y1: 122 });
  run.command("tie string to magnet");
  run.command("put magnet in hole");
  run.command("lower magnet");
  run.take("raise magnet", 51);
  run.command("unlock door");
  assert.equal(run.engine.flags[139], 1, "mine door unlocked");
  run.checkpoint("Fished the steel key through the mine door and unlocked it", {
    room: 148,
    score: 216,
  });
  enterInto(run, { x0: 2, x1: 6, y0: 110, y1: 110 }, 149);
  // Ladders: walk onto the rungs, then climb with plain up/down. Any sideways
  // drift on a ladder trips its edge triggers and is a fatal fall.
  run.walkDirection("W", () => run.engine.flags[238] === 1, "onto the ladder", 100);
  run.walkDirection("S", () => run.state().room === 151, "down the first ladder", 300);
  alive(run);
  run.walkDirection("S", () => run.engine.flags[238] === 0, "off the foot of the ladder", 300);
  alive(run);
  enterInto(run, { x0: 1, x1: 1, y0: 120, y1: 167 }, 154);
  // The long ladder: step on from the ledge at its rung line (y 147-153);
  // the floor just below that beside the ladder is a drop.
  walk(run, 84, 150);
  run.walkDirection("W", () => run.engine.flags[238] === 1, "onto the long ladder", 100);
  run.walkDirection("S", () => run.state().room === 155, "down the long ladder", 300);
  run.walkDirection("S", () => run.state().room === 156, "down the shaft", 300);
  run.walkDirection("S", () => run.engine.flags[238] === 0, "off the ladder", 300);
  alive(run);
  walkInto(run, { x0: 80, x1: 91, y0: 141, y1: 149 });
  run.take("get pick", 46);
  run.checkpoint("Found Jake's pick at the bottom of the shaft", { room: 156, score: 217 });
  dig(run, 85, 120, "E", 132, "vein by the pick chamber");
  // Back up both ladders to the ledge in the long-ladder cavern.
  walkInto(run, { x0: 56, x1: 63, y0: 117, y1: 117 }, () => run.engine.flags[238] === 1);
  run.walkDirection("N", () => run.state().room === 155, "up to the shaft", 300);
  run.walkDirection("N", () => run.state().room === 154, "up the shaft", 300);
  run.walkDirection("N", () => run.state().y <= 151, "up to the ledge's rung", 300);
  run.walkDirection("E", () => run.engine.flags[238] === 0, "off onto the ledge", 100);
  alive(run);
  dig(run, 84, 147, "E", 133, "vein on the ladder ledge");
  enterInto(run, { x0: 130, x1: 130, y0: 140, y1: 167 }, 151);
  dig(run, 22, 145, "W", 131, "vein below the first ladder");
  run.checkpoint("Struck the first gold veins with Jake's pick", { room: 151, score: 223 });
  enterInto(run, { x0: 130, x1: 130, y0: 100, y1: 167 }, 152);
  // East gallery: the floor in front of the ladder head (x 39-64, y 115-118)
  // is a hole, so keep to the wall on the way to the vein.
  walk(run, 30, 110);
  run.walkTo(52, 110);
  alive(run);
  dig(run, 56, 110, "E", 130, "vein in the east gallery");
  run.walkTo(30, 110);
  enterInto(run, { x0: 1, x1: 1, y0: 100, y1: 125 }, 151);
  enterInto(run, { x0: 1, x1: 1, y0: 120, y1: 167 }, 154);
  // Up the long ladder to the higher ledge on its west side.
  walk(run, 84, 150);
  run.walkDirection("W", () => run.engine.flags[238] === 1, "onto the long ladder", 100);
  // A nugget glints in the wall beside the upper rungs: lean over for it.
  run.walkDirection("N", () => run.state().y <= 80, "up past the west ledge", 300);
  run.walkDirection("E", () => run.state().x >= 62, "lean out to the nugget", 20);
  pocket(run, 130, "nugget beside the long ladder");
  run.walkDirection("W", () => run.state().x <= 59, "back onto the rungs", 20);
  run.walkDirection("S", () => run.state().y >= 100, "down to the west ledge", 300);
  run.walkDirection("W", () => run.engine.flags[238] === 0, "off onto the west ledge", 100);
  alive(run);
  enterInto(run, { x0: 1, x1: 1, y0: 100, y1: 125 }, 157);
  walkInto(run, { x0: 58, x1: 74, y0: 85, y1: 90 });
  pocket(run, 131, "nugget high in the sloping gallery");
  dig(run, 10, 112, "E", 134, "vein in the sloping gallery");
  enterInto(run, { x0: 1, x1: 1, y0: 100, y1: 130 }, 158);
  dig(run, 88, 102, "E", 135, "vein above the pit cavern");
  // The ladder hole (x 33-42, y 116-118) opens straight off the path: cross
  // above it and only approach the ladder from its west side.
  walk(run, 20, 111);
  alive(run);
  enterInto(run, { x0: 1, x1: 1, y0: 117, y1: 133 }, 159);
  // Loose nuggets lie in the open in the dead-end gallery.
  walkInto(run, { x0: 78, x1: 94, y0: 118, y1: 127 });
  run.command("get gold");
  assert.equal(run.engine.flags[132], 1, "loose nuggets pocketed");
  run.checkpoint("Scooped up the loose nuggets in the far gallery", { room: 159, score: 232 });
  enterInto(run, { x0: 130, x1: 130, y0: 110, y1: 140 }, 158);
  // Round to the west side of the ladder hole and climb down.
  walkInto(run, { x0: 14, x1: 22, y0: 117, y1: 117 });
  run.walkDirection("E", () => run.engine.flags[238] === 1, "onto the pit ladder", 100);
  run.walkDirection("S", () => run.state().room === 160, "down the pit ladder", 400);
  run.walkDirection("S", () => run.engine.flags[238] === 0, "off onto the middle ledge", 300);
  alive(run);
  pocket(run, 133, "nugget on the middle ledge");
  // The ledge's south edge (x 38-61, y 110-118) is a sheer drop.
  run.walkTo(48, 107);
  dig(run, 52, 107, "E", 136, "vein on the middle ledge");
  run.walkTo(64, 107);
  run.walkDirection("S", () => run.engine.flags[238] === 1, "onto the lower ladder", 100);
  // The rungs sit a touch left of where Jerrod lands on them.
  run.walkDirection("W", () => run.state().x <= 50, "centre on the lower ladder", 20);
  run.walkDirection("S", () => run.state().room === 161, "down the lower ladder", 300);
  run.walkDirection(
    "S",
    () => run.engine.flags[238] === 0,
    "off the ladder in Jake's diggings",
    300,
  );
  alive(run);
  // Jake has been busy here: two loose nuggets lie about, and two more veins.
  pocket(run, 134, "nugget at the foot of the ladder");
  dig(run, 98, 112, "E", 137, "vein up the east slope", 2);
  walkInto(run, { x0: 40, x1: 46, y0: 118, y1: 124 });
  pocket(run, 135, "nugget by the old timbers");
  dig(run, 18, 142, "W", 138, "vein in the lower west corner");
  run.checkpoint("Cleaned out the gold around Jake's diggings", { room: 161, score: 241 });
  enterInto(run, { x0: 1, x1: 1, y0: 138, y1: 153 }, 162);
  control(run, "the brothers' reunion");
  run.checkpoint("Found brother Jake at the end of his mine", { room: 162, score: 241 });
  // Two nuggets already glitter on the wall; three more come loose under the
  // pick. After that every swing widens a hole into a cavern beyond.
  walk(run, 38, 124);
  run.walkTo(42, 124);
  pocket(run, 136, "first wall nugget");
  pocket(run, 137, "second wall nugget");
  const swing = (label: string): void => {
    assert.equal(run.engine.flags[3], 1, `${label}: on the vein`);
    run.command("use pick");
    run.wait(() => run.engine.vars[223] === 0 && run.engine.movementControlEnabled, label, 400);
    run.dismiss();
  };
  for (const nugget of [139, 140, 141]) {
    const score = run.state().score;
    swing(`uncovering nugget v${nugget}`);
    assert.equal(run.engine.vars[nugget], 1);
    run.command("get gold");
    assert.equal(run.engine.vars[nugget], 2);
    assert.equal(run.state().score, score + 2);
  }
  assert.equal(run.engine.vars[126], 70, "every one of the game's seventy gold finds");
  run.checkpoint("Picked the last of the seventy gold finds", { room: 162, score: 249 });
  for (let size = 1; size <= 4; size++) {
    swing(`widening the hole (${size})`);
    assert.equal(run.engine.vars[129], size, "hole grows");
  }
  run.command("enter hole");
  run.waitForRoom(193, "through the hole into the cavern", 200);
  run.checkpoint("Broke through into the cavern of gold", { room: 193, score: 249 });
  // The brothers' celebration plays out by itself and ends on the thank-you card.
  run.wait(() => run.engine.vars[225] === 34, "ending sequence", 6000);
  run.dismiss();
  alive(run);
  run.checkpoint("Struck it rich with Jake: the mother lode and the full 255 points", {
    room: 193,
    score: 255,
  });
}

export const gr1Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.GR1,
  alias: "gr1",
  label: "struck the mother lode with Jake via Panama with the maximum 255 points",
  coverage: "complete-game",
  // Seed 1 rolls a safe swamp crossing (the crocodile takes one in five), a
  // prompt shopkeeper and ticket agent, and rich early pans on the river.
  seed: 1,
  route: gr1Complete,
  expected: {
    room: 193,
    score: 255,
    // v7: the Panama ticket raises the maximum to 255; v40: Panama route;
    // v126: all seventy gold finds; v225: the ending script's final state.
    vars: { 7: 255, 40: 2, 126: 70, 225: 34 },
    flags: { [DEAD]: 0, 112: 1, 117: 1 },
    carriedExactly: [5, 16, 17, 25, 26, 28, 34, 40, 46, 47, 49, 50, 51, 53, 55, 57, 58],
    inputEnabled: false,
  },
  requiresAnswer: true,
};
