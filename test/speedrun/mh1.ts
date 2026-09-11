import assert from "node:assert/strict";
import { directionForDelta } from "../../src/agent/gameTestSteps.ts";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import type { ScreenObject } from "../../src/runtime/screenObject.ts";
import { type DirectionInput, type Speedrun } from "./runner.ts";

/**
 * Manhunter: New York (3.002.107) is played through a cursor, screen object 0,
 * that the player steers with the arrow keys. Rooms register a hotspot when the
 * cursor enters a region (most rooms in v48, the sewers in v51), snap the
 * cursor to the region's anchor and print the action on text rows 23 and 24;
 * Enter (controller 20) performs it. Logic 90 binds the other keys used here:
 * F3 opens the city map (controller 21), C the MAD (controller 32, rooms 101
 * and 114) and Tab the inventory (controller 7). Waits are counted in host
 * ticks at 60 Hz; the game runs one interpreter cycle per six ticks.
 */
export const KEY_C = 0x43;
export const ROOM_MAP = 114;

export class Manhunter {
  readonly run: Speedrun;

  constructor(run: Speedrun) {
    this.run = run;
  }

  get engine() {
    return this.run.engine;
  }

  get cursor(): ScreenObject {
    return this.engine.screenObjects[0]!;
  }

  /** The hotspot hint on text rows 23 and 24. */
  hint(): string {
    return `${this.engine.textRow(23).trim()} / ${this.engine.textRow(24).trim()}`;
  }

  describe(): string {
    const v = this.engine.vars;
    return `room ${v[0]} v47=${v[47]} v48=${v[48]} v50=${v[50]} v51=${v[51]} v66=${v[66]} cursor (${this.cursor.x},${this.cursor.y}) hint "${this.hint()}"`;
  }

