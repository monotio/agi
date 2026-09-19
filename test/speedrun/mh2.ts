import assert from "node:assert/strict";
import { directionForDelta } from "../../src/agent/gameTestSteps.ts";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import type { ScreenObject } from "../../src/runtime/screenObject.ts";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

/**
 * Manhunter 2: San Francisco (3.002.149) is played through a cursor, screen
 * object 0, steered with the arrow keys. A room tracks its scene in v48 and
 * v45, registers the hotspot under the cursor in v46 (snapping the cursor to
 * the hotspot's anchor and printing the action on text rows 23 and 24), and
 * Enter or Space (controller 20) performs it. Logic 90 binds F3 to travel
 * (controller 21), C to the MAD (controllers 31 and 32), S to the tracker's
 * skip (24 and 33) and Tab to the inventory, whose selection arrives in v25.
 * v55 is the day and v57 the current location's room.
 */
export const KEY_C = 0x63;
export const KEY_S = 0x73;
export const ROOM_MAD = 101;
export const ROOM_MAP = 114;

export class Mh2 {
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

  get room(): number {
    return this.engine.vars[0]!;
  }

  get scene(): number {
    return this.engine.vars[48]!;
  }

  get stage(): number {
    return this.engine.vars[45]!;
  }

  get spot(): number {
    return this.engine.vars[46]!;
  }

  /** The hotspot hint on text rows 23 and 24; a long hint wraps mid-word across them. */
  hint(): string {
    return (this.engine.textRow(23) + this.engine.textRow(24)).replace(/\s+/g, " ").trim();
  }

  describe(): string {
    const v = this.engine.vars;
    return `room ${v[0]} day ${v[55]} v45=${v[45]} v46=${v[46]} v48=${v[48]} v56=${v[56]} v57=${v[57]} cursor (${this.cursor.x},${this.cursor.y}) hint "${this.hint()}"`;
  }

  /** Advance host ticks, acknowledging message windows as they open. */
  step(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      this.run.advance();
      if (this.engine.modalKind === "print") this.run.dismiss();
    }
  }

  key(code: number, ticks = 0): void {
    this.run.key(code);
    if (ticks > 0) this.step(ticks);
  }

  /** One interpreter cycle, so a key is read before the next decision. */
  cycle(count = 1): void {
    for (let c = 0; c < count; c++) {
      const from = this.run.cycles;
      for (let t = 0; t < 200 && this.run.cycles === from; t++) this.step(1);
    }
  }

  waitFor(predicate: () => boolean, label: string, max = 1200): void {
    for (let i = 0; i < max; i++) {
      if (predicate()) return;
      this.step(1);
    }
    throw new Error(`Timed out: ${label}; ${this.describe()}`);
  }

  waitForRoom(room: number, label?: string, max = 1200): void {
    this.waitFor(() => this.room === room, label ?? `room ${room}`, max);
  }

  waitForScene(scene: number, label?: string, max = 1200): void {
    this.waitFor(() => this.scene === scene, label ?? `scene ${scene}`, max);
  }

  /** Enter, then wait for the observed result. */
  enter(until: () => boolean, label: string, max = 1200): void {
    this.run.key(AGI_KEY.ENTER);
    this.waitFor(until, label, max);
  }

  private steerToward(x: number, y: number): void {
    const o = this.cursor;
    this.run.direction(directionForDelta(Math.sign(x - o.x), Math.sign(y - o.y)));
    this.run.advance();
  }

  /** Steer toward (x,y) until `done`; hotspots snap the cursor, so stop at once. */
  steer(x: number, y: number, done: () => boolean, label: string, max = 600): void {
    let stale = 0;
    let best = Infinity;
    for (let n = 0; n < max && !done(); n++) {
      const o = this.cursor;
      const distance = Math.abs(x - o.x) + Math.abs(y - o.y);
      if (distance === 0) break;
      if (distance >= best) {
        if (++stale > 40) break;
      } else {
        stale = 0;
        best = distance;
      }
      this.steerToward(x, y);
    }
    this.run.direction(0);
    this.cycle();
    assert.ok(done(), `${label}; ${this.describe()}`);
  }

  /** Steer toward (x,y) until hotspot `id` registers in v46. */
  hotspot(id: number, x: number, y: number, hint?: RegExp): void {
    this.steer(x, y, () => this.spot === id, `hotspot ${id}`);
    if (hint) assert.match(this.hint(), hint);
  }

  /** Register hotspot `id`, check its hint, press Enter and wait for scene `scene`. */
  press(id: number, x: number, y: number, hint: RegExp, scene: number): void {
    this.hotspot(id, x, y, hint);
    this.enter(() => this.scene === scene && this.engine.flags[21] === 0, `scene ${scene}`);
  }

  /**
   * Choose "Easy Arcade" from the game's Special menu (Escape opens the menu
   * bar; Left wraps to its last menu and Up to that menu's last item). Logic 0
   * answers with f39 clear and f101 set; the travel map sets f39 again, so
   * the choice is made inside the arcade room it is meant for.
   */
  easyArcade(): void {
    this.run.key(AGI_KEY.ESCAPE);
    this.waitFor(() => this.engine.modalKind === "menu", "the menu bar", 120);
    for (const key of [AGI_KEY.LEFT, AGI_KEY.UP, AGI_KEY.ENTER]) {
      this.run.key(key);
      this.run.advance(2);
    }
    this.waitFor(
      () => this.engine.flags[101] === 1 && this.engine.flags[39] === 0,
      "easy arcade",
      300,
    );
    this.cycle(2);
  }

  /** Select carried item `item` from the Tab inventory (v25 receives it). */
  use(item: number): void {
    this.run.assertCarried(item);
    // Logic 0 holds f30 for a cycle after a selection and rejects another one meanwhile.
    this.waitFor(() => this.engine.flags[30] === 0, "the previous item is put away", 120);
    const carried: number[] = [];
    for (let i = 0; i < 64; i++) if (this.engine.itemLocation(i) === 0xff) carried.push(i);
    const index = carried.indexOf(item);
    this.run.key(AGI_KEY.TAB);
    this.waitFor(() => this.engine.modalKind === "inventory", "the inventory", 120);
    const down = index <= carried.length - index;
    for (let n = 0; n < (down ? index : carried.length - index); n++) {
      this.run.key(down ? AGI_KEY.DOWN : AGI_KEY.UP);
      this.run.advance();
    }
    this.run.key(AGI_KEY.ENTER);
    this.waitFor(() => this.engine.modalKind !== "inventory", "the inventory closes", 120);
  }
}

/**
 * One leg of an arcade walk: wait `wait` interpreter cycles, then walk the
 * figure (screen object 0, one pixel a cycle) in a straight line to (x,y).
 * The waits were found by searching the engine's own runs for timings that
 * slip between the patrolling robots; they are replayed as plain key presses.
 */
export type Leg = readonly [x: number, y: number, wait: number];

/** Walk `legs` while `alive` holds; returns false as soon as it does not. */
export function walkLegs(mh: Mh2, legs: readonly Leg[], alive: () => boolean): boolean {
  const { run, engine } = mh;
  const room = mh.room;
  for (const [x, y, wait] of legs) {
    for (let c = 0; c < wait; c++) {
      mh.cycle();
      if (!alive()) return false;
    }
    let stuck = 0;
    for (let c = 0; c < 400 && stuck < 4; c++) {
      if (mh.room !== room) return true;
      if (!alive()) return false;
      const o = mh.cursor;
      const at = o.x + o.y * 256;
      const dir = directionForDelta(Math.sign(x - o.x), Math.sign(y - o.y));
      if (dir === 0) break;
      if (engine.vars[6] !== dir) run.direction(dir);
      else mh.cycle();
      stuck = o.x + o.y * 256 === at ? stuck + 1 : 0;
    }
    if (mh.room === room && engine.vars[6] !== 0) run.direction(0);
    if (!alive()) return false;
  }
  return true;
}

/**
 * The travel map (room 114) has five pages in v90. Pages 1, 2 and 5 stack
 * north to south in the western column and pages 3 and 4 in the eastern one;
 * pushing the cursor off an edge turns the page, and the row the cursor leaves
 * at picks between the two neighbours of a side edge. Each destination is a
 * hotspot id in v46 that the day's tracking or MAD lookups have unlocked.
 */
interface MapSite {
  page: number;
  x: number;
  y: number;
  room: number;
}
export const SITES: Record<string, MapSite & { id: number }> = {
  ferry: { id: 1, page: 4, x: 143, y: 75, room: 107 },
  warehouse: { id: 2, page: 3, x: 94, y: 130, room: 108 },
  hydePier: { id: 3, page: 1, x: 67, y: 60, room: 110 },
  bank: { id: 4, page: 4, x: 44, y: 59, room: 111 },
  fountain: { id: 5, page: 4, x: 117, y: 80, room: 117 },
  crash: { id: 6, page: 2, x: 65, y: 52, room: 124 },
  timov: { id: 7, page: 3, x: 38, y: 154, room: 118 },
  home: { id: 8, page: 1, x: 67, y: 138, room: 125 },
  temple: { id: 9, page: 2, x: 139, y: 107, room: 102 },
  pier5: { id: 10, page: 4, x: 128, y: 27, room: 127 },
  square: { id: 11, page: 1, x: 50, y: 87, room: 133 },
  pyramid: { id: 12, page: 4, x: 68, y: 63, room: 137 },
  doctor: { id: 13, page: 2, x: 99, y: 38, room: 136 },
  laundry: { id: 14, page: 4, x: 44, y: 41, room: 134 },
  club: { id: 15, page: 1, x: 119, y: 98, room: 131 },
  shop: { id: 16, page: 5, x: 56, y: 85, room: 139 },
  cableCars: { id: 17, page: 2, x: 98, y: 98, room: 140 },
  scientist: { id: 18, page: 3, x: 56, y: 102, room: 138 },
  waxMuseum: { id: 19, page: 1, x: 95, y: 71, room: 143 },
};

/** Page turns: [from, to, edge direction, row band the cursor must leave in]. */
const PAGE_TURNS: readonly (readonly [number, number, number, number, number])[] = [
  [1, 2, 5, 0, 167],
  [1, 3, 3, 0, 167],
  [2, 1, 1, 0, 167],
  [2, 5, 5, 0, 167],
  [2, 3, 3, 0, 60],
  [2, 4, 3, 66, 167],
  [3, 4, 5, 0, 167],
  [3, 1, 7, 0, 114],
  [3, 2, 7, 120, 167],
  [4, 3, 1, 0, 167],
  [4, 2, 7, 0, 103],
  [4, 5, 7, 109, 167],
  [5, 2, 1, 0, 167],
  [5, 4, 3, 0, 167],
];

function pagePath(from: number, to: number): (typeof PAGE_TURNS)[number][] {
  const queue: { page: number; path: (typeof PAGE_TURNS)[number][] }[] = [{ page: from, path: [] }];
  const seen = new Set([from]);
  for (const { page, path } of queue) {
    if (page === to) return path;
    for (const turn of PAGE_TURNS)
      if (turn[0] === page && !seen.has(turn[1])) {
        seen.add(turn[1]);
        queue.push({ page: turn[1], path: [...path, turn] });
      }
  }
  throw new Error(`no map path from page ${from} to ${to}`);
}

/** F3 opens the travel map from any location that allows it. */
export function openMap(mh: Mh2): void {
  mh.run.key(AGI_KEY.F3);
  mh.waitForRoom(ROOM_MAP, "the travel map", 1200);
  mh.waitFor(() => mh.cursor.active && mh.engine.flags[21] === 0, "the map cursor", 600);
}

