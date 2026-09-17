import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

/** Route under construction: lsl1 (2.440 profile). */
export function lsl1Complete(run: Speedrun): void {
  assert.fail(`lsl1 walkthrough not authored yet (room ${run.state().room})`);
}

export const lsl1Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.LSL1,
  alias: "lsl1",
  label: "route under construction",
  coverage: "partial",
  seed: 1,
  route: lsl1Complete,
  expected: { room: 0 },
};