  /**
   * Advance host ticks, acknowledging message windows as they open. Clock
   * busy-waits park the logic between ticks without a key, so this never
   * relies on the bounded settling loop of `dismiss()`.
   */
  step(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      this.run.advance();
      if (this.engine.modalKind === "print") this.run.dismiss();
    }
  }

  key(code: number, ticks = 60): void {
    this.run.key(code);
    this.step(ticks);
  }

  enter(ticks = 60): void {
    this.key(AGI_KEY.ENTER, ticks);
  }

  waitFor(predicate: () => boolean, label: string, max = 1200): void {
    for (let i = 0; i < max; i++) {
      if (predicate()) return;
      this.step(1);
    }
    throw new Error(`Timed out: ${label}; ${this.describe()}`);
  }

  waitForRoom(room: number, label?: string, max = 1200): void {
    this.waitFor(() => this.engine.vars[0] === room, label ?? `room ${room}`, max);
  }

  /** Let a scene finish: the cursor returns once the room hands control back. */
  settle(max = 400): void {
    for (let t = 0; t < max; t++) {
      this.step(1);
      if (t > 40 && this.cursor.active) break;
    }
    this.step(10);
  }

  /** One interpreter cycle, so a direction key is never doubled before it is read. */
  cycle(): void {
    const from = this.run.cycles;
    for (let t = 0; t < 40 && this.run.cycles === from; t++) this.step(1);
  }

  private steerToward(x: number, y: number): void {
    const o = this.cursor;
    this.run.direction(directionForDelta(Math.sign(x - o.x), Math.sign(y - o.y)));
    this.run.advance();
  }

  /**
   * Steer the cursor to within two pixels of (x,y). A registering hotspot snaps
   * the cursor, so a target can be unreachable: steering gives up after twelve
   * attempts without getting closer, including oscillation around a snapped anchor.
   */
  cursorTo(x: number, y: number, max = 600): void {
    let stale = 0;
    let bestDistance = Infinity;
    for (let n = 0; n < max; n++) {
      const o = this.cursor;
      if (Math.abs(x - o.x) <= 2 && Math.abs(y - o.y) <= 2) break;
      const distance = Math.abs(x - o.x) + Math.abs(y - o.y);
      if (distance >= bestDistance) {
        if (++stale > 12) break;
      } else {
        stale = 0;
        bestDistance = distance;
      }
      this.steerToward(x, y);
    }
    this.run.direction(0);
    this.step(3);
  }

  /**
   * Press `dir` once and ride it until `until` holds, re-pressing whenever a
   * hotspot registration stops the cursor (the room zeroes v6) before the
   * stop condition is met. One recorded press per straight run instead of a
   * steering decision per tick.
   */
  glide(dir: DirectionInput, until: () => boolean, label: string, max = 200): void {
    for (let n = 0; n < max && !until(); n++) {
      if (this.cursor.direction === 0) this.run.direction(dir);
      this.cycle();
    }
    this.run.direction(0);
    assert.ok(until(), `glide ${label}; ${this.describe()}`);
  }

  /**
   * Steer the cursor until the sewer room registers exit `selector` in v51:
   * 2 left (x under 66, any y under 148, or x under 5), 3 right (x over 90 or
   * over 145), 1 top (x 66-90, y under 148), 0 the bottom strip (y over 147),
   * 4 the keycard (x 63-82, y 133-154). Zones stop the cursor as they
   * register, so crossing an intermediate zone costs one re-press per zone.
   */
  selectExit(selector: number, label: string): void {
    const registered = () => this.engine.vars[51] === selector;
    for (let guard = 0; guard < 8 && !registered(); guard++) {
      const o = this.cursor;
      let dir: number;
      let done = registered;
      if (selector === 2) dir = 7;
      else if (selector === 3) dir = 3;
      else if (selector === 1)
        dir = o.y > 147 && o.x > 65 && o.x < 91 ? 1 : o.x < 66 ? 3 : o.x > 90 ? 7 : 0;
      else if (selector === 0) dir = o.x > 145 ? 7 : o.x < 5 ? 3 : 5;
      else if (o.x < 63) {
        // The keycard zone only registers once the cursor is both in its
        // column (x 63-82) and its rows, and not every picture stops the
        // cursor in between, so the column approach is position-based.
        dir = 3;
        done = () => this.cursor.x >= 63 || registered();
      } else if (o.x > 82) {
        dir = 7;
        done = () => this.cursor.x <= 82 || registered();
      } else dir = o.y > 154 ? 1 : 5;
      if (!dir) break;
      this.glide(dir, done, label);
    }
    assert.equal(this.engine.vars[51], selector, `${label}; ${this.describe()}`);
  }

  /**
   * Steer toward (x,y) only until hotspot `id` registers, then stop at once.
   * The room snaps the cursor to the region's anchor, and Enter is read with
   * that anchor: a later move can leave the region or select a neighbour.
   */
  hotspot(id: number, x: number, y: number, register = 48, max = 600): void {
    for (let n = 0; n < max && this.engine.vars[register] !== id; n++) this.steerToward(x, y);
    this.run.direction(0);
    this.step(2);
    assert.equal(this.engine.vars[register], id, `hotspot ${id} registers; ${this.describe()}`);
  }

  /** F3 opens the city map from any street room. */
  map(): void {
    this.key(AGI_KEY.F3);
    this.waitForRoom(ROOM_MAP, "the city map", 600);
    this.step(30);
  }

  /**
   * Push the cursor off a map edge until page `target` (v90) shows. Pages 1
   * to 4 stack north to south; pages 5 and 6 lie east of 3 and 4.
   */
  toPage(target: number): void {
    for (let guard = 0; this.engine.vars[90] !== target && guard < 8; guard++) {
      const page = this.engine.vars[90]!;
      const o = this.cursor;
      let edge: [number, number];
      if (target >= 5 && page <= 4) edge = page >= 3 ? [159, o.y] : [o.x, 167];
      else if (target <= 4 && page >= 5)
        edge = page === 6 ? [o.x, 1] : [0, target === 4 ? 100 : 60];
      else edge = target > page ? [o.x, 167] : [o.x, 1];
      for (let n = 0; n < 200 && this.engine.vars[90] === page; n++) {
        const c = this.cursor;
        const along = directionForDelta(Math.sign(edge[0] - c.x), Math.sign(edge[1] - c.y));
        const out = edge[1] === 167 ? 5 : edge[1] === 1 ? 1 : edge[0] === 159 ? 3 : 7;
        this.run.direction(along || out);
        this.run.advance();
      }
      this.run.direction(0);
      this.step(5);
    }
    assert.equal(this.engine.vars[90], target, `map page ${target}`);
  }

  /** On the city map: turn to `page`, register location `id`, travel and wait for `room`. */
  travel(id: number, page: number, x: number, y: number, room: number): void {
    assert.equal(this.engine.vars[0], ROOM_MAP, "travel starts on the city map");
    this.toPage(page);
    this.cursorTo(x, y);
    assert.equal(this.engine.vars[48], id, `map location ${id}; ${this.describe()}`);
    assert.match(this.hint(), /travel here/);
    this.enter();
    this.waitForRoom(room, `arrival in room ${room}`, 1200);
  }
}