/** On the travel map: turn to the site's page, register it, travel and wait for its room. */
export function travel(mh: Mh2, name: keyof typeof SITES): void {
  const { engine } = mh;
  const site = SITES[name]!;
  assert.equal(mh.room, ROOM_MAP, "travel starts on the map");
  for (const [from, to, dir, y0, y1] of pagePath(engine.vars[90]!, site.page)) {
    assert.equal(engine.vars[90], from, `map page; ${mh.describe()}`);
    const o = mh.cursor;
    if (o.y < y0 || o.y > y1) {
      const band = o.y < y0 ? y0 + 10 : y1 - 10;
      mh.steer(o.x, band, () => mh.cursor.y >= y0 && mh.cursor.y <= y1, "the page turn's rows");
    }
    for (let n = 0; n < 400 && engine.vars[90] === from; n++) {
      mh.run.direction(dir);
      mh.run.advance();
    }
    mh.run.direction(0);
    mh.cycle();
    assert.equal(engine.vars[90], to, `map page ${to}; ${mh.describe()}`);
  }
  mh.hotspot(site.id, site.x, site.y, /travel here/);
  mh.enter(() => mh.room === site.room, `arrival at ${name}`, 2400);
}

/**
 * Look names up in the MAD's Info function (room 101, scene 3). The reply is
 * parsed by logic 101 and unlocks the person's address on the travel map.
 */
export function madInfo(mh: Mh2, names: readonly string[], flags: readonly number[]): void {
  const { run, engine } = mh;
  const back = mh.room;
  run.key(KEY_C);
  mh.waitFor(() => mh.room === ROOM_MAD && mh.scene === 2, "the MAD", 600);
  names.forEach((name, i) => {
    mh.hotspot(i === 0 ? 11 : 13, 128, 138);
    run.answer(name);
    run.key(AGI_KEY.ENTER);
    mh.waitFor(() => engine.flags[flags[i]!] === 1, `the MAD knows ${name}`, 300);
    mh.cycle(2);
  });
  mh.hotspot(9, 130, 160, /Exit to Main Menu/);
  mh.enter(() => mh.scene === 2, "the MAD's main menu");
  run.key(KEY_C);
  mh.waitForRoom(back, "the MAD closes", 600);
}

/**
 * The death screen (room 156): Enter acknowledges the authors' remark, a
 * second Enter their "let's back up" card (v61 = 50), and the game resumes
 * in `room` just before the fatal mistake.
 */
export function backUp(mh: Mh2, room: number): void {
  const { engine } = mh;
  mh.waitFor(() => mh.room === 156 && mh.hint().includes("ENTER"), "the fatal mistake", 6000);
  mh.enter(() => engine.vars[61] === 50 && engine.flags[21] === 0, "the back-up card");
  mh.enter(() => mh.room === room && engine.flags[21] === 0, "backed up", 1200);
}

/** Title and introduction: Enter skips the prologue to the crash site. */
export function opening(mh: Mh2): void {
  const { run, engine } = mh;
  mh.waitFor(() => mh.room === 153 && engine.flags[21] === 0, "the title", 600);
  run.checkpoint("Title", { room: 153 });
  mh.enter(() => mh.room === 124, "the crash site", 9000);
}

/**
 * The crash site (room 124): the dead Manhunter's ID card (item 2, f49) and
 * his MAD (item 14, f48, which also sets f29 to allow travel). Taking the MAD
 * opens it at once.
 */
export function crashSite(mh: Mh2): void {
  const { run, engine } = mh;
  mh.waitFor(() => mh.scene === 1 && engine.flags[21] === 0, "the wreck close-up", 3000);
  mh.hotspot(2, 104, 95, /ID card/);
  mh.enter(() => mh.scene === 3, "the ID card close-up");
  run.assertCarried(2, "the ID card");
  mh.enter(() => mh.scene === 1, "back at the wreck");
  mh.hotspot(1, 108, 140, /Assignment Device/);
  mh.enter(() => mh.room === ROOM_MAD, "the MAD opens", 3000);
  run.assertCarried(14, "the MAD");
  run.checkpoint("Took over the dead Manhunter's identity", { room: ROOM_MAD });
}

/** Steer the MAD tracker's cursor onto moving target `object` until tag hotspot `id` registers. */
function tag(mh: Mh2, object: number, id: number, target: number): void {
  const { run, engine } = mh;
  const o = engine.screenObjects[object]!;
  for (let n = 0; n < 900 && mh.spot !== id; n++) {
    const c = mh.cursor;
    run.direction(directionForDelta(Math.sign(o.x - c.x), Math.sign(o.y - c.y)));
    run.advance();
  }
  run.direction(0);
  assert.equal(mh.spot, id, `tag hotspot; ${mh.describe()}`);
  mh.enter(() => engine.vars[51] === target, "the new tag");
  // The confirmation window swallows keys until it is acknowledged.
  mh.cycle(2);
}

/** Press S until the tracker (rooms 105 and 106) shows scene `scene` of the recording. */
function skipTo(mh: Mh2, room: number, scene: number, flag: number): void {
  const { run, engine } = mh;
  for (let n = 0; n < 8 && !(mh.room === room && mh.scene === scene); n++) {
    const from = `${mh.room}/${mh.scene}`;
    run.key(KEY_S);
    mh.waitFor(() => `${mh.room}/${mh.scene}` !== from, "the skip", 600);
    mh.waitFor(() => mh.room === room, "the next recording", 3000);
  }
  assert.equal(engine.flags[flag], 1, `tracker unlocked f${flag}; ${mh.describe()}`);
}

/**
 * Day 1 tracking (room 106, map interludes in 105): entering a scene of the
 * recording unlocks its map site. The default tag (v51 = 2) leads from the
 * bank (f37) past the warehouse (f42) to the ferry building (f40) and the
 * fountain (f44); tagging the other suspect at the warehouse leads to the
 * Hyde Street pier (f43).
 */
export function trackDay1(mh: Mh2): void {
  const { run, engine } = mh;
  mh.waitFor(() => mh.spot === 12, "the MAD's track button");
  mh.enter(() => mh.room === 106, "the tracker", 600);
  skipTo(mh, 106, 3, 42);
  tag(mh, 2, 19, 1);
  skipTo(mh, 106, 4, 43);
  // The last scene cannot be skipped, and a closed MAD resumes where it
  // stopped (v56), so the recording plays out before the second pass.
  mh.waitFor(() => mh.room === ROOM_MAD && mh.spot === 12, "the recording ends", 3000);
  mh.enter(() => mh.room === 106, "the tracker again", 600);
  skipTo(mh, 106, 3, 42);
  skipTo(mh, 106, 1, 40);
  skipTo(mh, 106, 2, 44);
  assert.equal(engine.flags[37], 1, "the bank is on the map");
  run.key(KEY_C);
  mh.waitForRoom(124, "the MAD closes");
  run.checkpoint("Tracked both suspects across the city", { room: 124 });
}

/**
 * Bank of Canton (rooms 111 and 112). Down the street lies the second body
 * with the broken fang (item 7, f46; taking it shows the item close-up of
 * room 155) and the laundry receipt (item 5, f47). The side door and the
 * tunnel lead into the office with Tad's note (item 1, f53) and the torn
 * newspaper (item 3, f54). The day cannot end while any of those flags is set.
 */
export function bank(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "bank");
  mh.waitFor(() => engine.flags[21] === 0, "the bank");
  mh.press(2, 5, 160, /direction of the arrow/, 1);
  mh.press(2, 11, 166, /closer look/, 2);
  mh.hotspot(1, 64, 51, /broken fang/);
  mh.enter(() => mh.room === 155, "the fang close-up");
  mh.enter(() => mh.room === 111 && mh.scene === 2, "back at the body");
  mh.press(2, 123, 160, /laundry receipt/, 6);
  mh.enter(() => mh.scene === 2, "the receipt is pocketed");
  run.assertCarried(7, "the fang");
  run.assertCarried(5, "the laundry receipt");
  mh.enter(() => mh.scene === 1, "back on the street");
  mh.press(3, 150, 100, /direction of the arrow/, 0);
  mh.press(1, 37, 148, /direction of the arrow/, 4);
  mh.press(1, 73, 61, /direction of the arrow/, 5);
  mh.hotspot(1, 72, 118);
  mh.enter(() => mh.room === 112, "the bank office");
  mh.waitFor(() => engine.flags[21] === 0, "the office");
  mh.press(3, 139, 85, /take the note/, 1);
  mh.enter(() => mh.scene === 0, "the note is pocketed");
  mh.press(4, 64, 142, /take the newspaper/, 1);
  mh.enter(() => mh.scene === 0, "the newspaper is pocketed");
  run.assertCarried(1, "the dragon note");
  run.assertCarried(3, "the newspaper");
  run.checkpoint("Searched the robbed Bank of Canton", { room: 112 });
}

/** The Ferry Building (room 107): arriving is what the day's report needs (f88). */
export function ferryBuilding(mh: Mh2): void {
  openMap(mh);
  travel(mh, "ferry");
  assert.equal(mh.engine.flags[88], 1, "the ferry building visit is recorded");
}

/**
 * Embarcadero Fountain (room 117). The whirlpool carries the swimmer (v30,
 * v31) in a tightening spiral toward the drain at x 73-82, y 78-97; Enter
 * "spins out", resetting the axis speeds v92 and v93 according to the
 * quadrant flags f157-f160. In the quadrant of f160 a spin-out sends the
 * swimmer east on a four-pixel diagonal, so Enter is pressed there whenever
 * that diagonal ends in the tunnel mouth (x over 143, y 76-104), and
 * otherwise only to swerve when the current heading would reach the drain.
 * On the way back (`leave`) a spin-out in the quadrant of f158 turns the
 * swimmer south, over the fountain's rim (y over 160), which ends the ride.
 */
function whirlpool(mh: Mh2, leave = false): void {
  const { run, engine } = mh;
  let px = engine.vars[30]!;
  let py = engine.vars[31]!;
  for (let c = 0; c < 1500 && mh.scene === 1; c++) {
    const x = engine.vars[30]!;
    const y = engine.vars[31]!;
    const landing = engine.flags[153] ? y + (144 - x) : y - (144 - x);
    let drain = false;
    for (let k = 1; k <= 4; k++) {
      const fx = x + (x - px) * k;
      const fy = y + (y - py) * k;
      if (fx >= 71 && fx <= 84 && fy >= 76 && fy <= 99) drain = true;
    }
    px = x;
    py = y;
    const aimed = leave
      ? engine.flags[158] !== 0 && engine.flags[153] === 0
      : engine.flags[160] !== 0 && landing >= 80 && landing <= 100;
    if (drain || aimed) run.key(AGI_KEY.ENTER);
    mh.cycle();
  }
  if (leave) mh.waitFor(() => mh.scene === 0, "thrown over the fountain's edge", 600);
  else assert.equal(mh.scene, 2, `thrown into the tunnel; ${mh.describe()}`);
}

/**
 * The tunnel (room 113): Right steps forward, Up punches the bat (object 3,
 * f156) and Down stomps the rat (object 2, f154); both close in at five
 * pixels a cycle. A blow lands two cycles after its key, so the rat is
 * stomped from 10 to 25 pixels ahead and the bat punched from 12 to 30.
 * Twenty kills (v94) stop the attacks, after which the game walks the hero
 * out itself once he is past x 90 — and ignores every key there, so an
 * attacker spawned alongside the twentieth kill could not be answered. The
 * hero therefore holds at x 90 until the count is full. A step commits four
 * cycles, so he only steps while nothing is near.
 */
