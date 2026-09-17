import assert from "node:assert/strict";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

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

/** Route under construction: bc (2.440 profile). */
export function bcComplete(run: Speedrun): void {
  const bc = new Cauldron(run);
  boot(bc);
}

export const bcWalkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.BC,
  alias: "bc",
  label: "route under construction",
  coverage: "partial",
  seed: 1,
  route: bcComplete,
  expected: { room: 8 },
};
