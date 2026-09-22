import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

/**
 * Donald Duck's Playground has no story ending: Donald earns money in four
 * jobs, spends it in three toy stores and arranges the toys in the park. The
 * chapter proven here is one full turn of that loop on the beginner level:
 * choose the level, work a one-minute shift at the produce market, collect
 * the pay, buy the Old Box from Goofy with exact change and move the
 * delivered box to a new spot in the playground.
 *
 * Every number below comes from the LOGIC resources: logic 0 maps the keys,
 * logic 3 the level doorways, logic 22 the produce market, logic 32 the shift
 * clock, logic 25 the pay window, logic 11 Goofy's store, logic 14 the cash
 * register and logic 16 the playground corner that holds the box.
 */

/** "Do Something": logic 28 binds x to controller 6, which logic 0 turns into f110. */
const DO = "x".charCodeAt(0);
/** "Use Something": z is controller 4, f111. */
const USE = "z".charCodeAt(0);

const ROOM = {
  title: 1,
  levels: 3,
  stores: 6,
  jobs: 7,
  goofy: 11,
  register: 14,
  boxCorner: 16,
  playground: 17,
  park: 19,
  market: 22,
  pay: 25,
} as const;

const VAR = {
  carriedProduce: 43,
  level: 115,
  phase: 116,
  boxX: 123,
  boxY: 124,
} as const;

/** Inventory object 4 is the Old Box (logic 33 message 24, logic 16 view 124). */
const OLD_BOX = 4;

/** Wallet counters shared by the pay window and the register (logics 25, 14, 34). */
const WALLET = {
  tens: 191,
  fives: 192,
  ones: 193,
  quarters: 194,
  dimes: 195,
  nickels: 196,
  pennies: 197,
};

function cents(run: Speedrun, dollarsTens: number): number {
  const v = run.engine.vars;
  return (
    (v[dollarsTens]! * 10 + v[dollarsTens + 1]!) * 100 +
    v[dollarsTens + 2]! * 10 +
    v[dollarsTens + 3]!
  );
}

function walletCents(run: Speedrun): number {
  const v = run.engine.vars;
  return (
    v[WALLET.tens]! * 1000 +
    v[WALLET.fives]! * 500 +
    v[WALLET.ones]! * 100 +
    v[WALLET.quarters]! * 25 +
    v[WALLET.dimes]! * 10 +
    v[WALLET.nickels]! * 5 +
    v[WALLET.pennies]!
  );
}

/** Hold left/right until Donald's x is within one step of the goal. */
function steer(run: Speedrun, goal: number, step: number): boolean {
  const x = run.engine.screenObjects[0]!.x;
  if (x + step <= goal) run.direction("E");
  else if (x - step >= goal) run.direction("W");
  else {
    run.direction(0);
    return true;
  }
  return false;
}

function chooseBeginner(run: Speedrun): void {
  run.until(() => run.state().room === ROOM.title && run.cycles > 1, 200, "title screen");
  run.checkpoint("Title parade", { room: ROOM.title, score: 0 });
  // The first key starts the parade, the second leaves it (logic 1, v40).
  run.key(AGI_KEY.ENTER);
  run.until(() => run.engine.vars[40] === 2, 200, "parade started");
  run.key(AGI_KEY.ENTER);
  run.until(() => run.state().room === ROOM.levels, 200, "Duckburg gate");
  run.dismiss();
  // The gate's trigger line is row 144; logic 3 latches the level from the x
  // where Donald last touched it: below 53 is beginner. Reach the left arch
  // along the bottom edge so the middle arch is never crossed.
  run.walkTo(36, 160);
  run.walkDirection("N", () => run.state().room === ROOM.jobs, "through the beginner arch");
  assert.equal(run.engine.vars[VAR.level], 0, "beginner level selected");
  run.checkpoint("Chose the beginner arch", { room: ROOM.jobs, score: 0 });
}

