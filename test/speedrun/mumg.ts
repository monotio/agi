import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

/** Route under construction: mumg (2.917 profile). */
export function mumgComplete(run: Speedrun): void {
  assert.fail(`mumg walkthrough not authored yet (room ${run.state().room})`);
}

export const mumgWalkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.MUMG,
  alias: "mumg",
  label: "route under construction",
  coverage: "partial",
  seed: 1,
  route: mumgComplete,
  expected: { room: 0 },
};
