import assert from "node:assert/strict";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import { parseDirection, type DirectionInput, type Speedrun } from "./runner.ts";
import { NavigationError } from "../../src/agent/navigationController.ts";
import type { PlanOptions } from "../../src/agent/navigation.ts";
import type { Walkthrough } from "./route.ts";
import type { TraversalRequest } from "../../src/agent/navigationTraversal.ts";

/** Inventory numbers from the OBJECT file. */
export const ITEM = {
  knapsack: 1,
  corn: 2,
  gruel: 3,
  foodWallet: 4,
  bread: 5,
  flask: 6,
  water: 7,
  apple: 8,
  cookies: 9,
  rope: 10,
  dagger: 11,
  sword: 12,
  harp: 13,
  lute: 14,
  dust: 15,
  keys: 16,
  cup: 17,
  word: 18,
  mirror: 19,
} as const;

/**
 * The Black Cauldron has no parser. Logic 107 binds F3 to the object selector
 * (controller 11: status() with the selector flag, the pick lands in v42),
 * F4 to Use (controller 26), F6 to Do (controller 6) and F8 to Look
 * (controller 8); logic 0 turns them into one-cycle flags for the room logic.
 */
export class Cauldron {
  readonly run: Speedrun;

  constructor(run: Speedrun) {
    this.run = run;
  }

  get engine(): Speedrun["engine"] {
    return this.run.engine;
  }

  room(): number {
    return this.run.state().room;
  }

  /** One function key, then the cycles that let the room logic answer it. */
  private fkey(key: number): void {
    const { run } = this;
    run.dismiss();
    const from = run.cycles;
    run.key(key);
    for (let n = 0; run.cycles < from + 2; n++) {
      assert.ok(n < 2000, "function key did not reach a cycle");
      if (run.engine.modalKind !== null || run.engine.continuationPending) break;
      run.advance();
    }
    run.dismiss();
  }

  doIt(): void {
    this.fkey(AGI_KEY.F6);
  }

  look(): void {
    this.fkey(AGI_KEY.F8);
  }

  /** F3 opens the carried list in item order; arrows move, Enter picks. */
  select(item: number): void {
    const { run, engine } = this;
    run.assertCarried(item);
    if (engine.vars[42] === item) return;
    run.dismiss();
    const carried: number[] = [];
    for (let i = 1; i < 26; i++) if (run.carried(i)) carried.push(i);
    const index = carried.indexOf(item);
    run.key(AGI_KEY.F3);
    run.until(() => engine.modalKind === "inventory", 600, "object selector open");
    const down = index <= carried.length - index;
    for (let n = down ? index : carried.length - index; n > 0; n--) {
      run.key(down ? AGI_KEY.DOWN : AGI_KEY.UP);
      run.advance();
    }
    run.key(AGI_KEY.ENTER);
    run.until(() => engine.modalKind === null, 600, "object selector closed");
    run.until(() => engine.vars[42] === item, 600, `item ${item} active`);
  }

  use(item: number): void {
    this.select(item);
    this.fkey(AGI_KEY.F4);
  }

  /**
   * Traverse, acknowledging the narration windows that interrupt a walk; the
   * traversal itself never answers a modal.
   */
  private passage(request: TraversalRequest, room: number): void {
    for (let attempt = 0; attempt < 12; attempt++) {
      const outcome = this.run.traverse(request, {
        budgets: { hostPolls: 10000, movementUpdates: 1000 },
      });
      if (outcome.status === "needs_input" || outcome.status === "movement_control_unavailable") {
        this.run.dismiss();
        this.run.wait(() => this.engine.movementControlEnabled, "control returns", 5000);
        if (this.room() === room) break;
        continue;
      }
      assert.equal(outcome.status, "reached", JSON.stringify(outcome));
      break;
    }
    assert.equal(this.room(), room);
    this.alive();
  }

  /** Walk onto a scripted doorway cell and land in the room behind it. */
  enter(x: number, y: number, room: number, planned = true): void {
    this.passage(
      {
        passage: { kind: "position", planned, target: { x0: x, x1: x, y0: y, y1: y } },
        expectedRoom: room,
        passageOptions: { avoidTriggers: false, geometry: "current" },
        landing: { label: `arrive in ${room}`, test: (e) => e.vars[0] === room },
      },
      room,
    );
  }

  /** Leave over a picture edge with a planned path. */
  leave(direction: DirectionInput, room: number, avoidTriggers = false): void {
    this.passage(
      {
        passage: { kind: "exit", direction: parseDirection(direction), room, planned: true },
        passageOptions: { avoidTriggers, geometry: "current", maxSearchNodes: 241920 },
        landing: { label: `arrive in ${room}`, test: (e) => e.vars[0] === room },
      },
      room,
    );
  }

