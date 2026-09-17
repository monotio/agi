import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

/** Route under construction: gr1 (3.002.149 profile). */
export function gr1Complete(run: Speedrun): void {
  assert.fail(`gr1 walkthrough not authored yet (room ${run.state().room})`);
}

export const gr1Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.GR1,
  alias: "gr1",
  label: "route under construction",
  coverage: "partial",
  seed: 1,
  route: gr1Complete,
  expected: { room: 0 },
};
