import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

/** Route under construction: sq2 (2.936 profile). */
export function sq2Complete(run: Speedrun): void {
  assert.fail(`sq2 walkthrough not authored yet (room ${run.state().room})`);
}

export const sq2Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.SQ2,
  alias: "sq2",
  label: "route under construction",
  coverage: "partial",
  seed: 1,
  route: sq2Complete,
  expected: { room: 0 },
};
