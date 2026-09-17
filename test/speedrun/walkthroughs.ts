import assert from "node:assert/strict";
import { Speedrun } from "./runner.ts";
import { opening } from "./openings.ts";
import type { Walkthrough, WalkthroughOutcome } from "./route.ts";
import { kq1Walkthrough } from "./kq1.ts";
import { kq2Walkthrough } from "./kq2.ts";
import { kq3Walkthrough } from "./kq3.ts";
import { sq1Walkthrough } from "./sq1.ts";
import { mh1Walkthrough } from "./mh1.ts";
import { sq2Walkthrough } from "./sq2.ts";
import { pq1Walkthrough } from "./pq1.ts";
import { lsl1Walkthrough } from "./lsl1.ts";
import { bcWalkthrough } from "./bc.ts";
import { mumgWalkthrough } from "./mumg.ts";
import { ddpWalkthrough } from "./ddp.ts";
import { kq4Walkthrough } from "./kq4.ts";
import { mh2Walkthrough } from "./mh2.ts";
import { gr1Walkthrough } from "./gr1.ts";

import { KNOWN_GAME_HASH, resolveGameHash } from "../../src/games/knownGames.ts";

export type { Walkthrough, WalkthroughOutcome };

export const WALKTHROUGHS: readonly Walkthrough[] = [
  kq1Walkthrough,
  mh1Walkthrough,
  kq2Walkthrough,
  kq3Walkthrough,
  sq1Walkthrough,
  sq2Walkthrough,
  pq1Walkthrough,
  lsl1Walkthrough,
  bcWalkthrough,
  mumgWalkthrough,
  ddpWalkthrough,
  kq4Walkthrough,
  mh2Walkthrough,
  gr1Walkthrough,
  {
    hash: KNOWN_GAME_HASH.ADVENTURE_DEPARTMENT,
    alias: "adventure-department",
    label: "repaired all three exhibits and graduated",
    coverage: "complete-game",
    route: (run) => {
      run.wait(() => run.state().room === 1, "boot into the gallery", 300);
      // Picture Gallery: the frame's posn() box is x 45–110, y 112–167.
      run.checkpoint("Picture Gallery", { room: 1, score: 0 });
      run.walkTo(45, 140);
      run.command("paint mural");
      run.checkpoint("Mural painted", { room: 1, score: 10 });
      run.command("east");
      // Sprite Lab: the doorway drops ego inside the lever's box (x 8–52).
      assert.equal(run.state().room, 2);
      assert.equal(run.state().score, 10);
      run.command("pull lever");
      // The lever's end.of.loop runs ~16 cycles, then f34 prints the result.
      run.advance(24);
      run.dismiss();
      run.checkpoint("Robot awake", { room: 2, score: 20 });
      run.command("east");
      // Priority Archive: show the depth numbers, then fix Felix's.
      assert.equal(run.state().room, 3);
      assert.equal(run.state().score, 20);
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

export function walkthrough(query: string): Walkthrough {
  const norm = query.toLowerCase();
  const resolved = resolveGameHash(norm) ?? norm;
  const entry = WALKTHROUGHS.find(
    (route) => route.hash.toLowerCase() === resolved || route.alias.toLowerCase() === norm,
  );
  assert.ok(
    entry,
    `Unknown walkthrough ${query}; choose ${WALKTHROUGHS.map((route) => route.alias).join(", ")}`,
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

export function runWalkthrough(
  route: Walkthrough,
  run = new Speedrun(route.hash, route.seed ?? 1),
): Speedrun {
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
