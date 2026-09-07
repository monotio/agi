import assert from "node:assert/strict";
import type { ScreenObject } from "../../src/runtime/screenObject.ts";
import type { Speedrun } from "./runner.ts";

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
export const KEY_ENTER = 13;
export const KEY_TAB = 9;
export const KEY_C = 0x43;
export const KEY_F3 = 0x3d00;
export const KEY_RIGHT = 0x4d00;
export const ROOM_MAP = 114;

const DIRECTIONS: Record<string, number> = {
  "0,-1": 1,
  "1,-1": 2,
  "1,0": 3,
  "1,1": 4,
  "0,1": 5,
  "-1,1": 6,
  "-1,0": 7,
  "-1,-1": 8,
  "0,0": 0,
};

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
    this.key(KEY_ENTER, ticks);
  }

  waitFor(predicate: () => boolean, label: string, max = 1200): void {
    for (let i = 0; i < max; i++) {
      if (predicate()) return;
      this.step(1);
    }
    throw new Error(`Timed out: ${label}; ${this.describe()}`);
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
    this.run.direction(DIRECTIONS[`${Math.sign(x - o.x)},${Math.sign(y - o.y)}`]!);
    this.run.advance();
  }

  /**
   * Steer the cursor to within two pixels of (x,y). A registering hotspot snaps
   * the cursor, so a target can be unreachable: steering gives up after twelve
   * motionless ticks and leaves the cursor where the room put it.
   */
  cursorTo(x: number, y: number, max = 600): void {
    let stale = 0;
    let lastX = -1;
    let lastY = -1;
    for (let n = 0; n < max; n++) {
      const o = this.cursor;
      if (Math.abs(x - o.x) <= 2 && Math.abs(y - o.y) <= 2) break;
      if (o.x === lastX && o.y === lastY) {
        if (++stale > 12) break;
      } else stale = 0;
      lastX = o.x;
      lastY = o.y;
      this.steerToward(x, y);
    }
    this.run.direction(0);
    this.step(3);
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
    this.key(KEY_F3);
    this.waitFor(() => this.engine.vars[0] === ROOM_MAP, "the city map", 600);
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
        const along = DIRECTIONS[`${Math.sign(edge[0] - c.x)},${Math.sign(edge[1] - c.y)}`]!;
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
    this.waitFor(() => this.engine.vars[0] === room, `arrival in room ${room}`, 1200);
  }
}