  /** Hold one heading until the picture edge hands over to the next room. */
  edge(direction: DirectionInput, room: number): void {
    this.run.walkDirection(direction, () => this.room() === room, `edge into ${room}`);
    this.alive();
  }

  /** Logic 0 turns a non-zero v59 into the death script (v102 = 13). */
  alive(): void {
    const { vars } = this.engine;
    assert.ok(vars[59] === 0 && vars[102] !== 13, `Taran died (v59=${vars[59]})`);
  }

  /** Run a walk, acknowledging the timed narration windows that interrupt it. */
  private through(walk: () => void): void {
    for (let prompts = 0; ; prompts++) {
      try {
        walk();
        return;
      } catch (error) {
        if (!(error instanceof NavigationError) || error.outcome.status !== "needs_input")
          throw error;
        assert.ok(prompts < 4, "unexpected repeated narration during a walk");
        this.run.dismiss();
      }
    }
  }

  walkTo(x: number, y: number): void {
    this.through(() => this.run.walkTo(x, y));
  }

  walkPath(x: number, y: number, options?: PlanOptions): void {
    this.through(() => this.run.walkPath(x, y, options));
  }
}

/** Cold boot: the title (room 67) leaves on any key for Caer Dallben. */
export function boot(bc: Cauldron): void {
  const { run } = bc;
  run.until(() => bc.room() === 67, 600, "title screen");
  run.advance(30);
  run.key(AGI_KEY.ENTER);
  run.waitForRoom(8, "Caer Dallben");
  run.checkpoint("Arrived at Caer Dallben", { room: 8, score: 0 });
}

/**
 * Logic 61: Do at the hearth takes the gruel, five Do presses at the cupboard
 * open it and empty it (knapsack, apple, bread, flask). Logic 8 counts the
 * doorstep as the trough's bank (f88), so the flask fills on the way out.
 * Logic 9: Do at the gate unhinges it (f164), and the gruel used inside the
 * pen feeds Hen Wen for the first five points.
 */
export function feedHenWen(bc: Cauldron): void {
  const { run } = bc;
  bc.walkPath(140, 124);
  bc.doIt();
  run.waitForRoom(61, "inside the cottage");
  run.wait(() => run.state().control, "Taran steps inside");
  bc.walkPath(60, 124);
  bc.doIt();
  run.assertCarried(ITEM.gruel, "gruel");
  bc.walkPath(86, 112);
  for (let n = 0; n < 5; n++) bc.doIt();
  for (const item of [ITEM.knapsack, ITEM.apple, ITEM.bread, ITEM.flask]) run.assertCarried(item);
  bc.enter(150, 126, 8);
  run.wait(() => run.state().control, "Taran steps outside");
  bc.use(ITEM.flask);
  run.assertCarried(ITEM.water, "water");
  bc.leave("E", 9);
  bc.walkPath(90, 158, { geometry: "current" });
  bc.doIt();
  run.waitForFlag(164, "gate open");
  bc.walkTo(90, 146);
  bc.walkTo(104, 140);
  bc.use(ITEM.gruel);
  run.checkpoint("Fed Hen Wen", { room: 9, score: 5 });
}

/**
 * Back in the cottage the fed pig's trance starts on its own (f58); Dallben's
 * speech ends with the rope and Hen Wen following (f108). Logic 116 loses her
 * (f98) when Taran leaves a room more than 26 pixels ahead, she will not swim,
 * and the forest rooms that call logic 114 roll a gwythaint after 77..166
 * cycles. The meadow north of the cottage is crossed before that timer runs
 * out; the pool, the glade and the briars never call logic 114.
 */
export function deliverHenWen(bc: Cauldron): void {
  const { run, engine } = bc;
  bc.walkTo(90, 146);
  bc.walkTo(90, 158);
  bc.leave("W", 8);
  bc.walkPath(140, 124);
  bc.doIt();
  run.waitForRoom(61, "inside the cottage");
  run.waitForFlag(108, "Hen Wen follows");
  run.wait(() => run.state().control, "Dallben finishes");
  run.assertCarried(ITEM.rope, "rope");
  run.checkpoint("Learned of Hen Wen's visions", { room: 61, score: 5 });
  bc.enter(150, 126, 8);
  run.wait(() => run.state().control, "Taran steps outside");
  bc.leave("N", 3);
  bc.leave("N", 23);
  // The pool's west bank is four pixels wide; straight legs keep both on land.
  bc.walkTo(0, 158);
  bc.walkTo(0, 112);
  bc.walkTo(22, 90);
  bc.walkTo(22, 78);
  bc.leave("N", 18);
  bc.leave("W", 17);
  bc.enter(88, 97, 65);
  assert.equal(engine.flags[108], 1, "Hen Wen came through the briars");
  run.checkpoint("Threaded the briar patch", { room: 65, score: 9 });
  run.wait(() => run.state().control, "Taran steps into the clearing");
  bc.walkPath(68, 124);
  bc.doIt();
  run.waitForRoom(66, "Gwystyl's way station");
  // Gwystyl speaks after 99 cycles; the cupboard fills the wait with cookies.
  bc.walkPath(84, 122);
  bc.doIt();
  run.waitForFlag(204, "cupboard open");
  bc.doIt();
  run.assertCarried(ITEM.cookies, "cookies");
  run.waitForFlag(50, "Hen Wen delivered");
  run.wait(() => engine.flags[205] === 0, "Gwystyl leaves with Hen Wen");
  run.assertCarried(ITEM.word, "magic word");
  run.checkpoint("Delivered Hen Wen to the Fair Folk", { room: 66, score: 29 });
}