function tunnel(mh: Mh2): void {
  const { run, engine } = mh;
  const hero = engine.screenObjects[1]!;
  const rat = engine.screenObjects[2]!;
  const bat = engine.screenObjects[3]!;
  for (let c = 0; c < 8000 && mh.room === 113; c++) {
    assert.ok(mh.scene < 51 || mh.scene === 50, `the tunnel attack was survived; ${mh.describe()}`);
    let dir = 0;
    if (mh.scene === 0 && engine.flags[21] === 0 && !(engine.vars[94]! >= 20 && hero.x > 90)) {
      const ratGap = engine.flags[154] ? rat.x - hero.x : 999;
      const batGap = engine.flags[156] && engine.vars[95] === 0 ? bat.x - hero.x : 999;
      const stomp = ratGap >= 10 && ratGap <= 25;
      const punch = batGap >= 12 && batGap <= 30;
      if (stomp && punch) dir = ratGap - 10 <= batGap - 12 ? 5 : 1;
      else if (stomp) dir = 5;
      else if (punch) dir = 1;
      else if (ratGap >= 53 && batGap >= 58 && (hero.x <= 84 || engine.vars[94]! >= 20)) dir = 3;
    }
    if (dir) run.direction(dir);
    else mh.cycle();
  }
}

export function fountain(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "fountain");
  mh.waitFor(() => engine.flags[21] === 0, "the fountain");
  mh.hotspot(1, 98, 144, /direction of the arrow/);
  mh.enter(() => mh.scene === 1, "the whirlpool");
  whirlpool(mh);
  mh.waitForRoom(113, "the tunnel", 2000);
  tunnel(mh);
  mh.waitForRoom(115, "the den", 600);
  run.checkpoint("Fought through the rats and bats to the den", { room: 115 });
}

/**
 * The den (room 115): the torn driver's license (item 12, f63) lies on the
 * floor and the empty "Remedy" flask (item 13, f64) by the dead creature's
 * hand. The way back is the quiet tunnel of room 135 and the whirlpool again.
 */
export function den(mh: Mh2): void {
  const { run, engine } = mh;
  mh.waitFor(() => mh.scene === 1 && engine.flags[21] === 0, "the den");
  mh.press(2, 57, 144, /driver's license/, 3);
  mh.enter(() => mh.scene === 1, "the license is pocketed");
  mh.press(1, 88, 117, /closer look/, 2);
  mh.press(1, 33, 87, /take the flask/, 4);
  mh.enter(() => mh.scene === 2, "the flask is pocketed");
  run.assertCarried(12, "the driver's license");
  run.assertCarried(13, "the flask");
  run.checkpoint("Found the creature's flask and a torn license", { room: 115 });
  mh.enter(() => mh.scene === 1, "back from the body");
  mh.steer(140, 60, () => mh.spot === 0, "clear of the den's hotspots");
  mh.enter(() => mh.room === 135, "the tunnel back");
  const hero = engine.screenObjects[1]!;
  for (let n = 0; n < 3000 && mh.room === 135; n++) {
    if (hero.direction !== 7 && engine.vars[6] !== 7) run.direction(7);
    else run.advance();
  }
  mh.waitFor(() => mh.room === 117 && mh.scene === 1, "the whirlpool again", 600);
  whirlpool(mh, true);
  assert.equal(engine.flags[29], 1, "travel is possible again");
}

/**
 * The warehouse (rooms 108, 103 and 109). Sentry robots patrol the aisles
 * between the crates of room 103 and charge down any aisle the intruder
 * shares with them (same x or same y); touching one is fatal. The office
 * beyond (room 109) holds the mallet (item 11, f61).
 */
const robotsAlive = (mh: Mh2) => () => mh.scene !== 20 && mh.room !== 156;

/** Found by searching the engine's runs from this exact state; see Leg. */
const WAREHOUSE_IN: readonly Leg[] = [
  [137, 44, 0],
  [113, 44, 0],
  [113, 66, 0],
  [39, 66, 0],
  [39, 134, 0],
  [12, 134, 0],
  [12, 144, 0],
  [2, 144, 0],
];
const WAREHOUSE_OUT: readonly Leg[] = [
  [15, 134, 0],
  [39, 134, 0],
  [39, 111, 0],
  [63, 111, 0],
  [63, 66, 0],
  [87, 66, 0],
  [87, 44, 0],
  [113, 44, 0],
  [113, 32, 0],
  [113, 23, 6],
  [113, 32, 0],
  [113, 23, 0],
  [113, 44, 0],
  [137, 44, 0],
  [137, 32, 0],
  [151, 32, 0],
];

export function warehouseEnter(mh: Mh2): void {
  const { engine } = mh;
  openMap(mh);
  travel(mh, "warehouse");
  mh.waitFor(() => engine.flags[21] === 0, "the warehouse street");
  mh.press(1, 79, 150, /direction of the arrow/, 1);
  mh.hotspot(1, 23, 150);
  mh.enter(() => mh.room === 103, "the warehouse floor");
  mh.waitFor(() => mh.scene === 0, "control of the intruder", 600);
}

export function warehouseOffice(mh: Mh2): void {
  const { run, engine } = mh;
  assert.ok(walkLegs(mh, WAREHOUSE_IN, robotsAlive(mh)), `crossed the floor; ${mh.describe()}`);
  mh.waitFor(() => mh.room === 109 && engine.flags[21] === 0, "the warehouse office", 600);
  mh.press(2, 105, 130, /take the mallet/, 2);
  mh.enter(() => mh.scene === 0 && engine.flags[21] === 0, "the mallet is pocketed");
  run.assertCarried(11, "the mallet");
  run.checkpoint("Took the mallet from the warehouse office", { room: 109 });
  mh.steer(140, 60, () => mh.spot === 0, "clear of the office hotspots");
  mh.enter(() => mh.room === 103 && mh.scene === 0, "the warehouse floor again", 900);
}

export function warehouseLeave(mh: Mh2): void {
  assert.ok(walkLegs(mh, WAREHOUSE_OUT, robotsAlive(mh)), `crossed back; ${mh.describe()}`);
  mh.waitFor(() => mh.room === 108, "the street outside the warehouse", 600);
}

/**
 * Hyde Street Pier (room 110): down the ladder, across the beach and into
 * the pipe, where the sleeping rat-creature kills the intruder. Logic 110
 * records the attempt in f87 — the day's report requires it — and the death
 * screen (room 156) backs the game up to the pipe.
 */
export function hydePierDeath(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "hydePier");
  mh.waitFor(() => engine.flags[21] === 0, "the pier");
  mh.hotspot(2, 41, 140, /climb down/);
  mh.enter(() => mh.scene === 3 && engine.flags[21] === 0, "the beach", 2400);
  mh.hotspot(2, 140, 115);
  mh.enter(() => mh.scene === 6 && engine.flags[21] === 0, "the pipe's mouth", 2400);
  mh.hotspot(1, 60, 120);
  mh.enter(() => engine.flags[87] === 1, "into the pipe");
  run.checkpoint("Woke the creature sleeping in the pipe", { room: 110 });
  backUp(mh, 110);
}

/** Tad Timov's apartment (room 118): stepping in records the visit (f102); back out before the dog. */
export function timovDay1(mh: Mh2): void {
  const { engine } = mh;
  openMap(mh);
  travel(mh, "timov");
  mh.waitFor(() => engine.flags[21] === 0, "Timov's street");
  mh.press(1, 84, 140, /./, 1);
  assert.equal(engine.flags[102], 1, "the apartment visit is recorded");
  mh.enter(() => mh.scene === 0 && engine.flags[29] === 1, "backed out before the dog");
}

/** The dead Manhunter's apartment (room 125): the cloth (item 15, f66) is in the dresser drawer. */
export function homeDay1(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "home");
  mh.waitFor(() => engine.flags[21] === 0, "the apartment house");
  mh.press(1, 105, 82, /./, 1);
  mh.press(2, 78, 96, /./, 3);
  mh.hotspot(1, 80, 100);
  mh.enter(() => mh.room === 155, "the cloth close-up");
  mh.enter(() => mh.room === 125 && engine.flags[21] === 0, "back in the apartment");
  run.assertCarried(15, "the cloth");
  run.checkpoint("Found the cloth in the dead Manhunter's drawer", { room: 125 });
}

/**
 * The Orb override (room 169) interrupts the next attempt to travel once the
 * day's sites, items and lookups are complete (logic 114 tests the flags). It
 * asks for the suspects' names — logic 169 parses the replies without
 * testing them — and sends the Manhunter home; room 126 then starts the next
 * day (v55) and opens the MAD on the new case.
 */
export function orbOverride(mh: Mh2, names: readonly string[], day: number): void {
  const { run, engine } = mh;
  run.key(AGI_KEY.F3);
  mh.waitForRoom(169, "the Orb override", 1200);
  for (const name of names) run.answer(name);
  let acknowledged = "";
  for (let t = 0; t < 12000 && mh.room === 169; t++) {
    mh.step(1);
    const stage = `${mh.scene}/${mh.stage}`;
    if (stage !== acknowledged && engine.flags[21] === 0 && mh.hint().includes("ENTER")) {
      acknowledged = stage;
      run.key(AGI_KEY.ENTER);
    }
  }
  mh.waitFor(() => mh.room === ROOM_MAD && engine.vars[55] === day, `day ${day}`, 12000);
}

/**
 * Day 2 tracking (rooms 130, 151, 152 and 157; interludes in 129). Logic 129
 * picks the next recording from the tagged target (v51), so three passes
 * cover every site. The first target walks from Pier 5 (f57) to the Temple
 * (f52). The second goes on to the Shop (f74), the Pyramid (f69), the
 * Doctor's House (f70) and the Laundry (f72). Tagging the newcomer at the
 * Pyramid leads to the Cable Car Barn instead (f75), and the killer tagged
 * there once he appears (v90) ends at the Private Club (f73). A recording's
 * last scene cannot be skipped and the MAD resumes where it stopped (v56),
 * so the first two passes play out; the third is simply closed.
 */
export function trackDay2(mh: Mh2): void {
  const { run, engine } = mh;
  const ended = () => mh.room === ROOM_MAD && mh.scene === 2 && mh.spot === 12;
  mh.waitFor(() => mh.room === ROOM_MAD && mh.hint().includes("ENTER"), "the day's case");
  mh.enter(() => mh.room === 130, "the tracker", 600);
  skipTo(mh, 130, 1, 52);
  mh.waitFor(ended, "the Temple recording ends", 3000);
  mh.enter(() => mh.room === 130, "the second pass", 600);
  tag(mh, 3, 20, 2);
  skipTo(mh, 130, 2, 74);
  skipTo(mh, 151, 0, 69);
  skipTo(mh, 151, 1, 70);
  skipTo(mh, 151, 2, 72);
  mh.waitFor(ended, "the Laundry recording ends", 3000);
  run.checkpoint("Followed the suspects to the Temple and the Laundry", { room: ROOM_MAD });
  mh.enter(() => mh.room === 130, "the third pass", 600);
  tag(mh, 3, 20, 2);
  skipTo(mh, 130, 2, 74);
  skipTo(mh, 151, 0, 69);
  tag(mh, 2, 19, 1);
  skipTo(mh, 151, 1, 70);
  skipTo(mh, 152, 0, 75);
  mh.waitFor(() => engine.vars[90]! > 0, "the killers enter the barn", 6000);
  tag(mh, 3, 20, 2);
  skipTo(mh, 157, 0, 75);
  skipTo(mh, 157, 1, 73);
  run.key(KEY_C);
  mh.waitForRoom(125, "the MAD closes");
  run.checkpoint("Tracked the killers to the Private Club", { room: 125 });
}