/**
 * Day 1 of Manhunter: New York from the title screen to the return home that
 * starts Day 2. Every input is a key the player could press: cursor steering,
 * Enter on hotspots, the MAD and inventory keys, and typed prompt replies.
 * Nothing writes game state. Room and variable numbers were read from the
 * game's logic disassemblies; the fixed maze and sewer routes were recorded
 * from the engine's own runs and are replayed here as ordinary key presses.
 */
export function day1(run: Speedrun): void {
  const mh = new Manhunter(run);
  opening(mh);
  bellevue(mh);
  trinity(mh);
  flatbush(mh);
  prospectPark(mh);
  sewers(mh);
  coneyIsland(mh);
  orbs(mh);
}

/** Canonical complete walkthrough entry point for Manhunter 1 (currently Day 1). */
export function mh1Complete(run: Speedrun): void {
  day1(run);
}

/** Title, intro, the MAD tracker's replay of the explosion, then the city map. */
export function opening(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.step(120);
  run.checkpoint("Title", { room: 153 });
  mh.key(AGI_KEY.ENTER, 120);
  mh.waitForRoom(101, "the MAD tracker", 6000);
  // Enter starts the tracker, which replays the suspect's movements in four
  // timed segments alternating rooms 125 and 124; each finished segment sets
  // one of flags 65, 38, 68 and 69. C closes the MAD onto the city map.
  mh.waitFor(() => mh.hint().includes("Press <ENTER>"), "the tracker prompt");
  run.key(AGI_KEY.ENTER);
  mh.waitFor(
    () => Boolean(engine.flags[69] && engine.flags[68] && engine.flags[38] && engine.flags[65]),
    "the tracker's four segments",
    9000,
  );
  assert.ok([124, 125].includes(engine.vars[0]!), `tracker rooms; ${mh.describe()}`);
  run.checkpoint("Tracker", {});
  mh.key(KEY_C, 120);
  run.checkpoint("City map", { room: ROOM_MAP });
}

