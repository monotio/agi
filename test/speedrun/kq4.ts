import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

/** Route under construction: kq4 (3.002.086 profile). */
export function kq4Complete(run: Speedrun): void {
  assert.fail(`kq4 walkthrough not authored yet (room ${run.state().room})`);
}

export const kq4Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.KQ4,
  alias: "kq4",
  label: "route under construction",
  coverage: "partial",
  seed: 1,
  route: kq4Complete,
  expected: { room: 0 },
};