/** Pier 5 (room 127): the dead dog-man on the burnt boat wears the muzzle (item 6; v42 = 1). */
export function pier5(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "pier5");
  mh.waitFor(() => engine.flags[21] === 0, "Pier 5");
  mh.press(1, 15, 105, /./, 1);
  mh.hotspot(1, 110, 100, /muzzle/);
  mh.enter(() => engine.vars[42] === 1, "the muzzle is taken");
  run.assertCarried(6, "the muzzle");
  run.checkpoint("Took the muzzle from the body on Pier 5", { room: 127 });
}

/**
 * Tad Timov's apartment again: showing the muzzle (item 6) while the guard
 * dog arrives tames it (v42 = 2), which frees the room's hotspots; the camera
 * (item 17, f68) lies on the bench. Its close-up offers the flash button —
 * the single flash is needed on Day 3, so the route only backs out of it.
 */
export function timovDay2(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "timov");
  mh.waitFor(() => engine.flags[21] === 0, "Timov's street");
  mh.press(1, 84, 140, /./, 1);
  mh.use(6);
  mh.waitFor(() => engine.vars[42] === 2, "the dog accepts the muzzle", 3000);
  mh.waitFor(() => mh.scene === 1 && engine.flags[21] === 0, "the dog leaves", 3000);
  mh.hotspot(2, 130, 125, /camera/);
  mh.enter(() => mh.room === 155, "the camera close-up");
  assert.equal(mh.spot, 0, "the flash button is not selected");
  mh.enter(() => mh.room === 118 && engine.flags[21] === 0, "back in the apartment");
  run.assertCarried(17, "the camera");
  assert.equal(engine.flags[95], 1, "the camera still has its flash");
  run.checkpoint("Muzzled the guard dog and took the camera", { room: 118 });
  mh.enter(() => mh.scene === 0 && engine.flags[29] === 1, "back on the street");
}

/**
 * The Temple (room 102). Taking the shield summons four ninja whose throwing
 * stars (objects 6 to 9, live while f154 to f157 are set) must each be met
 * facing their corner: v90 = 2, 1, 4 and 3 respectively when the star crosses
 * the centre (x under 89 from the right, over 74 from the left). Right turns
 * v90 through 1, 2, 4, 3 and Left the other way, one step per cycle. Twenty-six
 * blocks (v93) end the attack and open the way to the stairs (room 116).
 */
const NINJA_FACING = [2, 1, 4, 3] as const;
const TURN_RIGHT: Record<number, number> = { 1: 2, 2: 4, 4: 3, 3: 1 };

function ninjaStars(mh: Mh2): void {
  const { run, engine } = mh;
  for (let c = 0; c < 6000 && mh.scene === 2; c++) {
    let facing = 0;
    let soonest = Infinity;
    for (let i = 0; i < 4; i++) {
      if (!engine.flags[154 + i]) continue;
      const star = engine.screenObjects[6 + i]!;
      const gap = i % 2 === 0 ? star.x - 89 : 74 - star.x;
      if (gap < soonest) {
        soonest = gap;
        facing = NINJA_FACING[i]!;
      }
    }
    const now = engine.vars[90]!;
    if (facing === 0 || facing === now) mh.cycle();
    else
      run.direction(TURN_RIGHT[now] === facing || TURN_RIGHT[TURN_RIGHT[now]!] === facing ? 3 : 7);
  }
  assert.equal(mh.scene, 4, `every throwing star was blocked; ${mh.describe()}`);
}

export function temple(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "temple");
  mh.waitFor(() => engine.flags[21] === 0, "the Temple street");
  mh.hotspot(1, 68, 120);
  mh.enter(
    () => mh.scene === 1 && mh.stage === 1 && engine.flags[21] === 0,
    "the Temple hall",
    3000,
  );
  mh.hotspot(1, 77, 95, /shield/);
  mh.enter(() => mh.scene === 2, "the ninja appear", 3000);
  run.checkpoint("Picked up the shield as four ninja appeared", { room: 102 });
  ninjaStars(mh);
  mh.waitForRoom(116, "the stairway behind the Buddha", 3000);
  run.checkpoint("Blocked every throwing star", { room: 116 });
}

/**
 * The rolling log over the acid pool (room 119). The walker (object 1) heads
 * east on direction 3 while the log's roll knocks him onto the diagonals 2
 * and 4; Left and Right turn him one step up or down. Leaving the rows 120
 * to 136 is a fall, x over 130 the far bank. The route steers for row 128.
 */
function logRoll(mh: Mh2): void {
  const { run, engine } = mh;
  const walker = engine.screenObjects[1]!;
  for (let c = 0; c < 4000 && mh.room === 119 && mh.scene !== 3; c++) {
    assert.notEqual(mh.scene, 2, `stayed on the log; ${mh.describe()}`);
    const want = walker.y > 128 ? 2 : walker.y < 128 ? 4 : 3;
    if (mh.scene === 1 && walker.direction !== want) run.direction(walker.direction < want ? 3 : 7);
    else mh.cycle();
  }
}

export function templeStairs(mh: Mh2): void {
  const { run, engine } = mh;
  mh.waitFor(() => mh.stage >= 1 && engine.flags[21] === 0, "the Buddha rises", 3000);
  mh.press(1, 78, 120, /./, 1);
  assert.equal(mh.spot, 0, "the stairs, not a bust, are selected");
  mh.enter(() => mh.room === 119, "thrown onto the log", 6000);
  logRoll(mh);
  mh.waitForRoom(121, "the branding chamber", 9000);
  run.checkpoint("Crossed the acid pool", { room: 121 });
}

/**
 * The branding chamber (room 121): take a scroll from the box and leave by
 * the window before the priest's patience (v11 over 11 seconds) runs out;
 * the jump sets f55. On the pavement (room 122) the scroll (item 4) is read
 * and pocketed, and the ninja arrive six seconds later, so the route walks
 * off the right edge to the smoke house at once.
 */
export function brandingChamber(mh: Mh2): void {
  const { run, engine } = mh;
  mh.waitFor(() => mh.scene === 0 && engine.flags[21] === 0 && mh.cursor.active, "the chamber");
  mh.hotspot(2, 118, 135, /take a scroll/);
  mh.enter(
    () => mh.scene === 0 && engine.flags[21] === 0 && engine.vars[91]! > 0,
    "the scroll",
    3000,
  );
  mh.hotspot(3, 145, 100, /jump out the window/);
  mh.enter(() => mh.room === 122, "through the window", 3000);
  assert.equal(engine.flags[55], 1, "the escape is recorded");
  mh.waitFor(
    () => mh.scene === 1 && mh.stage === 1 && engine.flags[21] === 0,
    "the pavement",
    3000,
  );
  mh.enter(() => mh.stage === 2, "the scroll is pocketed");
  run.assertCarried(4, "the scroll");
  run.checkpoint("Escaped the Temple with a scroll", { room: 122 });
  mh.hotspot(2, 155, mh.cursor.y, /direction of the arrow/);
  mh.enter(() => mh.room === 128, "the smoke house door", 1200);
}

/**
 * The smoke house (room 128): four pinches (v72) from the second bowl (v73)
 * fill the pipe; smoking that mixture shows the vision of Ming, and her
 * father gives the statue (item 16, f67).
 */
export function smokeHouse(mh: Mh2): void {
  const { run, engine } = mh;
  mh.waitFor(() => engine.flags[21] === 0, "the smoke house street");
  mh.press(1, 60, mh.cursor.y, /./, 1);
  mh.press(1, 75, 120, /closer look/, 2);
  for (let pinch = 1; pinch <= 4; pinch++) {
    mh.hotspot(2, 48, 145, /take a pinch/);
    mh.enter(() => engine.vars[72] === pinch, `pinch ${pinch}`);
    mh.waitFor(() => mh.scene === 2 && engine.flags[21] === 0, "the pinch is in the pipe", 1200);
    if (pinch < 4) mh.steer(48, 120, () => mh.spot === 0, "off the bowl");
  }
  assert.equal(engine.vars[73], 4, "all four pinches came from the second bowl");
  mh.hotspot(6, 76, 123, /smoke the pipe/);
  mh.enter(() => mh.scene === 4, "smoking");
  run.checkpoint("Smoked the vision of Ming", { room: 128 });
  mh.waitFor(() => run.carried(16), "the statue is offered", 9000);
  mh.waitFor(() => mh.stage === 8 && engine.flags[21] === 0, "the statue in hand", 600);
  mh.enter(() => mh.room === 155, "the statue close-up");
  mh.enter(() => mh.room === 128 && engine.flags[21] === 0, "back in the smoke house");
  run.checkpoint("Received Ming's statue from her father", { room: 128 });
}

/** The Shop (room 139): the visit itself is what the day's report needs (f89). */
export function shopVisit(mh: Mh2): void {
  openMap(mh);
  travel(mh, "shop");
  assert.equal(mh.engine.flags[89], 1, "the shop visit is recorded");
}

/**
 * The Transamerica Pyramid (rooms 137, 144 and 104). Inside, the Manhunter
 * circles a shepherd robot on sixteen stations (v91) while its captive
 * mirrors him on the far side; with the Manhunter on station 9 the captive
 * stands at the door and runs (f153, then f81). The robot aims (v92) at the
 * Manhunter's station or at the one ahead of him and fires two cycles after
 * v93 turns 1, so the route circles with Right and only steps onto a station
 * that is not under aim, stepping back when its own is. Back on station 1
 * with the captive free, the game walks the Manhunter out (room 148).
 */
export function pyramid(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "pyramid");
  mh.waitFor(() => engine.flags[21] === 0, "the Pyramid");
  mh.press(1, 44, 148, /./, 1);
  mh.hotspot(2, 70, 90);
  mh.enter(() => mh.room === 144, "the dig inside the Pyramid");
  mh.waitFor(() => engine.flags[21] === 0, "the dig");
  mh.hotspot(2, 100, 120);
  mh.enter(() => mh.room === 104 && mh.scene === 0, "facing the shepherd robot", 3000);
  run.checkpoint("Confronted the shepherd robot", { room: 104 });
  for (let c = 0; c < 3000 && mh.room === 104 && mh.scene === 0; c++) {
    assert.notEqual(engine.vars[64], 1, `the robot never hit; ${mh.describe()}`);
    const station = engine.vars[91]!;
    const next = station === 1 ? 16 : station - 1;
    const aimed = engine.vars[93] === 1 || engine.vars[93] === 2 ? engine.vars[92]! : 0;
    if (engine.vars[94] !== 0 || engine.flags[21] !== 0 || engine.flags[153] !== 0) mh.cycle();
    else if (next !== aimed) run.direction(3);
    else if (station === aimed) run.direction(7);
    else mh.cycle();
  }
  assert.equal(engine.flags[81], 1, "the captive escaped");
  mh.waitForRoom(148, "out of the Pyramid", 3000);
  run.checkpoint("Freed the robot's captive", { room: 148 });
  mh.waitFor(() => mh.room === 137 && engine.flags[21] === 0, "the street outside", 6000);
}

/**
 * The Doctor's House (room 136): in the back room the dead doctor has a
 * letter in his pocket (item 24, f93) and a test tube of urine beside him;
 * showing the empty flask (item 13) over it fills the flask (item 18, f71).
 */
export function doctorsHouse(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "doctor");
  mh.waitFor(() => engine.flags[21] === 0, "the Doctor's House");
  mh.press(1, 24, 78, /./, 1);
  mh.press(2, 85, 100, /./, 50);
  mh.press(1, 60, 110, /./, 3);
  mh.use(13);
  mh.waitFor(() => run.carried(18), "the flask is filled", 3000);
  mh.waitFor(() => mh.room === 155 && engine.flags[21] === 0, "the full flask close-up", 3000);
  mh.enter(
    () => mh.room === 136 && mh.scene === 3 && engine.flags[21] === 0,
    "the doctor's desk again",
  );
  mh.hotspot(3, 8, 150, /./);
  mh.enter(() => mh.room === 155, "the letter close-up");
  mh.enter(() => mh.room === 136 && engine.flags[21] === 0, "back at the desk");
  run.assertCarried(24, "the doctor's letter");
  assert.equal(engine.flags[71], 0, "the test tube is empty");
  run.checkpoint("Filled the flask and took the doctor's letter", { room: 136 });
}