/** Bellevue Hospital: through the ward to the body, a close look at its foot, then the MAD lookup. */
export function bellevue(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(1, 2, 138, 113, 130);
  run.checkpoint("Bellevue Hospital", { room: 130 });
  // v66 is "inside", v50 the scene: 2 entrance hall, 3 ward, 6 close-up.
  mh.cursorTo(140, 137);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[66] === 1 && engine.vars[50] === 2 && mh.cursor.active, "the hall");
  mh.step(5);
  mh.cursorTo(77, 120);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 3 && mh.cursor.active, "the ward");
  mh.step(5);
  // The middle hotspot looks at the foot; the one on the right is the morgue.
  mh.cursorTo(96, 91);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 6, "the close-up");
  mh.step(60);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 3, "back in the ward");
  mh.step(10);
  mh.cursorTo(50, 160);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 2, "back in the hall");
  mh.step(5);
  mh.cursorTo(77, 160);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[66] === 0 && engine.vars[50] === 0, "outside");
  mh.step(10);
  // The MAD outside the hospital: Info on the name from the scene.
  mh.key(KEY_C, 30);
  mh.waitForRoom(101, "the MAD");
  mh.step(60);
  run.checkpoint("MAD", { room: 101 });
  mh.cursorTo(30, 40);
  run.answer("Reno Davis");
  mh.enter(120);
  run.answer("bye");
  mh.enter(120);
  mh.key(KEY_C);
  mh.waitForRoom(130, "back at Bellevue");
  mh.step(60);
  mh.map();
}

/** Trinity Church: in and straight back out registers the visit. */
export function trinity(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(13, 3, 73, 152, 111);
  mh.step(120);
  run.checkpoint("Trinity Church", { room: 111 });
  mh.cursorTo(72, 150);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[66] === 1, "inside the church");
  mh.step(60);
  mh.cursorTo(80, 160);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[66] === 0, "outside the church");
  mh.step(60);
  mh.map();
}

/**
 * The arcade maze (room 126): the avatar walks one pixel per cycle in the
 * pressed direction and cannot stop — the game restores v6 from v39 — until a
 * magic square's pick-up animation (v92) holds it, and touching a wall
 * (control 2, which sets f3) sends it back to the start. Each leg below is a
 * corner list for one square, derived from the maze's control surface with a
 * turn-minimizing search, so every recorded press is a deliberate corner with
 * no wall bumps or steering wiggle. The legs visit the squares that flags 151
 * to 162 count in the order 4 5 8 10 6 7 11 12 9 3; squares 1 and 2 register
 * en passant as the path crosses them, exactly as the original recording did.
 * Square 3 comes last: it ends the game.
 */