/**
 * Logic 104: once Hen Wen is safe (v57 > 0) the forest rooms roll Gurgi at
 * 88/256 on entry. He shows up after 55..123 cycles (f78), runs over to beg
 * (v231) and leaves Taran dizzy for 33 cycles (v234); the apple used within
 * 33 pixels of him is worth ten points and his friendship (f53).
 */
function befriendGurgi(bc: Cauldron): void {
  const { run, engine } = bc;
  bc.select(ITEM.apple);
  run.waitForFlag(78, "Gurgi appears");
  run.wait(() => engine.vars[231]! > 0 && engine.vars[234] === 0, "Gurgi begs", 5000);
  for (let n = 0; n < 20 && engine.flags[53] === 0; n++) {
    const gurgi = engine.screenObjects[7]!;
    run.walkToUntil(gurgi.x, gurgi.y, () => engine.vars[230]! <= 30, "within Gurgi's reach");
    bc.use(ITEM.apple);
  }
  assert.equal(engine.flags[53], 1, "Gurgi is a friend");
}

/**
 * Logic 2: two Do presses at the hollow tree find and take the lute. With the
 * seed in the catalog entry the glade north of it rolls Gurgi on the way back.
 */
export function luteAndGurgi(bc: Cauldron): void {
  const { run } = bc;
  bc.enter(70, 166, 65);
  run.wait(() => run.state().control, "Taran steps outside");
  bc.leave("S", 17);
  bc.leave("S", 22);
  bc.leave("S", 2);
  bc.walkPath(86, 160);
  bc.doIt();
  bc.doIt();
  run.assertCarried(ITEM.lute, "lute");
  bc.leave("N", 22);
  assert.equal(bc.engine.flags[200], 1, "Gurgi is due in the glade");
  befriendGurgi(bc);
  run.checkpoint("Befriended Gurgi", { room: 22, score: 39 });
}

/** The sunken rock, the pool's east bank and the ledge into the cave mouth. */
const CAVE_STEPS = [
  [108, 160],
  [116, 158],
  [118, 146],
  [122, 136],
] as const;

/**
 * Logic 24: the magic word spoken on the south bank sinks the rock (f200), so
 * the pool can be crossed dry and the cave behind the waterfall drops Taran
 * into logic 62 (13 points). Eiddileg lands (f202), Do introduces Taran, and
 * the lute offered while he waits for a token (f211) earns ten points, the
 * flying dust and the magic mirror (f77). Dust lifts Taran out through the
 * shaft; the word sinks the rock again for the way back.
 */
export function fairFolk(bc: Cauldron): void {
  const { run } = bc;
  bc.leave("E", 23);
  bc.walkPath(120, 160);
  bc.leave("E", 24);
  bc.walkPath(92, 160);
  bc.use(ITEM.word);
  run.waitForFlag(200, "rock sinks");
  for (const [x, y] of CAVE_STEPS) bc.walkTo(x, y);
  run.walkDirection("E", () => bc.room() === 62, "into the cave");
  run.waitForFlag(202, "Eiddileg lands");
  run.checkpoint("Fell into the Fair Folk kingdom", { room: 62, score: 52 });
  bc.doIt();
  run.waitForFlag(211, "Eiddileg wants a token");
  bc.use(ITEM.lute);
  run.waitForFlag(77, "Eiddileg's gifts");
  run.assertCarried(ITEM.dust, "flying dust");
  run.assertCarried(ITEM.mirror, "magic mirror");
  run.checkpoint("Traded the lute for dust and a mirror", { room: 62, score: 62 });
  bc.use(ITEM.dust);
  run.waitForFlag(103, "airborne");
  run.walkDirection("N", () => bc.room() === 24, "up the shaft");
  run.wait(() => run.state().control, "Taran steps out of the cave");
  bc.use(ITEM.word);
  run.waitForFlag(200, "rock sinks again");
  for (const [x, y] of [...CAVE_STEPS].reverse().slice(1)) bc.walkTo(x, y);
  bc.walkTo(92, 160);
  bc.alive();
}

