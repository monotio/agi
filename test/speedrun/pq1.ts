import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

/** Route under construction: pq1 (2.903 profile). */
export function pq1Complete(run: Speedrun): void {
  assert.fail(`pq1 walkthrough not authored yet (room ${run.state().room})`);
}

export const pq1Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.PQ1,
  alias: "pq1",
  label: "route under construction",
  coverage: "partial",
  seed: 1,
  route: pq1Complete,
  expected: { room: 0 },
};