export function cableCarBarnEnter(mh: Mh2): void {
  const { engine } = mh;
  openMap(mh);
  travel(mh, "cableCars");
  mh.waitFor(() => engine.flags[21] === 0, "the Cable Car Barn");
  mh.press(1, 73, 75, /./, 1);
  mh.hotspot(2, 8, 90, /ride the next cablecar/);
  mh.enter(() => mh.room === 141, "riding a car into the barn", 3000);
}

const barnAlive = (mh: Mh2) => () =>
  mh.engine.vars[94] === 0 && mh.engine.vars[64] === 0 && mh.room !== 156;

/** Found by searching the engine's runs from this exact state; see Leg. */
const BARN_TO_SWITCH: readonly Leg[] = [
  [87, 45, 0],
  [87, 48, 0],
];
const BARN_TO_GAP: readonly Leg[] = [
  [98, 70, 0],
  [72, 70, 0],
  [72, 123, 0],
  [116, 123, 0],
];

/**
 * Inside the barn (room 141) the floor between the transformers is a live
 * grid: every control line but one electrocutes (f3). The car may be left
 * while f159 is set; stepping off on its way up the middle aisle puts the
 * Manhunter in the top lane, a short walk from the one safe touch — the
 * north face of the north-east transformer (x 87-90, y 46-63), which shows
 * its switch. Two sentry robots patrol the east aisle and the south lane and
 * charge along any lane they share with him.
 */
export function cableCarBarnSwitch(mh: Mh2): void {
  const { run, engine } = mh;
  const car = engine.screenObjects[1]!;
  mh.waitFor(
    () => engine.vars[90] === 3 && car.y <= 57 && engine.flags[159] === 1,
    "the car nears the top lane",
    6000,
  );
  run.direction(3);
  assert.equal(engine.flags[154], 0, "stepped off the car");
  assert.ok(
    walkLegs(mh, BARN_TO_SWITCH, barnAlive(mh)),
    `reached the transformer; ${mh.describe()}`,
  );
  mh.waitFor(() => mh.scene === 4 && engine.flags[21] === 0, "the transformer's switch");
  mh.hotspot(1, 55, 100, /flip the switch/);
  mh.enter(() => mh.scene === 0 && engine.flags[158] === 1, "the grid opens", 3000);
  run.checkpoint("Threw the transformer switch", { room: 141 });
}

export function cableCarBarnGap(mh: Mh2): void {
  assert.ok(walkLegs(mh, BARN_TO_GAP, barnAlive(mh)), `reached the gap; ${mh.describe()}`);
  mh.waitForRoom(142, "the parked cable car", 3000);
}

/**
 * The parked cable car (room 142): the murdered suspect at its far end has a
 * letter tucked in his sash (item 20, f80).
 */
export function parkedCableCar(mh: Mh2): void {
  const { run, engine } = mh;
  mh.waitFor(() => engine.flags[21] === 0, "the parked car");
  mh.press(2, 96, 90, /./, 2);
  mh.press(1, 125, 76, /./, 3);
  run.assertCarried(20, "the suspect's letter");
  run.checkpoint("Found the letter on the body in the cable car", { room: 142 });
  mh.enter(() => mh.scene === 2 && engine.flags[21] === 0, "the letter is pocketed");
  mh.steer(60, 160, () => mh.spot === 0, "clear of the body's hotspots");
  mh.enter(() => mh.scene === 0 && engine.flags[21] === 0, "the car's doorway");
  mh.steer(20, 160, () => mh.spot === 0, "clear of the car's hotspots");
  mh.enter(() => mh.room === 141 && mh.scene === 0, "back on the barn floor", 3000);
}

/** Found by searching the engine's runs from this exact state; see Leg. */
const BARN_TO_CAR: readonly Leg[] = [
  [72, 123, 72],
  [72, 123, 6],
];

/** Back on the grid, wait in the middle aisle for the next car and ride it out (f154). */
export function cableCarBarnLeave(mh: Mh2): void {
  const { run, engine } = mh;
  assert.ok(walkLegs(mh, BARN_TO_CAR, barnAlive(mh)), `met the car; ${mh.describe()}`);
  mh.waitFor(() => engine.flags[154] === 1, "aboard the car", 120);
  mh.waitFor(() => mh.room === 140 && engine.flags[21] === 0, "the street outside the barn", 6000);
  run.checkpoint("Rode the cable car back out of the barn", { room: 140 });
}

/**
 * Noah Goring's house (room 138): the matchbook (item 19, f78) lies on the
 * corner table. His address comes from the MAD once the newspaper's "Noah
 * G..." is completed by the doctor's letter.
 */
export function scientistsHouse(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "scientist");
  mh.waitFor(() => engine.flags[21] === 0, "Goring's house");
  mh.press(1, 82, 112, /./, 1);
  mh.press(2, 107, 127, /./, 3);
  mh.hotspot(1, 50, 100, /matchbook/);
  mh.enter(() => mh.room === 155, "the matchbook close-up");
  mh.enter(() => mh.room === 138 && engine.flags[21] === 0, "back at the table");
  run.assertCarried(19, "the matchbook");
  run.checkpoint("Took the matchbook from Goring's table", { room: 138 });
}

/**
 * The Wax Museum (rooms 143, 146, 147 and 149), Zac West's address. The
 * mallet (item 11) strikes the wax fisherman's fish to open the door; past
 * the two propaganda exhibits the third one's fireplace is the way up to
 * Zac's room, and climbing it records the visit (f92).
 */
export function waxMuseumDay2(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "waxMuseum");
  mh.waitFor(() => engine.flags[21] === 0, "the Wax Museum");
  mh.press(1, 70, 130, /./, 1);
  mh.press(1, 108, 140, /./, 2);
  mh.use(11);
  mh.waitFor(() => mh.room === 146 && engine.flags[21] === 0, "the first exhibit", 6000);
  mh.hotspot(1, 2, mh.cursor.y);
  mh.enter(() => mh.room === 147 && engine.flags[21] === 0, "the second exhibit", 1200);
  mh.hotspot(1, 2, mh.cursor.y);
  mh.enter(() => mh.room === 149 && engine.flags[21] === 0, "the third exhibit", 1200);
  mh.hotspot(3, 57, 104);
  mh.enter(() => engine.flags[92] === 1, "up the chimney");
  mh.waitFor(() => mh.scene === 1 && engine.flags[21] === 0, "Zac's room", 3000);
  run.checkpoint("Climbed the chimney to Zac's room", { room: 149 });
  mh.enter(
    () => mh.room === 149 && mh.scene === 0 && engine.flags[21] === 0,
    "back down the chimney",
    3000,
  );
  leaveWaxMuseum(mh, [147, 146, 143]);
}

/** Walk out through the exhibits' right-hand exits; travel is only possible from the street. */
function leaveWaxMuseum(mh: Mh2, rooms: readonly number[]): void {
  const { engine } = mh;
  for (const room of rooms) {
    mh.hotspot(2, 155, mh.cursor.y);
    mh.enter(() => mh.room === room && engine.flags[21] === 0, `exhibit exit to ${room}`, 1200);
  }
  assert.equal(engine.flags[29], 1, "travel is possible again");
}

/**
 * Day 3 opens on the Ghirardelli Square recording (room 173); entering it
 * puts the Square on the map (f65), so the MAD is closed at once.
 */
export function trackDay3(mh: Mh2): void {
  const { run, engine } = mh;
  mh.waitFor(() => mh.room === ROOM_MAD && mh.hint().includes("ENTER"), "the day's case");
  mh.enter(() => mh.room === 173, "the tracker", 600);
  assert.equal(engine.flags[65], 1, "the Square is on the map");
  run.key(KEY_C);
  mh.waitFor(() => mh.room === 125 && engine.flags[21] === 0, "the MAD closes", 600);
}

/**
 * The Laundry (rooms 134, 166, 162, 167 and 163) is open on Day 3. The
 * laundry receipt (item 5) gets the Manhunter into the back room, where he is
 * knocked out and locked in a closet until the man from the Pyramid frees
 * him that night; the walking stick (item 8, f58) stands by the door.
 */
export function laundry(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "laundry");
  mh.waitFor(() => engine.flags[21] === 0, "the Laundry");
  mh.press(1, 43, 120, /./, 1);
  mh.press(1, 47, 100, /./, 11);
  mh.press(1, 40, 100, /./, 2);
  mh.use(5);
  mh.waitFor(
    () => mh.room === 166 && mh.scene === 1 && engine.flags[21] === 0,
    "admitted to the back",
    6000,
  );
  mh.hotspot(1, 75, mh.cursor.y);
  mh.enter(() => mh.room !== 166, "following the woman", 1200);
  mh.waitFor(
    () => mh.room === 163 && mh.scene === 3 && engine.flags[21] === 0,
    "freed from the closet",
    20000,
  );
  mh.hotspot(2, 101, 135, /./);
  mh.enter(() => mh.room === 155, "the walking stick close-up");
  mh.enter(() => mh.room === 163 && engine.flags[21] === 0, "back in the dark laundry", 3000);
  run.assertCarried(8, "the walking stick");
  run.checkpoint("Left the Laundry with the walking stick", { room: 163 });
  mh.waitFor(() => mh.scene === 3 && engine.flags[21] === 0, "the dark laundry", 3000);
  mh.hotspot(1, 75, 128);
  mh.enter(() => mh.room === 134 && engine.flags[21] === 0, "the street", 3000);
}

/**
 * Ghirardelli Square (room 133): between the buildings lie a severed rat's
 * paw (item 10, f60) and the rope to the roof; from the roof the right-hand
 * edge leads onto the electric sign (room 132).
 */
export function squareToSign(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "square");
  mh.waitFor(() => engine.flags[21] === 0, "the Square");
  mh.press(1, 44, 150, /./, 1);
  mh.hotspot(2, 40, 145, /./);
  mh.enter(() => mh.room === 155, "the paw close-up");
  mh.enter(() => mh.room === 133 && mh.scene === 1 && engine.flags[21] === 0, "back in the alley");
  run.assertCarried(10, "the rat's paw");
  mh.press(1, 10, mh.cursor.y, /./, 2);
  mh.hotspot(2, 110, 100);
  mh.enter(() => mh.room === 132, "onto the sign", 3000);
  mh.waitFor(() => mh.scene === 1, "hanging from the sign's wires", 3000);
  run.checkpoint("Climbed onto the Ghirardelli sign", { room: 132 });
}

/**
 * The sign (room 132) is a maze of wires: the climber (object 4) moves eight
 * pixels per Left or Right and sixteen per Up or Down, and falls if the pixel
 * he hangs from meets a control line (f3) — a broken wire — or a spark
 * (objects 1 to 3) from the shorting letter G. A fall is harmless: the game
 * walks him back to the first wire. SIGN_PATH is the shortest route through
 * the picture's control lines to the body (x 59-67, y 25-36), computed from
 * the priority screen while keeping off the top row beside the letter G. On
 * the Easy setting only one spark flies at a time; each move waits until no
 * course that spark can take would cross it, and a hit simply starts over.
 */
const SIGN_PATH = "7131771331771111757777555555757777777771171111113353353531113";

const DIR_VECTOR: Record<number, readonly [number, number]> = {
  0: [0, 0],
  1: [0, -1],
  2: [1, -1],
  3: [1, 0],
  4: [1, 1],
  5: [0, 1],
  6: [-1, 1],
  7: [-1, 0],
  8: [-1, -1],
};