/**
 * The rapids (f132) split the river rooms, and logic 6 only lets its south
 * edge reach the bank that leads west, so the way to the Eagle Mountains runs
 * north of the waterfall pool, west through the glade and the open ground
 * below the briars, across the dry corner of Morva Marsh and north through
 * the dagger wood. Logic 5 ignores blocks; the planner threads its boulders.
 */
export function toEagleMountains(bc: Cauldron): void {
  const { run } = bc;
  // Wade west of the f132 box below the falls; the rocks in the pool need a plan.
  bc.walkTo(40, 156);
  bc.walkPath(40, 78, { geometry: "current" });
  bc.walkTo(40, 64);
  for (const [direction, room] of [
    ["N", 19],
    ["W", 18],
    ["W", 17],
    ["W", 16],
    ["N", 11],
    ["N", 6],
    ["W", 5],
    ["N", 25],
  ] as const)
    bc.leave(direction, room);
  run.checkpoint("Reached the foot of the Eagle Mountains", { room: 25, score: 67 });
}

/**
 * Logic 26's cliff, west rope. Water strips are the handholds: walking into
 * one starts a climb (v65 = 7) and climbing into one drops Taran onto the
 * ledge beside it (v65 = 1). Trigger lines are the ledge rims (f3 is a fall
 * unless f160 marks a climbable face), so every leg is a straight line through
 * cells the control map leaves clear for the 13-pixel climbing cel.
 */
const CLIFF_UP: readonly (readonly [x: number, y: number, mode?: number])[] = [
  [138, 146],
  [108, 146],
  [100, 138],
  [100, 128, 7], // first hold, above the rope ledge
  [77, 125],
  [77, 147, 1], // down the face to the low ledge
  [76, 155],
  [46, 155],
  [46, 146, 7], // second hold
  [36, 133],
  [36, 76],
  [37, 75],
  [50, 75, 1], // onto the long ledge
  [59, 83],
  [114, 83],
  [114, 74, 7], // third hold
  [117, 51],
  [127, 51, 1], // the top ledge
];

/** The same cliff from the top: each hold becomes a drop and each drop a hold. */
const CLIFF_DOWN: typeof CLIFF_UP = [
  [136, 53], // clear of the summit doorway before turning north
  [136, 51, 7],
  [120, 48],
  [117, 51],
  [117, 73, 1],
  [114, 83],
  [59, 83],
  [59, 76],
  [59, 74, 7],
  [36, 72],
  [36, 133],
  [46, 143],
  [46, 145, 1],
  [46, 155],
  [76, 155],
  [76, 150],
  [76, 148, 7],
  [77, 125],
  [92, 125],
  [92, 127, 1],
  [100, 138],
  [108, 146],
  [138, 146],
  [140, 142],
];

function climb(bc: Cauldron, legs: typeof CLIFF_UP): void {
  const { run, engine } = bc;
  for (const [x, y, mode] of legs) {
    const ego = engine.screenObjects[0]!;
    // Logic 26 narrates some ledges; acknowledge and carry on to the same cell.
    const there = (): boolean =>
      mode === undefined ? ego.x === x && ego.y === y : engine.vars[65] === mode;
    while (!there()) {
      run.walkToUntil(x, y, () => there() || engine.modalKind !== null, `cliff leg to ${x},${y}`);
      run.dismiss();
    }
    assert.equal(engine.flags[152], 0, "Taran keeps his grip");
  }
}

/**
 * Logic 25: the rope lands on the west branch (f146) or the east one (f147)
 * or misses, by one random byte per throw; the catalog seed gives the west
 * branch first time. Do at its foot grabs it, and a held north-west heading
 * keeps y - x inside the two-pixel band logic 25 demands all the way up.
 */
export function climbEagleMountains(bc: Cauldron): void {
  const { run, engine } = bc;
  bc.use(ITEM.rope);
  assert.equal(engine.flags[146], 1, "rope caught the west branch");
  upTheCliff(bc);
  run.checkpoint("Scaled the cliff", { room: 29, score: 78 });
}

/** Rope, holds and ledges from the foot of the wall to the summit path. */
function upTheCliff(bc: Cauldron): void {
  const { run, engine } = bc;
  bc.walkPath(70, 140, { geometry: "current" });
  bc.doIt();
  assert.equal(engine.vars[65], 4, "on the rope");
  run.walkDirection("NW", () => bc.room() === 26, "up the rope");
  run.wait(() => engine.modalKind === null, "on the rope ledge");
  climb(bc, CLIFF_UP);
  run.walkDirection("E", () => bc.room() === 29, "off the cliff top");
  bc.alive();
}

/**
 * Logic 30's causeway is rimmed with trigger lines that drop Taran off the
 * mountain, so the planner keeps clear of every one of them.
 */
export function toTheCastle(bc: Cauldron): void {
  const { run } = bc;
  run.wait(() => run.state().control, "Taran steps onto the summit");
  bc.leave("N", 30);
  bc.leave("N", 34, true);
  run.checkpoint("Stood before the Horned King's castle", { room: 34, score: 83 });
}

