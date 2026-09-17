import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

/** Route under construction: mh2 (3.002.149 profile). */
export function mh2Complete(run: Speedrun): void {
  assert.fail(`mh2 walkthrough not authored yet (room ${run.state().room})`);
}

export const mh2Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.MH2,
  alias: "mh2",
  label: "route under construction",
  coverage: "partial",
  seed: 1,
  route: mh2Complete,
  expected: { room: 0 },
};