interface MazeLeg {
  /** Flag the game sets when the avatar stands on the square. */
  flag: number;
  name: string;
  /** Corner cells from the leg's start (the previous square) to the square. */
  path: readonly (readonly [number, number])[];
}
const MAZE_ROUTE: MazeLeg[] = [
  {
    flag: 154,
    name: "4",
    path: [
      [136, 161],
      [133, 161],
      [124, 152],
      [31, 152],
      [27, 156],
    ],
  },
  {
    flag: 155,
    name: "5",
    path: [
      [27, 156],
      [34, 149],
      [85, 149],
      [85, 133],
      [82, 130],
      [73, 139],
      [30, 139],
      [30, 127],
      [23, 120],
      [17, 126],
    ],
  },
  {
    flag: 158,
    name: "8",
    path: [
      [17, 126],
      [23, 120],
      [30, 127],
      [30, 139],
      [45, 139],
      [45, 127],
      [60, 112],
      [60, 102],
      [75, 102],
      [75, 118],
      [61, 132],
      [60, 132],
    ],
  },
  {
    flag: 160,
    name: "10",
    path: [
      [60, 132],
      [70, 122],
      [100, 122],
      [100, 138],
      [113, 138],
      [116, 135],
    ],
  },
  {
    flag: 156,
    name: "6",
    path: [
      [116, 135],
      [113, 138],
      [95, 138],
      [95, 119],
      [80, 119],
      [80, 112],
      [105, 112],
      [115, 122],
      [125, 122],
      [125, 133],
      [135, 143],
      [135, 112],
      [125, 102],
      [125, 79],
      [110, 79],
      [110, 68],
      [91, 49],
      [71, 49],
      [64, 42],
      [45, 42],
      [55, 52],
      [55, 72],
      [45, 72],
      [45, 99],
      [22, 99],
      [18, 95],
      [28, 85],
    ],
  },
  {
    flag: 157,
    name: "7",
    path: [
      [28, 85],
      [18, 95],
      [28, 105],
      [35, 98],
      [35, 72],
      [25, 72],
      [18, 65],
    ],
  },
  {
    flag: 161,
    name: "11",
    path: [
      [18, 65],
      [25, 72],
      [40, 72],
      [40, 102],
      [50, 92],
      [50, 70],
      [55, 70],
      [55, 52],
      [45, 42],
      [65, 42],
      [75, 52],
      [94, 52],
      [110, 68],
      [110, 79],
      [124, 79],
      [135, 68],
      [135, 96],
    ],
  },
  {
    flag: 162,
    name: "12",
    path: [
      [135, 96],
      [135, 42],
      [115, 42],
      [129, 56],
    ],
  },
  {
    flag: 159,
    name: "9",
    path: [
      [129, 56],
      [115, 42],
      [135, 42],
      [135, 68],
      [130, 73],
      [130, 108],
      [135, 113],
      [135, 143],
      [125, 133],
      [125, 122],
      [115, 122],
      [95, 102],
      [95, 92],
      [75, 72],
      [75, 62],
      [70, 62],
      [70, 78],
      [60, 88],
    ],
  },
  {
    flag: 153,
    name: "3",
    path: [
      [60, 88],
      [70, 78],
      [70, 62],
      [75, 62],
      [75, 73],
      [100, 98],
      [100, 107],
      [115, 122],
      [125, 122],
      [125, 133],
      [135, 143],
      [135, 112],
      [125, 102],
      [125, 79],
      [110, 79],
      [110, 68],
      [91, 49],
      [71, 49],
      [64, 42],
      [45, 42],
      [55, 52],
      [55, 72],
      [50, 72],
      [50, 92],
      [40, 102],
      [40, 57],
      [28, 45],
    ],
  },
];

/** Flatbush: the bar, the knife game in its arcade, then the maze machine. */
export function flatbush(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(8, 5, 51, 36, 122);
  mh.waitFor(() => engine.vars[47] === 1, "the bar ready");
  mh.step(5);
  run.checkpoint("Flatbush bar", { room: 122 });
  mh.cursorTo(75, 100);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[66] === 1 && engine.vars[0] === 122, "inside the bar");
  mh.step(120);
  mh.cursorTo(20, 100);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(
    () => engine.vars[0] === 118 && engine.vars[50] === 0 && mh.hint().includes("throw"),
    "the knife game",
    6000,
  );
  run.checkpoint("Knife game", { room: 118 });
  // The thrower sweeps; a knife leaves when Enter is read with the cursor on
  // the target column. Four hits end the game and return to the bar.
  for (const target of [50, 69, 85, 102]) {
    mh.waitFor(() => Math.abs(mh.cursor.x - target) <= 1, `a knife aimed at ${target}`, 600);
    run.key(AGI_KEY.ENTER);
    for (let t = 0; t < 400 && engine.vars[0] === 118; t++) {
      mh.step(1);
      if (t > 20 && engine.vars[50] === 0) break;
    }
    if (engine.vars[0] !== 118) break;
  }
  mh.step(60);
  mh.waitFor(() => engine.vars[0] === 122 && mh.cursor.active, "back in the bar", 3000);
  // The arcade again now runs the maze machine, room 126.
  mh.cursorTo(20, 100);
  assert.match(mh.hint(), /video game/);
  run.key(AGI_KEY.ENTER);
  // The machine shows its rules (v50 0) and Enter starts the game (v50 1);
  // from then on Enter would back out, so the avatar is driven by arrows only.
  mh.waitFor(
    () => engine.vars[0] === 126 && mh.hint().includes("continue"),
    "the maze machine",
    600,
  );
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 1 && mh.cursor.active, "the maze started", 300);
  run.checkpoint("Maze", { room: 126 });
  maze(mh);
  // The machine's ending returns to the bar through two Enter prompts.
  mh.waitFor(
    () => engine.vars[0] === 126 && mh.hint().includes("continue"),
    "the maze ending",
    4000,
  );
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 1, "the machine's back-up prompt");
  mh.step(10);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[0] === 122, "the bar after the maze");
  // Back out of the bar onto the street in front of it.
  mh.step(120);
  mh.cursorTo(75, 120);
  assert.match(mh.hint(), /back out/);
  mh.enter(200);
  mh.cursorTo(75, 120);
  assert.match(mh.hint(), /enter the Flatbush Bar/);
  mh.map();
}

