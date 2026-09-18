import assert from "node:assert/strict";
import { directionForDelta } from "../../src/agent/gameTestSteps.ts";
import { AGI_KEY, DIRECTION_KEYS } from "../../src/runtime/keys.ts";
import type { ScreenObject } from "../../src/runtime/screenObject.ts";
import { type DirectionInput, type Speedrun } from "./runner.ts";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import type { Walkthrough } from "./route.ts";

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
/** S (controller 33) skips the tracker's street-level replay. */
export const KEY_S = 0x53;
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

  /** Consume a queued sewer passage and observe its new scene before steering again. */
  settle(max = 400): void {
    const picture = this.engine.vars[250];
    const scene = this.engine.vars[50];
    this.waitFor(
      () => this.engine.vars[250] !== picture || this.engine.vars[50] !== scene,
      "the sewer passage changes its picture or scene",
      max,
    );
    this.waitFor(
      () => this.cursor.active && !this.engine.continuationPending,
      "the passage returns cursor control",
      max,
    );
    this.cycle();
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

/** The complete game: four days and the ending. */
export function mh1Complete(run: Speedrun): void {
  day1(run);
  day2(run);
  day3(run);
  day4(run);
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
  run.checkpoint("Tracker replay begins", { room: 101 });
  run.key(AGI_KEY.ENTER);
  mh.waitFor(
    () => Boolean(engine.flags[38] && engine.flags[65]),
    "the tracker's first two segments",
    9000,
  );
  run.checkpoint("Tracking the suspect", {});
  mh.waitFor(
    () => Boolean(engine.flags[69] && engine.flags[68] && engine.flags[38] && engine.flags[65]),
    "the tracker's four segments",
    9000,
  );
  assert.ok([124, 125].includes(engine.vars[0]!), `tracker rooms; ${mh.describe()}`);
  run.checkpoint("Tracker replay complete", {});
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
  run.checkpoint("Consult the MAD", { room: 101 });
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
  run.checkpoint("Enter the maze challenge", { room: 126 });
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
  let nextHighlight = 4;
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
    const collected =
      MAZE_ROUTE.filter((square) => engine.flags[square.flag]).length +
      Number(Boolean(engine.flags[151])) +
      Number(Boolean(engine.flags[152]));
    if (collected >= nextHighlight && nextHighlight < 12) {
      run.checkpoint(
        nextHighlight === 4
          ? "Maze: four squares collected"
          : nextHighlight === 8
            ? "Maze: eight squares collected"
            : "Maze: ten squares collected",
        { room: 126 },
      );
      nextHighlight = nextHighlight === 4 ? 8 : nextHighlight === 8 ? 10 : 12;
    }
  }
  const squares = [151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162].filter(
    (f) => engine.flags[f],
  ).length;
  assert.equal(squares, 12, "all twelve maze squares were collected");
  run.checkpoint("Maze challenge completed", { room: 126 });
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
      const previousCards = engine.vars[61]!;
      run.key(AGI_KEY.ENTER);
      mh.waitFor(() => engine.vars[61] === previousCards + 1, "the keycard is collected", 300);
      mh.cycle();
      cards++;
      if (cards % 4 === 0) run.checkpoint(`${cards} sewer keycards collected`, { room: 128 });
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
  run.checkpoint("Recover the medallion", { room: 128 });
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
  mh.run.checkpoint("Deliver the Data Card to the Orbs", { room: 131 });
  reportToOrbs(mh, ["Reno Davis"], 2);
  mh.run.checkpoint("Home, Day 2", { room: 104 });
}

/**
 * Every day ends before the Orbs (room 131), who ask for suspects: one name
 * on Days 1 and 3, three on Day 2 (v91 counts the prompts while v60 is 3).
 * The replies are parsed but never tested. Each stage waits for one Enter and
 * the closing sequence runs on clock waits into new.room(104).
 */
function reportToOrbs(mh: Manhunter, names: readonly string[], day: number): void {
  const { run, engine } = mh;
  for (const name of names) run.answer(name);
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
  assert.equal(engine.vars[60], day, `Day ${day} begins`);
}

/**
 * Day 2 opens on the MAD like Day 1, but its tracker (rooms 132, 133 and 142)
 * follows three signals leaving Bellevue, and a location only appears on the
 * city map once its signal has been followed there: the default target 1
 * reaches the nightclub (f67), target 3 the museum (f63) and target 2 crosses
 * Grand Central into Central Park (f64). Logic 133 keeps the replay stage in
 * v63 and only a finished replay clears it, so the first two are watched to
 * their end and the last is closed with C once the park has registered.
 */
export function day2Tracker(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.waitForRoom(101, "the MAD on Day 2", 6000);
  mh.waitFor(() => mh.hint().includes("Press <ENTER>"), "the tracker prompt");
  run.checkpoint("Day 2 tracker", { room: 101 });
  const follow = (target: number): void => {
    run.key(AGI_KEY.ENTER);
    mh.waitForRoom(132, "the tracker");
    mh.waitFor(() => mh.cursor.active && engine.vars[50] === 0, "the three signals");
    mh.step(12);
    if (target > 1) {
      // Targets 2 and 3 are objects 3 and 4; the room registers 20 or 21 in
      // v48 within ten pixels and Enter tags the signal (v54). The signals
      // walk east, so the cursor chases the live position.
      const signal = engine.screenObjects[target + 1]!;
      for (let n = 0; n < 600 && engine.vars[48] !== 18 + target; n++) {
        run.direction(
          directionForDelta(Math.sign(signal.x - mh.cursor.x), Math.sign(signal.y - mh.cursor.y)),
        );
        run.advance();
      }
      run.direction(0);
      assert.equal(engine.vars[48], 18 + target, `signal ${target} under the cursor`);
      mh.enter(12);
    }
    assert.equal(engine.vars[54], target, `signal ${target} tagged`);
    run.key(KEY_S);
    mh.waitForRoom(133, "the zoomed-out replay");
  };
  follow(1);
  mh.waitFor(() => engine.vars[0] === 101 && engine.vars[50] === 2, "the nightclub replay", 4000);
  assert.equal(engine.flags[67], 1, "the nightclub is on the map");
  assert.equal(mh.engine.vars[0], 101, "Tracked a signal to the nightclub");
  follow(3);
  mh.waitFor(() => engine.vars[0] === 101 && engine.vars[50] === 2, "the museum replay", 6000);
  assert.equal(engine.flags[63], 1, "the museum is on the map");
  assert.equal(mh.engine.vars[0], 101, "Tracked a signal to the museum");
  follow(2);
  mh.waitFor(() => engine.vars[0] === 132 && engine.vars[50] === 1, "Grand Central", 2000);
  run.key(KEY_S);
  mh.waitForRoom(142, "the Central Park replay", 2000);
  assert.equal(engine.flags[64], 1, "Central Park is on the map");
  mh.step(30);
  mh.key(KEY_C, 120);
  run.checkpoint("Tracked a signal into Central Park", { room: ROOM_MAP });
}

/**
 * The reflex sequences (the alley gang, the knifeman, and Day 4's chases) draw
 * on the interpreter's random stream every cycle, so a recorded key list only
 * fits one exact history of random draws, and that history shifts with how
 * long message windows stay open. They are therefore played the way a person
 * plays them, by looking ahead: whenever the game would accept a key, each
 * candidate key is tried on a fork of the running engine and the first one
 * that is still alive `horizon` cycles later is pressed for real. Forks only
 * ever receive key presses, and only the chosen keys reach the recorded tape,
 * so two cold boots search identically and record the same actions.
 */
interface ReflexGame {
  label: string;
  /** Mick was hit: the game is about to rewind the sequence. */
  lost(engine: Speedrun["engine"]): boolean;
  won(engine: Speedrun["engine"]): boolean;
  /** Candidate keys in order of preference while input is accepted (0 waits a cycle). */
  options(engine: Speedrun["engine"]): readonly number[];
  /** Lookahead in interpreter cycles. */
  horizon: number;
}

function reflexCycle(run: Speedrun): void {
  const from = run.cycles;
  for (let t = 0; t < 80 && run.cycles === from; t++) {
    run.advance();
    if (run.engine.modalKind === "print") run.dismiss();
  }
}

/** Press `key` (0 waits) and run on until the game accepts input again. Returns cycles spent. */
function reflexStep(run: Speedrun, game: ReflexGame, key: number): number {
  if (key) run.key(key);
  let spent = 0;
  do {
    reflexCycle(run);
    spent++;
  } while (
    spent < 40 &&
    !game.lost(run.engine) &&
    !game.won(run.engine) &&
    game.options(run.engine).length === 0
  );
  return spent;
}

function reflexSurvives(
  run: Speedrun,
  game: ReflexGame,
  cycles: number,
  budget: { nodes: number },
): boolean {
  if (game.lost(run.engine)) return false;
  if (cycles <= 0 || game.won(run.engine)) return true;
  for (const key of game.options(run.engine)) {
    if (--budget.nodes < 0) return false;
    const branch = run.fork();
    const spent = reflexStep(branch, game, key);
    if (reflexSurvives(branch, game, cycles - spent, budget)) return true;
  }
  return false;
}

function playReflex(mh: Manhunter, game: ReflexGame, maxCycles = 4000): void {
  const { run, engine } = mh;
  for (let n = 0; n < maxCycles && !game.won(engine);) {
    assert.ok(!game.lost(engine), `${game.label}: Mick was hit; ${mh.describe()}`);
    const options = game.options(engine);
    let chosen = 0;
    if (options.length > 1) {
      chosen = -1;
      for (const key of options) {
        const branch = run.fork();
        const spent = reflexStep(branch, game, key);
        if (reflexSurvives(branch, game, game.horizon - spent, { nodes: 200 })) {
          chosen = key;
          break;
        }
      }
      assert.notEqual(chosen, -1, `${game.label}: no key survives the lookahead; ${mh.describe()}`);
    } else if (options.length === 1) chosen = options[0]!;
    n += reflexStep(run, game, chosen);
  }
  assert.ok(game.won(engine), `${game.label}: not finished; ${mh.describe()}`);
}