/** Sparks: screen object, live flag, turn counter and the step size once it drops. */
const SPARKS = [
  { object: 1, flag: 151, counter: 90, drop: 8 },
  { object: 2, flag: 152, counter: 91, drop: 4 },
  { object: 3, flag: 153, counter: 92, drop: 8 },
] as const;

interface SparkState {
  x: number;
  y: number;
  dir: number;
  step: number;
  counter: number;
  drop: number;
}

/**
 * Would the climber, moving `cycles` pixels along `dir` from (cx,cy), be hit?
 * Logic 132 turns a spark one compass step every nine cycles (v90 to v92) and
 * may then let it drop in a straight line; a spark strictly inside x-3..x+8,
 * y-17..y+3 of the climber knocks him off. Every branch of that rule is
 * followed, so "safe" means safe whatever the dice say.
 */
function sparkHits(
  spark: SparkState,
  cx: number,
  cy: number,
  dir: number,
  cycles: number,
  horizon: number,
): boolean {
  if (spark.x > cx - 3 && spark.x < cx + 8 && spark.y > cy - 17 && spark.y < cy + 3) return true;
  if (horizon === 0) return false;
  const [mx, my] = cycles > 0 ? DIR_VECTOR[dir]! : DIR_VECTOR[0]!;
  const futures: SparkState[] = [];
  if (spark.counter > 0 && spark.counter + 1 > 9 && spark.dir < 6) {
    const turned = spark.dir + 1;
    if (turned < 6) futures.push({ ...spark, dir: turned, counter: 1 });
    if (turned > 3) futures.push({ ...spark, dir: turned, counter: 0, step: spark.drop });
  } else if (spark.counter > 0) {
    futures.push({ ...spark, counter: spark.counter + 1 > 9 ? 1 : spark.counter + 1 });
  } else {
    if (spark.y > 151 || spark.x > 151 || spark.x < 5) return false;
    futures.push(spark);
  }
  return futures.some((next) => {
    const [vx, vy] = DIR_VECTOR[next.dir]!;
    const moved = { ...next, x: next.x + vx * next.step, y: Math.max(0, next.y + vy * next.step) };
    return sparkHits(moved, cx + mx, cy + my, dir, cycles - 1, horizon - 1);
  });
}

function climbSign(mh: Mh2): void {
  const { run, engine } = mh;
  const climber = engine.screenObjects[4]!;
  const idle = () => mh.scene === 1 && engine.vars[96] === 0 && engine.vars[50] === 0;
  const danger = (dir: number, cycles: number, horizon: number) =>
    SPARKS.some((spark) => {
      if (!engine.flags[spark.flag]) return false;
      const o = engine.screenObjects[spark.object]!;
      const state = {
        x: o.x,
        y: o.y,
        dir: o.direction,
        step: o.stepSize,
        counter: engine.vars[spark.counter]!,
        drop: spark.drop,
      };
      return sparkHits(state, climber.x, climber.y, dir, cycles, horizon);
    });
  mh.easyArcade();
  for (let attempt = 0; attempt < 40 && mh.scene !== 2; attempt++) {
    mh.waitFor(idle, "hanging at the first wire", 3000);
    for (let i = 0; i < SIGN_PATH.length && mh.scene === 1;) {
      const dir = Number(SIGN_PATH[i]);
      const cycles = dir === 1 || dir === 5 ? 16 : 8;
      // Hold still while the move would cross a spark and waiting would not.
      if (danger(dir, cycles, cycles + 2) && !danger(0, 0, 3)) {
        mh.cycle();
        continue;
      }
      run.direction(dir);
      mh.waitFor(
        () => mh.scene !== 1 || (engine.vars[96] === 0 && engine.vars[50] === 0),
        "the move ends",
        300,
      );
      i++;
    }
    mh.waitFor(() => mh.scene === 2 || idle(), "the body or the first wire again", 3000);
  }
  assert.equal(mh.scene, 2, `reached the body on the sign; ${mh.describe()}`);
}

/**
 * The body on the sign wears a ring (item 9, f59) that is live with current;
 * the wooden walking stick (item 8) lifts it off safely. Without the ring the
 * next fall leads back to the roof.
 */
export function signRing(mh: Mh2): void {
  const { run, engine } = mh;
  climbSign(mh);
  mh.waitFor(() => engine.flags[21] === 0, "the body close-up");
  mh.use(8);
  mh.waitFor(() => run.carried(9), "the ring comes off on the stick", 3000);
  run.checkpoint("Lifted the ring off the body with the walking stick", { room: 132 });
  mh.waitFor(() => mh.scene === 6 && engine.flags[21] === 0, "the ring in hand");
  mh.enter(() => mh.stage === 1 && engine.flags[21] === 0, "the ring close-up");
  mh.enter(() => mh.scene === 1 && engine.vars[96] === 0, "back on the wires");
  // With the ring taken (f59 clear) a fall ends on the roof: Left from here
  // meets a broken wire two pixels on.
  mh.cycle(2);
  run.direction(7);
  mh.waitFor(
    () => mh.room === 133 && mh.scene === 2 && engine.flags[21] === 0,
    "dropped to the roof",
    6000,
  );
}

/**
 * The Shop (rooms 139, 158 and 123). The owner takes the rat's paw (item 10)
 * as a stake in his find-the-ace game. The ace is the card that starts in the
 * middle (object 2; logic 123 tracks it as the slot holding 2 among v90 to
 * v92), so the route watches where that card comes to rest. Three wins earn a
 * prize round (v68); the first offers a flashlight or a lantern, the second
 * the two rat masks, and the left-hand mask (item 22) has the eye holes.
 */
function findTheAce(mh: Mh2, round: number): void {
  const { engine } = mh;
  const ace = engine.screenObjects[2]!;
  for (let win = 1; win <= 3; win++) {
    mh.waitFor(
      () => mh.room === 123 && mh.scene === 0 && mh.stage === 5 && engine.flags[21] === 0,
      "the shuffle ends",
      6000,
    );
    const slot = ace.x < 66 ? 1 : ace.x < 90 ? 2 : 3;
    assert.equal(engine.vars[89 + slot], 2, `the watched card is the ace; ${mh.describe()}`);
    mh.hotspot(slot, [55, 78, 101][slot - 1]!, 104);
    mh.enter(() => mh.scene === 1, "the card is turned");
    mh.waitFor(
      () => engine.vars[98] === win % 3 || mh.scene === 2,
      `win ${win} of round ${round}`,
      3000,
    );
  }
  mh.waitFor(
    () => mh.scene === 2 && engine.vars[68] === round && engine.flags[21] === 0,
    "the prize table",
    3000,
  );
}

export function shopGame(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "shop");
  mh.waitFor(() => engine.flags[21] === 0, "the Shop");
  mh.hotspot(1, 41, 95);
  mh.enter(() => mh.scene === 1 && engine.flags[21] === 0, "inside the Shop", 6000);
  mh.press(1, 77, 80, /./, 2);
  mh.use(10);
  mh.waitFor(() => mh.room === 158 && engine.flags[21] === 0, "the owner takes the paw", 6000);
  mh.hotspot(1, 75, 140);
  mh.enter(() => mh.room === 123, "the card table", 3000);
  run.checkpoint("Staked the rat's paw on the shopkeeper's card game", { room: 123 });
  findTheAce(mh, 1);
  assert.equal(mh.spot, 0, "no first-round prize is selected");
  mh.enter(() => mh.room === 123 && mh.scene === 0, "playing on", 3000);
  findTheAce(mh, 2);
  mh.hotspot(1, 37, 100, /rat mask/);
  mh.enter(() => mh.room === 139 && engine.flags[21] === 0, "back in the Shop", 3000);
  run.assertCarried(22, "the rat mask");
  run.checkpoint("Won the rat mask", { room: 139 });
}

/**
 * The Private Club (rooms 131, 164 and 165). At the peephole the rat mask
 * (item 22) is put on before knocking (f84 clear), and the doorman lets the
 * "rat" in. The dice game is lost, the mask comes off (stage 43 of logic
 * 164), and the full flask (item 18) thrown to the rat-men starts a brawl
 * over it; the hatchet they chopped fingers with (item 23, f85) is left on
 * the floor on the way out.
 */
export function club(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "club");
  mh.waitFor(() => engine.flags[21] === 0, "the Club door");
  mh.press(1, 83, 96, /./, 1);
  mh.use(22);
  mh.waitFor(() => engine.flags[84] === 0, "the mask is on", 600);
  mh.hotspot(1, 75, 70, /Knock/i);
  mh.enter(() => mh.room === 164, "let into the Club", 6000);
  run.checkpoint("Knocked at the Club in the rat mask", { room: 164 });
  mh.waitFor(() => mh.stage === 44, "unmasked by the rat-men", 30000);
  mh.use(18);
  mh.waitFor(
    () => mh.room === 165 && mh.scene === 1 && engine.flags[21] === 0,
    "the brawl over the flask",
    6000,
  );
  mh.hotspot(1, 88, 130, /hatchet/);
  mh.enter(() => run.carried(23), "the hatchet");
  run.checkpoint("Distracted the rat-men with the flask and took their hatchet", { room: 165 });
  mh.hotspot(2, 144, 115);
  mh.enter(() => mh.room === 131 && engine.flags[21] === 0, "out of the Club", 6000);
}

/**
 * The Wax Museum on Day 3: Goring's body has been added to the second
 * exhibit's pile (room 147). The stitching on the back of his tie yields to
 * the broken fang (item 7; v69), and inside is the Orb access card (item 26).
 */
export function waxMuseumDay3(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "waxMuseum");
  mh.waitFor(() => engine.flags[21] === 0, "the Wax Museum");
  mh.press(1, 70, 130, /./, 1);
  mh.press(1, 108, 140, /./, 2);
  mh.use(11);
  mh.waitFor(() => mh.room === 146 && engine.flags[21] === 0, "the first exhibit", 6000);
  mh.hotspot(1, 2, mh.cursor.y);
  mh.enter(() => mh.room === 147 && engine.flags[21] === 0, "the second exhibit", 1200);
  mh.press(3, 105, 124, /./, 1);
  mh.use(7);
  mh.waitFor(
    () => engine.vars[69]! > 0 && mh.scene === 1 && engine.flags[21] === 0,
    "the stitching is cut",
    6000,
  );
  mh.hotspot(1, 49, 45, /./);
  mh.enter(() => mh.room === 155, "the access card close-up");
  mh.enter(() => mh.room === 147 && engine.flags[21] === 0, "back at the exhibit");
  run.assertCarried(26, "the Orb access card");
  run.checkpoint("Cut the Orb access card out of Goring's tie", { room: 147 });
  if (mh.scene !== 0)
    mh.enter(() => mh.scene === 0 && engine.flags[21] === 0, "back from the body", 1200);
  leaveWaxMuseum(mh, [146, 143]);
}

/**
 * Down the roof's stairwell (room 168) — safe now that the flask is gone
 * (f103) — the ring (item 9) unlocks the sewer gate. The crawl ends on Phil
 * Cook's throne (room 170), where the Orb-on-a-stick (item 25) falls loose,
 * and in the rat-men's pit (room 171), where the camera's one flash (item
 * 17, f95) blinds them during stage 6. The escape comes out of the pipe at
 * the Hyde Street Pier (room 110).
 */
