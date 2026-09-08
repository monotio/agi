import assert from "node:assert/strict";
import type { EngineStateReport } from "../../src/runtime/engine.ts";
import { Speedrun } from "./runner.ts";
import { opening } from "./openings.ts";
import { kq1Complete } from "./kq1.ts";
import { kq2Bridge } from "./kq2.ts";
import { sq1UlenceFlats } from "./sq1.ts";
import { day1 } from "./mh1-day1.ts";

/** Observable endpoint shared by the Node, CLI and browser walkthrough runners. */
export interface WalkthroughOutcome {
  state: EngineStateReport;
  egoView: number;
}
export interface Walkthrough {
  slug: string;
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
    slug: "kq1",
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
    slug: "mh1",
    label: "Day 1 completed",
    coverage: "chapter",
    route: day1,
    expected: { room: 104, vars: { 60: 2 }, carriedExactly: [11, 13, 14, 15] },
    requiresAnswer: true,
  },
  {
    slug: "kq2",
    label: "first inscription and bridge round trip",
    coverage: "partial",
    route: kq2Bridge,
    expected: { room: 48, score: 41, flags: { 67: 1, 119: 0 }, carried: [52, 55, 59, 68, 69] },
  },
  {
    slug: "sq1",
    label: "arrival at Ulence Flats",
    coverage: "chapter",
    route: sq1UlenceFlats,
    expected: {
      room: 35,
      score: 108,
      carriedExactly: [1, 3, 5, 6, 19, 22],
    },
    requiresAnswer: true,
  },
];

export function walkthrough(slug: string): Walkthrough {
  const entry = WALKTHROUGHS.find((route) => route.slug === slug);
  assert.ok(
    entry,
    `Unknown walkthrough ${slug}; choose ${WALKTHROUGHS.map((route) => route.slug).join(", ")}`,
  );
  return entry;
}

export function verifyWalkthrough(
  route: Walkthrough,
  { state, egoView }: WalkthroughOutcome,
): void {
  const expected = route.expected;
  assert.ok(
    opening(route.slug).profiles.includes(state.profile),
    `${route.slug}: supported interpreter profile`,
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

export function runWalkthrough(route: Walkthrough, run = new Speedrun(route.slug, 1)): Speedrun {
  assert.equal(run.slug, route.slug, "walkthrough fixture");
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