/**
 * The alley gang (room 137): four throwers in turn (v105), each hurling
 * knives low (jump, Up) or high (duck, Down). A jump also carries Mick toward
 * the thrower and Enter punches once he is in reach (v102 = 1). A hit sets
 * v101 = 3 (a knife) or v104 = 1 (the thrower) and the game rewinds the stage.
 * Input is read while v59 (jump or duck in progress) and v102 (punch in
 * progress) are idle.
 */
function alleyGang(stage: number): ReflexGame {
  return {
    label: `alley thrower ${stage}`,
    lost: (e) => e.vars[101] === 3 || e.vars[101] === 2 || e.vars[104] === 1 || e.vars[50] === 2,
    won: (e) => e.vars[0] !== 137 || e.vars[105]! > stage || e.vars[50] === 1,
    options: (e) => {
      const v = e.vars;
      if (v[50] !== 0 || v[59] !== 0 || v[102]! >= 2 || v[101]! >= 2 || e.flags[22]) return [];
      if (v[102] === 1) return [AGI_KEY.ENTER];
      return [AGI_KEY.UP, 0, AGI_KEY.DOWN];
    },
    horizon: 12,
  };
}

/** The nightclub's bouncer bars the door, so the way in is the alley on the left. */
export function nightclubAlley(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(7, 3, 44, 29, 141);
  mh.step(60);
  assert.equal(mh.engine.vars[0], 141, "Nightclub");
  mh.hotspot(2, 10, 150);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 1 && engine.vars[66] === 1, "the alley mouth");
  mh.waitFor(() => !engine.flags[22], "the alley accepts input", 600);
  mh.hotspot(1, 105, 130);
  run.key(AGI_KEY.ENTER);
  mh.waitForRoom(137, "the alley gang", 600);
  assert.equal(mh.engine.vars[0], 137, "Alley gang");
  for (let stage = 1; stage <= 4; stage++) {
    playReflex(mh, alleyGang(stage));
    if (stage === 2) assert.equal(mh.engine.vars[0], 137, "Two alley throwers down");
  }
  mh.waitForRoom(140, "inside the nightclub", 1200);
  run.checkpoint("Fought through the alley", { room: 140 });
}

/**
 * Inside the nightclub (room 140) the crowd scene registers one hotspot per
 * dancer; number 4 is the robed figure on the left. His close-up knocks Mick
 * over and a keycard slides across the floor (object 5); while it lies there
 * the floor region registers v48 = 25 and Enter takes it before the bouncer
 * arrives. That makes thirteen keycards (item 12, v61 = 13).
 */
export function nightclubKeycard(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.waitFor(() => engine.vars[50] === 1 && mh.cursor.active, "the dance floor", 3000);
  mh.hotspot(4, 28, 110);
  assert.match(mh.hint(), /closer look/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 3 && engine.vars[47] === 12, "knocked to the floor", 1500);
  mh.hotspot(25, 75, 128);
  assert.match(mh.hint(), /take Keycard/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => run.carried(12), "the thirteenth keycard", 600);
  assert.equal(engine.vars[61], 13, "thirteen keycards");
  run.checkpoint("Snatched the thirteenth keycard", { room: 140 });
  mh.waitForRoom(141, "thrown out by the bouncer", 3000);
  mh.step(60);
  mh.map();
}

/**
 * Central Park (room 136) is a minefield of eight views (v90). Each view
 * offers four arrows on the left edge (v48 1-4), thirteen along the horizon
 * (5-17), four on the right edge (18-21) and the way back along the bottom
 * (50); logic 136 accepts exactly one onward arrow per view and any other
 * detonates a mine. The safe arrows are 19, 8, 18, 6 to view 5, where 16
 * branches to the crowbar's clearing (view 8) and 7 continues through 18 and
 * 6 to the body the tracked signal ended at.
 */
const PARK_ARROWS: Record<number, readonly [number, number]> = {
  4: [0, 91],
  6: [32, 105],
  7: [42, 105],
  8: [49, 105],
  16: [132, 105],
  18: [144, 109],
  19: [144, 125],
  50: [77, 160],
};

export function centralPark(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(5, 1, 54, 100, 136);
  mh.step(60);
  assert.equal(mh.engine.vars[0], 136, "Central Park");
  const walk = (arrow: number, view: number): void => {
    mh.waitFor(() => !engine.flags[22] && mh.cursor.active, "the park view settles", 600);
    const [x, y] = PARK_ARROWS[arrow]!;
    mh.hotspot(arrow, x, y);
    run.key(AGI_KEY.ENTER);
    mh.waitFor(() => engine.vars[90] === view, `park view ${view}; ${mh.describe()}`, 600);
    assert.equal(engine.vars[50], 0, "no mine went off");
  };
  walk(19, 2);
  walk(8, 3);
  walk(18, 4);
  walk(6, 5);
  walk(16, 8);
  // In the clearing the far-left arrow leads to the crowbar's close-up.
  mh.waitFor(() => !engine.flags[22], "the clearing settles", 600);
  mh.hotspot(4, 0, 91);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 5 && !engine.flags[22], "the crowbar close-up", 600);
  mh.hotspot(1, 49, 70);
  assert.match(mh.hint(), /take the crowbar/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => run.carried(18), "the crowbar", 300);
  run.checkpoint("Pried the crowbar from the park", { room: 136 });
  // Back to view 5 and on to the body: its papers, then its face.
  mh.waitFor(() => engine.vars[50] === 0 && !engine.flags[22], "the clearing again", 600);
  walk(50, 5);
  walk(7, 6);
  walk(18, 7);
  mh.waitFor(() => !engine.flags[22], "the monument view settles", 600);
  mh.hotspot(6, 32, 105);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 3 && !engine.flags[22], "the body in the park", 600);
  run.checkpoint("Found the body in the park", { room: 136 });
  for (const [spot, x, y] of [
    [1, 51, 160],
    [2, 94, 141],
  ] as const) {
    mh.hotspot(spot, x, y);
    assert.match(mh.hint(), /closer look/);
    run.key(AGI_KEY.ENTER);
    mh.waitFor(() => engine.vars[50] === 4 && !engine.flags[22], "the close-up", 600);
    mh.step(60);
    run.key(AGI_KEY.ENTER);
    mh.waitFor(() => engine.vars[50] === 3 && !engine.flags[22], "back at the body", 600);
  }
  madInfo(mh, "Harvey Osborne", 136);
  assert.equal(engine.flags[35], 1, "the Osborne address is on the map");
  mh.map();
}

/**
 * Tab lists the carried items in item order with the first selected; Right
 * steps the selection and Enter uses the item (the game reads it from v25).
 */
function useItem(mh: Manhunter, item: number, name: string): void {
  const { run, engine } = mh;
  run.assertCarried(item, name);
  let index = 0;
  for (let i = 0; i < item; i++) if (run.carried(i)) index++;
  run.key(AGI_KEY.TAB);
  // The key is read on the next interpreter cycle, however slow the room runs.
  for (let t = 0; t < 120 && engine.modalKind !== "inventory"; t++) run.advance();
  assert.equal(engine.modalKind, "inventory", `inventory opens for ${name}`);
  for (let i = 0; i < index; i++) {
    run.key(AGI_KEY.RIGHT);
    mh.step(1);
  }
  run.key(AGI_KEY.ENTER);
  mh.step(12);
}

/** Open the MAD with C, ask Info about each name, say bye and close it again. */
function madInfo(mh: Manhunter, names: string | readonly string[], room: number): void {
  const { run } = mh;
  mh.key(KEY_C, 30);
  mh.waitForRoom(101, "the MAD");
  mh.step(60);
  mh.cursorTo(30, 40);
  for (const name of typeof names === "string" ? [names] : names) {
    run.answer(name);
    mh.enter(120);
  }
  run.answer("bye");
  mh.enter(120);
  mh.key(KEY_C);
  mh.waitForRoom(room, "the MAD closes");
  mh.step(60);
}

/**
 * The Osborne house (room 106): through the front door and the hall into the
 * living room (v50 0, 1, 2), where the shopping bag's close-up (v50 = 4)
 * holds the museum key, item 20. Enter on empty floor backs out one scene.
 */
export function osborneHouse(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(12, 1, 35, 57, 106);
  mh.step(60);
  assert.equal(mh.engine.vars[0], 106, "Osborne house");
  const scene = (spot: number, x: number, y: number, next: number): void => {
    mh.waitFor(() => !engine.flags[22] && mh.cursor.active, "the scene settles", 600);
    mh.hotspot(spot, x, y);
    run.key(AGI_KEY.ENTER);
    mh.waitFor(() => engine.vars[50] === next, `house scene ${next}; ${mh.describe()}`, 600);
  };
  scene(1, 75, 138, 1);
  scene(1, 37, 130, 2);
  scene(3, 114, 135, 4);
  mh.waitFor(() => !engine.flags[22], "the shopping bag", 600);
  mh.hotspot(1, 72, 96);
  assert.match(mh.hint(), /take the key/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => run.carried(20), "the museum key", 300);
  run.checkpoint("Took the key from the shopping bag", { room: 106 });
  for (const next of [2, 1, 0]) {
    mh.waitFor(() => !engine.flags[22], "free to back out", 600);
    // The hall's door arrow covers x 21-118, so the cursor steps aside first.
    if (engine.vars[48] !== 0) mh.glide(3, () => engine.vars[48] === 0, "clear of the door arrow");
    run.key(AGI_KEY.ENTER);
    mh.waitFor(
      () => engine.vars[50] === next,
      `backing out to scene ${next}; ${mh.describe()}`,
      600,
    );
    mh.step(6);
  }
  mh.map();
}

/** The museum's front doors never open; the glass side doors take the Osborne key. */
export function museumDoors(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(4, 1, 47, 72, 134);
  mh.step(60);
  assert.equal(mh.engine.vars[0], 134, "Museum of Natural History");
  mh.hotspot(2, 140, 90);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 2 && !engine.flags[22], "the side doors", 600);
  assert.equal(engine.flags[60], 1, "the side doors start locked");
  useItem(mh, 20, "the key");
  mh.waitFor(() => !engine.flags[60], "the key unlocks the doors", 300);
  mh.hotspot(9, 58, 104);
  run.key(AGI_KEY.ENTER);
  mh.waitForRoom(127, "inside the museum", 900);
  run.checkpoint("Unlocked the museum's side doors", { room: 127 });
}