/**
 * Logic 33 rolls the henchman's wagon at 80/256 each time Taran arrives
 * swordless from the moat side (f212); it waits 250 cycles before rolling in.
 * The moat is alligator water (f0 is fatal in logics 33 and 34), so both rooms
 * are crossed along their dry southern strips. Anyone right of the wagon and
 * level with it is caught (f216): Taran comes up the rutted road behind it and
 * Do within 20 pixels hides him in the back (f86) for the 18-point ride.
 */
export function rideTheWagon(bc: Cauldron): void {
  const { run, engine } = bc;
  for (let tries = 0; ; tries++) {
    assert.ok(tries < 12, "the wagon turns up");
    bc.walkTo(run.state().x, 160);
    bc.edge("W", 33);
    if (engine.flags[212] !== 0) break;
    bc.edge("E", 34);
  }
  bc.walkTo(30, 160);
  bc.walkTo(30, 98);
  bc.walkTo(24, 93);
  assert.ok(engine.vars[210]! > 10, "the wagon is still waiting");
  bc.doIt();
  assert.equal(engine.flags[86], 1, "hidden in the wagon");
  run.waitForRoom(47, "the wagon rolls into the castle");
  bc.use(ITEM.water);
  run.checkpoint("Rode the wagon into the castle", { room: 47, score: 101 });
}

/**
 * Logic 112 cannot see Taran in the wagon (f1) and walks its henchman off
 * (f96 clears); Do then climbs out. In the wine cellar the aisle between the
 * east casks crosses two trigger lines: the first finds the opening (six
 * points, f57), the second is the garbage chute down to the dungeon level
 * (logic 69, then ten points for arriving in logic 56).
 */
export function downTheChute(bc: Cauldron): void {
  const { run, engine } = bc;
  run.waitForFlag(96, "the henchman looks around");
  run.wait(() => engine.flags[96] === 0, "the henchman leaves");
  bc.doIt();
  bc.enter(82, 84, 46);
  bc.walkPath(106, 129, { geometry: "current" });
  run.walkDirection("E", () => bc.room() !== 46, "into the chute", 600);
  run.wait(() => bc.room() === 56 && run.state().control, "landed in the dungeon", 3000);
  bc.alive();
  run.checkpoint("Slid down the garbage chute", { room: 56, score: 117 });
}

/**
 * Eilonwy (logic 118) introduces herself and tags along. Logic 54: Do at the
 * loose wall looks first and then pushes its four blocks in (v37 = 4), and
 * the gap leads into the burial chamber for ten points. Logic 53: Do beside
 * the crypt frees Dyrnwyn (eight points); the way out stays shut (f212) until
 * Eilonwy has followed her bauble through the crack in the back wall.
 */
export function burialChamber(bc: Cauldron): void {
  const { run, engine } = bc;
  bc.edge("W", 55);
  bc.enter(6, 132, 54);
  bc.walkPath(56, 108, { geometry: "current" });
  for (let n = 0; n < 5; n++) bc.doIt();
  assert.equal(engine.vars[37], 4, "four blocks pushed in");
  run.walkToUntil(58, 104, () => bc.room() === 53, "through the gap");
  run.dismiss();
  assert.equal(run.state().score, 127);
  bc.walkPath(84, 152, { geometry: "current" });
  bc.doIt();
  run.assertCarried(ITEM.sword, "Dyrnwyn");
  run.checkpoint("Drew the magic sword Dyrnwyn", { room: 53, score: 135 });
  run.wait(() => engine.flags[212] === 0, "Eilonwy escapes", 6000);
  bc.edge("S", 54);
}

/** Logic 112's henchman (object 9) is chasing Taran and is close enough to hit. */
function henchmanInReach(bc: Cauldron, reach: number): boolean {
  const { flags, vars, screenObjects } = bc.engine;
  if (flags[96] === 0 || flags[100] === 0 || vars[80] !== 0 || flags[102] !== 0) return false;
  const ego = screenObjects[0]!;
  const henchman = screenObjects[9]!;
  // The interpreter's distance(): centre-to-centre in x plus the baseline gap.
  const gap =
    Math.abs(ego.x + (ego.width >> 1) - henchman.x - (henchman.width >> 1)) +
    Math.abs(ego.y - henchman.y);
  return gap < reach;
}

/**
 * Logic 0: using the sword starts a swing (f102); a henchman within 30 pixels
 * when it starts (f118) is stunned for 99 cycles (v80) when it ends. With the
 * sword carried, capture is fatal, so every swing is asserted.
 */
function swing(bc: Cauldron): void {
  const { run, engine } = bc;
  bc.use(ITEM.sword);
  assert.equal(engine.flags[118], 1, "henchman within the sword's reach");
  run.wait(() => engine.flags[102] === 0, "swing ends");
  assert.ok(engine.vars[80]! > 0, "henchman stunned");
}