export function lair(mh: Mh2): void {
  const { run, engine } = mh;
  openMap(mh);
  travel(mh, "square");
  mh.waitFor(() => engine.flags[21] === 0, "the Square");
  mh.press(1, 44, 150, /./, 1);
  mh.press(1, 10, mh.cursor.y, /./, 2);
  mh.hotspot(1, 33, 95);
  mh.enter(() => mh.room === 168, "the stairwell", 3000);
  assert.equal(engine.flags[103], 0, "no flask to break on the stairs");
  mh.waitFor(() => mh.scene === 1 && engine.flags[21] === 0, "the foot of the stairs", 9000);
  mh.press(1, 72, 128, /./, 2);
  mh.use(9);
  mh.waitForRoom(170, "through the sewer onto the throne", 20000);
  run.checkpoint("Unlocked the sewer gate with the ring", { room: 170 });
  mh.waitFor(
    () => mh.scene === 3 && mh.stage === 8 && engine.flags[21] === 0,
    "Phil drops the viewer",
    20000,
  );
  mh.hotspot(1, 70, 100, /./);
  mh.enter(() => run.carried(25), "the Orb-on-a-stick");
  mh.waitFor(() => mh.room === 171 && mh.stage === 6, "thrown to the rat-men", 20000);
  run.checkpoint("Thrown into the rat-men's pit by Phil", { room: 171 });
  mh.use(17);
  mh.waitFor(() => engine.flags[95] === 0, "the flash goes off", 600);
  mh.waitFor(() => mh.room === 110 && engine.flags[21] === 0, "out of the pipe at the pier", 20000);
  run.checkpoint("Blinded the rat-men and escaped to the pier", { room: 110 });
}

/**
 * Under the Hyde Street Pier (room 172) a cracked pillar leads up to a hole
 * blocked by a crate; the hatchet (item 23) breaks into it from below, and
 * the supply ship's robot loads crate and stowaway for Alcatraz (room 175).
 */
export function stowaway(mh: Mh2): void {
  const { run, engine } = mh;
  mh.waitFor(
    () => mh.room === 110 && mh.scene === 0 && engine.flags[21] === 0,
    "on top of the pier",
    6000,
  );
  mh.hotspot(2, 41, 140, /climb down/);
  mh.enter(() => mh.scene === 3 && engine.flags[21] === 0, "the beach", 3000);
  mh.hotspot(3, 45, 87, /look under the pier/);
  mh.enter(
    () => mh.room === 172 && mh.scene === 11 && engine.flags[21] === 0,
    "under the pier",
    6000,
  );
  mh.hotspot(1, 73, 50);
  mh.enter(() => mh.scene === 1 && engine.flags[21] === 0, "up the pillar to the crate", 6000);
  mh.use(23);
  mh.waitForRoom(175, "shipped to Alcatraz in the crate", 30000);
  run.checkpoint("Hacked into a crate bound for Alcatraz", { room: 175 });
}

/**
 * Alcatraz (rooms 175 and 176). The hatchet opens the crate from inside. In
 * the cell block the creature from the smoke-house vision sits in the second
 * cell of the second row (hotspot 6); giving her the statue (item 16, f98)
 * makes a friend of Ming. The Cell Door Access Machine takes Goring's card
 * (item 26) and then scans its user — the Orb-on-a-stick (item 25) must be
 * held up before the scan ends (stage under 10).
 */
export function alcatraz(mh: Mh2): void {
  const { run, engine } = mh;
  mh.waitFor(
    () => mh.room === 175 && mh.scene === 2 && engine.flags[21] === 0,
    "inside the delivered crate",
    30000,
  );
  mh.use(23);
  mh.waitFor(
    () => mh.room === 176 && mh.scene === 0 && engine.flags[21] === 0 && mh.cursor.active,
    "the cell block",
    30000,
  );
  mh.press(6, 67, 72, /./, 1);
  assert.equal(mh.spot, 6, "Ming's cell stays selected in the close-up");
  mh.use(16);
  mh.waitFor(() => engine.flags[98] === 1, "Ming takes the statue", 3000);
  mh.waitFor(() => mh.scene === 0 && engine.flags[21] === 0, "the cell block again", 6000);
  run.checkpoint("Gave Ming her father's statue", { room: 176 });
  mh.press(50, 10, 120, /./, 2);
  mh.use(26);
  mh.waitFor(() => mh.scene === 4, "the machine takes the card", 3000);
  mh.use(25);
  mh.waitFor(() => mh.room !== 176, "the cells open", 30000);
  run.checkpoint("Fooled the scanner with the Orb-on-a-stick", {});
}

/**
 * Ming carries the Manhunter out of the stampede (room 179, f98) to a hot
 * air balloon (room 180). Its right-hand valve starts the gas; a match from
 * Goring's matchbook (item 19), held to the jet within nine seconds, lights
 * the burner and the balloon lifts off (rooms 181 and 161).
 */
export function balloonLaunch(mh: Mh2): void {
  const { run, engine } = mh;
  mh.waitFor(
    () => mh.room === 180 && mh.scene === 50 && engine.flags[21] === 0,
    "in the balloon's basket",
    30000,
  );
  mh.press(1, 112, 112, /closer look/, 1);
  mh.press(1, 125, 83, /turn this handle/, 2);
  mh.use(19);
  mh.waitFor(() => mh.scene === 3, "a lit match", 600);
  mh.hotspot(1, 68, 85);
  mh.waitForRoom(161, "lift-off", 9000);
  run.checkpoint("Lit the burner and lifted off from Alcatraz", { room: 161 });
}

/**
 * The balloon flight (room 161). The balloon drifts east one pixel every six
 * cycles while gravity works on its vertical speed (v93: 3 fastest, 8
 * hanging; f153 set while sinking). Enter adds lift, which slows a descent
 * and at v93 over 8 turns it into a climb. Julius Castle's roof is the box
 * x 123-130, y 98-104 below Coit Tower (x over 129, y 46-68, a crash), so the
 * route brakes each descent just above row 100 and lets the balloon hang
 * there until the wind carries it over the roof (room 184).
 */
export function balloonFlight(mh: Mh2): void {
  const { run, engine } = mh;
  for (let c = 0; c < 4000 && mh.room === 161; c++) {
    assert.equal(mh.scene, 1, `the balloon is still flying; ${mh.describe()}`);
    const sinking = engine.flags[153] !== 0;
    if (sinking && engine.vars[31]! >= 94 + 2 * (engine.vars[93]! - 3) && engine.flags[21] === 0)
      run.key(AGI_KEY.ENTER);
    mh.cycle();
  }
  mh.waitForRoom(184, "through the castle's skylight", 600);
  run.checkpoint("Landed the balloon on Julius Castle", { room: 184 });
}

/**
 * "Hell", the Orbs' control room under Julius Castle (rooms 193, 178 and
 * 185). The wall panel shows eighteen chambers (hotspots 180 + i at v90 + i,
 * v110 + i) joined by nineteen gates (hotspots 236 + j at v129 + j, v149 + j;
 * state in v237 + j, 0 open). Three sensor buttons on the left choose what
 * the chambers show: lava (f153), slaves (f154, v180 + i) or robots (f155,
 * v200 + i). Enter on an occupied chamber picks its group up and Enter on
 * another chamber sets it down; Enter on a gate toggles it, and opening one
 * lets logic 178 spread the lava (v219 + i) from the full chamber 17.
 *
 * Read from that logic: lava entering chamber 5 through any of its open
 * gates but the one from chamber 4, or reaching chambers 12 or 13, loses, as
 * does a slave standing in lava or a slave sent to Hell (chamber 8) while a
 * robot survives. Robots standing in lava are destroyed. So the twelve gates
 * on those paths are closed first, the robots of the dry chambers 0, 2, 9 and
 * 13 join the others in chamber 16, the slaves of chambers 1, 4, 5, 15 and 16
 * move to the dry "Slavery" (chamber 7; leaving it again before the lava has
 * run is fatal), the gate between chambers 4 and 5 is opened, and last the gate
 * beside chamber 17. The lava takes chambers 16, then 4, 10 and 15, then 1, 3
 * and 5 with every robot in them. All slaves then go to Hell, and they carry
 * the Manhunter to the Orbs' digging machine (room 186).
 */
const PANEL_CHAMBERS: readonly (readonly [number, number])[] = [
  [61, 23],
  [80, 23],
  [99, 23],
  [118, 23],
  [42, 51],
  [80, 51],
  [99, 65],
  [64, 84],
  [119, 82],
  [137, 79],
  [23, 107],
  [61, 107],
  [99, 107],
  [64, 126],
  [99, 121],
  [42, 135],
  [80, 149],
  [109, 149],
];
const PANEL_GATES: readonly (readonly [number, number])[] = [
  [99, 91],
  [71, 22],
  [86, 22],
  [109, 22],
  [89, 42],
  [72, 50],
  [118, 56],
  [23, 78],
  [51, 78],
  [99, 72],
  [108, 78],
  [54, 106],
  [69, 106],
  [127, 106],
  [99, 113],
  [99, 128],
  [90, 134],
  [80, 139],
  [99, 148],
];
const GATES_TO_CLOSE = [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 16] as const;

export function hellPanel(mh: Mh2): void {
  const { run, engine } = mh;
  const panelReady = () => mh.room === 178 && mh.scene === 0 && engine.flags[21] === 0;
  /** Sit out the cutscenes a lava surge triggers; S skips the long ones. */
  const settle = (label: string) => {
    let skipped = -1;
    for (let t = 0; t < 60000 && !(panelReady() && t > 12); t++) {
      if (mh.room === 156) assert.fail(`${label}: the panel plan failed; ${mh.describe()}`);
      if (mh.room !== 178 && mh.room !== skipped && mh.hint().includes("Press S")) {
        skipped = mh.room;
        run.key(KEY_S);
      }
      mh.step(1);
    }
    assert.ok(panelReady(), `${label}; ${mh.describe()}`);
  };
  const sensor = (spot: number, y: number, flag: number) => {
    mh.hotspot(spot, 5, y, /press this button/);
    mh.enter(() => engine.flags[flag] === 1, "the sensor");
    mh.cycle(2);
  };
  const gate = (j: number, open: boolean) => {
    const [x, y] = PANEL_GATES[j]!;
    assert.equal(
      engine.vars[237 + j],
      open ? 1 : 0,
      `gate ${j} starts ${open ? "closed" : "open"}`,
    );
    mh.hotspot(236 + j, x, y, open ? /open this gate/ : /close this gate/);
    run.key(AGI_KEY.ENTER);
    mh.waitFor(() => engine.vars[237 + j] === (open ? 0 : 1) || mh.room !== 178, `gate ${j}`, 300);
    mh.cycle(2);
  };
  const move = (from: number, to: number, base: number) => {
    const [fx, fy] = PANEL_CHAMBERS[from]!;
    const [tx, ty] = PANEL_CHAMBERS[to]!;
    mh.hotspot(180 + from, fx, fy, /move them from here/);
    mh.enter(() => engine.vars[128]! > 0, "the group is picked up");
    mh.cycle(2);
    mh.hotspot(180 + to, tx, ty, /move them to here/);
    run.key(AGI_KEY.ENTER);
    mh.waitFor(
      () => (engine.vars[128] === 0 && engine.vars[base + to] === 1) || mh.room !== 178,
      "the group is set down",
      300,
    );
    assert.ok(mh.room !== 178 || engine.vars[base + from] === 0, "the source chamber emptied");
    mh.cycle(2);
  };

  mh.waitFor(
    () => mh.room === 193 && engine.flags[21] === 0 && mh.cursor.active,
    "the fall into Hell",
    30000,
  );
  run.checkpoint("Fell through the castle onto the Orb in Hell", { room: 193 });
  mh.hotspot(1, 75, 93);
  mh.enter(() => panelReady(), "the control panel", 3000);
  for (const j of GATES_TO_CLOSE) gate(j, false);
  sensor(42, 153, 155);
  for (const chamber of [0, 2, 9, 13]) move(chamber, 16, 200);
  sensor(41, 109, 154);
  for (const chamber of [1, 4, 5, 15, 16]) move(chamber, 7, 180);
  run.checkpoint("Herded the robots together and the slaves to safety", { room: 178 });
  gate(5, true);
  settle("the upper gate is open");
  gate(18, true);
  settle("the lava has run its course");
  for (const chamber of [1, 3, 4, 5, 10, 15, 16])
    assert.equal(engine.vars[219 + chamber], 1, `lava reached chamber ${chamber}`);
  for (let i = 0; i < 18; i++)
    assert.equal(engine.vars[200 + i], 0, `no robot survives in chamber ${i}`);
  assert.equal(engine.vars[231]! + engine.vars[232]!, 0, "Freedom's side stayed dry");
  run.checkpoint("Drowned the Orbs' robots in lava", { room: 178 });
  if (engine.flags[154] === 0) sensor(41, 109, 154);
  for (const chamber of [7, 14]) {
    move(chamber, 8, 180);
    if (mh.room !== 178) break;
  }
  mh.waitForRoom(186, "carried to Freedom by the freed slaves", 30000);
  run.checkpoint("Led the freed slaves through Hell to the digging machine", { room: 186 });
}