/**
 * The museum interior (room 127) is a first-person grid: v151 is the cell
 * (seven per row), v150 the facing (0 north, 1 south, 2 west, 3 east) and
 * v156 the floor. The cursor picks a passage by column — left of 66, 66-89
 * ahead, right of 90 — and the room answers in v51: 1-3 an open passage,
 * 4-6 a keycard door, 7-9 a wall. A door's close-up takes one keycard from
 * the inventory, slides open (f163) and shuts again after a few seconds, so
 * the same passage is entered at once. Staircases sit west of cells 104 and
 * 121 and east of 122 and turn Mick around on the next floor. The route
 * follows the tracked signal: up at 122, the north corridor to the 104
 * stairs, back to the 121 stairs, then the south and west corridors of the
 * fourth floor to cell 97, spending exactly the thirteen keycards.
 */
const MUSEUM_ROUTE = "LFRFLFFFFFFRFRRFRFFRFFFF";
const MUSEUM_PASSAGES: Record<string, readonly number[]> = {
  F: [1, 5, 9],
  L: [2, 4, 7],
  R: [3, 6, 8],
};

function museumSelect(mh: Manhunter, turn: string): number {
  const { engine } = mh;
  const passages = MUSEUM_PASSAGES[turn]!;
  // A finished move leaves v51 = 10 until the room re-registers the cursor.
  for (let c = 0; c < 3 && engine.vars[51] === 10; c++) mh.cycle();
  if (!passages.includes(engine.vars[51]!)) {
    const x = mh.cursor.x;
    const dir = turn === "L" ? 7 : turn === "R" ? 3 : x < 66 ? 3 : 7;
    mh.glide(dir, () => passages.includes(engine.vars[51]!), `museum passage ${turn}`);
  }
  return engine.vars[51]!;
}

export function museumMaze(mh: Manhunter): void {
  const { run, engine } = mh;
  const settled = (): boolean =>
    engine.vars[50] === 0 && !engine.flags[22] && !engine.flags[162] && mh.cursor.active;
  let step = 0;
  for (const turn of MUSEUM_ROUTE) {
    step++;
    mh.waitFor(settled, `museum step ${step} settles`, 900);
    let passage = museumSelect(mh, turn);
    assert.ok(passage < 7, `museum step ${step} (${turn}) is not a wall; ${mh.describe()}`);
    if (passage >= 4) {
      const cards = engine.vars[61]!;
      run.key(AGI_KEY.ENTER);
      mh.waitFor(() => engine.vars[50] === 1 && !engine.flags[22], "the keycard slot", 600);
      // The keycard stack is always the first inventory item.
      run.key(AGI_KEY.TAB);
      mh.step(6);
      assert.equal(engine.modalKind, "inventory");
      run.key(AGI_KEY.ENTER);
      mh.waitFor(
        () => engine.vars[50] === 0 && Boolean(engine.flags[163]),
        "the door slides open",
        900,
      );
      assert.equal(engine.vars[61], cards - 1, "one keycard spent");
      mh.waitFor(() => !engine.flags[22] && mh.cursor.active, "the cursor returns", 300);
      passage = museumSelect(mh, turn);
      assert.ok(passage <= 3, `the opened door at step ${step}; ${mh.describe()}`);
    }
    const before = `${engine.vars[151]}/${engine.vars[150]}/${engine.vars[156]}`;
    run.key(AGI_KEY.ENTER);
    mh.waitFor(
      () =>
        engine.vars[0] === 135 ||
        `${engine.vars[151]}/${engine.vars[150]}/${engine.vars[156]}` !== before,
      `museum step ${step} moves`,
      900,
    );
    if (step === 8) {
      assert.equal(engine.vars[156], 3, "third floor");
      assert.equal(mh.engine.vars[0], 127, "Climbed to the museum's third floor");
    }
    if (step === 14) {
      assert.equal(engine.vars[156], 4, "fourth floor");
      run.checkpoint("Reached the museum's fourth floor", { room: 127 });
    }
  }
  mh.waitForRoom(135, "the barricaded hall", 900);
  assert.equal(engine.vars[61], 0, "all thirteen keycards spent");
  assert.equal(mh.engine.vars[0], 135, "Spent the last keycard");
}

/**
 * The barricaded hall (room 135): the crowbar (v25 = 18) breaks the planks,
 * which wakes the guardian behind them; it charges from the right and kills
 * Mick once its x drops under 53, unless the medallion (v25 = 13) is shown
 * first. It then clears the doorway itself (f73).
 */
export function museumGuardian(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.waitFor(() => !engine.flags[22] && mh.cursor.active, "the planked door", 600);
  useItem(mh, 18, "the crowbar");
  mh.waitFor(() => engine.vars[50] === 1, "the guardian wakes", 600);
  useItem(mh, 13, "the medallion");
  mh.waitFor(() => engine.flags[73] === 1, "the guardian yields", 600);
  mh.waitFor(
    () => engine.vars[50] === 0 && !engine.flags[22] && mh.cursor.active,
    "the way is clear",
    3000,
  );
  run.checkpoint("Showed the guardian the medallion", { room: 135 });
  // Three views lead on (v50 0, 4, 6) to the laboratory (v50 = 8); entering
  // it sets f77, the flag the city map reads to end the day.
  for (const next of [4, 6, 8]) {
    mh.waitFor(() => !engine.flags[22] && mh.cursor.active, "the corridor settles", 900);
    if (engine.vars[48] !== 0) mh.glide(1, () => engine.vars[48] === 0, "the onward arrow");
    run.key(AGI_KEY.ENTER);
    mh.waitFor(() => engine.vars[50] === next, `hall view ${next}; ${mh.describe()}`, 1200);
  }
  assert.equal(engine.flags[77], 1, "the laboratory was reached");
  assert.equal(mh.engine.vars[0], 135, "Found the laboratory");
  mh.waitFor(() => !engine.flags[22], "the laboratory settles", 600);
  mh.hotspot(1, 104, 149);
  assert.match(mh.hint(), /closer look/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 9 && !engine.flags[22], "the dead scientist", 600);
  mh.hotspot(1, 32, 106);
  assert.match(mh.hint(), /take Module B/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => run.carried(16), "Module B", 300);
  run.checkpoint("Took Module B", { room: 135 });
  mh.step(30);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 8, "back in the laboratory", 600);
  mh.step(30);
  // Travel: with f77 set the city map advances v60 to 3 and hands over to the Orbs.
  mh.key(AGI_KEY.F3);
  mh.waitForRoom(131, "summoned by the Orbs", 1800);
  assert.equal(mh.engine.vars[0], 131, "Summoned to the Orbs with Module B");
  reportToOrbs(mh, ["Harvey Osborne", "Anna Osborne", "Reno Davis"], 3);
  run.checkpoint("Home, Day 3", { room: 104 });
}

export function day2(run: Speedrun): void {
  const mh = new Manhunter(run);
  day2Tracker(mh);
  nightclubAlley(mh);
  nightclubKeycard(mh);
  centralPark(mh);
  osborneHouse(mh);
  museumDoors(mh);
  museumMaze(mh);
  museumGuardian(mh);
}

/**
 * Day 3's tracker (rooms 116 and 115) follows one signal from the cemetery
 * (f80) past the Times Square theatre (f81) to the pawn shop (f82); S skips
 * each street-level replay and C closes the MAD once the shop has registered.
 */
export function day3Tracker(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.waitForRoom(101, "the MAD on Day 3", 8000);
  mh.waitFor(() => mh.hint().includes("Press <ENTER>"), "the tracker prompt");
  assert.equal(mh.engine.vars[0], 101, "Day 3 tracker");
  run.key(AGI_KEY.ENTER);
  for (const flag of [80, 81, 82]) {
    mh.waitFor(
      () => engine.vars[0] === 116 && engine.flags[flag] === 1,
      `tracker flag ${flag}`,
      3000,
    );
    if (flag !== 82) {
      mh.waitFor(() => mh.hint().includes("Press S"), "the skip prompt", 300);
      run.key(KEY_S);
      mh.waitForRoom(115, "the zoomed-out replay", 300);
    }
  }
  mh.step(30);
  mh.key(KEY_C, 120);
  assert.equal(mh.engine.vars[0], ROOM_MAP, "Tracked the signal to the pawn shop");
}

/**
 * Trinity Church (room 111): the left candle stand (v93 = 1) holds fifteen
 * candles in three rows of five, flags 151-165. A match from the tray (v92 =
 * 1) burns for three nine-second stages (v90). With exactly the first candle
 * of the top row, the third of the middle row and the fourth of the bottom
 * row alight (f151, f158, f164) the panel above slides open (v50 = 3) on
 * Module A, item 22.
 */
export function churchCandles(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(13, 3, 73, 152, 111);
  mh.step(120);
  assert.equal(mh.engine.vars[0], 111, "Trinity Church again");
  mh.cursorTo(72, 150);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 1 && !engine.flags[22], "inside the church", 600);
  mh.hotspot(1, 10, 135);
  assert.match(mh.hint(), /closer look/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 2 && !engine.flags[22], "the candle stand", 600);
  mh.hotspot(16, 94, 162);
  assert.match(mh.hint(), /take a match/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[92] === 1, "a lit match", 120);
  for (const [candle, x, y, flag] of [
    [1, 33, 38, 151],
    [8, 80, 77, 158],
    [14, 103, 115, 164],
  ] as const) {
    mh.hotspot(candle, x, y);
    assert.match(mh.hint(), /light this candle/);
    assert.equal(engine.vars[92], 1, "the match still burns");
    run.key(AGI_KEY.ENTER);
    mh.waitFor(() => engine.flags[flag] === 1, `candle ${candle} lit`, 120);
  }
  mh.waitFor(() => engine.vars[50] === 3, "the hidden panel opens", 300);
  assert.equal(mh.engine.vars[0], 111, "Lit the three candles");
  mh.waitFor(() => engine.vars[50] === 2 && engine.vars[94] === 1, "the open panel", 600);
  mh.hotspot(20, 72, 38);
  assert.match(mh.hint(), /take Module A/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => run.carried(22), "Module A", 120);
  run.checkpoint("Took Module A from the church", { room: 111 });
  // Leave things as they were: snuff the candles, step back, walk out.
  mh.hotspot(75, 72, 100);
  assert.match(mh.hint(), /extinguish/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(
    () => !engine.flags[151] && !engine.flags[158] && !engine.flags[164],
    "candles out",
    120,
  );
  mh.hotspot(76, 30, 150);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 1 && !engine.flags[22], "back in the nave", 600);
  mh.cursorTo(80, 160);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 0 && engine.vars[66] === 0, "outside the church", 600);
  mh.step(60);
  mh.map();
}