function stunHenchman(bc: Cauldron): void {
  bc.run.waitForFlag(96, "the henchman appears");
  swing(bc);
}

/**
 * Move inside the castle, stopping to stun the henchman whenever he comes
 * within 26 pixels: a straight leg to a cell, or a held heading into `room`.
 */
export function castleLeg(bc: Cauldron, x: number, y: number): void {
  const { run } = bc;
  const ego = bc.engine.screenObjects[0]!;
  const arrived = (): boolean => ego.x === x && ego.y === y;
  for (let swings = 0; !arrived(); swings++) {
    assert.ok(swings < 4, "henchman keeps getting up");
    run.walkToUntil(x, y, () => arrived() || henchmanInReach(bc, 26), `castle leg to ${x},${y}`);
    if (!arrived()) swing(bc);
  }
  bc.alive();
}

export function castleExit(bc: Cauldron, direction: DirectionInput, room: number): void {
  const { run } = bc;
  const arrived = (): boolean => bc.room() === room;
  for (let swings = 0; !arrived(); swings++) {
    assert.ok(swings < 4, "henchman keeps getting up");
    run.walkDirection(direction, () => arrived() || henchmanInReach(bc, 26), `exit to ${room}`);
    if (!arrived()) swing(bc);
  }
  bc.alive();
}

/**
 * Logic 58: Do at the gargoyle opens the trapdoor (f166) and the water strip
 * is the foot of the ladder into the dungeon. Logic 50 always posts the
 * henchman by the south door, so Taran arrives with the sword selected, stuns
 * him on the doorstep, takes the key ring with Do (south of the fallen body
 * and more than 30 pixels from the grate, which Do would examine instead),
 * rounds the body on its west side and uses the keys at the cell door. Logic
 * 48: Do beside Fflewddur Fflam unties him for nine points and his harp.
 */
export function freeFflewddur(bc: Cauldron): void {
  const { run, engine } = bc;
  bc.leave("S", 57);
  bc.leave("E", 58);
  bc.walkTo(58, 124);
  bc.doIt();
  run.wait(() => engine.flags[166] === 1 && engine.flags[201] === 0, "trapdoor opens");
  bc.select(ITEM.sword);
  bc.walkTo(77, 124);
  run.walkToUntil(77, 121, () => engine.flags[200] !== 0, "onto the ladder");
  bc.edge("N", 51);
  bc.edge("N", 50);
  stunHenchman(bc);
  bc.walkTo(117, 156);
  bc.doIt();
  run.assertCarried(ITEM.keys, "key ring");
  bc.walkTo(94, 157);
  bc.walkTo(94, 145);
  bc.walkTo(78, 122);
  bc.use(ITEM.keys);
  run.waitForRoom(48, "the cell opens");
  bc.alive();
  bc.walkPath(76, 100, { geometry: "current" });
  bc.doIt();
  run.waitForItem(ITEM.harp, "Fflewddur's harp");
  run.checkpoint("Freed Fflewddur Fflam", { room: 48, score: 144 });
}

/**
 * Coming out of the cell logic 50 has no henchman posted, and every other
 * castle room rolls him after 0..255 cycles while the sword is carried, so
 * the walk out is made of guarded legs. The west door's trigger leads to the
 * spiral stairs (logics 49 and 42, whose stair rims drop Taran a floor), the
 * great hall (logic 43, keeping west of the caged gwythaint) and the wine
 * cellar. Logic 47: the sword used within 30 pixels of the windlass cuts the
 * chain (f33); with the bridge down the gate's trigger line leaves the castle
 * and carrying Dyrnwyn out is worth 13 points (f49).
 */
export function cutTheDrawbridge(bc: Cauldron): void {
  const { run, engine } = bc;
  bc.leave("S", 50);
  assert.equal(engine.flags[96], 0, "no henchman posted");
  bc.select(ITEM.sword);
  bc.enter(30, 126, 49);
  bc.leave("N", 42, true);
  bc.leave("E", 43, true);
  castleLeg(bc, 60, 150);
  castleExit(bc, "S", 46);
  castleLeg(bc, 75, 140);
  castleExit(bc, "S", 47);
  bc.walkPath(38, 136, { geometry: "current" });
  bc.use(ITEM.sword);
  run.wait(() => engine.flags[33] === 1 && engine.flags[204] === 1, "drawbridge falls");
  castleLeg(bc, 46, 122);
  castleExit(bc, "W", 33);
  run.wait(() => run.state().control, "Taran steps onto the drawbridge");
  run.checkpoint("Cut the drawbridge chain and escaped", { room: 33, score: 157 });
}

