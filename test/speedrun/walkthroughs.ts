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
  alias: string;
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
    alias: "kq1",
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
    alias: "mh1",
    label: "Day 1 completed",
    coverage: "chapter",
    route: mh1Complete,
    expected: { room: 104, vars: { 60: 2 }, carriedExactly: [11, 13, 14, 15] },
    requiresAnswer: true,
  },
  {
    hash: KNOWN_GAME_HASH.KQ2,
    alias: "kq2",
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
    alias: "sq1",
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
  {
    hash: KNOWN_GAME_HASH.ADVENTURE_DEPARTMENT,
    alias: "adventure-department",
    label: "repaired all three exhibits and graduated",
    coverage: "complete-game",
    route: (run) => {
      run.wait(() => run.state().room === 1, "boot into the gallery", 300);
      // Picture Gallery: the frame's posn() box is x 45–110, y 112–167.
      run.checkpoint("Picture Gallery", { room: 1, score: 0 });
      run.walkTo(77, 140);
      run.command("paint mural");
      run.checkpoint("Mural painted", { room: 1, score: 10 });
      run.command("east");
      // Sprite Lab: the doorway drops ego inside the lever's box (x 8–52).
      run.checkpoint("Sprite Lab", { room: 2, score: 10 });
      run.command("pull lever");
      // The lever's end.of.loop runs ~16 cycles, then f34 prints the result.
      run.advance(24);
      run.dismiss();
      run.checkpoint("Robot awake", { room: 2, score: 20 });
      run.command("east");
      // Priority Archive: show the depth numbers, then fix Felix's.
      run.checkpoint("Priority Archive", { room: 3, score: 20 });
      run.command("show priority");
      run.command("fix priority");
      run.checkpoint("Graduated", { room: 3, score: 30 });
    },
    expected: {
      room: 3,
      score: 30,
      flags: { 30: 1, 31: 1, 32: 1, 33: 1 },
    },
  },
  {
    hash: KNOWN_GAME_HASH.SYNTHETIC,
    alias: "synthetic",
    label: "Synthetic Test Chamber route",
    coverage: "complete-game",
    route: (run) => {
      run.advance(10);
      run.checkpoint("Start", { room: 1, score: 0 });
      run.direction(3);
      run.advance(60);
      run.checkpoint("Corridor", { room: 1, score: 0 });
      run.advance(80);
      run.checkpoint("Chamber", { room: 2, score: 0 });
      run.direction(0);
      run.advance(5);
      run.answerNumber(42);
      run.command("answer");
      run.checkpoint("Solved", { room: 2, score: 50 });
      run.direction(7);
      run.advance(40);
      run.checkpoint("Complete", { room: 1, score: 50 });
      run.direction(0);
      run.advance(5);
    },
    expected: {
      room: 1,
      score: 50,
      vars: { 3: 50, 60: 42 },
      flags: { 32: 1 },
    },
    requiresAnswer: true,
  },
];

export function walkthrough(hashOrAlias: string): Walkthrough {
  const norm = hashOrAlias.toLowerCase();
  const resolved = resolveGameHash(norm) ?? norm;
  const entry = WALKTHROUGHS.find(
    (route) => route.hash.toLowerCase() === resolved || route.alias.toLowerCase() === norm,
  );
  assert.ok(
    entry,
    `Unknown walkthrough ${hashOrAlias}; choose ${WALKTHROUGHS.map((route) => route.alias).join(", ")}`,
  );
  return entry;
}

export function verifyWalkthrough(
  route: Walkthrough,
  { state, egoView }: WalkthroughOutcome,
): void {
  const expected = route.expected;
  assert.ok(
    opening(route.alias).profiles.includes(state.profile),
    `${route.alias}: supported interpreter profile`,
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
  assert.equal(run.hash, route.hash, "walkthrough fixture hash");
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