/**
 * Abdul's pawn shop (room 145). His badge case (v50 = 2) registers fifteen
 * badges; logic 145 accepts only numbers 4, 7 and 13 (f155-f157) and any
 * other choice gets Mick beheaded. With all three bought Abdul pulls the
 * trap-door lever and Mick lands in the rooms underneath (room 147).
 */
export function pawnShop(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(17, 3, 83, 42, 145);
  mh.step(60);
  assert.equal(mh.engine.vars[0], 145, "Abdul's pawn shop");
  mh.hotspot(1, 17, 54);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 1 && !engine.flags[22], "the shop front", 600);
  mh.hotspot(1, 78, 115);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 2 && !engine.flags[22], "the badge case", 600);
  for (const [badge, x, y, flag] of [
    [4, 94, 71, 155],
    [7, 123, 89, 156],
    [13, 26, 150, 157],
  ] as const) {
    mh.waitFor(() => !engine.flags[22], "the case settles", 300);
    mh.hotspot(badge, x, y);
    assert.match(mh.hint(), /select this badge/);
    run.key(AGI_KEY.ENTER);
    mh.waitFor(() => engine.flags[flag] === 1, `badge ${badge} bought`, 120);
  }
  assert.ok(run.carried(25) || run.carried(27), "badges in the inventory");
  run.checkpoint("Bought the three badges", { room: 145 });
  mh.waitForRoom(147, "dropped through the trap door", 3000);
  assert.equal(mh.engine.vars[0], 147, "Fell into the rooms under the shop");
}

/**
 * Four identical rooms (room 147, v150 = 1-4), each with a painting whose
 * close-up hides a row of ten buttons along the bottom edge (button 10 is
 * the zero). Logic 147 advances v151 on each correct press and opens the
 * door (f152) on the last; a wrong press (f28 alone) floods the room. The codes written
 * into the logic are 4-1, 1-0-3-1, 2-6-4 and 4-2-5; presses are accepted one
 * second apart.
 */
const PAINTING_CODES: readonly (readonly number[])[] = [
  [4, 1],
  [1, 10, 3, 1],
  [2, 6, 4],
  [4, 2, 5],
];

export function paintingRooms(mh: Manhunter): void {
  const { run, engine } = mh;
  PAINTING_CODES.forEach((code, index) => {
    const room = index + 1;
    mh.waitFor(
      () =>
        engine.vars[50] === 0 && engine.vars[150] === room && !engine.flags[22] && mh.cursor.active,
      `painting room ${room}`,
      1800,
    );
    // v48 can still hold a 1 from the keypad, so the hint line is not re-shown.
    mh.cursorTo(83, 100);
    assert.equal(engine.vars[48], 1, `the painting registers; ${mh.describe()}`);
    run.key(AGI_KEY.ENTER);
    mh.waitFor(() => engine.vars[50] === 1 && !engine.flags[22], "the painting", 600);
    mh.glide(5, () => engine.flags[154] === 1, "down to the button row");
    for (const button of code) {
      // Button n spans 14 pixels from x = 11 + 14 (n - 1); its anchor sits mid-span.
      mh.hotspot(button, 1 + 14 * button, 167);
      assert.match(mh.hint(), /press a button/);
      mh.waitFor(
        () => !engine.flags[22] && engine.vars[49]! < engine.vars[11]!,
        "the keypad accepts a press",
        300,
      );
      const progress = engine.vars[151];
      run.key(AGI_KEY.ENTER);
      mh.waitFor(
        () => engine.vars[151] !== progress || engine.flags[152] === 1 || engine.flags[28] === 1,
        "the press lands",
        120,
      );
      // f28 starts the outcome animation; without f152 that outcome is the flood.
      assert.ok(
        !engine.flags[28] || engine.flags[152] === 1,
        `button ${button} is right in room ${room}`,
      );
    }
    assert.equal(engine.flags[152], 1, `code ${room} accepted`);
    mh.waitFor(() => engine.vars[150] === room + 1, `door ${room} opens`, 1800);
    if (room === 2) assert.equal(mh.engine.vars[0], 147, "Two painting codes solved");
  });
  mh.waitFor(() => engine.vars[50] === 5 && !engine.flags[22], "the last room", 900);
  run.checkpoint("Solved the four painting codes", { room: 147 });
  // The last room holds another body; the passage behind it leads to a manhole.
  mh.hotspot(1, 45, 109);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 6 && !engine.flags[22], "the body's close-up", 600);
  mh.step(60);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 5 && !engine.flags[22], "back in the last room", 600);
  mh.hotspot(2, 53, 77);
  run.key(AGI_KEY.ENTER);
  mh.waitForRoom(148, "the manhole ladder", 900);
}

/**
 * The knifeman under the manhole (room 148): he lunges low (v92 2-4, duck
 * with Down) or high (5-7, jump with Up) and a punch (Enter) only connects
 * when he fails to dodge. One clean punch makes him run (v50 = 4) and drop a
 * note (f153); the MAD scans it (f121) and the ladder leads up to the street
 * by the Empire State Building (room 109).
 */
const MANHOLE_FIGHT: ReflexGame = {
  label: "manhole knifeman",
  lost: (e) => e.vars[50] === 2 || e.vars[50] === 3,
  won: (e) => e.vars[50] === 4 || e.vars[50] === 5,
  options: (e) => {
    const v = e.vars;
    if (v[50] !== 1 || v[90] !== 0 || v[47] !== 0) return [];
    return [AGI_KEY.ENTER, 0, AGI_KEY.UP, AGI_KEY.DOWN];
  },
  horizon: 8,
};

export function manholeFight(mh: Manhunter): void {
  const { run, engine } = mh;
  assert.equal(mh.engine.vars[0], 148, "Knifeman at the manhole");
  mh.waitFor(() => engine.vars[50] === 1, "the knifeman squares up", 900);
  playReflex(mh, MANHOLE_FIGHT);
  mh.waitFor(() => engine.vars[50] === 5 && !engine.flags[22] && mh.cursor.active, "he runs", 1800);
  assert.equal(engine.flags[153], 1, "he dropped a note");
  mh.hotspot(2, 88, 140);
  assert.match(mh.hint(), /take the note/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 7 && !engine.flags[22], "the note", 900);
  assert.equal(engine.flags[121], 1, "the note is in the MAD");
  run.checkpoint("Took the knifeman's note", { room: 148 });
  mh.step(60);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(
    () => engine.vars[50] === 5 && !engine.flags[22] && mh.cursor.active,
    "the MAD autoscan",
    1800,
  );
  mh.hotspot(1, 105, 56);
  run.key(AGI_KEY.ENTER);
  mh.waitForRoom(109, "up the ladder to the street", 1800);
  mh.step(60);
  assert.equal(mh.engine.vars[0], 109, "Climbed out by the Empire State Building");
}

/**
 * The Times Square theatre (rooms 144 and 146). In the office the left
 * picture comes off the wall on the first Enter and its wall safe opens on
 * the second (v50 = 2). The keypad is a 3 x 3 grid plus an entry bar
 * (v48 = 11); logic 146 counts correct digits in v90 and the bar opens the
 * safe (f155) only at six. The knifeman's note reads 843769. Inside lies the
 * slip with the Alliance computer's password, which the MAD scans (f120).
 */
const SAFE_BUTTONS: Record<number, readonly [number, number]> = {
  3: [129, 60],
  4: [67, 92],
  6: [129, 92],
  7: [67, 124],
  8: [98, 124],
  9: [129, 124],
  11: [100, 158],
};

export function theatreSafe(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.map();
  mh.travel(15, 2, 59, 37, 144);
  mh.step(60);
  assert.equal(mh.engine.vars[0], 144, "Times Square theatre");
  mh.hotspot(1, 64, 127);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 1 && !engine.flags[22], "the lobby", 600);
  mh.hotspot(1, 128, 110);
  run.key(AGI_KEY.ENTER);
  mh.waitForRoom(146, "the office", 900);
  mh.waitFor(
    () => engine.vars[50] === 1 && !engine.flags[22] && mh.cursor.active,
    "the office settles",
    600,
  );
  mh.hotspot(1, 18, 98);
  assert.match(mh.hint(), /remove picture/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[47] === 1 && !engine.flags[22], "the picture is off the wall", 300);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 2 && !engine.flags[22], "the wall safe", 600);
  for (const digit of [8, 4, 3, 7, 6, 9, 11]) {
    const [x, y] = SAFE_BUTTONS[digit]!;
    mh.waitFor(() => !engine.flags[22], "the keypad settles", 300);
    mh.hotspot(digit, x, y);
    // v91 is the display column of the echoed digit; the entry bar resets it.
    const column = engine.vars[91];
    run.key(AGI_KEY.ENTER);
    mh.waitFor(() => engine.vars[91] !== column, `key ${digit} echoed`, 120);
  }
  assert.equal(engine.flags[155], 1, "the safe accepted 843769");
  assert.equal(mh.engine.vars[0], 146, "Opened the theatre safe");
  // The door stays open for ten seconds (v93).
  mh.hotspot(15, 39, 108);
  assert.match(mh.hint(), /take the note/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.flags[120] === 1 && engine.vars[50] === 3, "the password slip", 300);
  run.checkpoint("Took the password slip", { room: 146 });
  mh.waitFor(() => !engine.flags[22], "the slip is readable", 300);
  mh.step(60);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(
    () => engine.vars[50] === 2 && !engine.flags[22] && mh.cursor.active,
    "the MAD autoscan",
    1800,
  );
  // The autoscan leaves v48 = 0: one Enter re-arms the "back" state (v48 = 10)
  // and the next steps back into the office, where Travel works again.
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[48] === 10 && !engine.flags[22], "the back arrow", 300);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 1 && engine.flags[75] === 1, "back in the office", 600);
  mh.step(30);
}