/**
 * Back over the drawbridge (logic 33 lifts its blocks on the span while the
 * bridge is down, and the trigger line south of it is the moat), round the
 * moat's dry rim, down the causeway and down the cliff. On the rope ledge Do
 * takes the rope; a held south-east heading follows it to the ground.
 */
export function downTheMountain(bc: Cauldron): void {
  const { run, engine } = bc;
  bc.walkTo(36, 90);
  bc.walkTo(30, 98);
  bc.walkTo(30, 160);
  bc.edge("E", 34);
  bc.walkTo(60, 160);
  bc.edge("S", 30);
  bc.leave("S", 29, true);
  run.wait(() => run.state().control, "Taran steps onto the summit");
  bc.edge("S", 26);
  run.wait(() => run.state().control, "Taran steps onto the top ledge");
  climb(bc, CLIFF_DOWN);
  bc.doIt();
  run.waitForRoom(25, "onto the rope");
  assert.equal(engine.vars[65], 4, "on the rope");
  run.walkDirection("SE", () => engine.vars[65] === 1, "down the rope");
  bc.alive();
  run.checkpoint("Climbed back down the cliff", { room: 25, score: 157 });
}

/**
 * Logic 108: dust used in the marsh rooms starts a flight (f103) of a few
 * seconds and dust used in the air lands Taran on that room's firm ground;
 * bog water is fatal on foot. Logic 20 pays 15 points on arrival. Logic 64:
 * Do opens the chest, six frogs leave and the witches storm in (f217); Do
 * again is Taran's introduction, which starts the frog countdown (f219), and
 * the sword offered then is the trade they want (18 points). Outside, Do hears
 * them out and a gwythaint carries the cauldron off to the castle (f79).
 */
export function witchesOfMorva(bc: Cauldron): void {
  const { run, engine } = bc;
  bc.leave("S", 5);
  bc.leave("S", 10);
  bc.leave("S", 15);
  bc.use(ITEM.dust);
  run.wait(() => engine.flags[103] === 1 && run.state().control, "airborne");
  bc.edge("S", 20);
  assert.equal(run.state().score, 172);
  bc.use(ITEM.dust);
  run.wait(() => engine.flags[103] === 0 && run.state().control, "landed by the house");
  run.checkpoint("Flew over Morva Marsh", { room: 20, score: 172 });
  bc.walkPath(44, 119, { geometry: "current" });
  bc.doIt();
  run.wait(() => bc.room() === 64 && run.state().control, "inside the witches' house");
  bc.walkPath(96, 108, { geometry: "current" });
  bc.doIt();
  run.wait(() => engine.flags[217] === 1, "the witches arrive", 6000);
  bc.doIt();
  run.waitForFlag(219, "the witches want a bargain");
  bc.use(ITEM.sword);
  assert.ok(!run.carried(ITEM.sword), "sword traded");
  run.checkpoint("Traded Dyrnwyn for the Black Cauldron", { room: 64, score: 190 });
  run.waitForRoom(20, "outside with the cauldron", 3000);
  bc.use(ITEM.bread);
  bc.doIt();
  run.wait(() => engine.flags[210] === 1, "a gwythaint takes the cauldron", 3000);
  assert.equal(engine.flags[79], 1, "cauldron carried to the castle");
  run.checkpoint("Lost the cauldron to a gwythaint", { room: 20, score: 190 });
  // The path off the island is a trigger box north-east of the witches.
  bc.walkPath(131, 99, { geometry: "current" });
  run.walkToUntil(131, 94, () => bc.room() === 15, "off the witches' island");
  bc.use(ITEM.dust);
  run.wait(() => engine.flags[103] === 1 && run.state().control, "airborne again");
  run.walkDirection("N", () => engine.screenObjects[0]!.y <= 84, "over the bog");
  bc.use(ITEM.dust);
  run.wait(() => engine.flags[103] === 0 && run.state().control, "landed north of the bog");
  bc.use(ITEM.water);
  bc.alive();
}

/**
 * The rope still hangs from the west branch. With the bridge down logic 33
 * lets Taran walk the span into the gatehouse, and the chute is the quick way
 * back below the dungeon; without the sword the henchman only jails Taran, but
 * the route never lets him close.
 */
export function backToTheCastle(bc: Cauldron): void {
  const { run, engine } = bc;
  bc.leave("N", 10);
  bc.leave("N", 5);
  bc.leave("N", 25);
  upTheCliff(bc);
  run.checkpoint("Scaled the cliff a second time", { room: 29, score: 190 });
  run.wait(() => run.state().control, "Taran steps onto the summit");
  bc.leave("N", 30);
  bc.leave("N", 34, true);
  bc.walkTo(run.state().x, 160);
  bc.edge("W", 33);
  assert.equal(engine.flags[33], 1, "drawbridge is down");
}