function workProduceShift(run: Speedrun): void {
  const e = run.engine;
  // The market door is the trigger column at x 87 inside logic 7's posn box.
  run.walkPath({ x0: 74, x1: 80, y0: 73, y1: 79 });
  run.walkDirection("E", () => run.state().room === ROOM.market, "into the produce market");
  // Logic 32: holding down lowers the shift from two minutes to one.
  run.direction("S");
  run.until(() => e.vars[31] === 1, 600, "one-minute shift selected");
  run.direction(0);
  run.key(DO);
  run.until(() => e.vars[VAR.phase] === 9, 200, "shift clock running");
  run.checkpoint("Clocked in at the produce market", { room: ROOM.market, score: 0 });

  const ego = e.screenObjects[0]!;
  const produce = e.screenObjects[5]!;
  // Logic 22: v42 is the lane, landing at these x; v40 the kind in flight;
  // v43 the kind in hand. Bins: kind 1 x 1..24, kind 2 x 25..54, kind 3 x 55..82.
  const laneX = [0, 1, 27, 51, 75];
  const binX = [0, 9, 36, 63];
  const milestones: Record<number, string> = {
    4: "Sorted the fourth crate",
    8: "Sorted the eighth crate",
    12: "Sorted the twelfth crate",
  };
  let marked = 0;
  while (e.vars[VAR.phase] === 9) {
    const earned = cents(run, 159);
    const milestone = milestones[earned];
    if (milestone !== undefined && earned > marked) {
      marked = earned;
      run.checkpoint(milestone, { room: ROOM.market, score: 0 });
    }
    assert.equal(e.flags[30], 0, "no produce was dropped on the floor");
    const held = e.vars[VAR.carriedProduce]!;
    // Fourteen cents pay out as a dime and four pennies, and a penny is the
    // exact price of the Old Box; a fifteenth crate would turn the pennies
    // into a nickel (logic 25), so Donald simply holds on to it.
    if (held > 0 && cents(run, 159) >= 14) steer(run, 36, 3);
    else if (held > 0) {
      const vx = e.vars[98]!;
      const inBin =
        held === 1 ? vx > 0 && vx < 25 : held === 2 ? vx > 24 && vx < 55 : vx > 54 && vx < 83;
      if (inBin) {
        run.direction(0);
        run.key(DO);
        run.until(() => e.vars[VAR.carriedProduce] === 0, 100, "produce released over its bin");
        continue;
      }
      steer(run, binX[held]!, 3);
    } else if (e.vars[40]! > 0 && e.vars[42]! > 0) {
      const lane = laneX[e.vars[42]!]!;
      const goal = lane + (produce.width >> 1) - (ego.width >> 1);
      steer(run, Math.min(72, Math.max(0, goal)), 3);
    } else steer(run, 36, 3);
    run.advance();
  }
  run.direction(0);
  // Beginner pay is one cent per correctly sorted crate (v121 in logic 22).
  assert.equal(cents(run, 159), 14, "earned fourteen cents");
  run.checkpoint("Shift whistle blew", { room: ROOM.market, score: 0 });
}

function collectPay(run: Speedrun): void {
  const e = run.engine;
  // Logic 32 phase 7: the whistle has blown and any key leaves for the pay window.
  run.key(DO);
  run.until(() => run.state().room === ROOM.pay, 200, "pay window");
  // Logic 34 walks each coin from the counter into the wallet, then sets phase 7.
  run.until(() => e.vars[VAR.phase] === 7, 4000, "pay moved into the wallet");
  assert.equal(walletCents(run), 14, "wallet holds the pay");
  assert.equal(e.vars[WALLET.dimes], 1);
  assert.equal(e.vars[WALLET.pennies], 4);
  assert.equal(cents(run, 141), 14, "money total matches the wallet");
  run.checkpoint("Collected fourteen cents of pay", { room: ROOM.pay, score: 0 });
  run.key(DO);
  run.until(() => run.state().room === ROOM.jobs, 200, "back on the job street");
}

function buyOldBox(run: Speedrun): void {
  // The job street's left edge leads to the store street (logic 7, v2 == 4).
  run.exit("W", ROOM.stores);
  run.checkpoint("Crossed over to the toy stores", { room: ROOM.stores, score: 0 });
  // Goofy's door is the trigger column at x 70 between rows 60 and 72,
  // reached from the east because x 68 is a blocking line.
  run.walkPath({ x0: 76, x1: 84, y0: 64, y1: 68 });
  run.walkDirection("W", () => run.state().room === ROOM.goofy, "into Goofy's store");
  const e = run.engine;
  // Logic 11 sets the beginner price of toy 4 to $0.01 (v176, v182, v188).
  run.walkPath({ x0: 34, x1: 50, y0: 102, y1: 113 });
  assert.equal(e.vars[117], 24, "standing at the Old Box");
  assert.deepEqual([e.vars[166], e.vars[167], e.vars[168]], [0, 0, 1], "the box costs one cent");
  run.key(DO);
  run.until(() => run.carried(OLD_BOX), 100, "Old Box taken from the shelf");
  run.checkpoint("Picked the Old Box off Goofy's shelf", { room: ROOM.goofy, score: 0 });
  run.walkPath({ x0: 50, x1: 95, y0: 145, y1: 165 });
  assert.equal(e.vars[117], 101, "standing at Goofy's counter");
  run.key(DO);
  run.until(() => run.state().room === ROOM.register, 100, "cash register");
  assert.equal(cents(run, 147), 1, "one cent owed");
  run.checkpoint("Stepped up to the cash register", { room: ROOM.register, score: 0 });

  // Logic 14: the arrow picks a coin from the wallet row (pennies at x 97..105
  // below row 86), and a second press above row 86 lays it on the counter.
  run.until(() => run.state().modal !== null, 100, "asked to pay");
  run.dismiss();
  run.walkTo(100, 140);
  assert.equal(e.vars[117], 1, "arrow over the wallet pennies");
  run.key(DO);
  run.until(() => e.vars[118] === 1, 100, "penny in hand");
  run.walkTo(100, 80);
  run.key(DO);
  run.until(() => e.vars[201] === 1 && e.vars[VAR.phase] === 1, 400, "penny on the counter");
  run.dismiss();
  assert.equal(cents(run, 153), 1, "one cent paid");
  // With the amount paid, the register's T key (x 109..159, y 19..81) totals the sale.
  run.walkTo(125, 70);
  assert.equal(e.vars[117], 31, "arrow over the Total key");
  run.key(DO);
  // An exact payment skips change making: phase 7 and "will be delivered".
  run.until(() => e.vars[VAR.phase] === 7, 400, "sale completed");
  run.dismiss();
  assert.equal(e.vars[WALLET.pennies], 3, "one penny spent");
  assert.equal(cents(run, 141), 13, "thirteen cents left");
  assert.ok(run.carried(OLD_BOX), "Old Box bought");
  run.checkpoint("Paid Goofy one penny for the Old Box", { room: ROOM.register, score: 0 });
  run.key(DO);
  run.until(() => run.state().room === ROOM.stores, 100, "back on the store street");
}