/**
 * Harry Jones's house at the tip of Manhattan (room 113) appears on the map
 * once the MAD has looked him up (f101); the same session looks up Phil Cook
 * (f36, the Empire State Building). The radio in the back room hides Module C:
 * the crowbar (v25 = 18) smashes it (f95) and the module can be lifted out.
 */
export function jonesHouse(mh: Manhunter): void {
  const { run, engine } = mh;
  madInfo(mh, ["Harry Jones", "Phil Cook"], 146);
  assert.equal(engine.flags[101], 1, "the Jones address is on the map");
  assert.equal(engine.flags[36], 1, "the Empire State Building is on the map");
  mh.map();
  mh.travel(18, 4, 59, 16, 113);
  mh.step(60);
  assert.equal(mh.engine.vars[0], 113, "Harry Jones's house");
  const scene = (spot: number, x: number, y: number, next: number): void => {
    mh.waitFor(() => !engine.flags[22] && mh.cursor.active, "the scene settles", 600);
    mh.hotspot(spot, x, y);
    run.key(AGI_KEY.ENTER);
    mh.waitFor(() => engine.vars[50] === next, `Jones scene ${next}; ${mh.describe()}`, 600);
  };
  scene(1, 97, 64, 1);
  scene(1, 75, 138, 2);
  scene(1, 54, 90, 3);
  mh.waitFor(() => !engine.flags[22], "the radio", 600);
  useItem(mh, 18, "the crowbar");
  mh.waitFor(() => engine.flags[95] === 1, "the radio is smashed", 300);
  mh.hotspot(1, 78, 70);
  assert.match(mh.hint(), /take Module C/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => run.carried(23), "Module C", 300);
  run.checkpoint("Pried Module C out of the radio", { room: 113 });
  for (const next of [2, 1, 0]) {
    mh.waitFor(() => !engine.flags[22], "free to back out", 600);
    if (engine.vars[48] !== 0) mh.glide(3, () => engine.vars[48] === 0, "clear of the arrows");
    run.key(AGI_KEY.ENTER);
    mh.waitFor(
      () => engine.vars[50] === next,
      `backing out to scene ${next}; ${mh.describe()}`,
      600,
    );
    mh.step(6);
  }
  mh.map();
}

/**
 * The Alliance computer in the Empire State Building (rooms 109 and 149).
 * The power switch boots it, the prompt takes the password from the theatre
 * slip, and "Continue" past the warning sets f77, which ends the day at the
 * next Travel. Site Alpha's Security page lists the robot guarding
 * Bellevue's inner door on "Special Security" (f83); toggling it to Hall
 * Patrol is what lets Mick through on Day 4.
 */
export function allianceComputer(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(16, 2, 75, 89, 109);
  mh.step(60);
  assert.equal(mh.engine.vars[0], 109, "Empire State Building");
  mh.hotspot(1, 77, 147);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 1 && !engine.flags[22], "the burned-out lobby", 600);
  mh.hotspot(5, 58, 92);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 2 && !engine.flags[22], "the terminal", 600);
  mh.hotspot(1, 69, 167);
  run.answer("ucucc");
  run.key(AGI_KEY.ENTER);
  mh.waitForRoom(149, "the password is accepted", 1800);
  run.checkpoint("Logged in to the Alliance computer", { room: 149 });
  const pick = (menu: number, item: number, y: number, label: string): void => {
    mh.waitFor(
      () =>
        engine.vars[0] === 149 && engine.vars[47] === menu && !engine.flags[22] && mh.cursor.active,
      `${label} menu`,
      2400,
    );
    // A menu change parks the cursor at the top but can leave the previous
    // item number in v48, so the cursor must really stand on the item: Enter
    // outside its rows would clear v48 on the way into the cutscene room.
    mh.glide(
      mh.cursor.y < y ? 5 : 1,
      () => engine.vars[48] === item && Math.abs(mh.cursor.y - y) <= 5,
      `${label} item ${item}`,
    );
    mh.cycle();
    assert.equal(engine.vars[48], item, `${label} item ${item} selected; ${mh.describe()}`);
    run.key(AGI_KEY.ENTER);
  };
  pick(2, 1, 102, "warning");
  mh.waitFor(() => engine.flags[77] === 1, "access granted", 300);
  pick(3, 1, 47, "site selector");
  pick(4, 2, 63, "site Alpha");
  pick(5, 2, 63, "Alpha security");
  mh.waitFor(() => engine.flags[83] === 0, "the guard robot is reassigned", 300);
  // Room 164 shows the robot leaving its post, then the menu returns.
  mh.waitForRoom(164, "the robot's new orders", 300);
  mh.waitForRoom(149, "back at the menu", 2400);
  run.checkpoint("Sent the guard robot on hall patrol", { room: 149 });
  pick(5, 5, 118, "Alpha security return");
  pick(4, 5, 118, "site Alpha return");
  pick(3, 5, 118, "site selector quit");
  mh.waitFor(() => engine.vars[50] === 5 && !engine.flags[22], "the logout screen", 600);
  run.key(AGI_KEY.ENTER);
  mh.waitForRoom(109, "back in the lobby", 900);
  mh.step(60);
  // Travel: f77 is set, so the map advances v60 to 4 and the Orbs take over.
  mh.key(AGI_KEY.F3);
  mh.waitForRoom(131, "summoned by the Orbs", 1800);
  assert.equal(mh.engine.vars[0], 131, "Summoned to the Orbs on Day 3");
  reportToOrbs(mh, ["Phil Cook"], 4);
  run.checkpoint("Home, Day 4", { room: 104 });
}

export function day3(run: Speedrun): void {
  const mh = new Manhunter(run);
  day3Tracker(mh);
  churchCandles(mh);
  pawnShop(mh);
  paintingRooms(mh);
  manholeFight(mh);
  theatreSafe(mh);
  jonesHouse(mh);
  allianceComputer(mh);
}

/**
 * Day 4: the MAD opens on a tracker again, but Bellevue and Grand Central are
 * already on the map, so C closes it at once. In the hospital ward the inner
 * door (hotspot 2) is no longer guarded (f83 clear) and leads, by way of a
 * capture cutscene (room 102), to the processing room (room 150).
 */
export function hospitalDoor(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.waitForRoom(101, "the MAD on Day 4", 8000);
  mh.waitFor(() => mh.hint().includes("Press <ENTER>"), "the tracker prompt");
  assert.equal(mh.engine.vars[0], 101, "Day 4 tracker");
  run.key(AGI_KEY.ENTER);
  mh.waitForRoom(103, "the tracker", 600);
  mh.step(30);
  mh.key(KEY_C, 120);
  mh.waitForRoom(ROOM_MAP, "the city map", 600);
  mh.travel(1, 2, 138, 113, 130);
  assert.equal(mh.engine.vars[0], 130, "Bellevue Hospital again");
  mh.cursorTo(140, 137);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[66] === 1 && engine.vars[50] === 2 && mh.cursor.active, "the hall");
  mh.step(5);
  mh.cursorTo(77, 120);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 3 && mh.cursor.active, "the ward");
  mh.step(5);
  mh.hotspot(2, 52, 94);
  assert.equal(engine.flags[83], 0, "the robot has left the door");
  run.key(AGI_KEY.ENTER);
  mh.waitForRoom(102, "through the unguarded door", 900);
  run.checkpoint("Slipped through the unguarded door", { room: 102 });
}

/**
 * The processing room (room 150). From the bone pit the barred window's
 * close-up (v50 = 1) shows the guard, an Orb and a robot at the machine; the
 * crowbar opens the window (f94) and after thirty seconds they file out
 * (f99), the room-security robot last (f100, which needs f84 untouched).
 * Inside (v50 = 2) Module D lies by the door (item 24), the lever sets the
 * conveyor: up is v150 = 1, carrying left and away from the press, down is
 * v150 = 2, into it. The ladder then drops Mick on the belt, which carries
 * him out to the ventilation shafts (room 110).
 */
export function processingRoom(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.waitFor(
    () => engine.vars[0] === 150 && engine.vars[50] === 0 && !engine.flags[22] && mh.cursor.active,
    "thrown into the bone pit",
    4000,
  );
  assert.equal(mh.engine.vars[0], 150, "Thrown into the bone pit");
  mh.hotspot(1, 78, 23);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 1 && !engine.flags[22], "the barred window", 600);
  useItem(mh, 18, "the crowbar");
  mh.waitFor(() => engine.flags[94] === 1, "the bars are out", 300);
  mh.waitFor(() => engine.flags[100] === 1, "the guards leave the machine", 6000);
  run.checkpoint("Watched the guards leave", { room: 150 });
  mh.hotspot(1, 31, 105);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(
    () => engine.vars[50] === 2 && !engine.flags[22] && mh.cursor.active,
    "the machine room",
    900,
  );
  mh.hotspot(3, 16, 158);
  assert.match(mh.hint(), /take Module D/);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => run.carried(24), "Module D", 300);
  run.checkpoint("Took Module D", { room: 150 });
  mh.hotspot(2, 63, 129);
  assert.match(mh.hint(), /handle up or down/);
  run.direction(1);
  mh.waitFor(() => engine.vars[150] === 1, "the belt runs away from the press", 120);
  run.direction(0);
  mh.step(12);
  mh.hotspot(1, 107, 71);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 4, "up the ladder", 300);
  mh.waitForRoom(110, "carried out on the conveyor", 3000);
  assert.equal(mh.engine.vars[0], 110, "Rode the conveyor out of the machine room");
}

/**
 * The ventilation shafts (room 110): Mick climbs a wall of pipes from
 * (152,160) to the grating above row 29. Up climbs one pixel per cycle, Left
 * and Right swing eight pixels to the next pipe (logic 110, v50 = 2), Down climbs back down, and any
 * touch of a broken section (control value 2, which sets f3) or of a falling
 * bolt (objects 1-3, within six pixels) drops him back to the start
 * (v50 = 3). The broken sections are fixed, so the way up is a shortest path
 * over the picture's own control surface.
 */
const SHAFT_TOP = 28;

