import assert from "node:assert/strict";
import type { EngineStateReport } from "../../src/runtime/engine.ts";
import { Speedrun } from "./runner.ts";
import { opening } from "./openings.ts";
import { kq1Complete } from "./kq1.ts";
import { kq2Complete } from "./kq2.ts";
import { sq1Complete } from "./sq1.ts";
import { mh1Complete } from "./mh1.ts";

import { KNOWN_GAME_HASH, resolveGameHash } from "../../src/games/knownGames.ts";

/** Observable endpoint shared by the Node, CLI and browser walkthrough runners. */
export interface WalkthroughOutcome {
  state: EngineStateReport;
  egoView: number;
}
export interface Walkthrough {
  hash: string;
  gameId: string;
  label: string;
  coverage: "complete-game" | "chapter" | "partial";
  route(run: Speedrun): void;
  expected: {
    room: number;
    score?: number;
    vars?: Readonly<Record<number, number>>;
    flags?: Readonly<Record<number, number>>;
    carried?: readonly number[];
    carriedExactly?: readonly number[];
    inputEnabled?: boolean;
    egoView?: number;
  };
  requiresAnswer?: boolean;
}

export const WALKTHROUGHS: readonly Walkthrough[] = [
  {
    hash: KNOWN_GAME_HASH.KQ1,
    gameId: "kq1",
    label: "completed throne-room ending",
    coverage: "complete-game",
    route: kq1Complete,
    expected: {
      room: 53,
      score: 159,
      vars: { 74: 3 },
      flags: { 195: 1 },
      inputEnabled: false,
      egoView: 142,
    },
  },
  {
    hash: KNOWN_GAME_HASH.MH1,
    gameId: "mh1",
    label: "Day 1 completed",
    coverage: "chapter",
    route: mh1Complete,
    expected: { room: 104, vars: { 60: 2 }, carriedExactly: [11, 13, 14, 15] },
    requiresAnswer: true,
  },
  {
    hash: KNOWN_GAME_HASH.KQ2,
    gameId: "kq2",
    label: "completed wedding and ending credits with maximum score",
    coverage: "complete-game",
    route: kq2Complete,
    expected: {
      room: 106,
      score: 185,
      carriedExactly: [50, 53, 54, 55, 56, 57, 58, 59, 60, 65, 68, 69, 73, 74, 75, 76, 78, 82, 83],
    },
  },
  {
    hash: KNOWN_GAME_HASH.SQ1,
    gameId: "sq1",
    label: "completed ceremony and ending credits with maximum score",
    coverage: "complete-game",
    route: sq1Complete,
    expected: {
      room: 64,
      score: 202,
      carriedExactly: [1, 3, 5, 6, 13, 14, 16, 19, 22],
    },
    requiresAnswer: true,
  },
];

export function walkthrough(hashOrAlias: string): Walkthrough {
  const norm = hashOrAlias.toLowerCase();
  const resolved = resolveGameHash(norm) ?? norm;
  const entry = WALKTHROUGHS.find(
    (route) => route.hash.toLowerCase() === resolved || route.gameId.toLowerCase() === norm,
  );
  assert.ok(
    entry,
    `Unknown walkthrough ${hashOrAlias}; choose ${WALKTHROUGHS.map((route) => route.gameId).join(", ")}`,
  );
  return entry;
}

export function verifyWalkthrough(
  route: Walkthrough,
  { state, egoView }: WalkthroughOutcome,
): void {
  const expected = route.expected;
  assert.ok(
    opening(route.gameId).profiles.includes(state.profile),
    `${route.gameId}: supported interpreter profile`,
  );
  assert.equal(state.room, expected.room, route.label);
  if (expected.score !== undefined) assert.equal(state.vars[3], expected.score, "milestone score");
  for (const [index, value] of Object.entries(expected.vars ?? {}))
    assert.equal(state.vars[Number(index)], value, `v${index}`);
  for (const [index, value] of Object.entries(expected.flags ?? {}))
    assert.equal(state.flags[Number(index)], value, `f${index}`);
  const carried = state.inventory
    .filter((item) => item.room === 255)
    .map((item) => item.num)
    .sort((a, b) => a - b);
  for (const item of expected.carried ?? [])
    assert.ok(carried.includes(item), `item ${item} carried`);
  if (expected.carriedExactly)
    assert.deepEqual(carried, expected.carriedExactly, "carried inventory");
  if (expected.inputEnabled !== undefined)
    assert.equal(state.inputEnabled, expected.inputEnabled, "parser input");
  if (expected.egoView !== undefined) assert.equal(egoView, expected.egoView, "ending view");
}

export function runWalkthrough(route: Walkthrough, run = new Speedrun(route.hash, 1)): Speedrun {
  assert.ok(run.gameId === route.gameId || run.gameId === route.hash, "walkthrough fixture");
  route.route(run);
  verifyWalkthrough(route, {
    state: run.engine.readState(),
    egoView: run.engine.screenObjects[0]!.view,
  });
  if (route.requiresAnswer)
    assert.ok(
      run.actions.some((action) => action.kind === "answer"),
      "prompt answer recorded",
    );
  return run;
}
