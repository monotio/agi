import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

/** Route under construction: ddp (2.440 profile). */
export function ddpComplete(run: Speedrun): void {
  assert.fail(`ddp walkthrough not authored yet (room ${run.state().room})`);
}

export const ddpWalkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.DDP,
  alias: "ddp",
  label: "route under construction",
  coverage: "partial",
  seed: 1,
  route: ddpComplete,
  expected: { room: 0 },
};