/** Steps to the grating from every (pipe x, row), by breadth-first search from the top. */
function shaftDistances(control: Uint8Array): Map<number, number> {
  const broken = (x0: number, x1: number, y: number): boolean => {
    for (let x = Math.max(0, x0); x <= Math.min(159, x1); x++)
      if (control[y * 160 + x] === 2) return true;
    return false;
  };
  const key = (x: number, y: number): number => y * 160 + x;
  const pipes: number[] = [];
  for (let x = 152; x >= 8; x -= 8) pipes.push(x);
  const distance = new Map<number, number>();
  let frontier: [number, number][] = [];
  for (const x of pipes)
    if (!broken(x, x + 5, SHAFT_TOP)) {
      distance.set(key(x, SHAFT_TOP), 0);
      frontier.push([x, SHAFT_TOP]);
    }
  // Reverse edges: a state is reached by climbing from the row below or down
  // from the row above, or by a swing from the neighbouring pipe (three cycles).
  while (frontier.length > 0) {
    const next: [number, number][] = [];
    for (const [x, y] of frontier) {
      const d = distance.get(key(x, y))!;
      const relax = (px: number, py: number, cost: number): void => {
        if (py > 162 || py < SHAFT_TOP || px < 8 || px > 152 || broken(px, px + 5, py)) return;
        const k = key(px, py);
        if ((distance.get(k) ?? Infinity) <= d + cost) return;
        distance.set(k, d + cost);
        next.push([px, py]);
      };
      relax(x, y + 1, 1);
      relax(x, y - 1, 1);
      // Swinging left from x + 8 poses across x .. x + 11; right from x - 8 across x - 8 .. x + 3.
      if (!broken(x, x + 11, y)) relax(x + 8, y, 3);
      if (!broken(x - 8, x + 3, y)) relax(x - 8, y, 3);
    }
    frontier = next;
  }
  return distance;
}

function ventilationShafts(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.waitFor(() => !engine.flags[22] && mh.cursor.active, "the foot of the pipes", 600);
  const distance = shaftDistances(engine.surface.priority);
  const at = (x: number, y: number): number => distance.get(y * 160 + x) ?? Infinity;
  assert.ok(at(152, 160) < Infinity, "the pipes can be climbed");
  const won = (e: Speedrun["engine"]): boolean => e.vars[50]! >= 4 || e.vars[0] !== 110;
  const fell = (e: Speedrun["engine"]): boolean => e.vars[50] === 3;
  /** The key that follows the shortest path from here, 0 to keep the current heading. */
  const pathKey = (e: Speedrun["engine"]): number => {
    if (e.vars[50] === 0) return AGI_KEY.UP;
    if (e.vars[50] !== 1) return 0;
    const ego = e.screenObjects[0]!;
    const heading = e.vars[6];
    const moves: [number, number][] = [
      [at(ego.x, ego.y - 1) + 1, heading === 1 ? 0 : AGI_KEY.UP],
      [at(ego.x, ego.y + 1) + 1, heading === 5 ? 0 : AGI_KEY.DOWN],
      [at(ego.x - 8, ego.y) + 3, AGI_KEY.LEFT],
      [at(ego.x + 8, ego.y) + 3, AGI_KEY.RIGHT],
    ];
    moves.sort((a, b) => a[0] - b[0]);
    return moves[0]![1];
  };
  /** Pressing the held direction again stops the climb. */
  const holdKey = (e: Speedrun["engine"]): number =>
    e.vars[50] === 1 && e.vars[6] === 1
      ? AGI_KEY.UP
      : e.vars[50] === 1 && e.vars[6] === 5
        ? AGI_KEY.DOWN
        : 0;
  const step = (target: Speedrun, key: number): void => {
    if (key) target.key(key);
    reflexCycle(target);
  };
  const control = engine.surface.priority;
  const broken = (x0: number, x1: number, y: number): boolean => {
    for (let x = Math.max(0, x0); x <= Math.min(159, x1); x++)
      if (control[y * 160 + x] === 2) return true;
    return false;
  };
  /** A swing to the pipe on `side` (-1 left, 1 right) is clear of broken sections. */
  const canSwing = (x: number, y: number, side: number): boolean => {
    const target = x + 8 * side;
    if (target < 8 || target > 152) return false;
    return (
      !broken(Math.min(x, target), Math.min(x, target) + 11, y) && !broken(target, target + 5, y)
    );
  };
  const boltAbove = (e: Speedrun["engine"], x: number, y: number, reach: number): boolean =>
    [1, 2, 3].some((n) => {
      const bolt = e.screenObjects[n]!;
      return (
        e.flags[150 + n] === 1 && Math.abs(bolt.x - x) < 6 && bolt.y < y + 6 && y - bolt.y < reach
      );
    });
  /** Waiting out the bolts: hold still, and swing aside when one comes down this pipe. */
  const waitKey = (e: Speedrun["engine"]): number => {
    if (e.vars[50] !== 1) return 0;
    const ego = e.screenObjects[0]!;
    if (boltAbove(e, ego.x, ego.y, 30)) {
      const sides = [-1, 1].filter((side) => canSwing(ego.x, ego.y, side));
      sides.sort(
        (p, q) =>
          Number(boltAbove(e, ego.x + 8 * p, ego.y, 60)) -
          Number(boltAbove(e, ego.x + 8 * q, ego.y, 60)),
      );
      if (sides.length > 0) return sides[0] === -1 ? AGI_KEY.LEFT : AGI_KEY.RIGHT;
    }
    return holdKey(e);
  };
  /** Cycles the path can be followed from `from` before a fall, up to `ahead`. */
  const rehearse = (from: Speedrun, ahead: number): number => {
    const branch = from.fork();
    for (let c = 0; c < ahead; c++) {
      if (won(branch.engine)) return ahead;
      step(branch, pathKey(branch.engine));
      if (fell(branch.engine)) return c;
    }
    return ahead;
  };
  // The bolts fall at random, half of them down Mick's own pipe, and the last
  // pipe on the left has sixty rows with nowhere to swing to. Each stretch is
  // therefore rehearsed on a fork first. If following the path from this
  // cycle ends in a fall, the rehearsal looks for a spot before that fall
  // where Mick can swing aside, waits there (dodging) one cycle longer at a
  // time, and rehearses again from each of those moments until the next 120
  // cycles are clean. That plan is then played for real: up to the spot, the
  // wait, forty cycles of path, and the next stretch is rehearsed.
  const AHEAD = 120;
  const COMMIT = 40;
  let halfway = false;
  for (let guard = 0; guard < 600 && !won(engine); guard++) {
    const clean = rehearse(run, AHEAD);
    let lead = 0;
    let wait = 0;
    if (clean < AHEAD) {
      let found = false;
      for (lead = clean - 1; lead >= Math.max(0, clean - 100) && !found; lead--) {
        const spot = run.fork();
        for (let c = 0; c < lead; c++) step(spot, pathKey(spot.engine));
        const ego = spot.engine.screenObjects[0]!;
        if (spot.engine.vars[50] !== 1) continue;
        if (!canSwing(ego.x, ego.y, -1) && !canSwing(ego.x, ego.y, 1)) continue;
        for (wait = 1; wait <= 240; wait++) {
          step(spot, waitKey(spot.engine));
          if (fell(spot.engine)) break;
          if (rehearse(spot, AHEAD) >= AHEAD) {
            found = true;
            break;
          }
        }
        if (found) break;
      }
      assert.ok(found, `ventilation shafts: no clean start found; ${mh.describe()}`);
    }
    for (let c = 0; c < lead + wait + COMMIT && !won(engine); c++) {
      step(run, c < lead ? pathKey(engine) : c < lead + wait ? waitKey(engine) : pathKey(engine));
      assert.ok(!fell(engine), `ventilation shafts: Mick fell; ${mh.describe()}`);
    }
    if (!halfway && at(mh.cursor.x, mh.cursor.y) < at(152, 160) / 2) {
      halfway = true;
      assert.equal(mh.engine.vars[0], 110, "Halfway up the ventilation pipes");
    }
  }
  assert.ok(won(engine), `ventilation shafts: not at the grating; ${mh.describe()}`);
  run.checkpoint("Climbed the ventilation pipes", { room: 110 });
}

/**
 * Grand Central Station (room 138): the grating drops Mick back into the
 * hospital hall, and the missing maintenance robot's trail ends at the
 * station. The low windows on the left (hotspot 1) take the crowbar on Day 4
 * (f102), and through them lies the hangar (room 152) with the Orb ship,
 * whose cockpit is room 154.
 */
export function grandCentral(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.waitFor(
    () => engine.vars[0] === 130 && engine.vars[50] === 2 && !engine.flags[22] && mh.cursor.active,
    "dropped back into the hospital hall",
    3000,
  );
  assert.equal(mh.engine.vars[0], 130, "Fell out of the shafts into the hospital hall");
  mh.cursorTo(77, 160);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[66] === 0 && engine.vars[50] === 0, "outside the hospital", 600);
  mh.step(10);
  mh.map();
  mh.travel(6, 2, 101, 53, 138);
  mh.step(60);
  assert.equal(mh.engine.vars[0], 138, "Grand Central Station");
  mh.hotspot(1, 20, 164);
  run.key(AGI_KEY.ENTER);
  mh.waitFor(() => engine.vars[50] === 1 && !engine.flags[22], "the low windows", 600);
  useItem(mh, 18, "the crowbar");
  mh.waitFor(() => engine.vars[50] === 2 && engine.flags[102] === 1, "the window is forced", 300);
  mh.waitFor(() => !engine.flags[22], "the open window", 300);
  mh.hotspot(1, 80, 121);
  run.key(AGI_KEY.ENTER);
  mh.waitForRoom(152, "the hangar under the station", 900);
  run.checkpoint("Found the Orb ship under Grand Central", { room: 152 });
  mh.waitFor(
    () => engine.vars[50] === 0 && !engine.flags[22] && mh.cursor.active,
    "the hangar settles",
    600,
  );
  mh.hotspot(1, 67, 113);
  assert.match(mh.hint(), /enter the ship/);
  run.key(AGI_KEY.ENTER);
  mh.waitForRoom(154, "the cockpit", 900);
}