/**
 * Ride the maze avatar along MAZE_ROUTE: one press per corner, steering at
 * one interpreter cycle per step so the avatar never overshoots a corner into
 * a wall. A square's pick-up animation (v92) holds the avatar; after it the
 * current leg's heading is pressed again. The flag check in the game runs in
 * the cycle after the avatar steps onto the square, so the final corner gets
 * one extra cycle before the route moves on.
 */
function maze(mh: Manhunter): void {
  const { run, engine } = mh;
  for (const leg of MAZE_ROUTE) {
    if (engine.flags[leg.flag]) continue; // crossed en passant on an earlier leg
    const start = mh.cursor;
    assert.deepEqual(
      [start.x, start.y],
      leg.path[0],
      `maze square ${leg.name} starts where the previous leg ended; ${mh.describe()}`,
    );
    for (let w = 1; w < leg.path.length && !engine.flags[leg.flag]; w++) {
      const [x, y] = leg.path[w]!;
      const final = w === leg.path.length - 1;
      for (let n = 0; n < 4000; n++) {
        const o = mh.cursor;
        assert.notEqual(
          engine.vars[50],
          4,
          `the maze avatar touched a wall at (${o.x},${o.y}) heading for (${x},${y})`,
        );
        if (engine.flags[leg.flag]) break;
        if (engine.vars[92] !== 0) {
          while (engine.vars[92] !== 0) mh.cycle();
          continue;
        }
        const direction = directionForDelta(Math.sign(x - o.x), Math.sign(y - o.y));
        if (direction === 0) {
          if (final) mh.cycle();
          break;
        }
        const before = run.cycles;
        run.direction(direction);
        // direction() waits out a cycle when it presses; one cycle per step.
        if (run.cycles === before) mh.cycle();
      }
    }
    while (engine.vars[92] !== 0) mh.cycle();
    assert.ok(engine.flags[leg.flag], `maze square ${leg.name}; ${mh.describe()}`);
  }
  const squares = [151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162].filter(
    (f) => engine.flags[f],
  ).length;
  assert.equal(squares, 12, "all twelve maze squares were collected");
}

/** Prospect Park: the women's toilets, stall three, sit, and three flushes drop Mick into the sewers. */
export function prospectPark(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(9, 5, 65, 50, 119);
  mh.step(180);
  run.checkpoint("Prospect Park", { room: 119 });
  const use = (x: number, y: number, id: number, action: RegExp, ticks: number): void => {
    mh.cursorTo(x, y);
    assert.equal(engine.vars[48], id, `park hotspot ${id}; ${mh.describe()}`);
    assert.match(mh.hint(), action);
    mh.enter(ticks);
  };
  use(62, 70, 1, /Move/, 240);
  assert.equal(engine.vars[66], 1, "inside the toilets");
  // The left door is the women's room (v93 = 2); the right one leads nowhere useful.
  use(45, 70, 1, /Move/, 240);
  assert.equal(engine.vars[93], 2, "the women's room");
  use(125, 45, 3, /Move/, 240);
  use(125, 45, 3, /Move/, 240);
  assert.equal(engine.vars[90], 3, "stall three");
  use(62, 70, 2, /sit down/, 240);
  assert.equal(engine.flags[151], 1, "seated");
  for (let flush = 1; flush <= 3; flush++) {
    mh.waitFor(() => engine.vars[92] === 0, `flush ${flush} ready`, 600);
    use(62, 70, 9, /flush/, 30);
  }
  mh.waitForRoom(128, "the fall into the sewers", 12000);
  mh.step(120);
}