/**
 * Logic 60 with the cauldron in place (f79): the Horned King starts raising
 * his Cauldron-Born and then hunts Taran, but the mirror used on arrival shows
 * him his true self (25 points) and he leaps into the cauldron. Gurgi's
 * sacrifice and Taran's own leap are the lesser endings, so nothing else is
 * touched. The blast throws Taran into the moat (logic 32) and a log carries
 * him down the river to the lake.
 */
export function mirrorTheHornedKing(bc: Cauldron): void {
  const { run, engine } = bc;
  bc.walkTo(30, 160);
  bc.walkTo(30, 98);
  bc.walkTo(36, 90);
  run.walkToUntil(128, 90, () => bc.room() === 47, "across the drawbridge");
  run.checkpoint("Crossed the lowered drawbridge", { room: 47, score: 190 });
  bc.enter(82, 84, 46);
  bc.walkPath(106, 129, { geometry: "current" });
  run.walkDirection("E", () => bc.room() !== 46, "into the chute", 600);
  run.wait(() => bc.room() === 56 && run.state().control, "landed in the dungeon", 3000);
  bc.select(ITEM.mirror);
  bc.leave("S", 59);
  bc.enter(140, 134, 60);
  bc.use(ITEM.mirror);
  assert.equal(engine.flags[216], 1, "the Horned King saw himself");
  run.checkpoint("Showed the Horned King his true self", { room: 60, score: 215 });
  run.waitForRoom(32, "thrown into the moat", 5000);
  assert.equal(engine.flags[54], 0, "Gurgi is alive");
  run.waitForRoom(12, "the log drifts to the lake", 20000);
  run.checkpoint("Rode a log down the river", { room: 12, score: 215 });
}

/**
 * Logic 12: the witches want their cauldron back and offer a shield, a suit
 * of armour and finally Dyrnwyn. Do would accept the offer on the table, so
 * Taran waits: the third offer is taken for him (15 points, v35 = 23) and
 * logic 0 moves to the closing scene, which ends on its final picture (f211)
 * with input prevented.
 */
export function refuseTheWitches(bc: Cauldron): void {
  const { run, engine } = bc;
  run.waitForRoom(71, "the witches' last offer", 30000);
  run.assertCarried(ITEM.sword, "Dyrnwyn");
  run.checkpoint("Won Dyrnwyn back from the witches", { room: 71, score: 230 });
  run.waitForFlag(211, "the friends walk home", 30000);
  run.dismiss();
  assert.equal(engine.vars[102], 0, "no death script ran");
  run.checkpoint("Walked home with Eilonwy, Fflewddur and Gurgi", { room: 71, score: 230 });
}

/**
 * The Black Cauldron, best ending with every point. The scoring writes in the
 * logics add up to 463 across mutually exclusive branches; the best
 * compatible set is 230, which is also the maximum logic 107 declares (v7):
 * feed Hen Wen 5, briar path 4, Hen Wen delivered 20, Gurgi fed 10, Fair Folk
 * 13 + lute 10, mountain 5 + rope 5 + cliff 6 + causeway 5, wagon 18, chute
 * found 6 + dungeon 10, burial chamber 10 + sword 8, Fflewddur 9, sword
 * carried out 13, witches' island 15 + trade 18, mirror 25, sword won back 15.
 */
export function bcComplete(run: Speedrun): void {
  const bc = new Cauldron(run);
  boot(bc);
  feedHenWen(bc);
  deliverHenWen(bc);
  luteAndGurgi(bc);
  fairFolk(bc);
  toEagleMountains(bc);
  climbEagleMountains(bc);
  toTheCastle(bc);
  rideTheWagon(bc);
  downTheChute(bc);
  burialChamber(bc);
  freeFflewddur(bc);
  cutTheDrawbridge(bc);
  downTheMountain(bc);
  witchesOfMorva(bc);
  backToTheCastle(bc);
  mirrorTheHornedKing(bc);
  refuseTheWitches(bc);
}

export const bcWalkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.BC,
  alias: "bc",
  label:
    "destroyed the Black Cauldron with the mirror and reached the closing scene with maximum score",
  coverage: "complete-game",
  // Seed 1 rolls no gwythaint on Hen Wen's road, Gurgi on the way back from
  // the lute, the west rope branch on the first throw, the wagon on the third
  // visit and late henchmen in the castle; the route asserts each of these.
  seed: 1,
  route: bcComplete,
  expected: {
    room: 71,
    score: 230,
    // f211 closing picture shown, f143 game over, f50 Hen Wen safe, f53 Gurgi
    // befriended, f54 Gurgi never sacrificed, f79 cauldron reached the castle.
    flags: { 211: 1, 143: 1, 50: 1, 53: 1, 54: 0, 79: 1 },
    vars: { 7: 230, 59: 0 },
    carriedExactly: [1, 6, 7, 9, 12, 13, 15, 16, 18, 19, 24],
    inputEnabled: false,
  },
};