/**
 * The cockpit (room 154). The four modules go into their sockets from the
 * inventory (A 22, B 16, C 23, D 24; f108-f111), which lights the upper-left
 * switch (button 4, f106/f112). The rest follow logic 154's interlocks: the
 * middle square (2) powers up and shows the guard robots outside, the screen
 * switch (6) and the slider beside it (5) bring the instruments up, the right
 * square (3) opens the hangar doors and the left square (1) lifts off into
 * the hangar (room 152, v50 = 3). Any other order is the wrong button.
 */
const COCKPIT_BUTTONS: Record<number, readonly [number, number]> = {
  1: [53, 138],
  2: [78, 138],
  3: [103, 138],
  4: [52, 107],
  5: [106, 107],
  6: [79, 104],
};

export function cockpit(mh: Manhunter): void {
  const { run, engine } = mh;
  const ready = (): boolean =>
    engine.vars[0] === 154 && engine.vars[50] === 0 && !engine.flags[22] && mh.cursor.active;
  mh.waitFor(ready, "the cockpit", 900);
  assert.equal(mh.engine.vars[0], 154, "Boarded the Orb ship");
  for (const [item, flag, name] of [
    [22, 108, "Module A"],
    [16, 109, "Module B"],
    [23, 110, "Module C"],
    [24, 111, "Module D"],
  ] as const) {
    useItem(mh, item, name);
    mh.waitFor(() => engine.flags[flag] === 1, `${name} seated`, 600);
    mh.waitFor(ready, `${name} socket closes`, 1800);
  }
  run.checkpoint("Seated the four modules", { room: 154 });
  for (const button of [4, 2, 6, 5, 3, 1]) {
    mh.waitFor(ready, `the panel before button ${button}`, 6000);
    const [x, y] = COCKPIT_BUTTONS[button]!;
    mh.hotspot(button, x, y);
    run.key(AGI_KEY.ENTER);
    mh.waitFor(() => !ready(), `button ${button} responds`, 120);
  }
  mh.waitFor(
    () => engine.vars[0] === 152 && engine.vars[50] === 3,
    "lift-off into the hangar",
    3000,
  );
  assert.equal(mh.engine.vars[0], 152, "Lifted off inside the hangar");
}

/**
 * Flying out of the hangar (room 152, v50 = 3). The ship (object 2) drifts
 * with inertia: a held direction shortens the axis period (v109, v110) toward
 * that side and walls bounce it (f3). The open doors are the gap in the right
 * wall, x over 102 with y 45-52. Steering is a rehearsed greedy descent:
 * every eight cycles each of the nine headings is flown for sixteen cycles on
 * a fork and the one that ends nearest the gap is held for real.
 */
export function hangarFlight(mh: Manhunter): void {
  const { run, engine } = mh;
  const out = (e: Speedrun["engine"]): boolean => e.vars[50] !== 3 || e.vars[0] !== 152;
  const steer = (target: Speedrun, heading: number): void => {
    const current = target.engine.vars[6]!;
    if (current !== heading) target.key(DIRECTION_KEYS[heading || current]!);
  };
  const miss = (e: Speedrun["engine"]): number => {
    if (e.vars[50] === 6) return -1;
    const ship = e.screenObjects[2]!;
    return Math.abs(ship.x - 112) + 2 * Math.abs(ship.y - 48);
  };
  for (let leg = 0; leg < 200 && !out(engine); leg++) {
    let best = 0;
    let bestMiss = Infinity;
    for (let heading = 0; heading <= 8; heading++) {
      const branch = run.fork();
      steer(branch, heading);
      for (let c = 0; c < 16 && !out(branch.engine); c++) reflexCycle(branch);
      const result = miss(branch.engine);
      if (result < bestMiss) {
        bestMiss = result;
        best = heading;
      }
    }
    steer(run, best);
    for (let c = 0; c < 8 && !out(engine); c++) reflexCycle(run);
  }
  assert.equal(engine.vars[50], 6, `through the hangar doors; ${mh.describe()}`);
  run.checkpoint("Flew out through the hangar doors", { room: 152 });
}

/**
 * The service tunnels (room 155): five screens of cave (v90; 4 lies east of
 * 1 and 5 east of 4) flown with the same inertia as the hangar; walls only
 * bounce the ship (object 1). The way out is the shaft at the far side of
 * screen 5, x over 135 above row 40. Each screen's open space is read from
 * its control surface, a breadth-first path is laid to that screen's exit,
 * and the ship is steered along it by rehearsal: the headings that point
 * roughly at the next waypoint are each flown for two dozen cycles on a fork
 * and the one ending nearest to it is held for the next eight.
 */
interface TunnelLeg {
  screen: number;
  /** The screen edge to leave by, or "shaft" for the way out. */
  edge: "N" | "E" | "S" | "W" | "shaft";
  /** The open stretch of that edge, in pixels along it. */
  lo: number;
  hi: number;
}
/**
 * The shortest way through, from a breadth-first search over all five control
 * surfaces: the direct door from screen 1 into 4 is a dead-end pocket, so the
 * route loops down through 2 and 3, up into 4, back west into 1 by the lower
 * gallery and east again by the middle one.
 */
const TUNNEL_ROUTE: readonly TunnelLeg[] = [
  { screen: 1, edge: "S", lo: 4, hi: 18 },
  { screen: 2, edge: "E", lo: 98, hi: 112 },
  { screen: 3, edge: "N", lo: 70, hi: 86 },
  { screen: 4, edge: "W", lo: 110, hi: 124 },
  { screen: 1, edge: "E", lo: 62, hi: 78 },
  { screen: 4, edge: "E", lo: 32, hi: 48 },
  { screen: 5, edge: "shaft", lo: 138, hi: 159 },
];

function tunnelExit(leg: TunnelLeg): (x: number, y: number) => boolean {
  if (leg.edge === "S") return (x, y) => y >= 162 && x >= leg.lo && x <= leg.hi;
  if (leg.edge === "N") return (x, y) => y <= 11 && x >= leg.lo && x <= leg.hi;
  if (leg.edge === "E") return (x, y) => x >= 150 && y >= leg.lo && y <= leg.hi;
  if (leg.edge === "W") return (x, y) => x <= 4 && y >= leg.lo && y <= leg.hi;
  return (x, y) => x >= leg.lo && y <= 38;
}

function tunnelPath(
  control: Uint8Array,
  from: readonly [number, number],
  width: number,
  exit: (x: number, y: number) => boolean,
): [number, number][] | null {
  // Cells are 2 x 2 pixels. A cell is blocked when the ship's baseline span
  // there touches a wall (control 0 or 2); every open cell knows its distance
  // to the nearest blocked one, and the path pays for flying close to walls,
  // because a touch reverses the ship on both axes.
  const COLS = 80;
  const ROWS = 84;
  const blocked = new Uint8Array(COLS * ROWS);
  for (let cy = 0; cy < ROWS; cy++)
    for (let cx = 0; cx < COLS; cx++) {
      const x = cx * 2;
      const y = cy * 2;
      let wall = y < 8 || y > 166 || x + width > 160;
      for (let px = x; !wall && px < x + width; px++) {
        const value = control[y * 160 + px]!;
        wall = value === 0 || value === 2;
      }
      blocked[cy * COLS + cx] = wall ? 1 : 0;
    }
  const clearance = new Int16Array(COLS * ROWS).fill(-1);
  let ring: number[] = [];
  blocked.forEach((wall, cell) => {
    if (wall) {
      clearance[cell] = 0;
      ring.push(cell);
    }
  });
  const neighbours = (cell: number): number[] => {
    const cx = cell % COLS;
    const cy = Math.floor(cell / COLS);
    const out: number[] = [];
    if (cx > 0) out.push(cell - 1);
    if (cx < COLS - 1) out.push(cell + 1);
    if (cy > 0) out.push(cell - COLS);
    if (cy < ROWS - 1) out.push(cell + COLS);
    return out;
  };
  while (ring.length > 0) {
    const next: number[] = [];
    for (const cell of ring)
      for (const n of neighbours(cell))
        if (clearance[n] === -1) {
          clearance[n] = clearance[cell]! + 1;
          next.push(n);
        }
    ring = next;
  }
  // A screen change can leave the ship against a wall: start from the nearest open cell.
  let start = (from[1] >> 1) * COLS + (from[0] >> 1);
  search: for (let radius = 0; radius < 24; radius++)
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = (from[0] >> 1) + dx;
        const cy = (from[1] >> 1) + dy;
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS || blocked[cy * COLS + cx]) continue;
        start = cy * COLS + cx;
        break search;
      }
  // Dijkstra with small integer costs, as a bucket queue.
  const cost = new Int32Array(COLS * ROWS).fill(-1);
  const previous = new Int32Array(COLS * ROWS).fill(-1);
  const buckets: number[][] = [[start]];
  cost[start] = 0;
  let goal = -1;
  for (let c = 0; c < buckets.length && goal === -1; c++)
    for (const cell of buckets[c] ?? []) {
      if (cost[cell] !== c) continue;
      if (exit((cell % COLS) * 2, Math.floor(cell / COLS) * 2)) {
        goal = cell;
        break;
      }
      for (const n of neighbours(cell)) {
        if (blocked[n]) continue;
        const stepCost = 2 + Math.floor(16 / clearance[n]!);
        const total = c + stepCost;
        if (cost[n] !== -1 && cost[n]! <= total) continue;
        cost[n] = total;
        previous[n] = cell;
        (buckets[total] ??= []).push(n);
      }
    }
  if (goal === -1) return null;
  const cells: [number, number][] = [];
  for (let cell = goal; cell !== -1; cell = previous[cell]!)
    cells.push([(cell % COLS) * 2, Math.floor(cell / COLS) * 2]);
  cells.reverse();
  return cells.filter((_, index) => index % 6 === 0 || index === cells.length - 1);
}

