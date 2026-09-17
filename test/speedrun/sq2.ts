import assert from "node:assert/strict";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

/** Logic 95 is the game-over room; every death path ends in new.room(95). */
const DEATH_ROOM = 95;

function alive(run: Speedrun, label: string): void {
  assert.notEqual(run.engine.vars[0], DEATH_ROOM, `Roger died: ${label}`);
}

function boot(run: Speedrun): void {
  // Logic 98 asks for a name with get.string before the opening room.
  run.answer("Roger Wilco");
  run.wait(() => run.state().room === 140, "title screen", 600);
  run.checkpoint("Title screen", { room: 140, score: 0 });
  run.key(AGI_KEY.ENTER);
  run.wait(() => run.state().room === 1, "story introduction", 600);
  run.advance(30);
  run.key(AGI_KEY.ENTER);
  run.wait(() => run.state().room === 2, "orbital station hull", 2000);
  run.wait(() => run.engine.inputEnabled, "janitor introduction complete", 5000);
  alive(run, "boot");
  run.checkpoint("Sweeping the station hull", { room: 2, score: 0 });
}

export const SQ2_STAGES: readonly ((run: Speedrun) => void)[] = [boot];

/** Complete game. */
export function sq2Complete(run: Speedrun): void {
  for (const stage of SQ2_STAGES) stage(run);
}

export const sq2Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.SQ2,
  alias: "sq2",
  label: "route under construction",
  coverage: "partial",
  seed: 1,
  route: sq2Complete,
  expected: { room: 0 },
  requiresAnswer: true,
};