/**
 * Recorded sewer route. Room 128 is a graph of pictures (v250) with up to four
 * exits, selected by moving the cursor over an arrow: the room registers the
 * selection in v51 (2 left, 3 right, 1 top, 0 bottom, 4 the keycard) and stops
 * the cursor. Enter follows the registered exit — only v51 matters, not the
 * cursor's exact pixel. SEWER_MOVES is the recorded route (C takes the keycard
 * on the current picture); SEWER_SELECTORS is the v51 each move registered
 * before its Enter in the same recording. The route collects all twelve
 * keycards and ends at the dock picture 78.
 */
const SEWER_MOVES =
  "LBBLLLLLLLLCBLLLLLLLLLLLLLLLRLLLCLLLLLLLLRLLLLCLRRLLBLLLLLRRLLCLLRRLLLLLLCLLLLLLLRRLLLLRLLLLLLLRCBLLLLLLLLLRLLLLLLLLLLLLRLLLLLLLCBLLLLLRRLLCLLLRLLLLLLLCLLRRLLLLRLRLLLLLLRLLLLLLLLLLLLRLRLLLCLLLLLLLLLLRCBLLLLLLCL";
const SEWER_SELECTORS =
  "300211111124031111121223111131224033121213213140121302131313234023113121240313121331212323122113402113312323123213122112311213124031212331140111112122340233131132313123211321223132113113324032212112134021212341";

export function sewers(mh: Manhunter): void {
  const { run, engine } = mh;
  run.checkpoint("Sewers", { room: 128 });
  assert.equal(engine.vars[250], 254, "the sewer entry picture");
  assert.equal(SEWER_MOVES.length, SEWER_SELECTORS.length, "every move has a selector");
  let cards = 0;
  for (let i = 0; i < SEWER_MOVES.length; i++) {
    const move = SEWER_MOVES[i]!;
    const selector = Number(SEWER_SELECTORS[i]);
    if (move === "C") {
      mh.selectExit(selector, `keycard ${cards + 1}`);
      mh.enter(90);
      cards++;
      continue;
    }
    mh.selectExit(selector, `sewer move ${i} (${move})`);
    run.key(AGI_KEY.ENTER);
    mh.settle();
  }
  assert.equal(cards, 12, "twelve keycards");
  assert.equal(engine.vars[250], 78, "the dock picture");
  // The dock: gliding onto the ship hotspot registers v51 = 6, Enter looks
  // closer; in the close-up the medallion hotspot registers v51 = 7.
  mh.glide(2, () => engine.vars[51] === 6, "the ship");
  assert.equal(engine.vars[51], 6, `the dock; ${mh.describe()}`);
  run.key(AGI_KEY.ENTER);
  mh.settle();
  mh.glide(3, () => engine.vars[51] === 7, "the medallion");
  assert.match(mh.hint(), /take the medallion/);
  mh.enter(120);
  run.assertCarried(13, "the medallion");
  // Back on the dock, straight down off the bottom edge returns to the sewers.
  mh.glide(5, () => engine.vars[51] === 0, "the dock's lower edge");
  run.key(AGI_KEY.ENTER);
  mh.settle();
  mh.map();
}

/** One pitch at the Kewpie Doll booth once the sweeping thrower reaches (x,y) on one of `shelves`. */
function pitch(mh: Manhunter, x: number, y: number, shelves: readonly number[]): void {
  const { run, engine } = mh;
  mh.waitFor(
    () => mh.cursor.x === x && mh.cursor.y === y && shelves.includes(engine.vars[91]!),
    `the thrower at (${x},${y})`,
    2000,
  );
  run.key(AGI_KEY.ENTER);
  for (let t = 0; t < 400 && engine.vars[59] === 0; t++) {
    mh.step(1);
    if (t > 20 && engine.vars[95] === 0) break;
  }
}