function placeBoxInPlayground(run: Speedrun): void {
  // The park gate is the trigger column at x 97, rows 48..59, again entered from the east.
  run.walkPath({ x0: 102, x1: 110, y0: 52, y1: 56 });
  run.walkDirection("W", () => run.state().room === ROOM.park, "into the park");
  const e = run.engine;
  // Logic 19: touching the crossing line at row 125 makes Donald look both
  // ways and walk himself over the tracks (f40 until the move completes).
  run.walkPath({ x0: 62, x1: 70, y0: 130, y1: 136 });
  run.walkDirection("N", () => e.flags[40] !== 0, "railway crossing reached");
  run.until(() => e.flags[40] === 0 && run.state().control, 1500, "crossed the tracks");
  run.checkpoint("Crossed the park railway", { room: ROOM.park, score: 0 });
  run.walkDirection("N", () => run.state().room === ROOM.playground, "playground gate");
  run.exit("W", ROOM.boxCorner);
  // Logic 16 draws a bought box at its delivery spot (64,110) until it is moved.
  const box = e.screenObjects[4]!;
  assert.deepEqual([box.x, box.y, box.view], [64, 110, 124], "Old Box delivered to the playground");
  run.checkpoint("Found the delivered box by the fort", { room: ROOM.boxCorner, score: 0 });
  // Z within 15 pixels lifts the box (v41 = 24); Z again sets it down at Donald's feet.
  // Straight legs keep clear of the fort ramp, where logic 16 switches block
  // observance on and off by position and would invalidate a planned path.
  run.walkTo(112, 166);
  run.walkTo(112, 112);
  run.walkTo(75, 112);
  run.key(USE);
  run.until(() => e.vars[41] === 24, 100, "box lifted");
  run.walkTo(112, 112);
  run.walkTo(112, 150);
  run.key(USE);
  run.until(() => e.vars[41] === 0, 100, "box set down");
  // The box is positioned onto Donald's own spot, so the interpreter's
  // collision shuffle settles it one pixel away; logic 16 records where it landed.
  assert.deepEqual([e.vars[VAR.boxX], e.vars[VAR.boxY]], [111, 151], "box position recorded");
  assert.deepEqual([box.x, box.y], [111, 151], "box drawn at its new spot");
  run.verify("Set the box down in the open corner", { room: ROOM.boxCorner, score: 0 });
  // X beside the box climbs onto it (phase 11, view 24); X again hops off (phase 13, view 16).
  run.key(DO);
  run.until(() => e.vars[VAR.phase] === 11 && e.screenObjects[0]!.view === 24, 100, "on the box");
  const ego = e.screenObjects[0]!;
  run.until(() => ego.cel !== 0, 100, "bouncing on the box");
  run.until(() => ego.cel === 0, 200, "one full bounce");
  run.key(DO);
  run.until(() => e.vars[VAR.phase] === 13 && e.screenObjects[0]!.view === 16, 100, "off the box");
  // Hopping off puts the box back at Donald's perch plus (5,-4): the same (111,151).
  run.until(() => box.active, 20, "box redrawn");
  assert.deepEqual([box.x, box.y], [111, 151], "box back on the ground");
  run.checkpoint("Played on the Old Box", { room: ROOM.boxCorner, score: 0 });
}

export function ddpComplete(run: Speedrun): void {
  chooseBeginner(run);
  workProduceShift(run);
  collectPay(run);
  buyOldBox(run);
  placeBoxInPlayground(run);
}

export const ddpWalkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.DDP,
  alias: "ddp",
  label:
    "chose beginner, earned pay sorting produce, bought the Old Box and placed it in the playground",
  coverage: "chapter",
  // The seed fixes the produce kinds and lanes (logic 22 random calls) and
  // whether the park train runs; seed 1 yields fourteen clean catches.
  seed: 1,
  route: ddpComplete,
  expected: {
    room: ROOM.boxCorner,
    score: 0,
    vars: {
      [VAR.level]: 0,
      [VAR.phase]: 13,
      [VAR.boxX]: 111,
      [VAR.boxY]: 151,
      // Money total (tens, ones, dimes, cents) and the wallet's dime and pennies.
      141: 0,
      142: 0,
      143: 1,
      144: 3,
      [WALLET.dimes]: 1,
      [WALLET.pennies]: 3,
    },
    carriedExactly: [OLD_BOX],
    inputEnabled: false,
    egoView: 16,
  },
};
