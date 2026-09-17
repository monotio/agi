import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

/** Route under construction: bc (2.440 profile). */
export function bcComplete(run: Speedrun): void {
  assert.fail(`bc walkthrough not authored yet (room ${run.state().room})`);
}

export const bcWalkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.BC,
  alias: "bc",
  label: "route under construction",
  coverage: "partial",
  seed: 1,
  route: bcComplete,
  expected: { room: 0 },
};