/**
 * The digging machine (room 186) wants a four-letter Orb password on its
 * four buttons, then the red button. Logic 186 compares the display cels with
 * 0, 1, 1, 2 — buttons one, two, two, three — the word tattooed on the
 * severed arm in the Club. The lit view screen then starts the drive.
 */
export function diggerPassword(mh: Mh2): void {
  const { run, engine } = mh;
  mh.waitFor(
    () => mh.room === 186 && mh.scene === 0 && engine.flags[21] === 0 && mh.cursor.active,
    "the digger's cockpit",
    6000,
  );
  [1, 2, 2, 3].forEach((button, i) => {
    if (mh.spot === button) mh.steer(mh.cursor.x, 125, () => mh.spot === 0, "off the button");
    mh.hotspot(button, 47 + button * 12.5, 102);
    mh.enter(() => engine.vars[91] === i + 1, `letter ${i + 1}`);
    mh.cycle(2);
  });
  mh.hotspot(5, 77, 80);
  mh.enter(() => mh.scene === 2 && engine.flags[21] === 0, "the password is accepted", 3000);
  run.checkpoint("Entered the Orb password into the digging machine", { room: 186 });
  mh.hotspot(1, 75, 130);
  mh.enter(() => mh.room === 183, "driving the digger", 3000);
}

/**
 * The drive to the surface (room 183): four screens of lava pockets (v90: 1
 * bottom-left, 2 bottom-right, 3 top-left, 4 top-right), crossed by a digger
 * with inertia. An arrow key is thrust that logic 183 turns into speed levels
 * (v94 and v95: 3 fastest, 9 at rest) with friction, and the same key again
 * lets go. The digger's six-pixel baseline touching lava (f3) ends the drive;
 * the exit is on screen 4 at x 130-143 above row 24. The only passage wide
 * enough runs screens 1, 2, 4, back down into 2, and up into 4 again. The
 * room draws no random numbers, so DIGGER_KEYS — thrust changes as
 * [cycle, direction] pairs counted from the room's first cycle, found by
 * searching the engine's own runs along that passage — replays exactly.
 */
// prettier-ignore
const DIGGER_KEYS: readonly (readonly [number, number])[] = [
  [0, 8], [3, 1], [6, 0], [15, 7], [18, 0], [21, 1], [24, 0], [27, 3], [33, 1], [36, 0],
  [42, 1], [45, 0], [48, 1], [51, 0], [54, 1], [57, 3], [60, 0], [63, 3], [72, 5], [75, 0],
  [81, 2], [84, 5], [87, 0], [90, 4], [93, 0], [108, 8], [111, 4], [114, 8], [117, 1], [120, 5],
  [123, 2], [126, 0], [132, 3], [135, 0], [138, 5], [141, 0], [144, 4], [147, 5], [150, 0], [153, 7],
  [156, 4], [159, 0], [162, 4], [165, 0], [171, 4], [174, 0], [177, 7], [180, 4], [183, 2], [189, 5],
  [192, 2], [195, 0], [201, 3], [204, 1], [210, 3], [213, 0], [222, 3], [228, 0], [243, 5], [246, 3],
  [249, 4], [252, 0], [255, 4], [258, 0], [261, 3], [264, 0], [270, 3], [273, 5], [276, 1], [279, 3],
  [285, 0], [291, 1], [294, 3], [297, 0], [303, 3], [306, 0], [312, 3], [315, 0], [321, 1], [324, 3],
  [330, 0], [336, 3], [339, 0], [348, 6], [351, 4], [357, 3], [360, 0], [366, 4], [369, 3], [372, 0],
  [375, 1], [378, 3], [381, 0], [384, 3], [390, 0], [399, 3], [405, 0], [411, 1], [414, 3], [417, 0],
  [420, 1], [423, 0], [429, 3], [432, 1], [435, 0], [444, 1], [447, 0], [453, 1], [456, 0], [465, 1],
  [468, 0], [480, 1], [483, 0], [486, 1], [489, 0], [492, 1], [495, 0], [504, 1], [507, 0], [519, 1],
  [522, 0], [540, 7], [543, 1], [546, 7], [549, 2], [552, 0], [564, 7], [567, 0], [570, 4], [579, 0],
  [582, 7], [585, 5], [588, 6], [591, 0], [594, 5], [597, 2], [600, 0], [612, 4], [615, 8], [618, 5],
  [624, 0], [627, 6], [630, 0], [633, 5], [636, 7], [642, 5], [645, 0], [651, 7], [654, 0], [666, 7],
  [669, 0], [678, 2], [681, 7], [684, 1], [687, 0], [696, 1], [699, 0], [705, 1], [708, 0], [723, 4],
  [726, 1], [729, 3], [735, 0], [738, 2], [741, 0], [747, 1], [750, 2], [753, 3], [756, 0], [759, 1],
  [762, 7], [765, 0], [771, 1], [774, 0], [786, 4], [789, 2], [792, 3], [795, 0], [798, 2], [801, 0],
  [804, 3], [810, 0], [813, 1], [816, 0], [819, 3], [822, 0], [825, 1], [828, 0], [840, 1], [843, 0],
  [846, 2], [849, 0], [858, 1], [861, 0], [867, 1], [870, 3], [876, 0], [879, 1], [882, 0], [888, 1],
  [891, 0],
];

export function lavaMaze(mh: Mh2): void {
  const { run, engine } = mh;
  const start = run.cycles;
  for (const [cycle, dir] of DIGGER_KEYS) {
    while (run.cycles - start < cycle) mh.cycle();
    assert.equal(engine.flags[3], 0, `the digger stays clear of the lava; ${mh.describe()}`);
    assert.equal(mh.room, 183, "still driving");
    run.direction(dir);
  }
  mh.waitForRoom(187, "the digger breaks the surface", 3000);
  run.checkpoint("Drove the digging machine through the lava to the surface", { room: 187 });
}

/**
 * The ending (room 187): Phil Cook runs for his ship behind the Ferry
 * Building and takes off with the Manhunter clinging to the landing gear.
 * One Enter ends the flight, a closer look at the shape in the distance
 * shows "To be continued..." (scene 7), and two seconds later logic 187
 * quits the game, so the route stops on that card.
 */
export function ending(mh: Mh2): void {
  const { run, engine } = mh;
  mh.waitFor(() => mh.scene === 5 && engine.flags[21] === 0, "the flight to London", 60000);
  run.checkpoint("Carried off on Phil's ship toward London", { room: 187 });
  mh.enter(() => mh.scene === 6 && engine.flags[21] === 0, "the distant shape");
  mh.hotspot(1, 77, 93, /closer look/);
  mh.enter(() => mh.scene === 7, "the closing card");
  run.checkpoint("To be continued...", { room: 187 });
}

/** The route, one named stage per site so a stage can be studied from the state before it. */
export const MH2_STAGES: readonly (readonly [string, (mh: Mh2) => void])[] = [
  ["opening", opening],
  ["crashSite", crashSite],
  ["trackDay1", trackDay1],
  ["bank", bank],
  ["ferryBuilding", ferryBuilding],
  ["fountain", fountain],
  ["den", den],
  ["warehouseEnter", warehouseEnter],
  ["warehouseOffice", warehouseOffice],
  ["warehouseLeave", warehouseLeave],
  ["madDay1", (mh) => madInfo(mh, ["Tad Timov"], [50])],
  ["hydePierDeath", hydePierDeath],
  ["timovDay1", timovDay1],
  ["homeDay1", homeDay1],
  [
    "reportDay1",
    (mh) => {
      orbOverride(mh, ["Tad Timov", "Mic Stone"], 2);
      mh.run.checkpoint("Reported the suspects; a new day begins", { room: ROOM_MAD });
    },
  ],
  ["trackDay2", trackDay2],
  ["pier5", pier5],
  ["timovDay2", timovDay2],
  ["temple", temple],
  ["templeStairs", templeStairs],
  ["brandingChamber", brandingChamber],
  ["smokeHouse", smokeHouse],
  ["shopVisit", shopVisit],
  ["pyramid", pyramid],
  ["doctorsHouse", doctorsHouse],
  ["cableCarBarnEnter", cableCarBarnEnter],
  ["cableCarBarnSwitch", cableCarBarnSwitch],
  ["cableCarBarnGap", cableCarBarnGap],
  ["parkedCableCar", parkedCableCar],
  ["cableCarBarnLeave", cableCarBarnLeave],
  ["madDay2", (mh) => madInfo(mh, ["Noah Goring", "Zac West"], [76, 77])],
  ["scientistsHouse", scientistsHouse],
  ["waxMuseumDay2", waxMuseumDay2],
  [
    "reportDay2",
    (mh) => {
      orbOverride(mh, ["Noah Goring", "Zac West"], 3);
      mh.run.checkpoint("Reported Goring and West; the third day begins", { room: ROOM_MAD });
    },
  ],
  ["trackDay3", trackDay3],
  ["laundry", laundry],
  ["squareToSign", squareToSign],
  ["signRing", signRing],
  ["shopGame", shopGame],
  ["club", club],
  ["waxMuseumDay3", waxMuseumDay3],
  ["lair", lair],
  ["stowaway", stowaway],
  ["alcatraz", alcatraz],
  ["balloonLaunch", balloonLaunch],
  ["balloonFlight", balloonFlight],
  ["hellPanel", hellPanel],
  ["diggerPassword", diggerPassword],
  ["lavaMaze", lavaMaze],
  ["ending", ending],
];

export function mh2Complete(run: Speedrun): void {
  const mh = new Mh2(run);
  for (const [, stage] of MH2_STAGES) stage(mh);
}

/**
 * The game keeps no score (v3 stays 0), so the claim is the ending itself:
 * the closing card of room 187 on Day 3 with exactly the items that survive
 * the story. Seed 1: the recorded robot-dodging walks in the warehouse and
 * the cable car barn were searched under it; every other arcade is steered
 * from observed state.
 */
export const mh2Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.MH2,
  alias: "mh2",
  label: "freed San Francisco, drove the digger to the surface and reached the closing card",
  coverage: "complete-game",
  seed: 1,
  route: mh2Complete,
  expected: {
    room: 187,
    score: 0,
    vars: { 48: 7, 55: 3 },
    flags: { 81: 1, 98: 1 },
    carriedExactly: [1, 2, 3, 4, 7, 8, 11, 12, 14, 15, 17, 19, 20, 24, 25],
    inputEnabled: false,
  },
  requiresAnswer: true,
};
