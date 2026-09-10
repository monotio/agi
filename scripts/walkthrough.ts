import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixtureSkip } from "../test/fixtures.ts";
import { Speedrun } from "../test/speedrun/runner.ts";
import { walkthrough, runWalkthrough } from "../test/speedrun/walkthroughs.ts";
import { walkthroughFixtureHashes, type WalkthroughArtifact } from "../test/speedrun/artifact.ts";

const route = walkthrough(process.argv[2] ?? "");
const missing = fixtureSkip(route.hash, ["AGIDATA.OVL"]);
if (missing) {
  process.stdout.write(`SKIP: ${missing}\n`);
} else {
  const output = resolve(process.argv[3] ?? `/tmp/agi-${route.alias}-speedrun.json`);
  const started = performance.now();
  const run = new Speedrun(route.hash, 1, { dwellModals: true });
  const fixtureHashes = walkthroughFixtureHashes(route.hash);
  let failure: string | null = null;
  try {
    runWalkthrough(route, run);
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.exitCode = 1;
  }
  const elapsedMs = Math.round(performance.now() - started);
  const artifact: WalkthroughArtifact = {
    schema: "monotio_agi.walkthrough.v1",
    game: route.alias,
    targetHash: route.hash,
    supportedHashes: [route.hash],
    coverage: route.coverage,
    profile: run.engine.profile.id,
    seed: run.seed,
    fixtureHashes,
    status: failure === null ? "completed" : "failed",
    failure,
    elapsedMs,
    virtualTicks: run.ticks,
    cycles: run.cycles,
    actions: run.actions,
    finalState: run.engine.readState(),
  };
  writeFileSync(output, JSON.stringify(artifact, null, 2) + "\n");
  process.stdout.write(
    `${artifact.status} (${route.coverage}): ${run.cycles} cycles, ${(run.ticks / 60).toFixed(1)} virtual seconds in ${elapsedMs}ms; ${output}\n`,
  );
  if (failure) process.stderr.write(failure + "\n");
}
