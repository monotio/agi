import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { fixtureSkip } from "../fixtures.ts";
import {
  readWalkthroughArtifact,
  shippedTapePath,
  walkthroughFixtureHashes,
  walkthroughServedRevisions,
  type WalkthroughArtifact,
} from "./artifact.ts";
import type { Speedrun } from "./runner.ts";
import { runWalkthrough, shippedSpeedrun, walkthrough } from "./walkthroughs.ts";

/**
 * Fail unless `tape` is exactly what `run` recorded: the same inputs, the
 * same virtual time and the same ending state.
 */
export function assertTapeMatchesRun(tape: WalkthroughArtifact, run: Speedrun): void {
  const alias = run.alias ?? run.hash;
  const regenerate = `If the route changed on purpose, regenerate its tape with \`npm run prove:walkthrough -- ${alias} app/public/walkthroughs/${alias}.json\`.`;
  assert.equal(tape.seed, run.seed, `${alias}: tape seed. ${regenerate}`);
  assert.equal(tape.profile, run.engine.profile.id, `${alias}: tape profile. ${regenerate}`);
  const length = Math.max(tape.actions.length, run.actions.length);
  for (let index = 0; index < length; index++) {
    if (isDeepStrictEqual(tape.actions[index], run.actions[index])) continue;
    assert.fail(
      `${alias}: the shipped tape differs from its route at action ${index} of ${run.actions.length}: ` +
        `tape ${JSON.stringify(tape.actions[index])}, route ${JSON.stringify(run.actions[index])}. ${regenerate}`,
    );
  }
  assert.equal(tape.virtualTicks, run.ticks, `${alias}: tape duration. ${regenerate}`);
  assert.equal(tape.cycles, run.cycles, `${alias}: tape interpreter cycles. ${regenerate}`);
  assert.deepEqual(
    tape.finalState,
    run.engine.readState(),
    `${alias}: ending state. ${regenerate}`,
  );
}

/**
 * One catalog route, played once under the shipped settings, must reach its
 * ending and reproduce its committed tape. Each game gets its own test file
 * so `node --test` plays the routes in parallel processes.
 */
export function testShippedWalkthrough(alias: string): void {
  const route = walkthrough(alias);
  test(
    `${route.alias}: ${route.label}, and the shipped tape matches the route`,
    {
      skip: fixtureSkip(route.hash, ["AGIDATA.OVL"], { checkVolumes: "shipped" }),
      // Police Quest's route takes about forty seconds alone.
      timeout: 180_000,
    },
    async () => {
      const tape = await readWalkthroughArtifact(shippedTapePath(route.alias));
      assert.equal(tape.identity.project, route.alias, "tape catalog id");
      assert.equal(tape.coverage, route.coverage, "tape coverage");
      assert.deepEqual(
        tape.fixtureHashes,
        walkthroughFixtureHashes(route.hash),
        "exact fixture resources",
      );
      assert.deepEqual(
        tape.supportedRevisions,
        await walkthroughServedRevisions(route.hash),
        "served bundle revisions",
      );
      assertTapeMatchesRun(tape, runWalkthrough(route, shippedSpeedrun(route)));
    },
  );
}