/**
 * Coney Island: the Kewpie Doll Baseball booth. Logic 129 judges a pitch by
 * the ball's final column (v30, the thrower's x plus six) and shelf (v91: 2
 * top, 1 or 4 middle, 0 bottom); the prize sequence needs the third top doll,
 * then the second middle doll, then the fourth bottom doll (v90 10, 20, 30).
 * The barker then wants to see the medallion (v25 = 13 from the inventory)
 * and hands over the Data Card, item 15, which leads to the Orbs.
 */
export function coneyIsland(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(10, 6, 68, 157, 129);
  mh.step(200);
  run.checkpoint("Coney Island", { room: 129 });
  // The path hotspot snaps the cursor to (34,125); Enter from there opens the
  // booth choice. Moving after the snap would select the darts booth instead.
  mh.hotspot(1, 40, 100);
  assert.match(mh.hint(), /test your skills/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 1, "the booth choice", 300);
  mh.step(5);
  mh.hotspot(2, 96, 100);
  assert.match(mh.hint(), /Kewpie Doll/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 2, "the booth", 300);
  mh.waitFor(() => mh.hint().includes("throw"), "the first ball", 300);
  assert.equal(engine.vars[62], 2, "the Kewpie Doll booth");
  run.checkpoint("Kewpie Doll Baseball", { room: 129 });
  pitch(mh, 77, 105, [2]);
  assert.equal(engine.vars[90], 10, "the first pitch hit the third top doll");
  pitch(mh, 65, 135, [1, 4]);
  assert.equal(engine.vars[90], 20, "the second pitch hit the second middle doll");
  pitch(mh, 89, 165, [0]);
  mh.waitFor(() => engine.vars[59] === 4, "the barker's odd look", 1500);
  // Tab lists the carried items by number (Twelve Keycards 11, Medallion 13,
  // MAD 14); Right moves to the medallion and Enter shows it (v25 = 13).
  run.key(AGI_KEY.TAB);
  mh.step(6);
  assert.equal(engine.modalKind, "inventory");
  run.key(AGI_KEY.RIGHT);
  mh.step(1);
  run.key(AGI_KEY.ENTER);
  mh.step(12);
  assert.equal(engine.flags[72], 1, "the barker accepted the medallion");
  mh.waitFor(() => engine.vars[59] === 3, "the prize offer", 2500);
  mh.hotspot(1, 120, 100);
  assert.match(mh.hint(), /take your prize/);
  run.key(AGI_KEY.ENTER);
  mh.waitForRoom(131, "the Orbs", 600);
  run.assertCarried(15, "the Data Card");
}

/**
 * The Orbs read the Data Card, demand the suspect's name and send Mick home.
 * Logic 131 parses the reply without testing it on Day 1. Each stage of v50
 * and v47 waits for one Enter; the closing sequence runs on clock waits and
 * sets v60 = 2 before new.room(104).
 */
export function orbs(mh: Manhunter): void {
  const { run, engine } = mh;
  run.checkpoint("Orbs", { room: 131 });
  run.answer("Reno Davis");
  let acknowledged = "";
  for (let t = 0; t < 12000 && engine.vars[0] === 131; t++) {
    mh.step(1);
    const stage = `${engine.vars[50]}/${engine.vars[47]}`;
    if (stage !== acknowledged && mh.hint().includes("Press <ENTER>")) {
      acknowledged = stage;
      run.key(AGI_KEY.ENTER);
    }
  }
  mh.waitForRoom(104, "home", 600);
  mh.step(30);
  assert.equal(engine.vars[60], 2, "Day 2 begins");
  run.checkpoint("Home, Day 2", { room: 104 });
}