export function serviceTunnels(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.waitForRoom(155, "the service tunnels", 1200);
  assert.equal(mh.engine.vars[0], 155, "Into the service tunnels");
  const ship = engine.screenObjects[1]!;
  const steer = (target: Speedrun, heading: number): void => {
    const current = target.engine.vars[6]!;
    if (current !== heading) target.key(DIRECTION_KEYS[heading || current]!);
  };
  // Inertia can carry the ship straight back through the edge it just
  // crossed; the leg index then steps back and that screen is flown again.
  let index = 0;
  let halfway = false;
  for (let visits = 0; visits < 60 && engine.vars[0] === 155; visits++) {
    // Let a new picture settle, then plan from where the ship actually is.
    for (let c = 0; c < 2; c++) reflexCycle(run);
    if (engine.vars[0] !== 155) break;
    const screen = engine.vars[90]!;
    if (TUNNEL_ROUTE[index]!.screen !== screen) {
      if (TUNNEL_ROUTE[index + 1]?.screen === screen) index++;
      else if (index > 0 && TUNNEL_ROUTE[index - 1]!.screen === screen) index--;
    }
    const leg = TUNNEL_ROUTE[index]!;
    assert.equal(
      screen,
      leg.screen,
      `the planned tunnel screen; ship (${ship.x},${ship.y}); ${mh.describe()}`,
    );
    const exit = tunnelExit(leg);
    const path = tunnelPath(engine.surface.priority, [ship.x, ship.y], ship.width, exit);
    assert.ok(path, `a way across tunnel screen ${screen}; ${mh.describe()}`);
    let waypoint = 1;
    for (let hop = 0; hop < 6000 && engine.vars[0] === 155 && engine.vars[90] === screen; hop++) {
      while (
        waypoint < path.length - 1 &&
        Math.abs(path[waypoint]![0] - ship.x) + Math.abs(path[waypoint]![1] - ship.y) < 8
      )
        waypoint++;
      const [wx, wy] = path[Math.min(waypoint, path.length - 1)]!;
      // Past the last waypoint keep pushing through the exit edge.
      const last = waypoint >= path.length - 1;
      const tx = wx + (last ? (leg.edge === "E" ? 20 : leg.edge === "W" ? -20 : 0) : 0);
      const ty =
        wy +
        (last ? (leg.edge === "S" ? 20 : leg.edge === "N" || leg.edge === "shaft" ? -20 : 0) : 0);
      // Each axis has a period (v94, v95: 11 at rest, 3 flat out) and a sense
      // (f155 right, f156 down). Thrust toward the waypoint up to speed level
      // 6, thrust against the motion once the error is within twice the
      // level, and reverse at once when drifting the wrong way.
      const thrust = (error: number, period: number, positive: boolean): number => {
        const level = 11 - period;
        const sign = Math.sign(error);
        const moving = level > 0 ? (positive ? 1 : -1) : 0;
        if (sign === 0) return -moving;
        if (moving !== 0 && moving !== sign) return sign;
        if (Math.abs(error) <= 2 * level) return -sign;
        return level >= 6 ? 0 : sign;
      };
      steer(
        run,
        directionForDelta(
          thrust(tx - ship.x, engine.vars[94]!, engine.flags[155] === 1),
          thrust(ty - ship.y, engine.vars[95]!, engine.flags[156] === 1),
        ),
      );
      reflexCycle(run);
    }
    if (leg.screen === 3 && !halfway && engine.vars[90] === 4) {
      halfway = true;
      run.checkpoint("Halfway through the service tunnels", { room: 155 });
    }
  }
  mh.waitForRoom(158, "out of the tunnels", 600);
  run.checkpoint("Flew out of the tunnels", { room: 158 });
}

/**
 * The bombing run (room 151). The instrument screen's close-up (cockpit
 * hotspot 7) flies the ship over the six pages of the city map (v90), with
 * the tunnels' inertia at a slower rate (rest period v118 = 25). Enter drops
 * one of four bombs on the spot under the ship; logic 151 counts a hit when
 * it lands in a target box: on page 2 Bellevue (x over 134, y 85-135), Grand
 * Central (x 95-105, y 41-61) and the Empire State Building (x 69-79, y
 * 85-97), on page 4 the Alliance island (x under 9, y 139-155). All four
 * (f160-f163) end the game in room 162. From page 3 on, Phil's ship hunts
 * Mick, half chasing and half wandering at random, and a touch is fatal
 * (room 163).
 */
interface BombLeg {
  page: number;
  x: number;
  y: number;
  /** Target box x0, x1, y0, y1: drop a bomb inside it; otherwise just fly through. */
  box?: readonly [number, number, number, number];
}
const BOMB_PLAN: readonly BombLeg[] = [
  { page: 5, x: -20, y: 60 },
  { page: 3, x: 74, y: -20 },
  { page: 2, x: 74, y: 91, box: [69, 79, 85, 97] },
  { page: 2, x: 100, y: 51, box: [95, 105, 41, 61] },
  { page: 2, x: 142, y: 110, box: [135, 159, 85, 135] },
  { page: 2, x: 60, y: 190 },
  { page: 3, x: 30, y: 190 },
  { page: 4, x: 5, y: 147, box: [3, 8, 139, 155] },
];

/** Fly the plan with a speed cap and braking factor; true when the fourth bomb ends the game. */
function flyBombPlan(run: Speedrun, cap: number, braking: number): boolean {
  const e = run.engine;
  const ship = e.screenObjects[1]!;
  const from = run.cycles;
  let index = 0;
  while (e.vars[0] === 151 && run.cycles - from < 4000 && index < BOMB_PLAN.length) {
    if (e.vars[50] !== 0) {
      reflexCycle(run);
      continue;
    }
    if (e.vars[90] !== BOMB_PLAN[index]!.page) {
      // A bounce or a chase can carry the ship to a neighbouring page: pick the plan up there.
      const ahead = BOMB_PLAN.findIndex((leg, k) => k >= index && leg.page === e.vars[90]);
      const anywhere = BOMB_PLAN.findIndex((leg) => leg.page === e.vars[90]);
      if (ahead < 0 && anywhere < 0) return false;
      index = ahead >= 0 ? ahead : anywhere;
      continue;
    }
    const leg = BOMB_PLAN[index]!;
    const box = leg.box;
    if (
      box &&
      ship.x >= box[0] &&
      ship.x <= box[1] &&
      ship.y >= box[2] &&
      ship.y <= box[3] &&
      !e.flags[154] &&
      !e.flags[22]
    ) {
      run.key(AGI_KEY.ENTER);
      // f154 is the bomb in flight; v50 = 1 the four-second close-up of a hit.
      for (
        let c = 0;
        c < 400 && e.vars[0] === 151 && (c < 3 || e.flags[154] || e.vars[50] !== 0);
        c++
      )
        reflexCycle(run);
      index++;
      continue;
    }
    const thrust = (error: number, period: number, positive: boolean): number => {
      const level = e.vars[118]! - period;
      const sign = Math.sign(error);
      const moving = level > 0 ? (positive ? 1 : -1) : 0;
      if (sign === 0) return -moving;
      if (moving !== 0 && moving !== sign) return sign;
      if (box && Math.abs(error) <= braking * level) return -sign;
      return level >= cap ? 0 : sign;
    };
    const heading = directionForDelta(
      thrust(leg.x - ship.x, e.vars[109]!, e.flags[164] === 1),
      thrust(leg.y - ship.y, e.vars[110]!, e.flags[165] === 1),
    );
    const current = e.vars[6]!;
    if (current !== heading) run.key(DIRECTION_KEYS[heading || current]!);
    reflexCycle(run);
  }
  return e.vars[0] === 162;
}

export function bombingRun(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.waitForRoom(158, "clear of the tunnels", 600);
  // Rooms 158 and 161 show Phil taking off in pursuit, then the cockpit returns.
  mh.waitFor(() => engine.vars[0] === 161, "meanwhile, elsewhere in the city", 3000);
  mh.waitFor(
    () => engine.vars[0] === 154 && engine.vars[50] === 0 && !engine.flags[22] && mh.cursor.active,
    "back in the cockpit",
    6000,
  );
  assert.equal(mh.engine.vars[0], 154, "Back in the cockpit over the city");
  mh.hotspot(7, 78, 82);
  assert.match(mh.hint(), /closer look/);
  run.key(AGI_KEY.ENTER);
  mh.waitForRoom(151, "the bombing run", 3000);
  mh.step(10);
  run.checkpoint("Bombing run over New York", { room: 151 });
  // Phil's wandering is random, so each pair of flying parameters is
  // rehearsed on a fork and the first that lands all four bombs is flown.
  let flown = false;
  search: for (const cap of [20, 18, 22, 16, 14])
    for (const braking of [0.5, 1, 0.75, 1.5, 2]) {
      if (!flyBombPlan(run.fork(), cap, braking)) continue;
      flown = flyBombPlan(run, cap, braking);
      break search;
    }
  assert.ok(flown, `all four bombs on target; ${mh.describe()}`);
  for (const flag of [160, 161, 162, 163])
    assert.equal(engine.flags[flag], 1, `target flag ${flag}`);
  run.checkpoint("All four Alliance sites destroyed", { room: 162 });
}

/**
 * The ending (room 162) plays itself on clock waits: the last target burns,
 * Phil's ship escapes, Mick lands and walks off, and stage v47 = 29 shows
 * "To be continued..." before the game calls quit(1).
 */
export function ending(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.waitFor(() => engine.vars[47] === 17 || engine.vars[47]! >= 26, "Mick lands the ship", 9000);
  run.checkpoint("Landed after the last explosion", { room: 162 });
  mh.waitFor(() => engine.vars[47] === 29, "the closing card", 9000);
  assert.match(engine.textRow(11), /To be continued/);
  run.checkpoint("To be continued", { room: 162 });
}

export function day4(run: Speedrun): void {
  const mh = new Manhunter(run);
  hospitalDoor(mh);
  processingRoom(mh);
  ventilationShafts(mh);
  grandCentral(mh);
  cockpit(mh);
  hangarFlight(mh);
  serviceTunnels(mh);
  bombingRun(mh);
  ending(mh);
}

export const mh1Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.MH1,
  alias: "mh1",
  label: "completed all four days, destroyed the four Alliance sites and reached the closing card",
  coverage: "complete-game",
  route: mh1Complete,
  // Manhunter keeps no score (v3 stays 0). The ending is logic 162's last
  // stage, v47 = 29, reached only with all four target flags set on Day 4.
  expected: {
    room: 162,
    score: 0,
    vars: { 47: 29, 60: 4 },
    flags: { 160: 1, 161: 1, 162: 1, 163: 1 },
    carriedExactly: [13, 14, 15, 18, 20, 25],
    inputEnabled: false,
    egoView: 1,
  },
  requiresAnswer: true,
};
